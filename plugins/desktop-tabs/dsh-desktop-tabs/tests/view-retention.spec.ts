/**
 * Regression test for the retained-guest view layer (`src/client/view.ts`).
 *
 * The layer used to own exactly one guest and unload it on every switch. It now
 * owns one surface (and one retained guest) per remote tab: switching reveals a
 * surface without touching the guest left behind, and only a refresh, a tab
 * close, or a dispose unloads a guest and releases its lease.
 *
 * Runs under plain Node (type stripping) as one in-process script — no test
 * runner and no child processes. The DOM is a minimal fake: elements with
 * attributes, children, hidden state, listeners, and the `<webview>` API the
 * layer calls. Timers are recorded, never fired, so the test drives every
 * transition directly.
 *
 * Run: `node tests/view-retention.spec.ts`
 */

import { createRemoteView, type RemoteView } from '../src/client/view.ts'

let failures = 0
/** @returns whether the assertion held; counts a mismatch as a failure. */
function check(condition: unknown, label: string): void {
  if (condition) return
  failures += 1
  console.error(`FAIL: ${label}`)
}

type Listener = (event: Record<string, unknown>) => void

/** One fake DOM element with just the surface the view layer touches. */
class FakeElement {
  readonly tag: string
  readonly attrs = new Map<string, string>()
  readonly children: FakeElement[] = []
  readonly listeners = new Map<string, Listener[]>()
  hidden = false
  textContent = ''
  scrollTop = 0
  scrollHeight = 0
  loading = false
  focused = false
  readonly loadedUrls: string[] = []
  parent: FakeElement | undefined

  constructor(tag: string) {
    this.tag = tag
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value))
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name)
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.remove()
      node.parent = this
      this.children.push(node)
    }
  }

  remove(): void {
    const parent = this.parent
    if (parent === undefined) return
    parent.children.splice(parent.children.indexOf(this), 1)
    this.parent = undefined
  }

  /** Only the `webview` tag query the layer issues is supported. */
  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = []
    const walk = (node: FakeElement): void => {
      for (const child of node.children) {
        if (selector === 'webview' && child.tag === 'webview') found.push(child)
        walk(child)
      }
    }
    walk(this)
    return found
  }

  addEventListener(type: string, listener: Listener, options?: { once?: boolean }): void {
    const wrapped: Listener = (event) => {
      if (options?.once === true) {
        const list = this.listeners.get(type) ?? []
        this.listeners.set(type, list.filter((candidate) => candidate !== wrapped))
      }
      listener(event)
    }
    const list = this.listeners.get(type) ?? []
    list.push(wrapped)
    this.listeners.set(type, list)
  }

  dispatch(type: string, extra: Record<string, unknown> = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ type, ...extra })
  }

  focus(): void {
    this.focused = true
  }

  loadURL(url: string): Promise<void> {
    this.loadedUrls.push(url)
    return Promise.resolve()
  }

  isLoading(): boolean {
    return this.loading
  }

  executeJavaScript(): Promise<unknown> {
    return Promise.resolve(undefined)
  }
}

/** Install the fake document/window the layer expects; returns their timers. */
function installFakeDom(): {
  documentElement: FakeElement
  timers: Map<number, Listener>
} {
  const documentElement = new FakeElement('html')
  const timers = new Map<number, Listener>()
  let nextTimer = 1
  const document = {
    createElement: (tag: string): FakeElement => new FakeElement(tag),
    documentElement,
  }
  const window = {
    setInterval: (callback: Listener): number => {
      const id = nextTimer
      nextTimer += 1
      timers.set(id, callback)
      return id
    },
    clearInterval: (id: number): void => {
      timers.delete(id)
    },
  }
  ;(globalThis as unknown as { document: unknown }).document = document
  ;(globalThis as unknown as { window: unknown }).window = window
  return { documentElement, timers }
}

