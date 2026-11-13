/**
 * The `+` panel, as a dependency-free DOM factory shared by both shells.
 *
 * Saved connections, the SSH hosts the user's `~/.ssh/config` declares, and the
 * WSL distributions `wsl.exe` reports — all filtered by one search box and
 * foldable per group. The panel owns only its DOM, its search text, and its fold
 * state; every action is a callback into the caller, which owns the tab and
 * connection lists. A rejected callback leaves the panel open with the reason
 * shown, so a failed save is never silent. Both host lists are display data:
 * when the host half cannot provide one, that group is simply empty without
 * taking the other down.
 *
 * This file must stay import-free plain ESM: the desktop shell bundles it into
 * its browser half, and the Tauri shell copies it verbatim into `src-tauri/ui/`
 * and mounts the factory on `window.__dshRemoteUi`. It only uses standard DOM
 * APIs, so both shells run the same control.
 *
 * @typedef {object} SavedConnection
 * @property {string} id
 * @property {string} title
 * @property {string} [type] Connection kind: `ssh` or `wsl`; a missing kind reads as `ssh`.
 * @property {unknown} [ssh]
 * @property {unknown} [wsl]
 * @property {string} [account] Login account, when one was configured.
 * @property {string} [workdir]
 * @property {string} [startCommand]
 *
 * @typedef {object} SshHost
 * @property {string} alias
 * @property {string} [hostName]
 * @property {string} [user]
 * @property {number} [port]
 *
 * @typedef {object} WslHost
 * @property {string} name
 * @property {string} [state]
 * @property {number} [version]
 * @property {boolean} [default]
 *
 * @typedef {object} ConnectionListHandlers
 * @property {(connection: SavedConnection) => Promise<void> | void} onOpen
 *   Open (or activate) a saved connection; a rejection is shown in the panel.
 * @property {(connection: SavedConnection) => void} onEdit
 *   Edit a saved connection's settings in the settings panel.
 * @property {(connection: SavedConnection) => Promise<void> | void} onDelete
 *   Delete a saved connection; a rejection is shown in the panel.
 * @property {(host: SshHost) => void} onPickHost
 *   Configure a new connection for one SSH host alias.
 * @property {(host: WslHost) => void} onPickWslHost
 *   Configure a new connection for one WSL distribution.
 *
 * @typedef {object} ConnectionList
 * @property {HTMLElement} element The panel to append to the document.
 * @property {() => boolean} isOpen Whether the panel is currently shown.
 * @property {() => void} open Open the panel, re-showing a message kept while closed.
 * @property {() => void} close Close the panel; a pending message is kept for the next open.
 * @property {() => void} toggle Open a closed panel, close an open one.
 * @property {(connections: readonly SavedConnection[]) => void} setConnections
 * @property {(hosts: readonly SshHost[]) => void} setSshHosts
 * @property {(hosts: readonly WslHost[]) => void} setWslHosts
 * @property {(message: string) => void} fail Report a failure.
 * @property {() => void} dispose Detach the panel and its listeners.
 */

/** Marks the panel element. */
export const CONNECTION_LIST_ATTR = 'data-dsh-desktop-tabs-panel'

/** The three foldable groups; `configured` holds every saved connection. */
const GROUP_NAMES = ['configured', 'ssh-hosts', 'wsl-hosts']

/** Search placeholder; the box filters every group. */
const SEARCH_PLACEHOLDER = '搜索连接、SSH 或 WSL 主机'

/** Group headings and the arrows a fold toggles between. */
const GROUP_LABEL = { configured: '已配置', 'ssh-hosts': 'SSH 主机', 'wsl-hosts': 'WSL 主机' }
const EXPANDED = '▾'
const COLLAPSED = '▸'

