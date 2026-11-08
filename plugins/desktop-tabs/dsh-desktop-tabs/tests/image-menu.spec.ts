/**
 * Regression test for the remote-guest image context menu
 * (`src/client/image-menu.ts`) and its view-layer wiring (`src/client/view.ts`).
 *
 * Runs under plain Node (v24 type stripping) as one in-process script — no test
 * runner and no child processes, so it stays inside sandboxed environments. The
 * DOM is a minimal hand-written fake (elements with attributes, style, children,
 * listeners, a focus target and a layout; a document with `body`/`head`; a window
 * with a viewport size and recorded timers), and the clipboard is a recorded
 * `ClipboardItem`/`navigator.clipboard.write` pair. Every menu transition is
 * driven directly; no real browser is involved.
 *
 * Covered: the guest capture script's safe argument splicing and fallbacks, the
 * data-URL read guard, the app-document clipboard write, menu placement/clamping,
 * the copy hit path, unreadable images, refused writes with the retry timer,
 * Escape and outside-pointer dismissal, window blur/resize/scroll dismissal,
 * reopen/close/dispose listener cleanup, and the view layer's `context-menu`
 * wiring (image-only menu, guest-relative position, non-image ignored, stale guest
 * ignored, and menu closure on tab switches).
 *
 * Run: `node tests/image-menu.spec.ts`
 */
import {
  COPY_RETRY_MS,
  copyImageToClipboard,
  createImageContextMenu,
  guestImageScript,
  PNG_DATA_URL_PREFIX,
  readGuestImage,
} from '../src/client/image-menu.ts'
import { createRemoteView, type RemoteView } from '../src/client/view.ts'

let failures = 0
/** @returns whether the assertion held; counts a mismatch as a failure. */
function check(condition: unknown, label: string): void {
  if (condition) return
  failures += 1
  console.error(`FAIL: ${label}`)
}

type Listener = (event: Record<string, unknown>) => void

interface ListenerEntry {
  readonly listener: Listener
  readonly once: boolean
  readonly wrapped: Listener
}

/** The listener surface shared by the fake document, window, and elements. */
class FakeEventTarget {
  readonly listeners = new Map<string, ListenerEntry[]>()

  addEventListener(type: string, listener: Listener, options?: boolean | { once?: boolean }): void {
    const once = typeof options === 'object' && options !== null && options.once === true
    const entry: ListenerEntry = {
      listener,
      once,
      wrapped: (event: Record<string, unknown>) => {
        if (once) this.removeEntry(type, entry)
        listener(event)
      },
    }
    const list = this.listeners.get(type) ?? []
    list.push(entry)
    this.listeners.set(type, list)
  }

  removeEventListener(type: string, listener: Listener, _options?: unknown): void {
    const list = this.listeners.get(type)
    if (list === undefined) return
    const index = list.findIndex((entry) => entry.listener === listener)
    if (index >= 0) list.splice(index, 1)
  }

  dispatch(type: string, extra: Record<string, unknown> = {}): void {
    for (const entry of [...(this.listeners.get(type) ?? [])]) entry.wrapped({ type, target: this, ...extra })
  }

  /** @returns the number of registered listeners, for cleanup assertions. */
  listenerCount(): number {
    let total = 0
    for (const list of this.listeners.values()) total += list.length
    return total
  }

  private removeEntry(type: string, entry: ListenerEntry): void {
    const list = this.listeners.get(type)
    if (list === undefined) return
    const index = list.indexOf(entry)
    if (index >= 0) list.splice(index, 1)
  }
}

/** One fake DOM element with just the surface the menu and view layers touch. */
class FakeElement extends FakeEventTarget {
  readonly tag: string
  readonly doc: FakeDocument
  readonly attrs = new Map<string, string>()
  readonly children: FakeElement[] = []
  readonly style: Record<string, string> = {}
  parent: FakeElement | undefined
  textContent = ''
  hidden = false
  disabled = false
  focused = false
  /** The rect `getBoundingClientRect()` reports; tests may move a guest. */
  readonly layout = { left: 0, top: 0, width: 120, height: 34 }
  clientWidth = 0
  clientHeight = 0

