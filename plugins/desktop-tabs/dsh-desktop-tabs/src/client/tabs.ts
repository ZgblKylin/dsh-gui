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
 * The `+` panel lists saved connections plus the SSH hosts `~/.ssh/config`
 * declares, the WSL distributions `wsl.exe` reports, and the remote host devices
 * ds-harness-remote offers. Expanding a remote host lists its workspaces; opening
 * one saves a `remote` connection and starts an isolated child Harness tab. All
 * host lists are conveniences fetched side by side: each may fail on its own
 * without emptying the others or the saved connections.
 *
 * Switching retains: every open remote tab owns a guest that stays attached
 * while another tab is shown, so selecting a tab only reveals its surface — the
 * guest left behind keeps running (document state, scroll position, connections,
 * in-page work) until its tab is closed. Selecting the local tab hides the layer,
 * which is how the native UI is revealed again, and leaves every guest alive.
 * The host conversation panel is never unmounted — this plugin only covers the
 * content area with its own layer.
 *
 * Connecting shows the tab's own placeholder page: activating a tab that needs a
 * connection immediately switches the layer to that tab's empty surface with the
 * status line and the connection's progress log, polled from
 * `/desktop-tabs/api/connections`. A failure keeps the log and adds the reason;
 * success replaces the surface with the guest, whether or not the tab is still
 * the active one.
 *
 * Refreshing replaces the active tab's guest and re-establishes its connection:
 * the guest is unloaded, the connection is brought down, and the normal connect
 * flow runs again (persisting nothing, since the tab and connection already
 * exist). Only the active tab offers the refresh control, beside its close
 * button; an addressed (`url`) tab has no connection behind it, so refreshing it
 * just unloads the guest and loads the address again.
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

import {
  downConnection,
  fetchConnections,
  fetchRemoteHosts,
  fetchRemoteWorkspaces,
  fetchSshHosts,
  fetchTabs,
  fetchWslHosts,
  forgetConnection,
  putTabs,
  upConnection,
} from './api.ts'
import type { DesktopBrowserBridge } from './bridge.ts'
import { installStyles, removeStyles } from './styles.ts'
import {
  hostOfSsh,
  hostOfWsl,
  isLocalTab,
  isRemoteConnection,
  savedRemoteConnection,
  sshOfAlias,
  wslOfDistro,
  type ConnectionStatus,
  type DesktopTab,
  type RemoteHost,
  type RemoteWorkspace,
  type SavedConnection,
  type SshHost,
  type WslHost,
} from './types.ts'
import { CONNECTION_LIST_ATTR, createConnectionList } from './ui/connection-list.js'
import { CONNECTION_SETTINGS_ATTR, createConnectionSettings } from './ui/connection-settings.js'
import { createRemoteView, VIEW_ATTR, type RemoteTarget, type RemoteView } from './view.ts'