/** Empty-state hints, split by whether a search is narrowing the group. */
const EMPTY_FILTERED = '没有匹配项'
const EMPTY_ALL = {
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

/** Chinese names for the states `wsl.exe -l -v` reports. */
const WSL_STATE_LABEL = {
  running: '运行中',
  stopped: '已停止',
  installing: '安装中',
  uninstalling: '卸载中',
  converting: '转换中',
  upgrading: '升级中',
  starting: '启动中',
}

/**
 * Create the panel.
 * @param {ConnectionListHandlers} handlers - the caller's connection operations.
 * @returns {ConnectionList} the panel element and its transitions.
 */
export function createConnectionList(handlers) {
  const element = document.createElement('div')
  element.setAttribute(CONNECTION_LIST_ATTR, '')
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

  const groups = {
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
  let pending
  let connections = []
  let hosts = []
  let wslHosts = []
  const collapsed = { configured: false, 'ssh-hosts': false, 'wsl-hosts': false }

  const showStatus = (text) => {
    status.textContent = text ?? ''
    status.hidden = text === undefined
  }

  const renderGroup = (name, rows, total) => {
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

  const render = () => {
    renderGroup('configured', connections.filter(matchesConnection).map(connectionRow), connections.length)
    renderGroup('ssh-hosts', hosts.filter(matchesHost).map(hostRow), hosts.length)
    renderGroup('wsl-hosts', wslHosts.filter(matchesWslHost).map(wslHostRow), wslHosts.length)
  }

  const matchesConnection = (connection) => matches(
    search.value,
    connectionLabel(connection),
    connectionTypeLabel(connection.type),
    connection.title,
    connection.id,
    hostOfSsh(connection.ssh),
    hostOfWsl(connection.wsl),
    connection.account,
  )

  const matchesHost = (host) => matches(search.value, 'SSH', host.alias, host.hostName, host.user)

  const matchesWslHost = (host) => matches(
    search.value,
    'WSL',
    host.name,
    host.state,
    host.version === undefined ? undefined : String(host.version),
  )

  const connectionRow = (connection) => {
    const row = document.createElement('div')
    row.setAttribute('data-dsh-desktop-tabs-connection', connection.id)

    const label = document.createElement('button')
    label.type = 'button'
    // The kind prefix is what tells an `ssh-archlinux` connection from the
    // `wsl-archlinux` one beside it, so it leads the visible text.
    label.textContent = connectionLabel(connection)
    label.title = describeConnection(connection)
    label.setAttribute('data-dsh-desktop-tabs-connection-open', connection.id)
    label.addEventListener('click', () => { void run(() => handlers.onOpen(connection)) })

    const actions = document.createElement('span')
    actions.setAttribute('data-dsh-desktop-tabs-row-actions', '')
    const edit = actionButton(EDIT_LABEL, EDIT_GLYPH, 'data-dsh-desktop-tabs-connection-edit', connection.id)
    edit.addEventListener('click', (event) => {
      event.stopPropagation()
      handlers.onEdit(connection)
    })
    const remove = actionButton(DELETE_LABEL, DELETE_GLYPH, 'data-dsh-desktop-tabs-connection-delete', connection.id)
    remove.addEventListener('click', (event) => {
      event.stopPropagation()
      void run(() => handlers.onDelete(connection))
    })
    actions.append(edit, remove)

    row.append(label, actions)
    return row
  }

  const hostRow = (host) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = host.alias
    button.title = describeHost(host)
    button.setAttribute('data-dsh-desktop-tabs-ssh-host', host.alias)
    button.addEventListener('click', () => { handlers.onPickHost(host) })
    return button
  }

  const wslHostRow = (host) => {
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
  const run = async (action) => {
    try {
      await action()
    } catch (error) {
      pending = error instanceof Error ? error.message : String(error)
      showStatus(pending)
      return
    }
    pending = undefined
    showStatus(undefined)
    closePanel()
  }

  const onEscape = (event) => {
    if (event.key === 'Escape') closePanel()
  }

  const closePanel = () => {
    open = false
    element.hidden = true
    document.removeEventListener('keydown', onEscape, true)
  }

  const openPanel = () => {
    open = true
    element.hidden = false
    showStatus(pending)
    document.addEventListener('keydown', onEscape, true)
    render()
    search.focus()
  }

  search.addEventListener('input', render)
  closeButton.addEventListener('click', closePanel)
  for (const name of GROUP_NAMES) {
    groups[name].toggle.addEventListener('click', () => {
      collapsed[name] = !collapsed[name]
      render()
    })
  }

  return {
    element,
    isOpen: () => open,
    open: openPanel,
    close: closePanel,
    toggle: () => { if (open) closePanel(); else openPanel() },
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
function createGroup(name) {
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
function actionButton(label, glyph, attr, id) {
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
function matches(query, ...fields) {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return fields.some((field) => field !== undefined && containsSubsequence(needle, field.toLowerCase()))
}

/** @returns whether every character of `needle` appears in `haystack`, in order. */
function containsSubsequence(needle, haystack) {
  let index = 0
  for (const character of haystack) {
    if (character !== needle[index]) continue
    index += 1
    if (index === needle.length) return true
  }
  return false
}

/**
 * @returns the upper-case label of a connection kind: `SSH`, `WSL`, or the kind
 * itself upper-cased. A record without a kind is an SSH connection.
 */
function connectionTypeLabel(type) {
  const normalized = typeof type === 'string' ? type.trim() : ''
  if (normalized === '' || normalized.toLowerCase() === 'ssh') return 'SSH'
  if (normalized.toLowerCase() === 'wsl') return 'WSL'
  return normalized.toUpperCase()
}

/** @returns a connection row's visible text: its kind prefix and its title. */
function connectionLabel(connection) {
  return `${connectionTypeLabel(connection.type)} - ${connection.title}`
}

/**
 * @returns the hover text of a connection row: the kind, the title, and the
 * channel detail (SSH host or WSL distribution) with the account when one is set.
 */
function describeConnection(connection) {
  const parts = []
  if (typeof connection.type === 'string' && connection.type.toLowerCase() === 'wsl') {
    const distro = hostOfWsl(connection.wsl)
    if (distro !== undefined) parts.push(`发行版 ${distro}`)
  } else {
    const host = hostOfSsh(connection.ssh)
    if (host !== undefined) parts.push(`主机 ${host}`)
  }
  if (connection.account !== undefined) parts.push(`账号 ${connection.account}`)
  return parts.length === 0 ? connectionLabel(connection) : `${connectionLabel(connection)}（${parts.join('，')}）`
}

/** @returns the SSH host alias a connection describes, if any. */
function hostOfSsh(ssh) {
  if (typeof ssh !== 'object' || ssh === null) return undefined
  const host = ssh.host
  return typeof host === 'string' && host !== '' ? host : undefined
}

/** @returns the WSL distribution a connection describes, if any. */
function hostOfWsl(wsl) {
  if (typeof wsl !== 'object' || wsl === null) return undefined
  const distro = wsl.distro
  return typeof distro === 'string' && distro !== '' ? distro : undefined
}

/** @returns a one-line description of an SSH host entry. */
function describeHost(host) {
  const destination = host.hostName ?? host.alias
  const withUser = host.user === undefined ? destination : `${host.user}@${destination}`
  return host.port === undefined ? withUser : `${withUser}:${host.port}`
}

/**
 * @returns a one-line description of a WSL distribution, e.g.
 * `WSL 发行版 archlinux（运行中，版本 2，默认）`.
 */
function describeWslHost(host) {
  const parts = []
  const state = host.state === undefined ? undefined : WSL_STATE_LABEL[host.state.toLowerCase()] ?? host.state
  if (state !== undefined) parts.push(state)
  if (host.version !== undefined) parts.push(`版本 ${host.version}`)
  if (host.default === true) parts.push('默认')
  return parts.length === 0 ? `WSL 发行版 ${host.name}` : `WSL 发行版 ${host.name}（${parts.join('，')}）`
}