  constructor(tag: string, doc: FakeDocument) {
    super()
    this.tag = tag
    this.doc = doc
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

  contains(node: unknown): boolean {
    let current = node as FakeElement | undefined
    while (current !== undefined && current !== null) {
      if (current === this) return true
      current = current.parent
    }
    return false
  }

  /** Only the `webview` tag query the view layer issues is supported. */
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

  getBoundingClientRect(): { x: number; y: number; left: number; top: number; width: number; height: number; right: number; bottom: number } {
    const { left, top, width, height } = this.layout
    return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height }
  }

  focus(): void {
    this.focused = true
    this.doc.activeElement = this
  }

  /** The guest evaluation surface; tests override it per guest. */
  executeJavaScript(_code: string, _userGesture?: boolean): Promise<unknown> {
    return Promise.resolve(undefined)
  }
}

/** The fake document the menu, the view layer, and the title layer read. */
class FakeDocument extends FakeEventTarget {
  title = '本机标题'
  activeElement: FakeElement | undefined
  readonly body: FakeElement
  readonly head: FakeElement
  readonly documentElement: FakeElement

  constructor() {
    super()
    this.body = new FakeElement('body', this)
    this.head = new FakeElement('head', this)
    this.documentElement = new FakeElement('html', this)
    this.documentElement.clientWidth = 800
    this.documentElement.clientHeight = 600
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this)
  }

  querySelector(_selector: string): FakeElement | null {
    return null
  }

  querySelectorAll(_selector: string): FakeElement[] {
    return []
  }
}

/** The fake window: viewport size, window listeners, and recorded timers. */
class FakeWindow extends FakeEventTarget {
  innerWidth = 800
  innerHeight = 600
  readonly timeouts = new Map<number, { callback: () => void; delay: number }>()
  readonly intervals = new Map<number, () => void>()
  private nextTimer = 1

  setTimeout(callback: () => void, delay = 0): number {
    const id = this.nextTimer
    this.nextTimer += 1
    this.timeouts.set(id, { callback, delay })
    return id
  }

  clearTimeout(id: number): void {
    this.timeouts.delete(id)
  }

  setInterval(callback: () => void): number {
    const id = this.nextTimer
    this.nextTimer += 1
    this.intervals.set(id, callback)
    return id
  }

  clearInterval(id: number): void {
    this.intervals.delete(id)
  }

  /** Run every pending timeout once, oldest first. */
  runTimeouts(): void {
    const pending = [...this.timeouts.entries()]
    this.timeouts.clear()
    for (const [, entry] of pending) entry.callback()
  }
}

/** An inert `MutationObserver`: the window-title layer only needs its start/stop API. */
class FakeMutationObserver {
  constructor(_listener: () => void) {}
  observe(): void {}
  disconnect(): void {}
}

/** The fake `ClipboardItem` the app document's clipboard write receives. */
class FakeClipboardItem {
  readonly items: Record<string, Blob>

  constructor(items: Record<string, Blob>) {
    this.items = items
  }
}

interface FakeDom {
  readonly document: FakeDocument
  readonly window: FakeWindow
}

/** Install the fake document/window globals the layers expect. */
function installFakeDom(): FakeDom {
  const document = new FakeDocument()
  const window = new FakeWindow()
  const scope = globalThis as unknown as Record<string, unknown>
  scope.document = document
  scope.window = window
  scope.MutationObserver = FakeMutationObserver
  return { document, window }
}