/** The values one settings session edits; the shared panel factory carries them unread. */
interface ConnectionDraft {
  /** Absent while creating a connection. */
  readonly id?: string
  /** Connection kind: `ssh` or `wsl`; the title prefix and the account hint follow it. */
  readonly kind: string
  readonly title: string
  readonly ssh?: unknown
  readonly wsl?: unknown
  /** Login account, already trimmed; empty means the channel's own default. */
  readonly account: string
  readonly workdir: string
  readonly startCommand: string
}

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
/** The active tab's refresh control: glyph and Chinese label for `title`/`aria-label`. */
const REFRESH_GLYPH = '⟳'
const REFRESH_LABEL = '刷新'
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
  document.querySelectorAll(`[${STRIP_ATTR}], [${VIEW_ATTR}], [${CONNECTION_LIST_ATTR}], [${CONNECTION_SETTINGS_ATTR}]`)
    .forEach((stale) => { stale.remove() })
  const strip = document.createElement('div')
  strip.setAttribute(STRIP_ATTR, '')
  strip.setAttribute('role', 'group')
  strip.setAttribute('aria-label', STRIP_LABEL)
  strip.hidden = true
  const view: RemoteView = createRemoteView(bridge)
  const panel = createConnectionList({
    onOpen: openConnection,
    onEdit: editConnection,
    onDelete: deleteConnection,
    onPickHost: pickHost,
    onPickWslHost: pickWslHost,
    onRemoteHost: loadRemoteWorkspaces,
    onRemoteWorkspace: openRemoteWorkspace,
    onRefreshRemote: refreshRemoteHosts,
  })
  const config = createConnectionSettings({
    onConfirm: confirmConnection,
    onCancel: () => {},
  })
  panel.setSshHosts([])
  panel.setWslHosts([])
  panel.setRemoteHosts([])
  document.body.append(strip, view.element, panel.element, config.element)

  /** The open tabs, local tab first. */
  let tabs: DesktopTab[] = []
  /** The saved connections; a tab may exist without one (a `url` tab, or a legacy inline `ssh` tab). */
  let connections: SavedConnection[] = []
  let hosts: readonly SshHost[] = []
  let wslHosts: readonly WslHost[] = []
  let remoteHosts: readonly RemoteHost[] = []
  let activeId: string | undefined
  /** Bumped per connection attempt; a tab's entry invalidates its older attempt. */
  let attemptSeq = 0
  /** Current attempt number per tab; absent means no attempt is trusted. */
  const attempts = new Map<string, number>()
  /** Tabs whose `up` is in flight (and whose log poller is running). */
  const connecting = new Set<string>()
  /** Tabs whose refresh is in flight, so repeated clicks are ignored. */
  const refreshing = new Set<string>()
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

  /**
   * Rebuild the strip from `tabs`: one entry per tab, then the `+` button.
   *
   * The remote host list is not re-pushed here: its expansion state belongs to
   * the panel and must survive tab switches and connection edits. It is set when
   * it is loaded (mount, or the remote group's refresh).
   */
  const render = (): void => {
    strip.replaceChildren(...tabs.map(createTabEntry), createAddButton())
    panel.setConnections(connections)
    panel.setSshHosts(hosts)
    panel.setWslHosts(wslHosts)
    refreshVisibility()
    markActive()
    placeConfig()
  }

  const markActive = (): void => {
    for (const button of buttons()) {
      button.setAttribute('aria-pressed', String(button.dataset.dshDesktopTab === activeId))
    }
    // The row background belongs to the slot, so the label, the refresh control,
    // and the `×` share it.
    for (const slot of strip.querySelectorAll<HTMLElement>(`[${TAB_SLOT_ATTR}]`)) {
      if (slot.dataset.dshDesktopTabSlot === activeId) slot.setAttribute(TAB_ACTIVE_ATTR, '')
      else slot.removeAttribute(TAB_ACTIVE_ATTR)
    }
    // Only the active tab reloads itself, so its refresh control is the only one
    // rendered; `hidden` keeps the inactive ones out of the tab order as well.
    for (const refreshButton of strip.querySelectorAll<HTMLButtonElement>('[data-dsh-desktop-tab-refresh]')) {
      refreshButton.hidden = refreshButton.dataset.dshDesktopTabRefresh !== activeId
    }
  }

  const buttons = (): HTMLButtonElement[] => [...strip.querySelectorAll<HTMLButtonElement>('[data-dsh-desktop-tab]')]

  const buttonFor = (id: string): HTMLButtonElement | undefined =>
    buttons().find((button) => button.dataset.dshDesktopTab === id)

  const createTabEntry = (tab: DesktopTab): HTMLElement => {
    // The slot is the visual row (and paints its own hover/active background);
    // the inner buttons stay focusable controls, since a button may not contain
    // another button.
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
      // The active tab reloads its content and connection; the control sits next
      // to `×` and is revealed for the active tab only (see `markActive`).
      const refreshButton = document.createElement('button')
      refreshButton.type = 'button'
      refreshButton.textContent = REFRESH_GLYPH
      refreshButton.title = `${REFRESH_LABEL} ${tab.title}`
      refreshButton.setAttribute('aria-label', `${REFRESH_LABEL} ${tab.title}`)
      refreshButton.dataset.dshDesktopTabRefresh = tab.id
      refreshButton.hidden = tab.id !== activeId
      refreshButton.addEventListener('click', (event) => {
        event.stopPropagation()
        guard(refreshTab(tab.id), 'refresh')
      })
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
      slot.append(refreshButton, closeButton)
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
    add.addEventListener('click', () => {
      panel.toggle()
      // Host devices' online state changes while the panel is closed, so each
      // open refreshes the remote group; a failure is shown in the panel itself.
      if (!panel.isOpen()) return
      void refreshRemoteHosts().catch((error: unknown) => {
        panel.setRemoteError(message(error))
      })
    })
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

  /** Start a new connection attempt for a tab, invalidating its previous one. */
  function beginAttempt(id: string): number {
    attemptSeq += 1
    attempts.set(id, attemptSeq)
    return attemptSeq
  }

  /** Drop a tab's runtime state: in-flight attempt, retained guest, and its surface. */
  function forgetTab(id: string): void {
    // A tab's entry in `attempts` is the validity token of its pending `up`:
    // deleting it makes every result still on its way stale.
    attempts.delete(id)
    connecting.delete(id)
    refreshing.delete(id)
    view.unload(id)
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
      if (stopped || run !== attempts.get(id)) {
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
      if (stopped || run !== attempts.get(id)) return
      const status = list.find((entry) => entry.id === id)
      if (status?.log !== undefined) view.setLog(id, status.log)
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
        if (run === attempts.get(id) && status?.log !== undefined) view.setLog(id, status.log)
      })
      .catch(() => {})
  }

  /** The view target of a tab whose address is known. */
  function targetOf(tab: DesktopTab, url: string): RemoteTarget {
    return { account: account(tab), url, title: tab.title }
  }

  /** Reveal a tab: its retained guest, or a fresh connection when it has none. */
  async function activate(id: string | undefined): Promise<void> {
    const tab = tabs.find((candidate) => candidate.id === id)
    if (tab === undefined) return
    activeId = tab.id
    markActive()
    if (isLocalTab(tab)) {
      view.hide()
      return
    }
    view.activate(tab.id)
    if (tab.url !== undefined) {
      // An addressed tab is never reconnected: its retained guest is the tab.
      if (!view.hasGuest(tab.id)) view.show(tab.id, targetOf(tab, tab.url))
      return
    }
    // A tab that already has its guest, or is still connecting, only gets revealed.
    if (view.hasGuest(tab.id) || connecting.has(tab.id)) return
    await connectTab(tab)
  }

  /**
   * Connect one remote tab (SSH or WSL) and load it into a fresh guest.
   * @param refresh - tear the local channel down first, then reconnect.
   */
  async function connectTab(tab: DesktopTab, refresh = false): Promise<void> {
    const id = tab.id
    const run = beginAttempt(id)
    connecting.add(id)
    // The tab's placeholder replaces its guest before the attempt is made; the
    // log started below is the progress feedback.
    view.open(id, tab.title)
    let stopLog: () => void = () => {}
    try {
      if (refresh) {
        // `up` returns an established connection as-is, so a refresh must prove
        // the old tunnel is gone before asking for a new one. Tearing it down
        // first also drops the settled record whose log would end the poller
        // before the reconnect writes its own.
        await downConnection(id).catch((error: unknown) => {
          console.warn(`[dsh-desktop-tabs] could not bring connection '${id}' down before reconnecting:`, error)
        })
        if (attempts.get(id) !== run) return
      }
      stopLog = pollConnectionLog(id, run)
      const url = await upConnection(id)
      if (attempts.get(id) !== run) return
      stopLog()
      clearTabError(id)
      view.show(id, targetOf(tab, url))
    } catch (error: unknown) {
      if (attempts.get(id) !== run) return
      const text = message(error)
      stopLog()
      failTab(id, text)
      view.fail(id, `${tab.title} 连接失败：${text}`)
      reapLog(id, run)
    } finally {
      if (attempts.get(id) === run) connecting.delete(id)
    }
  }

  /** Reload the active tab: unload its content and re-establish its connection. */
  async function refreshTab(id: string): Promise<void> {
    const tab = tabs.find((candidate) => candidate.id === id)
    if (tab === undefined || isLocalTab(tab)) return
    // A connection in flight is already resetting the tab; let it settle instead
    // of aborting it (an aborted attempt tears down the remote session it made).
    if (refreshing.has(id) || connecting.has(id)) return
    refreshing.add(id)
    try {
      clearTabError(id)
      if (tab.url !== undefined) {
        // No connection behind an addressed tab: unloading and loading the same
        // address again is the whole refresh.
        view.show(id, targetOf(tab, tab.url))
        return
      }
      await connectTab(tab, true)
    } finally {
      refreshing.delete(id)
    }
  }

  /** Remove one tab, persist the list, and bring its connection down. */
  async function closeTab(id: string): Promise<void> {
    const tab = tabs.find((candidate) => candidate.id === id)
    if (tab === undefined || isLocalTab(tab)) return
    forgetTab(id)
    tabs = tabs.filter((candidate) => candidate.id !== id)
    render()
    if (activeId === id) {
      activeId = undefined
      guard(activate(tabs[0]?.id), 'switch')
    }
    if (tab.ssh !== undefined || tab.wsl !== undefined || tab.remote !== undefined) {
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
    if (connection.remote === undefined && isRemoteConnection(connection)) {
      // A remote row without its device/workspace descriptor cannot open a tab;
      // report it instead of turning it into the local view.
      throw new Error('远程连接缺少目标信息，请删除后重新添加')
    }
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
    // A remote-tab connection has no editable settings in v1: its device and
    // workspace are fixed, so the panel offers delete (and add again) only.
    if (isRemoteConnection(connection)) return
    config.open({
      id: connection.id,
      kind: connection.type,
      title: connection.title,
      ...(connection.ssh === undefined ? {} : { ssh: connection.ssh }),
      ...(connection.wsl === undefined ? {} : { wsl: connection.wsl }),
      account: connection.account ?? '',
      workdir: connection.workdir ?? '',
      startCommand: connection.startCommand ?? '',
    })
    placeConfig()
  }

  /** Configure a new connection for one SSH host alias. */
  function pickHost(host: SshHost): void {
    config.open({
      kind: 'ssh',
      title: host.alias,
      ssh: sshOfAlias(host.alias),
      account: '',
      workdir: '',
      startCommand: '',
    })
    placeConfig()
  }

  /** Configure a new connection for one WSL distribution. */
  function pickWslHost(host: WslHost): void {
    config.open({
      kind: 'wsl',
      title: host.name,
      wsl: wslOfDistro(host.name),
      account: '',
      workdir: '',
      startCommand: '',
    })
    placeConfig()
  }

  /** Expand one remote host in the panel: discover its workspaces. */
  async function loadRemoteWorkspaces(host: RemoteHost): Promise<readonly RemoteWorkspace[]> {
    const answer = await fetchRemoteWorkspaces(host.deviceId)
    // The panel shows a rejection in its status line; an answer that carries a
    // reason could not be discovered (no remote plugin, or the parent is in
    // remote mode) and is the same failure.
    if (answer.error !== undefined) throw new Error(answer.error)
    return answer.workspaces
  }

  /** Open one remote host workspace: save its connection, then open its tab. */
  async function openRemoteWorkspace(host: RemoteHost, workspace: RemoteWorkspace): Promise<void> {
    await upsertConnection(savedRemoteConnection(host, workspace))
  }

  /**
   * Reload the remote host list (the remote group's heading refresh, and each
   * panel open). A discovery failure rejects so the panel shows its reason.
   */
  async function refreshRemoteHosts(): Promise<void> {
    const answer = await fetchRemoteHosts()
    remoteHosts = answer.hosts
    panel.setRemoteHosts(remoteHosts)
    if (answer.error !== undefined) throw new Error(`远程主机不可用：${answer.error}`)
  }

  /** Save a connection draft and open — or reopen — its tab. */
  async function confirmConnection(draft: ConnectionDraft): Promise<void> {
    const id = draft.id ?? uniqueConnectionId(draft.kind, connectionStem(draft))
    await upsertConnection({
      id,
      title: draft.title,
      type: draft.kind,
      ...(draft.ssh === undefined ? {} : { ssh: draft.ssh }),
      ...(draft.wsl === undefined ? {} : { wsl: draft.wsl }),
      ...(draft.account.trim() === '' ? {} : { account: draft.account.trim() }),
      ...(draft.workdir.trim() === '' ? {} : { workdir: draft.workdir.trim() }),
      ...(draft.startCommand.trim() === '' ? {} : { startCommand: draft.startCommand.trim() }),
    })
  }

  /**
   * Save one connection (insert or replace) and open — or reopen — its tab.
   * Both the settings panel's confirm and the remote workspace pick land here.
   */
  async function upsertConnection(entry: SavedConnection): Promise<void> {
    const id = entry.id
    const known = connections.some((connection) => connection.id === id)
    connections = known ? connections.map((connection) => (connection.id === id ? entry : connection)) : [...connections, entry]
    const openTab = tabs.find((tab) => tab.id === id)
    if (openTab !== undefined) {
      tabs = tabs.map((tab) => (tab.id === id ? tabWithConnection(tab, entry) : tab))
      render()
      // The new settings live in the connection, which the host half reads when
      // the next `up` arrives: drop the old session, persist, then reconnect.
      await downConnection(id).catch((error: unknown) => {
        console.warn(`[dsh-desktop-tabs] could not bring connection '${id}' down:`, error)
      })
      await persist()
      panel.close()
      forgetTab(id)
      guard(activate(id), 'switch')
      return
    }
    tabs = [...tabs, tabOfConnection(entry)]
    render()
    // Persist before connecting: the host half reads this tab's connection
    // descriptor from the config file when `up` arrives.
    await persist()
    panel.close()
    guard(activate(id), 'switch')
  }

  /** Delete a saved connection, closing its tab when it is open. */
  async function deleteConnection(connection: SavedConnection): Promise<void> {
    connections = connections.filter((candidate) => candidate.id !== connection.id)
    const openTab = tabs.find((tab) => tab.id === connection.id)
    if (openTab !== undefined) {
      forgetTab(connection.id)
      tabs = tabs.filter((tab) => tab.id !== connection.id)
      render()
      if (activeId === connection.id) {
        activeId = undefined
        guard(activate(tabs[0]?.id), 'switch')
      }
    } else {
      render()
    }
    if (isRemoteConnection(connection)) {
      // Forget, not just down: the host half stops the child Harness, revokes its
      // client device, and removes its home. The config file still holds the row
      // at this point, which is how the host half resolves the connection by id.
      await forgetConnection(connection.id).catch((error: unknown) => {
        console.warn(`[dsh-desktop-tabs] could not forget remote connection '${connection.id}':`, error)
      })
    } else if (openTab !== undefined) {
      // Bring the session down while the file still holds the descriptor.
      await downConnection(connection.id).catch((error: unknown) => {
        console.warn(`[dsh-desktop-tabs] could not bring connection '${connection.id}' down:`, error)
      })
    }
    await persist()
  }

  /**
   * Read the stored tabs and connections, then the SSH, WSL, and remote host
   * lists side by side. Every host list is a convenience: any of them may be
   * unavailable on its own and must not take the others down.
   */
  async function load(): Promise<void> {
    // Start every list at once: the strip appears as soon as the stored tabs
    // arrive, while discovery keeps running in parallel.
    const snapshotPromise = fetchTabs().catch((error: unknown) => {
      console.warn('[dsh-desktop-tabs] could not read tab targets:', error)
      return undefined
    })
    const sshPromise = fetchSshHosts().catch(() => [] as SshHost[])
    const wslPromise = fetchWslHosts().catch(() => [] as WslHost[])
    const remotePromise = fetchRemoteHosts().catch((error: unknown) => ({
      hosts: [] as RemoteHost[],
      error: message(error),
    }))
    const snapshot = await snapshotPromise
    tabs = normalize(snapshot?.tabs ?? [])
    connections = [...(snapshot?.connections ?? [])]
    render()
    guard(activate(tabs[0]?.id), 'switch')
    const [ssh, wsl, remote] = await Promise.all([sshPromise, wslPromise, remotePromise])
    hosts = ssh
    wslHosts = wsl
    remoteHosts = remote.hosts
    panel.setSshHosts(hosts)
    panel.setWslHosts(wslHosts)
    panel.setRemoteHosts(remoteHosts)
    if (remote.error !== undefined) panel.setRemoteError(`远程主机不可用：${remote.error}`)
  }

  /** Store both persisted lists. */
  async function persist(): Promise<void> {
    await putTabs({ tabs, connections })
  }

  /**
   * @returns a free connection id for one host name, preferring the readable
   * `ssh-<alias>` / `wsl-<distribution>` form.
   */
  function uniqueConnectionId(kind: string, name: string): string {
    const taken = (candidate: string): boolean =>
      connections.some((connection) => connection.id === candidate) || tabs.some((tab) => tab.id === candidate)
    const prefix = connectionTypeIdPrefix(kind)
    const stem = name === '' ? prefix : `${prefix}-${name}`
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
    ...(connection.wsl === undefined ? {} : { wsl: connection.wsl }),
    ...(connection.remote === undefined ? {} : { remote: connection.remote }),
  }
}

