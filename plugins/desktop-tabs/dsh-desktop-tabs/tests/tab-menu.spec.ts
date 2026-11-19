/**
 * Tests of the per-tab action menu (`src/client/tab-menu.ts`).
 *
 * Runs under plain Node (type stripping) with a minimal fake document/window:
 * elements carry attributes, children, listeners, a viewport rectangle, and the
 * focus/disabled surface the menu drives. The module owns no timers, so every
 * transition is asserted directly instead of waiting.
 *
 * Run: `node tests/tab-menu.spec.ts`
 */

import { createTabActionMenu, TAB_MENU_ATTR, type TabMenuAction } from '../src/client/tab-menu.ts'

let failures = 0
/** @returns whether the assertion held; counts a mismatch as a failure. */
function check(condition: unknown, label: string): void {
  if (condition) return
  failures += 1
  console.error(`FAIL: ${label}`)
}

type Listener = (event: Record<string, unknown>) => void

/** One fake DOM element with just the surface the menu touches. */
class FakeElement {
  readonly tag: string
  readonly attrs = new Map<string, string>()
  readonly children: FakeElement[] = []
  readonly listeners = new Map<string, Listener[]>()
  parent: FakeElement | undefined
  hidden = false
  disabled = false
  tabIndex = 0
  textContent = ''
  title = ''
  focused = false
  readonly style: Record<string, string> = {}
  rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }

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

  contains(node: unknown): boolean {
    if (node === this) return true
    return this.children.some((child) => child.contains(node))
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? []
    this.listeners.set(type, list.filter((candidate) => candidate !== listener))
  }

  dispatch(type: string, extra: Record<string, unknown> = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ type, target: this, ...extra })
  }

  focus(): void {
    this.focused = true
  }

  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
    // An open menu is measured before it is placed; give it the real CSS size so
    // the viewport clamping and the flip-above branch are exercised.
    if (this.getAttribute(TAB_MENU_ATTR) !== null) {
      return { left: this.rect.left, top: this.rect.top, right: this.rect.left + 112, bottom: this.rect.top + 132, width: 112, height: 132 }
    }
    return this.rect
  }

  get offsetWidth(): number {
    return this.rect.width
  }

  get offsetHeight(): number {
    return this.rect.height
  }
}

/** The fake document/window pair the menu expects. */
interface FakeDom {
  readonly document: {
    body: FakeElement
    createElement(tag: string): FakeElement
    addEventListener(type: string, listener: Listener): void
    removeEventListener(type: string, listener: Listener): void
    dispatch(type: string, extra?: Record<string, unknown>): void
  }
  readonly window: {
    innerWidth: number
    innerHeight: number
    addEventListener(type: string, listener: Listener): void
    removeEventListener(type: string, listener: Listener): void
    dispatch(type: string, extra?: Record<string, unknown>): void
  }
}

/** Install the fake globals; returns the document/window handles and event sinks. */
function installFakeDom(): FakeDom {
  const documentListeners = new Map<string, Listener[]>()
  const windowListeners = new Map<string, Listener[]>()
  const documentElement = new FakeElement('html')
  const body = new FakeElement('body')
  const document = {
    body,
    documentElement,
    createElement: (tag: string): FakeElement => new FakeElement(tag),
    addEventListener(type: string, listener: Listener): void {
      const list = documentListeners.get(type) ?? []
      list.push(listener)
      documentListeners.set(type, list)
    },
    removeEventListener(type: string, listener: Listener): void {
      const list = documentListeners.get(type) ?? []
      documentListeners.set(type, list.filter((candidate) => candidate !== listener))
    },
    dispatch(type: string, extra: Record<string, unknown> = {}): void {
      for (const listener of [...(documentListeners.get(type) ?? [])]) listener({ type, ...extra })
    },
  }
  const window = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener(type: string, listener: Listener): void {
      const list = windowListeners.get(type) ?? []
      list.push(listener)
      windowListeners.set(type, list)
    },
    removeEventListener(type: string, listener: Listener): void {
      const list = windowListeners.get(type) ?? []
      windowListeners.set(type, list.filter((candidate) => candidate !== listener))
    },
    dispatch(type: string, extra: Record<string, unknown> = {}): void {
      for (const listener of [...(windowListeners.get(type) ?? [])]) listener({ type, ...extra })
    },
  }
  ;(globalThis as unknown as { document: unknown }).document = document
  ;(globalThis as unknown as { window: unknown }).window = window
  return { document, window } as unknown as FakeDom
}