/** Replace the image clipboard with recording fakes; `restore()` puts Node's back. */
function installFakeClipboard(behavior?: (items: unknown[]) => Promise<void>): {
  written: FakeClipboardItem[]
  restore(): void
} {
  const written: FakeClipboardItem[] = []
  const scope = globalThis as unknown as Record<string, unknown>
  const priorNavigator = Object.getOwnPropertyDescriptor(scope, 'navigator')
  const priorItem = Object.getOwnPropertyDescriptor(scope, 'ClipboardItem')
  const clipboard = {
    async write(items: unknown[]): Promise<void> {
      for (const item of items) if (item instanceof FakeClipboardItem) written.push(item)
      if (behavior !== undefined) await behavior(items)
    },
  }
  Object.defineProperty(scope, 'navigator', { value: { clipboard }, configurable: true })
  Object.defineProperty(scope, 'ClipboardItem', { value: FakeClipboardItem, configurable: true, writable: true })
  return {
    written,
    restore(): void {
      if (priorNavigator === undefined) Reflect.deleteProperty(scope, 'navigator')
      else Object.defineProperty(scope, 'navigator', priorNavigator)
      if (priorItem === undefined) Reflect.deleteProperty(scope, 'ClipboardItem')
      else Object.defineProperty(scope, 'ClipboardItem', priorItem)
    },
  }
}

/** A 1x1 PNG as the guest would return it. */
const PNG = PNG_DATA_URL_PREFIX + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** Attributes the menu root and item use (also asserted so styles stay pointed at them). */
const MENU_ATTR = 'data-dsh-desktop-tabs-image-menu'

/** Let pending promise continuations run. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Wait until `condition` holds (bounded), asserting it eventually does. */
async function until(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return
    await tick()
  }
  check(false, label)
}

/** @returns the menu root inside the fake document body, if any. */
function openMenuRoot(document: FakeDocument): FakeElement | undefined {
  return document.body.children.find((child) => child.getAttribute(MENU_ATTR) !== null)
}

/** @returns whether a promise rejects. */
async function rejects(promise: Promise<unknown>): Promise<boolean> {
  try {
    await promise
    return false
  } catch {
    return true
  }
}

/** The guest script is spliced safely and carries the documented fallbacks. */
function captureScript(): void {
  const source = 'https://a.test/i.png?q="x"\\y\n'
  const script = guestImageScript(12.4, -3.6, source)
  check(script.endsWith('(12, -4, ' + JSON.stringify(source) + ')'), 'script: rounded point and JSON-escaped source')
  check(!script.includes('`'), 'script: no template literals')
  check(script.includes('document.elementFromPoint'), 'script: finds the image under the point')
  check(script.includes('document.images'), 'script: falls back to matching document.images by source')
  check(script.includes('naturalWidth'), 'script: draws at the image natural size')
  check(script.includes('canvas.toDataURL("image/png")'), 'script: re-encodes to PNG')
  check(script.includes('credentials: "include"'), 'script: the fetch fallback sends credentials')
  check(script.includes('URL.createObjectURL'), 'script: the fetch fallback re-encodes the blob')
  check(guestImageScript(Number.NaN, Number.POSITIVE_INFINITY, '').endsWith('(0, 0, "")'), 'script: invalid point and empty source stay numeric literals')
  check(guestImageScript(5, 6, undefined as unknown as string).endsWith('(5, 6, "")'), 'script: a non-string source degrades to empty')
}

/** `readGuestImage` accepts only PNG data URLs and never throws. */
async function readImage(): Promise<void> {
  const source = 'http://r.test/i.png?a=1&b=2'
  let script = ''
  const value = await readGuestImage(
    {
      executeJavaScript: (code: string): Promise<unknown> => {
        script = code
        return Promise.resolve(PNG)
      },
    },
    { x: 3, y: 4, srcURL: source },
  )
  check(value === PNG, 'read: a PNG data URL passes through')
  check(script.endsWith('(3, 4, ' + JSON.stringify(source) + ')'), 'read: the point and source are passed to the guest')

  const jpeg = await readGuestImage(
    { executeJavaScript: () => Promise.resolve('data:image/jpeg;base64,AAAA') },
    { x: 0, y: 0, srcURL: '' },
  )
  check(jpeg === null, 'read: a non-PNG data URL is rejected')

  const missing = await readGuestImage(
    { executeJavaScript: () => Promise.reject(new Error('guest destroyed')) },
    { x: 0, y: 0, srcURL: '' },
  )
  check(missing === null, 'read: a rejecting guest resolves null instead of throwing')

  const notAString = await readGuestImage(
    { executeJavaScript: () => Promise.resolve(42) },
    { x: 0, y: 0, srcURL: '' },
  )
  check(notAString === null, 'read: a non-string result resolves null')
}