/** A bridge that hands out ordered leases and records acquire/release. */
function recordingBridge(): {
  acquired: string[]
  released: string[]
  acquire(account: string): Promise<{ lease: string; partition: string }>
  release(lease: string): Promise<void>
} {
  const acquired: string[] = []
  const released: string[] = []
  let next = 1
  return {
    acquired,
    released,
    async acquire(): Promise<{ lease: string; partition: string }> {
      const lease = `lease-${next}`
      next += 1
      acquired.push(lease)
      return { lease, partition: `persist:${lease}` }
    },
    async release(lease: string): Promise<void> {
      released.push(lease)
    },
  }
}

/** Let the view's `acquire()` continuation run. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** @returns the surface element of one tab, if the layer created it. */
function surfaceOf(view: RemoteView, id: string): FakeElement | undefined {
  const root = view.element as unknown as FakeElement
  return root.children.find((child) => child.getAttribute('data-dsh-desktop-tabs-surface') === id)
}

/** @returns the guest element inside one surface, if it has one. */
function guestOf(surface: FakeElement | undefined): FakeElement | undefined {
  return surface?.children.find((child) => child.tag === 'webview')
}

/** @returns the log element inside one surface. */
function logOf(surface: FakeElement | undefined): FakeElement | undefined {
  return surface?.children.find((child) => child.getAttribute('data-dsh-desktop-tabs-log') !== null)
}

/** @returns the status element inside one surface. */
function statusOf(surface: FakeElement | undefined): FakeElement | undefined {
  return surface?.children.find((child) => child.getAttribute('data-dsh-desktop-tabs-status') !== null)
}

const viewAttrs = { view: 'data-dsh-desktop-tabs-view', cover: 'data-dsh-desktop-tabs-cover' }