/**
 * Re-point an open tab at a saved connection's current settings: the connection
 * owns the title and the channel descriptor, while an address already loaded
 * into the tab (`url`) is kept.
 * @param tab - the open tab.
 * @param connection - the saved connection it was opened from.
 * @returns the tab with the connection's settings.
 */
function tabWithConnection(tab: DesktopTab, connection: SavedConnection): DesktopTab {
  return {
    id: tab.id,
    title: connection.title,
    ...(tab.url === undefined ? {} : { url: tab.url }),
    ...(connection.ssh === undefined ? {} : { ssh: connection.ssh }),
    ...(connection.wsl === undefined ? {} : { wsl: connection.wsl }),
    ...(connection.remote === undefined ? {} : { remote: connection.remote }),
  }
}

/** @returns the id prefix for a connection kind: `ssh`, `wsl`, or the kind itself. */
function connectionTypeIdPrefix(kind: string): string {
  const normalized = kind.trim().toLowerCase()
  return normalized === '' ? 'connection' : normalized
}

/**
 * @returns the host name a draft connects to — the SSH alias, the WSL
 * distribution, or the title when a descriptor names neither.
 */
function connectionStem(draft: ConnectionDraft): string {
  return hostOfWsl(draft.wsl) ?? hostOfSsh(draft.ssh) ?? draft.title.trim()
}

/**
 * Guarantee exactly one local tab, always first: the first entry that is neither
 * an addressed tab nor a remote (SSH/WSL) tab keeps its id and title, and a list
 * with no such entry gets the default local view prepended.
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