/** `copyImageToClipboard` decodes the data URL and writes one `image/png` blob. */
async function copyToClipboard(): Promise<void> {
  installFakeDom()
  const clipboard = installFakeClipboard()
  try {
    await copyImageToClipboard(PNG)
    check(clipboard.written.length === 1, 'clipboard: one ClipboardItem is written')
    const blob = clipboard.written[0]?.items['image/png']
    check(blob instanceof Blob, 'clipboard: the item carries a Blob under image/png')
    check(blob !== undefined && blob.size > 0 && blob.type === 'image/png', 'clipboard: the blob decodes the whole PNG')
    check(await rejects(copyImageToClipboard('data:image/jpeg;base64,AAAA')), 'clipboard: a non-PNG data URL rejects')
    clipboard.restore()
    check(await rejects(copyImageToClipboard(PNG)), 'clipboard: a missing ClipboardItem rejects')
    installFakeDom()
    const refusing = installFakeClipboard(() => Promise.reject(new Error('denied')))
    try {
      check(await rejects(copyImageToClipboard(PNG)), 'clipboard: a refused write rejects')
    } finally {
      refusing.restore()
    }
  } finally {
    clipboard.restore()
    Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'ClipboardItem')
  }
}

/** The menu opens at the requested point, focuses its item, and copies. */
async function menuOpensAndCopies(): Promise<void> {
  const { document } = installFakeDom()
  const clipboard = installFakeClipboard()
  try {
    const closed: number[] = []
    const menu = createImageContextMenu({
      write: copyImageToClipboard,
      onClosed: () => { closed.push(1) },
    })
    check(menu.element === undefined, 'menu: nothing is open initially')
    check(document.body.children.length === 0, 'menu: construction touches no DOM')
    menu.open({ x: 100, y: 120, image: Promise.resolve(PNG) })
    const root = openMenuRoot(document)
    check(root !== undefined, 'menu: open appends the menu root')
    check(root?.getAttribute('role') === 'menu', 'menu: the root has role=menu')
    check(root?.style.left === '100px' && root?.style.top === '120px', 'menu: placed at the requested viewport point')
    const button = root?.children[0]
    check(button?.tag === 'button' && button?.getAttribute('role') === 'menuitem', 'menu: one menuitem button')
    check(button?.textContent === '复制图片', 'menu: the item reads 复制图片')
    check(button?.focused === true, 'menu: the item is focused on open')
    button?.dispatch('click')
    await until(() => document.body.children.length === 0, 'copy: a successful write closes the menu')
    check(clipboard.written.length === 1, 'copy: the clipboard write receives the image')
    check(closed.length === 1, 'copy: onClosed runs once')
    check(menu.element === undefined, 'copy: the controller has no open element after closing')
    menu.dispose()
  } finally {
    clipboard.restore()
  }
}

/** A menu opened near a window edge is clamped fully inside the viewport. */
async function menuClamps(): Promise<void> {
  const { document, window } = installFakeDom()
  window.innerWidth = 320
  window.innerHeight = 200
  const menu = createImageContextMenu({ write: () => Promise.resolve() })
  menu.open({ x: 900, y: 700, image: Promise.resolve(PNG) })
  const root = openMenuRoot(document)
  const left = Number.parseFloat(root?.style.left ?? 'NaN')
  const top = Number.parseFloat(root?.style.top ?? 'NaN')
  check(left >= 0 && left + 120 <= window.innerWidth, 'clamp: the menu stays inside the window horizontally')
  check(top >= 0 && top + 34 <= window.innerHeight, 'clamp: the menu stays inside the window vertically')
  menu.close()

  const second = createImageContextMenu({ write: () => Promise.resolve() })
  second.open({ x: -50, y: -20, image: Promise.resolve(PNG) })
  const negative = openMenuRoot(document)
  check(Number.parseFloat(negative?.style.left ?? '-1') >= 0, 'clamp: a negative x is moved into the window')
  check(Number.parseFloat(negative?.style.top ?? '-1') >= 0, 'clamp: a negative y is moved into the window')
  second.dispose()
}

