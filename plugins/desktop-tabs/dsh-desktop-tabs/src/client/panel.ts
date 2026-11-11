/**
 * The `+` panel: saved connections, the SSH hosts the user's `~/.ssh/config`
 * declares, and the WSL distributions `wsl.exe` reports — all filtered by one
 * search box and foldable per group.
 *
 * The panel owns only its DOM, its search text, and its fold state; every action
 * is a callback into the strip, which owns the tab and connection lists. A
 * rejected callback leaves the panel open with the reason shown, so a failed
 * save is never silent. Both host lists are display data: when the host half
 * cannot provide one, that group is simply empty without taking the other down.
 */

import { connectionTypeLabel, hostOfSsh, hostOfWsl, type SavedConnection, type SshHost, type WslHost } from './types.ts'

/** Marks the panel element. */
export const PANEL_ATTR = 'data-dsh-desktop-tabs-panel'

/** The three foldable groups; `configured` holds every saved connection. */
type GroupName = 'configured' | 'ssh-hosts' | 'wsl-hosts'

/** The actions the panel forwards to the strip. */
export interface PanelHandlers {
  /** Open (or activate) the tab of a saved connection; a rejection is shown in the panel. */
  onOpenConnection(connection: SavedConnection): Promise<void>
  /** Edit a saved connection's settings in the config panel. */
  onEditConnection(connection: SavedConnection): void
  /** Delete a saved connection, closing its tab when open; a rejection is shown in the panel. */
  onDeleteConnection(connection: SavedConnection): Promise<void>
  /** Configure a new connection for one SSH host alias. */
  onPickHost(host: SshHost): void
  /** Configure a new connection for one WSL distribution. */
  onPickWslHost(host: WslHost): void
}

/** The panel element and its transitions. */
export interface Panel {
  /** The panel to append to the document. */
  readonly element: HTMLElement
  /** @returns whether the panel is currently shown. */
  isOpen(): boolean
  /** Open the panel, re-showing any message that could not be displayed while it was closed. */
  open(): void
  /** Close the panel; a pending message is kept for the next open. */
  close(): void
  /** Open a closed panel, close an open one. */
  toggle(): void
  /** Render the saved connections. */
  setConnections(connections: readonly SavedConnection[]): void
  /** Render the SSH host aliases the host half reports. */
  setSshHosts(hosts: readonly SshHost[]): void
  /** Render the WSL distributions the host half reports. */
  setWslHosts(hosts: readonly WslHost[]): void
  /** Report a failure; visible immediately while open, kept for the next open otherwise. */
  fail(message: string): void
  /** Detach the panel and its listeners. */
  dispose(): void
}

/** Search placeholder; the box filters every group. */
const SEARCH_PLACEHOLDER = '搜索连接、SSH 或 WSL 主机'

/** Group headings and the arrows a fold toggles between. */
const GROUP_LABEL: Record<GroupName, string> = {
  configured: '已配置',
  'ssh-hosts': 'SSH 主机',
  'wsl-hosts': 'WSL 主机',
}
const EXPANDED = '▾'
const COLLAPSED = '▸'

/** Empty-state hints, split by whether a search is narrowing the group. */
const EMPTY_FILTERED = '没有匹配项'
const EMPTY_ALL: Record<GroupName, string> = {
  configured: '没有已保存的连接',
  'ssh-hosts': '没有可用的 SSH 主机',
  'wsl-hosts': '没有可用的 WSL 发行版',
}

/** Row action labels (Chinese, shown in `title`/`aria-label`) and their glyphs. */
const EDIT_LABEL = '编辑'
const DELETE_LABEL = '删除'
const EDIT_GLYPH = '✎'
const DELETE_GLYPH = '✕'

/** Panel close button label. */
const CLOSE_LABEL = '关闭'

/**
 * Create the panel.
 * @param handlers - the strip's connection operations.
 * @returns the panel element and its transitions.
 */
