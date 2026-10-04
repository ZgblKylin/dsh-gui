/**
 * The caption-band tab strip: the tabs, their add/close entries, the saved
 * connections behind them, and the remote views they drive.
 *
 * Geometry: the shell reserves a 40px band at the top of the page for the
 * Windows caption and draws its own fixed caption menu in it (`data-windows-menu`,
 * `z-index: 1100`, left edge `--dsh-windows-menu-start`). There is no layout
 * container to insert into, so the strip is `position: fixed`, `top: 0`, height
 * `--dsh-windows-titlebar-height`, and its `left` is the menu's live right edge:
 * a ResizeObserver on the menu covers width changes (a language switch rewrites
 * the menu labels), and a document-level MutationObserver covers the menu
 * appearing, being replaced, and `lang` changes. The `+` panel and the
 * connection settings panel hang from the same edge.
 *
 * Switching unloads: selecting a remote tab destroys any previous guest and
 * mounts a new one; selecting the local tab destroys the current guest and
 * hides the layer, which is how the native UI is revealed again. The host
 * conversation panel is never unmounted — this plugin only covers the content
 * area with its own layer.
 *
 * Connecting shows the tab's own placeholder page: activating a tab that needs a
 * connection immediately switches the layer to an empty page with the status
 * line and the connection's progress log, polled from
 * `/desktop-tabs/api/connections`. The previous tab's guest is already gone at
 * that point, so the window never keeps showing the tab the user just left. A
 * failure keeps the log and adds the reason; success replaces the page with the
 * guest.
 *
 * Editing: tabs stay open independently of the saved connections that produced
 * them, so closing a tab never forgets a connection. Every change is persisted
 * with `PUT /desktop-tabs/api/tabs` before any connection is attempted, because
 * the host half reads the connection settings back from that file.
 *
 * The browser half renders nothing at all outside the desktop shell: `apply()`
 * returns unless the carrier publishes the guest bridge, and the strip stays
 * hidden until the Windows caption menu actually exists.
 */

import { downConnection, fetchConnections, fetchSshHosts, fetchTabs, putTabs, upConnection } from './api.ts'
import type { DesktopBrowserBridge } from './bridge.ts'
import { CONFIG_PANEL_ATTR, createConfigPanel, type ConfigPanel, type ConnectionDraft } from './config-panel.ts'
import { createPanel, PANEL_ATTR, type Panel } from './panel.ts'
import { installStyles, removeStyles } from './styles.ts'
import { isLocalTab, sshOfAlias, type ConnectionStatus, type DesktopTab, type SavedConnection, type SshHost } from './types.ts'
import { createRemoteView, VIEW_ATTR, type RemoteView } from './view.ts'

/** Marks the strip element. */
const STRIP_ATTR = 'data-dsh-desktop-tabs'
/** Marks one tab's row: the container that paints the whole row's background. */
const TAB_SLOT_ATTR = 'data-dsh-desktop-tab-slot'
/** Marks the tab row that is currently active. */
const TAB_ACTIVE_ATTR = 'data-dsh-desktop-tab-active'
/** Marks the `+` button. */
const ADD_ATTR = 'data-dsh-desktop-tabs-add'
/** The shell's caption menu host (light DOM, fixed, `z-index: 1100`). */
const MENU_SELECTOR = '[data-windows-menu]'
/** Fallback left edge before the menu is measured (the menu's own CSS default). */
const MENU_FALLBACK_LEFT = 48
/** Shown when the stored list declares no local tab. */
const LOCAL_TAB: DesktopTab = { id: 'local', title: '本机' }
/** Strip accessibility label. */
const STRIP_LABEL = '主机标签'
/** `+` button label. */
const ADD_LABEL = '新增标签'
/** How often a connecting tab asks for its progress log. */
const LOG_POLL_MS = 500
/** Gap between the `+` panel and the settings panel beside it. */
const CONFIG_GAP = 8

/**
 * Mount the strip, its panels, and its remote views.
 * @param bridge - guest lease operations from the desktop shell.
 * @returns teardown, registered as the plugin's effect disposer.
 */