/** An unreadable image shows the label and disables the item. */
async function menuUnreadable(): Promise<void> {
  const { document } = installFakeDom()
  let writes = 0
  const closed: number[] = []
  const menu = createImageContextMenu({
    write: () => { writes += 1; return Promise.resolve() },
    onClosed: () => { closed.push(1) },
  })
  menu.open({ x: 10, y: 10, image: Promise.resolve(null) })
  const root = openMenuRoot(document)
  const button = root?.children[0]
  button?.dispatch('click')
  await until(() => button?.textContent === '无法读取图片', 'unreadable: the item reports the failed read')
  check(button?.disabled === true, 'unreadable: the item is disabled after the read')
  check(openMenuRoot(document) !== undefined, 'unreadable: the menu stays open')
  check(writes === 0, 'unreadable: no clipboard write is attempted')
  document.dispatch('keydown', { key: 'Escape' })
  check(openMenuRoot(document) === undefined, 'unreadable: Escape still closes the menu')
  check(closed.length === 1, 'unreadable: onClosed runs once')
  menu.dispose()
}

/** A refused write shows the retry label and re-enables after the delay. */
async function menuWriteFailure(): Promise<void> {
  const { document, window } = installFakeDom()
  let attempts = 0
  const closed: number[] = []
  const menu = createImageContextMenu({
    write: () => {
      attempts += 1
      return attempts === 1 ? Promise.reject(new Error('denied')) : Promise.resolve()
    },
    onClosed: () => { closed.push(1) },
  })
  menu.open({ x: 10, y: 10, image: Promise.resolve(PNG) })
  const root = openMenuRoot(document)
  const button = root?.children[0]
  button?.dispatch('click')
  await until(() => button?.textContent === '复制失败，请重试', 'failure: the item reports the refused write')
  check(button?.disabled === true, 'failure: the item is disabled while the write runs')
  check(openMenuRoot(document) !== undefined, 'failure: the menu stays open')
  check(window.timeouts.size === 1, 'failure: one retry timer is armed')
  const delay = [...window.timeouts.values()][0]?.delay
  check(delay === COPY_RETRY_MS, 'failure: the retry timer waits the documented delay')
  window.runTimeouts()
  check(button?.textContent === '复制图片', 'failure: the retry restores the label')
  check(button?.disabled === false, 'failure: the retry re-enables the item')
  button?.dispatch('click')
  await until(() => document.body.children.length === 0, 'failure: a retried copy succeeds and closes')
  check(attempts === 2, 'failure: the retry runs the write again')
  check(closed.length === 1, 'failure: onClosed runs once after the successful retry')
  menu.dispose()
}