/** The menu root inside the fake body, if open. */
function menuRoot(dom: FakeDom): FakeElement | undefined {
  return dom.document.body.children.find((child) => child.getAttribute(TAB_MENU_ATTR) !== null)
}

/** The item buttons of an open menu. */
function itemsOf(root: FakeElement | undefined): FakeElement[] {
  return root?.children ?? []
}

/** A viewport rectangle for a 26px-tall caption-band trigger. */
function triggerRect(left: number): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
  return { left, top: 8, right: left + 18, bottom: 34, width: 18, height: 26 }
}

const entries = [
  { action: 'refresh' as const, label: '刷新' },
  { action: 'restart' as const, label: '重启', disabled: true, title: '没有可重启的进程' },
  { action: 'disconnect' as const, label: '断开', title: '关闭标签页' },
]

{
  const dom = installFakeDom()
  const selected: TabMenuAction[] = []
  let closed = 0
  const menu = createTabActionMenu({ closed: () => { closed += 1 } })
  const anchor = dom.document.createElement('button')
  anchor.setAttribute('aria-expanded', 'false')
  anchor.rect = triggerRect(100)
  dom.document.body.append(anchor)

  check(menu.element === undefined, 'mount: no menu DOM before the first open')

  menu.open({
    anchor,
    label: '标签操作 A',
    entries,
    select: (action) => { selected.push(action) },
  })
  const root = menuRoot(dom)
  check(root !== undefined, 'open: one menu root is appended to the body')
  check(root?.getAttribute('role') === 'menu', 'open: the root is a menu')
  check(root?.getAttribute('aria-label') === '标签操作 A', 'open: the root carries the accessible name')
  check(anchor.getAttribute('aria-expanded') === 'true', 'open: the trigger reports the menu expanded')
  const items = itemsOf(root)
  check(items.length === 3, 'open: three entries are rendered')
  check(items[0].textContent === '刷新' && items[2].textContent === '断开', 'open: entries keep their labels')
  check(items[1].disabled === true, 'open: the disabled entry is disabled')
  check(items[1].getAttribute('aria-label') === '重启', 'open: a disabled entry keeps its plain label')
  check(items[1].title === '没有可重启的进程', 'open: a disabled entry explains itself in its title')
  check(items[0].focused === true, 'open: the first enabled entry takes focus')
  check(root?.style.left === '100px', 'position: the menu aligns with the trigger left edge')
  check(root?.style.top === '38px', 'position: the menu hangs below the trigger')

  // A disabled entry never activates and never closes the menu.
  items[1].dispatch('click')
  check(selected.length === 0, 'disabled: a click reports nothing')
  check(menu.element !== undefined, 'disabled: the menu stays open')

  // An enabled entry closes the menu before the action runs.
  let openWhileSelecting: HTMLElement | undefined
  menu.open({
    anchor,
    label: '标签操作 A',
    entries,
    select: (action) => {
      openWhileSelecting = menu.element
      selected.push(action)
    },
  })
  const reopened = menuRoot(dom)
  itemsOf(reopened)[2].dispatch('click')
  check(selected.at(-1) === 'disconnect', 'select: the enabled entry reports its action')
  check(openWhileSelecting === undefined, 'select: the menu is closed before the action runs')
  check(menu.element === undefined, 'select: the controller reports closed')
  check(anchor.getAttribute('aria-expanded') === 'false', 'select: the trigger reports collapsed')
  check(closed === 2, 'select: each closed menu reports exactly once')

  // A pointer inside the trigger is the toggle's business; anywhere else closes.
  menu.open({ anchor, label: '标签操作 A', entries, select: (action) => { selected.push(action) } })
  dom.document.dispatch('pointerdown', { target: anchor })
  check(menu.element !== undefined, 'outside pointer: the trigger does not dismiss its own menu')
  const outside = dom.document.createElement('div')
  dom.document.body.append(outside)
  dom.document.dispatch('pointerdown', { target: outside })
  check(menu.element === undefined, 'outside pointer: a click elsewhere dismisses the menu')
  check(anchor.getAttribute('aria-expanded') === 'false', 'outside pointer: the trigger reports collapsed')

  // Escape returns focus to the trigger.
  menu.open({ anchor, label: '标签操作 A', entries, select: (action) => { selected.push(action) } })
  dom.document.dispatch('keydown', { key: 'Escape', preventDefault() {} })
  check(menu.element === undefined, 'escape: the menu closes')
  check(anchor.focused === true, 'escape: focus returns to the trigger')

  // Arrow keys rove over the enabled entries only.
  menu.open({ anchor, label: '标签操作 A', entries, select: (action) => { selected.push(action) } })
  const roving = itemsOf(menuRoot(dom))
  dom.document.dispatch('keydown', { key: 'ArrowDown', preventDefault() {} })
  check(roving[2].focused === true, 'keys: ArrowDown skips the disabled entry')
  dom.document.dispatch('keydown', { key: 'ArrowDown', preventDefault() {} })
  check(roving[0].focused === true, 'keys: ArrowDown wraps to the first enabled entry')
  dom.document.dispatch('keydown', { key: 'End', preventDefault() {} })
  check(roving[2].focused === true, 'keys: End focuses the last enabled entry')
  dom.document.dispatch('keydown', { key: 'Home', preventDefault() {} })
  check(roving[0].focused === true, 'keys: Home focuses the first enabled entry')
  dom.document.dispatch('keydown', { key: 'ArrowUp', preventDefault() {} })
  check(roving[2].focused === true, 'keys: ArrowUp wraps backwards over the disabled entry')

  // Reopening replaces the previous root instead of stacking a second one.
  menu.open({ anchor, label: '标签操作 B', entries, select: (action) => { selected.push(action) } })
  const roots = dom.document.body.children.filter((child) => child.getAttribute(TAB_MENU_ATTR) !== null)
  check(roots.length === 1, 'reopen: only one menu root exists')
  check(roots[0].getAttribute('aria-label') === '标签操作 B', 'reopen: the new menu replaces the old one')

  // A window scroll dismisses the fixed menu (its trigger moved).
  dom.window.dispatch('scroll')
  check(menu.element === undefined, 'window: a scroll closes the menu')

  // Dispose closes the open menu and refuses later opens.
  menu.open({ anchor, label: '标签操作 A', entries, select: (action) => { selected.push(action) } })
  menu.dispose()
  check(menu.element === undefined, 'dispose: the open menu closes')
  check(closed === 7, 'dispose: every open reported its close')
  menu.open({ anchor, label: '标签操作 A', entries, select: (action) => { selected.push(action) } })
  check(menu.element === undefined, 'dispose: a later open is ignored')
}

// Viewport clamping: a trigger near the right edge shifts the menu left, and a
// trigger near the bottom flips the menu above itself.
{
  const dom = installFakeDom()
  const menu = createTabActionMenu()
  const anchor = dom.document.createElement('button')
  anchor.setAttribute('aria-expanded', 'false')
  anchor.rect = { left: 1150, top: 700, right: 1168, bottom: 726, width: 18, height: 26 }
  dom.document.body.append(anchor)
  menu.open({ anchor, label: '标签操作', entries, select() {} })
  const root = menuRoot(dom)
  check(root?.style.left === '1084px', 'position: a menu at the right edge is clamped into the viewport')
  check(root?.style.top === '564px', 'position: a menu without room below flips above the trigger')
  menu.dispose()
}

if (failures > 0) {
  console.error(`tab-menu: ${failures} assertion(s) failed`)
  process.exitCode = 1
} else {
  console.log('tab-menu: all assertions passed')
}