export function createDesktopTabs(bridge: DesktopBrowserBridge): () => void {
  installStyles()
  // Single instance: a mount that outlived its fiber would otherwise leave a
  // second strip, view layer, and panels behind.
  document.querySelectorAll(`[${STRIP_ATTR}], [${VIEW_ATTR}], [${PANEL_ATTR}], [${CONFIG_PANEL_ATTR}]`)
    .forEach((stale) => { stale.remove() })
  const strip = document.createElement('div')
  strip.setAttribute(STRIP_ATTR, '')
  strip.setAttribute('role', 'group')
  strip.setAttribute('aria-label', STRIP_LABEL)
  strip.hidden = true
  const view: RemoteView = createRemoteView(bridge)
  const panel: Panel = createPanel({
    onOpenConnection: openConnection,
    onEditConnection: editConnection,
    onDeleteConnection: deleteConnection,
    onPickHost: pickHost,
  })
  const config: ConfigPanel = createConfigPanel({
    onConfirm: confirmConnection,
    onCancel: () => {},
  })
  panel.setSshHosts([])
  document.body.append(strip, view.element, panel.element, config.element)

  /** The open tabs, local tab first. */
  let tabs: DesktopTab[] = []
  /** The saved connections; a tab may exist without one (a `url` tab, or a legacy inline `ssh` tab). */
  let connections: SavedConnection[] = []
  let hosts: readonly SshHost[] = []
  let activeId: string | undefined
  /** Invalidates an ssh activation that is still awaiting `up`. */
  let activation = 0
  let menu: HTMLElement | undefined
  let resizeObserver: ResizeObserver | undefined

  const account = (tab: DesktopTab): string => `desktop-tabs:${tab.id}`

  /** Anchor the strip and the panels to the caption menu's right edge. */
  const measure = (): void => {
    const right = menu?.getBoundingClientRect().right
    strip.style.left = `${right === undefined || right === 0 ? MENU_FALLBACK_LEFT : right}px`
    panel.element.style.left = strip.style.left
    placeConfig()
  }

  /** Keep the settings panel beside the `+` panel while both are open. */
  const placeConfig = (): void => {
    if (!config.isOpen()) return
    const rect = panel.element.getBoundingClientRect()
    config.element.style.left = `${rect.right + CONFIG_GAP}px`
    config.element.style.top = `${rect.top}px`
  }

  const findMenu = (): HTMLElement | undefined => {
    const element = document.querySelector(MENU_SELECTOR)
    return element instanceof HTMLElement ? element : undefined
  }

  /** Follow the current menu host, or no host at all. */
  const bindMenu = (next: HTMLElement | undefined): void => {
    if (next === menu) return
    resizeObserver?.disconnect()
    resizeObserver = undefined
    menu = next
    if (next !== undefined) {
      resizeObserver = new ResizeObserver(measure)
      resizeObserver.observe(next)
    }
    measure()
    refreshVisibility()
  }

  const refreshVisibility = (): void => {
    const hidden = menu === undefined || tabs.length === 0
    strip.hidden = hidden
    if (hidden) {
      panel.close()
      config.close()
      view.hide()
    }
  }

  /** Rebuild the strip from `tabs`: one entry per tab, then the `+` button. */
  const render = (): void => {
    strip.replaceChildren(...tabs.map(createTabEntry), createAddButton())
    panel.setConnections(connections)
    panel.setSshHosts(hosts)
    refreshVisibility()
    markActive()
    placeConfig()
  }

  const markActive = (): void => {
    for (const button of buttons()) {
      button.setAttribute('aria-pressed', String(button.dataset.dshDesktopTab === activeId))
    }
    // The row background belongs to the slot, so the label and the `×` share it.
    for (const slot of strip.querySelectorAll<HTMLElement>(`[${TAB_SLOT_ATTR}]`)) {
      if (slot.dataset.dshDesktopTabSlot === activeId) slot.setAttribute(TAB_ACTIVE_ATTR, '')
      else slot.removeAttribute(TAB_ACTIVE_ATTR)
    }
  }

  const buttons = (): HTMLButtonElement[] => [...strip.querySelectorAll<HTMLButtonElement>('[data-dsh-desktop-tab]')]

  const buttonFor = (id: string): HTMLButtonElement | undefined =>
    buttons().find((button) => button.dataset.dshDesktopTab === id)

  const createTabEntry = (tab: DesktopTab): HTMLElement => {
    // The slot is the visual row (and paints its own hover/active background);
    // the two inner buttons stay focusable controls, since a button may not
    // contain another button.
    const slot = document.createElement('div')
    slot.setAttribute(TAB_SLOT_ATTR, tab.id)
    slot.setAttribute('role', 'presentation')
    const label = document.createElement('button')
    label.type = 'button'
    label.textContent = tab.title
    label.title = tab.title
    label.setAttribute('aria-pressed', 'false')
    label.dataset.dshDesktopTab = tab.id
    label.addEventListener('click', () => { guard(activate(tab.id), 'switch') })
    slot.append(label)
    if (!isLocalTab(tab)) {
      const closeButton = document.createElement('button')
      closeButton.type = 'button'
      closeButton.textContent = '✕'
      closeButton.title = `关闭 ${tab.title}`
      closeButton.setAttribute('aria-label', `关闭 ${tab.title}`)
      closeButton.dataset.dshDesktopTabClose = tab.id
      closeButton.addEventListener('click', (event) => {
        event.stopPropagation()
        guard(closeTab(tab.id), 'close')
      })
      slot.append(closeButton)
    }
    return slot
  }

  const createAddButton = (): HTMLButtonElement => {
    const add = document.createElement('button')
    add.type = 'button'
    add.textContent = '+'
    add.title = ADD_LABEL
    add.setAttribute('aria-label', ADD_LABEL)
    add.setAttribute(ADD_ATTR, '')
    add.addEventListener('click', () => { panel.toggle() })
    return add
  }

  /** Show the failure on the tab itself, in addition to the view layer. */
  const failTab = (id: string, text: string): void => {
    const button = buttonFor(id)
    if (button === undefined) return
    button.dataset.dshDesktopTabError = text
    button.title = text
  }

  const clearTabError = (id: string): void => {
    const button = buttonFor(id)
    if (button === undefined) return
    delete button.dataset.dshDesktopTabError
    const tab = tabs.find((candidate) => candidate.id === id)
    if (tab !== undefined) button.title = tab.title
  }

  /** Run an operation from a DOM handler, reporting an unexpected rejection instead of dropping it. */
  const guard = (operation: Promise<void>, what: string): void => {
    void operation.catch((error: unknown) => {
      console.warn(`[dsh-desktop-tabs] ${what} failed:`, error)
    })
  }

  /** Poll one connecting tab's progress log until the connection settles. */
  function pollConnectionLog(id: string, run: number): () => void {
    let timer: number | undefined
    let stopped = false
    const stop = (): void => {
      stopped = true
      if (timer !== undefined) window.clearInterval(timer)
      timer = undefined
    }
    const read = async (): Promise<void> => {
      if (stopped || run !== activation) {
        stop()
        return
      }
      let list: ConnectionStatus[]
      try {
        list = await fetchConnections()
      } catch {
        // A missed poll is transient; the next tick retries.
        return
      }
      if (stopped || run !== activation) return
      const status = list.find((entry) => entry.id === id)
      if (status?.log !== undefined) view.setLog(status.log)
      // The connection owns the lifetime: once it settles, the log is final.
      if (status?.state === 'up' || status?.state === 'error') stop()
    }
    void read()
    timer = window.setInterval(() => { void read() }, LOG_POLL_MS)
    return stop
  }

  /** Read the log once more so a failure keeps the lines the poller had not seen yet. */
  function reapLog(id: string, run: number): void {
    void fetchConnections()
      .then((list) => {
        const status = list.find((entry) => entry.id === id)
        if (run === activation && status?.log !== undefined) view.setLog(status.log)
      })
      .catch(() => {})
  }

  /** Activate one tab, bringing its ssh connection up first when it has no address. */
  async function activate(id: string | undefined): Promise<void> {
    const tab = tabs.find((candidate) => candidate.id === id)
    if (tab === undefined) return
    activeId = tab.id
    markActive()
    const run = ++activation
    if (tab.url !== undefined) {
      view.show({ account: account(tab), url: tab.url, title: tab.title })
      return
    }
    if (isLocalTab(tab)) {
      view.hide()
      return
    }
    // The placeholder page replaces whatever the previous tab showed before the
    // connection is even attempted; the log below is the progress feedback.
    view.open(tab.title)
    const stopLog = pollConnectionLog(tab.id, run)
    try {
      const url = await upConnection(tab.id)
      if (run !== activation) return
      stopLog()
      clearTabError(tab.id)
      view.show({ account: account(tab), url, title: tab.title })
    } catch (error: unknown) {
      if (run !== activation) return
      const text = message(error)
      stopLog()
      failTab(tab.id, text)
      view.fail(`${tab.title} 连接失败：${text}`)
      reapLog(tab.id, run)
    }
  }

  /** Remove one tab, persist the list, and bring its connection down. */
  async function closeTab(id: string): Promise<void> {
    const tab = tabs.find((candidate) => candidate.id === id)
    if (tab === undefined || isLocalTab(tab)) return
    tabs = tabs.filter((candidate) => candidate.id !== id)
    render()
    if (activeId === id) {
      activeId = undefined
      guard(activate(tabs[0]?.id), 'switch')
    }
    if (tab.ssh !== undefined) {
      void downConnection(tab.id).catch((error: unknown) => {
        console.warn(`[dsh-desktop-tabs] could not bring connection '${tab.id}' down:`, error)
      })
    }
    try {
      await persist()
    } catch (error: unknown) {
      panel.fail(`保存失败：${message(error)}`)
      throw error
    }
  }

  /** Open a saved connection: activate its tab, or create the tab first. */
  async function openConnection(connection: SavedConnection): Promise<void> {
    const existing = tabs.find((tab) => tab.id === connection.id)
    if (existing !== undefined) {
      guard(activate(connection.id), 'switch')
      return
    }
    tabs = [...tabs, tabOfConnection(connection)]
    render()
    // Persist before connecting: the host half reads this tab's connection
    // descriptor from the config file when `up` arrives.
    await persist()
    guard(activate(connection.id), 'switch')
  }

  /** Open the settings panel for an existing connection. */
  function editConnection(connection: SavedConnection): void {
    config.open({
      id: connection.id,
      title: connection.title,
      ssh: connection.ssh,
      workdir: connection.workdir ?? '',
      startCommand: connection.startCommand ?? '',
    })
    placeConfig()
  }

  /** Configure a new connection for one SSH host alias. */
  function pickHost(host: SshHost): void {
    config.open({ title: host.alias, ssh: sshOfAlias(host.alias), workdir: '', startCommand: '' })
    placeConfig()
  }

  /** Save a connection draft and open — or reopen — its tab. */
  async function confirmConnection(draft: ConnectionDraft): Promise<void> {
    const id = draft.id ?? uniqueConnectionId(draft.title)
    const entry: SavedConnection = {
      id,
      title: draft.title,
      type: 'ssh',
      ...(draft.ssh === undefined ? {} : { ssh: draft.ssh }),
      ...(draft.workdir.trim() === '' ? {} : { workdir: draft.workdir.trim() }),
      ...(draft.startCommand.trim() === '' ? {} : { startCommand: draft.startCommand.trim() }),
    }
    const known = connections.some((connection) => connection.id === id)
    connections = known ? connections.map((connection) => (connection.id === id ? entry : connection)) : [...connections, entry]
    const openTab = tabs.find((tab) => tab.id === id)
    if (openTab !== undefined) {
      tabs = tabs.map((tab) => (tab.id === id ? { ...tab, title: entry.title, ...(entry.ssh === undefined ? {} : { ssh: entry.ssh }) } : tab))
      render()
      // The new settings live in the connection, which the host half reads when
      // the next `up` arrives: drop the old session, persist, then reconnect.
      await downConnection(id).catch((error: unknown) => {
        console.warn(`[dsh-desktop-tabs] could not bring connection '${id}' down:`, error)
      })
      await persist()
      panel.close()
      guard(activate(id), 'switch')
      return
    }
    tabs = [...tabs, tabOfConnection(entry)]
    render()
    await persist()
    panel.close()
    guard(activate(id), 'switch')
  }

  /** Delete a saved connection, closing its tab when it is open. */
  async function deleteConnection(connection: SavedConnection): Promise<void> {
    connections = connections.filter((candidate) => candidate.id !== connection.id)
    const openTab = tabs.find((tab) => tab.id === connection.id)
    if (openTab !== undefined) {
      tabs = tabs.filter((tab) => tab.id !== connection.id)
      render()
      if (activeId === connection.id) {
        activeId = undefined
        guard(activate(tabs[0]?.id), 'switch')
      }
      // Bring the session down while the file still holds the descriptor.
      await downConnection(connection.id).catch((error: unknown) => {
        console.warn(`[dsh-desktop-tabs] could not bring connection '${connection.id}' down:`, error)
      })
    } else {
      render()
    }
    await persist()
  }

  /** Read the stored tabs and connections plus the SSH host aliases. */
  async function load(): Promise<void> {
    try {
      const snapshot = await fetchTabs()
      tabs = normalize(snapshot.tabs)
      connections = [...snapshot.connections]
    } catch (error: unknown) {
      console.warn('[dsh-desktop-tabs] could not read tab targets:', error)
      tabs = normalize([])
      connections = []
    }
    render()
    guard(activate(tabs[0]?.id), 'switch')
    try {
      hosts = await fetchSshHosts()
    } catch {
      // The SSH host list is a convenience: an unavailable host half leaves the
      // group empty instead of reporting an error the user cannot act on.
      hosts = []
    }
    panel.setSshHosts(hosts)
  }

  /** Store both persisted lists. */
  async function persist(): Promise<void> {
    await putTabs({ tabs, connections })
  }

  /** @returns a free connection id for an alias, preferring the readable `ssh-<alias>` form. */
  function uniqueConnectionId(alias: string): string {
    const taken = (candidate: string): boolean =>
      connections.some((connection) => connection.id === candidate) || tabs.some((tab) => tab.id === candidate)
    const stem = `ssh-${alias}`
    if (!taken(stem)) return stem
    let suffix = 1
    while (taken(`${stem}-${suffix}`)) suffix += 1
    return `${stem}-${suffix}`
  }

  const observer = new MutationObserver(() => {
    bindMenu(findMenu())
  })
  observer.observe(document.body, { childList: true })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
  window.addEventListener('resize', measure)
  /**
   * Close both panels when a pointer goes down outside them. The listener lives
   * for the mount and returns immediately while nothing is open, so no
   * open/close bookkeeping can leave it stale.
   */
  const onPointerDownOutside = (event: Event): void => {
    if (!panel.isOpen() && !config.isOpen()) return
    const target = event.target
    if (isWithin(panel.element, target) || isWithin(config.element, target)) return
    // The `+` button owns its own toggle; let its click handler decide.
    const candidate = target as { closest?: (selector: string) => unknown } | null
    if (typeof candidate?.closest === 'function' && candidate.closest(`[${ADD_ATTR}]`) !== null) return
    panel.close()
    config.close()
  }
  /** `Escape` closes both panels, wherever focus is. */
  const onEscapeKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    panel.close()
    config.close()
  }
  document.addEventListener('pointerdown', onPointerDownOutside, true)
  document.addEventListener('keydown', onEscapeKey, true)
  bindMenu(findMenu())

  guard(load(), 'mount')

  return () => {
    resizeObserver?.disconnect()
    observer.disconnect()
    document.removeEventListener('pointerdown', onPointerDownOutside, true)
    document.removeEventListener('keydown', onEscapeKey, true)
    window.removeEventListener('resize', measure)
    config.dispose()
    panel.dispose()
    view.dispose()
    strip.remove()
    removeStyles()
  }
}

/** @returns whether an event target is the element or one of its descendants. */
function isWithin(element: HTMLElement, target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') return false
  if ((target as unknown) === element) return true
  return typeof element.contains === 'function' && element.contains(target as Node)
}

/** Project a saved connection onto the tab that opens it. */
function tabOfConnection(connection: SavedConnection): DesktopTab {
  return {
    id: connection.id,
    title: connection.title,
    ...(connection.ssh === undefined ? {} : { ssh: connection.ssh }),
  }
}

/**
 * Guarantee exactly one local tab, always first: the first entry that is neither
 * an addressed tab nor an ssh tab keeps its id and title, and a list with no
 * such entry gets the default local view prepended.
 * @param list - validated tabs, in host order.
 * @returns local tab followed by the remote tabs, in host order.
 */
function normalize(list: readonly DesktopTab[]): DesktopTab[] {
  return [list.find((tab) => isLocalTab(tab)) ?? LOCAL_TAB, ...list.filter((tab) => !isLocalTab(tab))]
}

/** @returns an error's message, or its string form. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