/** Escape, outside pointerdown, and close idempotence. */
async function menuDismissal(): Promise<void> {
  const { document } = installFakeDom()
  const closed: number[] = []
  const menu = createImageContextMenu({
    write: () => Promise.resolve(),
    onClosed: () => { closed.push(1) },
  })
  menu.open({ x: 20, y: 20, image: Promise.resolve(PNG) })
  document.dispatch('keydown', { key: 'Escape' })
  check(openMenuRoot(document) === undefined && closed.length === 1, 'dismiss: Escape closes the menu')

  menu.open({ x: 20, y: 20, image: Promise.resolve(PNG) })
  document.dispatch('pointerdown', { target: document.createElement('div') })
  check(openMenuRoot(document) === undefined && closed.length === 2, 'dismiss: a pointer outside the menu closes it')

  menu.open({ x: 20, y: 20, image: Promise.resolve(PNG) })
  const root = openMenuRoot(document)
  document.dispatch('pointerdown', { target: root })
  check(openMenuRoot(document) !== undefined && closed.length === 2, 'dismiss: a pointer inside the menu keeps it open')

  menu.close()
  menu.close()
  check(openMenuRoot(document) === undefined && closed.length === 3, 'dismiss: close is idempotent and notifies once')

  menu.open({ x: 20, y: 20, image: Promise.resolve(PNG) })
  menu.open({ x: 40, y: 40, image: Promise.resolve(PNG) })
  check(document.body.children.length === 1, 'dismiss: reopening leaves exactly one menu')
  check(openMenuRoot(document)?.style.left === '40px', 'dismiss: reopening places the new menu')
  menu.dispose()
}

/** Window blur, resize, and scroll dismiss the menu. */
async function menuWindowChanges(): Promise<void> {
  const { document, window } = installFakeDom()
  const closed: number[] = []
  const menu = createImageContextMenu({
    write: () => Promise.resolve(),
    onClosed: () => { closed.push(1) },
  })
  for (const event of ['blur', 'resize', 'scroll']) {
    menu.open({ x: 30, y: 30, image: Promise.resolve(PNG) })
    window.dispatch(event)
    check(openMenuRoot(document) === undefined, `window: ${event} closes the menu`)
  }
  check(closed.length === 3, 'window: each dismissal notifies once')
  menu.dispose()
}

/** dispose removes DOM and listeners and refuses later opens without notifying. */
async function menuDispose(): Promise<void> {
  const { document, window } = installFakeDom()
  const closed: number[] = []
  const menu = createImageContextMenu({
    write: () => Promise.resolve(),
    onClosed: () => { closed.push(1) },
  })
  const documentBaseline = document.listenerCount()
  const windowBaseline = window.listenerCount()
  menu.open({ x: 10, y: 10, image: Promise.resolve(PNG) })
  check(document.listenerCount() === documentBaseline + 2, 'dispose: open attaches the document listeners')
  check(window.listenerCount() === windowBaseline + 3, 'dispose: open attaches the window listeners')
  menu.dispose()
  check(openMenuRoot(document) === undefined, 'dispose: the menu DOM is removed')
  check(document.listenerCount() === documentBaseline, 'dispose: the document listeners are removed')
  check(window.listenerCount() === windowBaseline, 'dispose: the window listeners are removed')
  check(closed.length === 0, 'dispose: handing focus back is left to a normal close')
  menu.open({ x: 10, y: 10, image: Promise.resolve(PNG) })
  check(openMenuRoot(document) === undefined, 'dispose: later opens create no DOM')
  menu.close()
  menu.dispose()
  check(closed.length === 0, 'dispose: later closes notify nothing')
}

