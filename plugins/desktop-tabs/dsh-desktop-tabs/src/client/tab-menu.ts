/**
 * The action menu behind one tab row's `⋯` trigger.
 *
 * The tab strip owns the tab and its connection; this module owns only the
 * popup: the menu element appended to the application document, its items,
 * keyboard roving, and every way it closes. Actions are reported through the
 * `select` callback supplied with each open, so the strip keeps ownership of
 * the tab state and the connection lifecycle.
 *
 * The menu is fixed-positioned below its trigger and kept inside the viewport:
 * the strip lives in the Windows caption band and has no layout container of its
 * own, so an absolutely positioned child could be clipped. Its own styles live
 * in `styles.ts`; it is deliberately not a child of the strip.
 */

/** Marks the open menu root (styles.ts and tests). */
export const TAB_MENU_ATTR = 'data-dsh-desktop-tabs-tab-menu'

/** Marks an item's leading glyph. */
export const TAB_MENU_ICON_ATTR = 'data-dsh-desktop-tabs-tab-menu-icon'

/** Marks an item's text label. */
export const TAB_MENU_LABEL_ATTR = 'data-dsh-desktop-tabs-tab-menu-label'

/** The actions one tab menu offers. */
export type TabMenuAction = 'refresh' | 'restart' | 'disconnect'

/** One rendered item. */
export interface TabMenuEntry {
  readonly action: TabMenuAction
  readonly label: string
  /** Decorative leading glyph; the accessible name stays {@link label}. */
  readonly icon?: string
  /** A disabled item is rendered but never activates. */
  readonly disabled?: boolean
  /** Hover description; kept out of the visible item text. */
  readonly title?: string
}

/** One opening of the menu. */
export interface TabMenuOpenOptions {
  /** Trigger the menu hangs from; also receives focus again on Escape. */
  readonly anchor: HTMLElement
  /** Accessible name of the menu. */
  readonly label: string
  readonly entries: readonly TabMenuEntry[]
  /** Called with the activated entry; the menu closes before this runs. */
  select(action: TabMenuAction): void
}

/** What the caller may observe while the menu lives. */
export interface TabActionMenuOptions {
  /** Called after the open menu closed, however it closed. */
  closed?(): void
}

/** The menu controller. */
export interface TabActionMenu {
  /** The open menu root, or undefined while closed. */
  readonly element: HTMLElement | undefined
  /** Show one menu, closing any previous one first. */
  open(options: TabMenuOpenOptions): void
  /** Close the menu; a no-op while closed. */
  close(): void
  /** Close the menu and ignore later opens. */
  dispose(): void
}

/** Distance between the trigger and the menu. */
const GAP = 4

/** Keeps the menu inside the viewport. */
const VIEWPORT_MARGIN = 4

/**
 * Create the tab action menu.
 *
 * Nothing touches the document until the first `open`, so a strip that never
 * shows a tab never creates menu DOM.
 * @param options - close notification.
 * @returns the menu controller.
 */