export function createPanel(handlers: PanelHandlers): Panel {
  const element = document.createElement('div')
  element.setAttribute(PANEL_ATTR, '')
  element.hidden = true

  const status = document.createElement('p')
  status.setAttribute('data-dsh-desktop-tabs-panel-status', '')
  status.hidden = true

  const search = document.createElement('input')
  search.type = 'search'
  search.spellcheck = false
  search.placeholder = SEARCH_PLACEHOLDER
  search.setAttribute('data-dsh-desktop-tabs-search', '')
  search.setAttribute('aria-label', SEARCH_PLACEHOLDER)

  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.textContent = '×'
  closeButton.title = CLOSE_LABEL
  closeButton.setAttribute('aria-label', CLOSE_LABEL)
  closeButton.setAttribute('data-dsh-desktop-tabs-panel-close', '')

  const groups: Record<GroupName, { readonly root: HTMLElement; readonly toggle: HTMLButtonElement; readonly body: HTMLElement }> = {
    configured: createGroup('configured'),
    'ssh-hosts': createGroup('ssh-hosts'),
    'wsl-hosts': createGroup('wsl-hosts'),
  }

  element.append(
    status,
    search,
    groups.configured.root,
    groups['ssh-hosts'].root,
    groups['wsl-hosts'].root,
    closeButton,
  )

  let open = false
  /** A message produced while the panel was closed. */
  let pending: string | undefined
  let connections: readonly SavedConnection[] = []
  let hosts: readonly SshHost[] = []
  let wslHosts: readonly WslHost[] = []
  const collapsed: Record<GroupName, boolean> = { configured: false, 'ssh-hosts': false, 'wsl-hosts': false }

  const showStatus = (text: string | undefined): void => {
    status.textContent = text ?? ''
    status.hidden = text === undefined
  }

  const renderGroup = (name: GroupName, rows: readonly HTMLElement[], total: number): void => {
    const group = groups[name]
    group.toggle.textContent = ''
    const arrow = document.createElement('span')
    arrow.setAttribute('data-dsh-desktop-tabs-section-arrow', '')
    arrow.textContent = collapsed[name] ? COLLAPSED : EXPANDED
    const label = document.createElement('span')
    label.textContent = `${GROUP_LABEL[name]} (${rows.length}${rows.length === total ? '' : `/${total}`})`
    group.toggle.append(arrow, label)
    group.toggle.setAttribute('aria-expanded', String(!collapsed[name]))
    group.body.hidden = collapsed[name]
    if (collapsed[name]) return
    if (rows.length > 0) {
      group.body.replaceChildren(...rows)
      return
    }
    const hint = document.createElement('p')
    hint.setAttribute('data-dsh-desktop-tabs-empty', '')
    hint.textContent = search.value.trim() === '' ? EMPTY_ALL[name] : EMPTY_FILTERED
    group.body.replaceChildren(hint)
  }

  const render = (): void => {
    renderGroup('configured', connections.filter(matchesConnection).map(connectionRow), connections.length)
    renderGroup('ssh-hosts', hosts.filter(matchesHost).map(hostRow), hosts.length)
    renderGroup('wsl-hosts', wslHosts.filter(matchesWslHost).map(wslHostRow), wslHosts.length)
  }

  const matchesConnection = (connection: SavedConnection): boolean =>
    matches(
      search.value,
      connectionLabel(connection),
      connectionTypeLabel(connection.type),
      connection.title,
      connection.id,
      hostOfSsh(connection.ssh),
      hostOfWsl(connection.wsl),
      connection.account,
    )

  const matchesHost = (host: SshHost): boolean =>
    matches(search.value, 'SSH', host.alias, host.hostName, host.user)

  const matchesWslHost = (host: WslHost): boolean =>
    matches(search.value, 'WSL', host.name, host.state, host.version === undefined ? undefined : String(host.version))

  const connectionRow = (connection: SavedConnection): HTMLElement => {
    const row = document.createElement('div')
    row.setAttribute('data-dsh-desktop-tabs-connection', connection.id)

    const label = document.createElement('button')
    label.type = 'button'
    // The kind prefix is what tells an `ssh-archlinux` connection from the
    // `wsl-archlinux` one beside it, so it leads the visible text.
    label.textContent = connectionLabel(connection)
    label.title = describeConnection(connection)
    label.setAttribute('data-dsh-desktop-tabs-connection-open', connection.id)
    label.addEventListener('click', () => { void run(() => handlers.onOpenConnection(connection)) })

    const actions = document.createElement('span')
    actions.setAttribute('data-dsh-desktop-tabs-row-actions', '')
    const edit = actionButton(EDIT_LABEL, EDIT_GLYPH, 'data-dsh-desktop-tabs-connection-edit', connection.id)
    edit.addEventListener('click', (event) => {
      event.stopPropagation()
      handlers.onEditConnection(connection)
    })
    const remove = actionButton(DELETE_LABEL, DELETE_GLYPH, 'data-dsh-desktop-tabs-connection-delete', connection.id)
    remove.addEventListener('click', (event) => {
      event.stopPropagation()
      void run(() => handlers.onDeleteConnection(connection))
    })
    actions.append(edit, remove)

    row.append(label, actions)
    return row
  }

  const hostRow = (host: SshHost): HTMLElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = host.alias
    button.title = describeHost(host)
    button.setAttribute('data-dsh-desktop-tabs-ssh-host', host.alias)
    button.addEventListener('click', () => { handlers.onPickHost(host) })
    return button
  }

  const wslHostRow = (host: WslHost): HTMLElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = host.name
    button.title = describeWslHost(host)
    button.setAttribute('data-dsh-desktop-tabs-wsl-host', host.name)
    button.addEventListener('click', () => { handlers.onPickWslHost(host) })
    return button
  }

  /**
   * Run one panel action; success closes the panel, a rejection stays visible.
   *
   * Closing goes through this module's own function, never the unqualified
   * `close` name: in a browser that name is `window.close`, and calling it from
   * the desktop shell's own application window tears the whole window — and with
   * it the embedded Host — down.
   */
  const run = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action()
    } catch (error: unknown) {
      pending = error instanceof Error ? error.message : String(error)
      showStatus(pending)
      return
    }
    pending = undefined
    showStatus(undefined)
    closePanel()
  }

  const onEscape = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closePanel()
  }

  const closePanel = (): void => {
    open = false
    element.hidden = true
    document.removeEventListener('keydown', onEscape, true)
  }

  search.addEventListener('input', render)
  closeButton.addEventListener('click', closePanel)
  for (const name of ['configured', 'ssh-hosts', 'wsl-hosts'] as const) {
    groups[name].toggle.addEventListener('click', () => {
      collapsed[name] = !collapsed[name]
      render()
    })
  }

  return {
    element,
    isOpen: () => open,
    open: () => {
      open = true
      element.hidden = false
      showStatus(pending)
      document.addEventListener('keydown', onEscape, true)
      render()
      search.focus()
    },
    close: closePanel,
    toggle: () => { if (open) closePanel(); else { open = true; element.hidden = false; showStatus(pending); document.addEventListener('keydown', onEscape, true); render(); search.focus() } },
    setConnections: (next) => { connections = next; render() },
    setSshHosts: (next) => { hosts = next; render() },
    setWslHosts: (next) => { wslHosts = next; render() },
    fail: (message) => {
      pending = message
      showStatus(message)
    },
    dispose: () => {
      document.removeEventListener('keydown', onEscape, true)
      element.remove()
    },
  }
}