/** The view layer wires a guest `context-menu` event to the app-document menu. */
async function viewWiring(): Promise<void> {
  const { document } = installFakeDom()
  const clipboard = installFakeClipboard()
  try {
    const bridge = {
      acquire: (): Promise<{ lease: string; partition: string }> => Promise.resolve({ lease: 'lease-1', partition: 'persist:lease-1' }),
      release: (): Promise<void> => Promise.resolve(),
    }
    const view: RemoteView = createRemoteView(bridge)
    view.activate('remote')
    view.show('remote', { account: 'desktop-tabs:remote', url: 'http://r.test/', title: 'R' })
    await tick()
    const surface = (view.element as unknown as FakeElement).children.find(
      (child) => child.getAttribute('data-dsh-desktop-tabs-surface') === 'remote',
    )
    const guest = surface?.children.find((child) => child.tag === 'webview')
    check(guest !== undefined, 'view: the guest mounted')
    if (guest === undefined) {
      view.dispose()
      return
    }
    guest.layout.left = 10
    guest.layout.top = 20
    const scripts: string[] = []
    guest.executeJavaScript = (code: string): Promise<unknown> => {
      scripts.push(code)
      return Promise.resolve(PNG)
    }

    guest.dispatch('context-menu', { params: { x: 5, y: 7, mediaType: 'image', srcURL: 'http://r.test/i.png' } })
    check(scripts.length === 1, 'view: an image context menu captures in the guest')
    const root = openMenuRoot(document)
    check(root !== undefined, 'view: an image context menu opens the app-document menu')
    check(root?.style.left === '15px' && root?.style.top === '27px', 'view: the menu follows the guest rect plus the event point')
    check(root?.children[0]?.textContent === '复制图片', 'view: the menu offers 复制图片')

    guest.focused = false
    root?.children[0]?.dispatch('click')
    await until(() => openMenuRoot(document) === undefined, 'view: copying closes the menu')
    check(clipboard.written.length === 1, 'view: copying writes the guest image to the clipboard')
    check(guest.focused === true, 'view: closing the menu returns focus to the guest')

    guest.dispatch('context-menu', { params: { x: 1, y: 1, mediaType: 'none' } })
    check(openMenuRoot(document) === undefined, 'view: a non-image context menu opens nothing')

    guest.dispatch('context-menu', { params: { x: 1, y: 1, mediaType: 'image', srcURL: 'http://r.test/i.png' } })
    check(openMenuRoot(document) !== undefined, 'view: a second image context menu opens')
    view.hide()
    check(openMenuRoot(document) === undefined, 'view: hiding the layer closes the menu')

    guest.dispatch('context-menu', { params: { x: 1, y: 1, mediaType: 'image', srcURL: 'http://r.test/i.png' } })
    check(openMenuRoot(document) !== undefined, 'view: the menu opens again')
    view.dispose()
    check(openMenuRoot(document) === undefined, 'view: dispose closes the menu')
    guest.dispatch('context-menu', { params: { x: 1, y: 1, mediaType: 'image', srcURL: 'http://r.test/i.png' } })
    check(openMenuRoot(document) === undefined, 'view: a disposed layer never opens another menu')
  } finally {
    clipboard.restore()
  }
}

/** A superseded guest (replaced by a refresh) must not open a menu. */
async function staleGuest(): Promise<void> {
  const { document } = installFakeDom()
  const bridge = {
    acquire: (): Promise<{ lease: string; partition: string }> => Promise.resolve({ lease: 'lease-1', partition: 'persist:lease-1' }),
    release: (): Promise<void> => Promise.resolve(),
  }
  const view = createRemoteView(bridge)
  view.activate('remote')
  view.show('remote', { account: 'desktop-tabs:remote', url: 'http://r.test/', title: 'R' })
  await tick()
  const surface = (view.element as unknown as FakeElement).children.find(
    (child) => child.getAttribute('data-dsh-desktop-tabs-surface') === 'remote',
  )
  const stale = surface?.children.find((child) => child.tag === 'webview')
  view.show('remote', { account: 'desktop-tabs:remote', url: 'http://r.test/next', title: 'R' })
  await tick()
  const fresh = surface?.children.find((child) => child.tag === 'webview')
  check(stale !== undefined && fresh !== undefined && stale !== fresh, 'stale: the refresh mounted a new guest')
  stale?.dispatch('context-menu', { params: { x: 1, y: 1, mediaType: 'image', srcURL: 'http://r.test/i.png' } })
  check(openMenuRoot(document) === undefined, 'stale: a superseded guest opens no menu')
  view.dispose()
}

captureScript()
await readImage()
await copyToClipboard()
await menuOpensAndCopies()
await menuClamps()
await menuUnreadable()
await menuWriteFailure()
await menuDismissal()
await menuWindowChanges()
await menuDispose()
await viewWiring()
await staleGuest()

if (failures > 0) {
  console.error(`image-menu: ${failures} assertion(s) failed`)
  process.exitCode = 1
} else {
  console.log('image-menu: all assertions passed')
}