async function retention(): Promise<void> {
  const { documentElement, timers } = installFakeDom()
  const bridge = recordingBridge()
  const view = createRemoteView(bridge)

  view.activate('a')
  view.show('a', { account: 'desktop-tabs:a', url: 'http://a.test/', title: 'A' })
  await tick()
  const a = surfaceOf(view, 'a')
  const guestA = guestOf(a)
  check(view.element.hidden === false, 'a shown: layer visible')
  check(documentElement.getAttribute(viewAttrs.cover) !== null, 'a shown: application covered')
  check(a !== undefined && a.hidden === false, 'a shown: its surface visible')
  check(guestA?.getAttribute('src') === 'about:blank#lease-1', 'a shown: first guest attached')
  check(timers.size === 1, 'a shown: one notification poll runs for its guest')
  guestA?.dispatch('dom-ready')
  await tick()
  check(guestA?.loadedUrls[0] === 'http://a.test/', 'a shown: target URL loaded on dom-ready')

  // Switching creates b's surface and hides a's; a's guest is untouched.
  view.activate('b')
  view.show('b', { account: 'desktop-tabs:b', url: 'http://b.test/', title: 'B' })
  await tick()
  const b = surfaceOf(view, 'b')
  const guestB = guestOf(b)
  check(a?.hidden === true, 'b shown: a hidden')
  check(b !== undefined && b.hidden === false, 'b shown: b visible')
  check(guestOf(a) === guestA, 'b shown: a keeps its guest')
  check(guestA?.parent === a, 'b shown: a guest still attached to the document')
  check(bridge.released.length === 0, 'b shown: switching releases no lease')
  check(guestB?.getAttribute('src') === 'about:blank#lease-2', 'b shown: b guest attached')
  check(timers.size === 2, 'b shown: each live guest keeps its own notification poll')

  // Switching back reveals a's original guest without acquiring anything new.
  if (guestA !== undefined) guestA.focused = false
  view.activate('a')
  check(a?.hidden === false, 'a revealed: surface visible')
  check(b?.hidden === true, 'a revealed: b hidden')
  check(guestOf(a) === guestA, 'a revealed: same guest node')
  check(bridge.acquired.length === 2, 'a revealed: no new lease acquired')
  check(guestA?.focused === true, 'a revealed: shown guest focused')

  // Hiding the layer (the local tab) leaves every guest alive.
  view.hide()
  check(view.element.hidden === true, 'hidden: layer invisible')
  check(documentElement.getAttribute(viewAttrs.cover) === null, 'hidden: cover removed')
  check(guestA?.parent === a && guestB?.parent === b, 'hidden: both guests stay attached')
  check(bridge.released.length === 0, 'hidden: hiding releases no lease')
  check(timers.size === 2, 'hidden: both notification polls keep running')

  // Refreshing a tab unloads only that tab's guest and lease.
  view.activate('a')
  const staleA = guestOf(a)
  view.show('a', { account: 'desktop-tabs:a', url: 'http://a.test/next', title: 'A' })
  await tick()
  const freshA = guestOf(a)
  check(freshA !== staleA, 'refresh: a has a new guest')
  check(staleA?.parent === undefined, 'refresh: the old guest is detached')
  check(bridge.released.includes('lease-1'), 'refresh: the old lease was released')
  check(guestOf(b) === guestB, 'refresh: b keeps its guest')
  check(!bridge.released.includes('lease-2'), 'refresh: b keeps its lease')
  check(freshA?.getAttribute('src') === 'about:blank#lease-3', 'refresh: a mounted a fresh lease')
  check(timers.size === 2, 'refresh: a replaced its poll without leaking the old one')
  freshA?.dispatch('dom-ready')
  await tick()
  check(freshA?.loadedUrls[0] === 'http://a.test/next', 'refresh: a loads the address again')

  // Placeholder, status, and log are per tab.
  view.open('a', 'A')
  view.setLog('a', ['a-line'])
  check(guestOf(a) === undefined, 'placeholder: a unloaded its guest')
  check(bridge.released.includes('lease-3'), 'placeholder: a released its guest lease')
  check(timers.size === 1, 'placeholder: a stopped its notification poll')
  check(statusOf(a)?.textContent.includes('A'), 'placeholder: a shows its own status')
  view.setLog('b', ['b-line'])
  check(logOf(a)?.textContent === 'a-line', 'placeholder: a keeps its own log')
  check(logOf(b)?.textContent === 'b-line', 'placeholder: b keeps its own log')

  // Closing a tab drops its surface and unloads only its guest.
  view.unload('a')
  check(surfaceOf(view, 'a') === undefined, 'unload: a surface removed')
  check(view.element.hidden === true, 'unload: the layer stops covering the application')
  check(documentElement.getAttribute(viewAttrs.cover) === null, 'unload: cover removed')
  check(logOf(b) !== undefined, 'unload: b surface stays')

  view.dispose()
  check(view.element.parent === undefined, 'dispose: layer detached')
  check(bridge.released.includes('lease-2'), 'dispose: b lease released')
  check(timers.size === 0, 'dispose: every notification poll stopped')
  check(documentElement.getAttribute(viewAttrs.cover) === null, 'dispose: cover removed')
}

/** A mount whose lease arrives after its tab was already unloaded must not attach. */
async function staleMount(): Promise<void> {
  installFakeDom()
  const released: string[] = []
  let resolveLease: ((value: { lease: string; partition: string }) => void) | undefined
  const leaseArrives = new Promise<{ lease: string; partition: string }>((resolve) => {
    resolveLease = resolve
  })
  const view = createRemoteView({
    acquire: () => leaseArrives,
    release: async (lease: string) => {
      released.push(lease)
    },
  })
  view.activate('c')
  view.show('c', { account: 'desktop-tabs:c', url: 'http://c.test/', title: 'C' })
  view.unload('c')
  resolveLease?.({ lease: 'lease-late', partition: 'persist:late' })
  await tick()
  check(released.includes('lease-late'), 'stale mount: late lease released')
  check(view.element.children.length === 0, 'stale mount: no surface was re-created')
}

await retention()
await staleMount()

if (failures > 0) {
  console.error(`view-retention: ${failures} assertion(s) failed`)
  process.exitCode = 1
} else {
  console.log('view-retention: all assertions passed')
}