/** One foldable group: heading button plus body. */
function createGroup(name: GroupName): { readonly root: HTMLElement; readonly toggle: HTMLButtonElement; readonly body: HTMLElement } {
  const root = document.createElement('div')
  root.setAttribute('data-dsh-desktop-tabs-section', name)
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.setAttribute('data-dsh-desktop-tabs-section-toggle', name)
  const body = document.createElement('div')
  body.setAttribute('data-dsh-desktop-tabs-section-body', name)
  root.append(toggle, body)
  return { root, toggle, body }
}

/**
 * A row action button: the glyph is the visible label, the Chinese action name
 * rides in `title` and `aria-label`.
 */
function actionButton(label: string, glyph: string, attr: string, id: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = glyph
  button.title = label
  button.setAttribute(attr, id)
  button.setAttribute('aria-label', `${label} ${id}`)
  return button
}

/**
 * Fuzzy match for the search box: case-insensitive subsequence over the given
 * fields, so `wls` still finds `WSL` and `orin` finds `jetson-orin-dev`.
 */
function matches(query: string, ...fields: readonly (string | undefined)[]): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return fields.some((field) => field !== undefined && containsSubsequence(needle, field.toLowerCase()))
}

/** @returns whether every character of `needle` appears in `haystack`, in order. */
function containsSubsequence(needle: string, haystack: string): boolean {
  let index = 0
  for (const character of haystack) {
    if (character !== needle[index]) continue
    index += 1
    if (index === needle.length) return true
  }
  return false
}

/** @returns a one-line description of an SSH host entry. */
function describeHost(host: SshHost): string {
  const destination = host.hostName ?? host.alias
  const withUser = host.user === undefined ? destination : `${host.user}@${destination}`
  return host.port === undefined ? withUser : `${withUser}:${host.port}`
}

/** @returns a connection row's visible text: its kind prefix and its title. */
function connectionLabel(connection: SavedConnection): string {
  return `${connectionTypeLabel(connection.type)} - ${connection.title}`
}

/**
 * @returns the hover text of a connection row: the kind, the title, and the
 * channel detail (SSH host or WSL distribution) with the account when one is set.
 */
function describeConnection(connection: SavedConnection): string {
  const parts: string[] = []
  if (connection.type.toLowerCase() === 'wsl') {
    const distro = hostOfWsl(connection.wsl)
    if (distro !== undefined) parts.push(`发行版 ${distro}`)
  } else {
    const host = hostOfSsh(connection.ssh)
    if (host !== undefined) parts.push(`主机 ${host}`)
  }
  if (connection.account !== undefined) parts.push(`账号 ${connection.account}`)
  return parts.length === 0 ? connectionLabel(connection) : `${connectionLabel(connection)}（${parts.join('，')}）`
}

/** Chinese names for the states `wsl.exe -l -v` reports. */
const WSL_STATE_LABEL: Readonly<Record<string, string>> = {
  running: '运行中',
  stopped: '已停止',
  installing: '安装中',
  uninstalling: '卸载中',
  converting: '转换中',
  upgrading: '升级中',
  starting: '启动中',
}

/**
 * @returns a one-line description of a WSL distribution, e.g.
 * `WSL 发行版 archlinux（运行中，版本 2，默认）`.
 */
function describeWslHost(host: WslHost): string {
  const parts: string[] = []
  const state = host.state === undefined ? undefined : WSL_STATE_LABEL[host.state.toLowerCase()] ?? host.state
  if (state !== undefined) parts.push(state)
  if (host.version !== undefined) parts.push(`版本 ${host.version}`)
  if (host.default === true) parts.push('默认')
  return parts.length === 0 ? `WSL 发行版 ${host.name}` : `WSL 发行版 ${host.name}（${parts.join('，')}）`
}