export function createTabActionMenu(options: TabActionMenuOptions = {}): TabActionMenu {
  /** The open menu root; the only trigger for DOM and listeners. */
  let root: HTMLElement | undefined
  /** The trigger the menu hangs from while open. */
  let anchor: HTMLElement | undefined
  /** The activation callback of the current opening. */
  let select: ((action: TabMenuAction) => void) | undefined
  /** Rendered items, in order, while open. */
  let items: HTMLButtonElement[] = []
  /** Index into the enabled items that keyboard roving is on. */
  let focused = 0
  /** Set by dispose: no DOM is created and no callback fires afterwards. */
  let disposed = false
  /** Guards the close callback against a focus change that re-enters close. */
  let closing = false

  /** @returns whether `target` is inside the open menu. */
  const isInsideMenu = (target: EventTarget | null): boolean => {
    if (root === undefined || target === null) return false
    return typeof root.contains === 'function' && root.contains(target as Node)
  }

  /** @returns whether `target` is the trigger or inside it. */
  const isInsideAnchor = (target: EventTarget | null): boolean => {
    if (anchor === undefined || target === null) return false
    return typeof anchor.contains === 'function' && anchor.contains(target as Node)
  }

  /** The items that can take focus. */
  const enabled = (): HTMLButtonElement[] => items.filter((item) => !item.disabled)

  /** Focus one enabled item by its index among enabled items. */
  const focusEnabled = (index: number): void => {
    const list = enabled()
    if (list.length === 0) return
    const normalized = ((index % list.length) + list.length) % list.length
    focused = normalized
    list[normalized]?.focus()
  }

  /** Move the keyboard focus within the enabled items. */
  const move = (direction: 'first' | 'last' | 'next' | 'previous'): void => {
    const list = enabled()
    if (list.length === 0) return
    if (direction === 'first') focusEnabled(0)
    else if (direction === 'last') focusEnabled(list.length - 1)
    else if (direction === 'next') focusEnabled(focused + 1)
    else focusEnabled(focused - 1)
  }

  /** A pointer outside the menu and its trigger dismisses it. */
  const onPointerDown = (event: Event): void => {
    if (isInsideMenu(event.target) || isInsideAnchor(event.target)) return
    close()
  }

  /** Escape dismisses the menu and returns focus to its trigger. */
  const onKeyDown = (event: Event): void => {
    const key = (event as { key?: unknown }).key
    if (key === 'Escape') {
      ;(event as { preventDefault?: () => void }).preventDefault?.()
      const trigger = anchor
      close()
      trigger?.focus()
      return
    }
    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return
    ;(event as { preventDefault?: () => void }).preventDefault?.()
    move(key === 'ArrowDown' ? 'next' : key === 'ArrowUp' ? 'previous' : key === 'Home' ? 'first' : 'last')
  }

  /** Window blur, resize, and scroll move the anchor; dismissing is safer. */
  const onWindowChange = (): void => { close() }

  /**
   * Remove the menu DOM and listeners.
   *
   * The trigger's `aria-expanded` flips back here, so every close path leaves
   * the trigger in the same state.
   */
  function close(): void {
    if (root === undefined || closing) return
    closing = true
    try {
      const menu = root
      const trigger = anchor
      const done = options.closed
      root = undefined
      anchor = undefined
      select = undefined
      items = []
      focused = 0
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', onWindowChange)
      window.removeEventListener('resize', onWindowChange)
      window.removeEventListener('scroll', onWindowChange, true)
      trigger?.setAttribute('aria-expanded', 'false')
      menu.remove()
      done?.()
    } finally {
      closing = false
    }
  }

  /** Clamp each axis so the menu stays fully inside the viewport. */
  function place(menu: HTMLElement, trigger: HTMLElement): void {
    const rect = trigger.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    const width = menuRect.width || menu.offsetWidth || 0
    const height = menuRect.height || menu.offsetHeight || 0
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN)
    const left = Math.min(Math.max(VIEWPORT_MARGIN, Math.round(rect.left)), maxLeft)
    let top = Math.round(rect.bottom + GAP)
    if (top + height > viewportHeight - VIEWPORT_MARGIN) {
      const above = Math.round(rect.top - height - GAP)
      top = above >= VIEWPORT_MARGIN ? above : Math.max(VIEWPORT_MARGIN, viewportHeight - height - VIEWPORT_MARGIN)
    }
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
  }

  return {
    get element(): HTMLElement | undefined {
      return root
    },
    open(openOptions: TabMenuOpenOptions): void {
      if (disposed) return
      close()
      const menu = document.createElement('div')
      menu.setAttribute('role', 'menu')
      menu.setAttribute(TAB_MENU_ATTR, '')
      menu.setAttribute('aria-label', openOptions.label)
      menu.tabIndex = -1
      const rendered = openOptions.entries.map((entry) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.setAttribute('role', 'menuitem')
        button.setAttribute('aria-label', entry.label)
        if (entry.icon !== undefined) {
          const icon = document.createElement('span')
          icon.setAttribute(TAB_MENU_ICON_ATTR, '')
          // The glyph duplicates the label's meaning; screen readers keep the
          // plain accessible name set on the button above.
          icon.setAttribute('aria-hidden', 'true')
          icon.textContent = entry.icon
          button.append(icon)
        }
        const label = document.createElement('span')
        label.setAttribute(TAB_MENU_LABEL_ATTR, '')
        label.textContent = entry.label
        button.append(label)
        if (entry.title !== undefined) button.title = entry.title
        button.disabled = entry.disabled === true
        button.addEventListener('click', () => {
          if (button.disabled || root !== menu) return
          const action = entry.action
          const run = select
          close()
          run?.(action)
        })
        menu.append(button)
        return button
      })
      document.body.append(menu)
      root = menu
      anchor = openOptions.anchor
      select = openOptions.select
      items = rendered
      focused = 0
      anchor.setAttribute('aria-haspopup', 'menu')
      anchor.setAttribute('aria-expanded', 'true')
      place(menu, anchor)
      document.addEventListener('pointerdown', onPointerDown, true)
      document.addEventListener('keydown', onKeyDown, true)
      window.addEventListener('blur', onWindowChange)
      window.addEventListener('resize', onWindowChange)
      window.addEventListener('scroll', onWindowChange, true)
      if (items.some((item) => !item.disabled)) focusEnabled(0)
      else menu.focus()
    },
    close,
    dispose(): void {
      if (disposed) return
      disposed = true
      close()
    },
  }
}
