/**
 * The `+` panel, as a dependency-free DOM factory shared by both shells.
 *
 * Saved connections, the SSH hosts the user's `~/.ssh/config` declares, the WSL
 * distributions `wsl.exe` reports, and the remote host devices ds-harness-remote
 * offers — all filtered by one search box and foldable per group. A remote host
 * expands into its workspaces on demand; picking one hands the host/workspace
 * pair to the caller, which persists it and opens a tab. The panel owns only its
 * DOM, its search text, its fold state, and the remote hosts' expansion state;
 * every action is a callback into the caller, which owns the tab and connection
 * lists. A rejected callback leaves the panel open with the reason shown, so a
 * failed save is never silent. Every host list is display data: when the host
 * half cannot provide one, that group is simply empty without taking the others
 * down.
 *
 * This file must stay import-free plain ESM: the desktop shell bundles it into
 * its browser half, and the Tauri shell copies it verbatim into `src-tauri/ui/`
 * and mounts the factory on `window.__dshRemoteUi`. It only uses standard DOM
 * APIs, so both shells run the same control. Remote callbacks are optional: the
 * Tauri shell predates the remote group and simply does not pass them.
 *
 * @typedef {object} RemoteConnection
 * @property {string} targetDeviceId
 * @property {string} [targetName]
 * @property {string} workspacePath
 * @property {string} [backend]
 *
 * @typedef {object} SavedConnection
 * @property {string} id
 * @property {string} title
 * @property {string} [type] Connection kind: `ssh`, `wsl`, or `remote`; a missing kind reads as `ssh`.
 * @property {unknown} [ssh]
 * @property {unknown} [wsl]
 * @property {RemoteConnection} [remote] Remote host device and workspace.
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
 * @typedef {object} RemoteHost
 * @property {string} deviceId
 * @property {string} name
 * @property {string} [platform]
 * @property {boolean} [online]
 * @property {string} [version]
 *
 * @typedef {object} RemoteWorkspace
 * @property {string} workspaceId
 * @property {string} path
 * @property {string} title
 * @property {string} [backend]
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
 * @property {(host: RemoteHost) => Promise<readonly RemoteWorkspace[] | void> | readonly RemoteWorkspace[] | void} [onRemoteHost]
 *   Load one remote host's workspaces when it is expanded; a rejection is shown
 *   in the panel.
 * @property {(host: RemoteHost, workspace: RemoteWorkspace) => Promise<void> | void} [onRemoteWorkspace]
 *   Open one remote workspace as a tab; a rejection is shown in the panel.
 * @property {() => Promise<void> | void} [onRefreshRemote]
 *   Reload the remote host list (the remote group's heading refresh); a rejection
 *   is shown in the panel.
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
 * @property {(hosts: readonly RemoteHost[]) => void} setRemoteHosts
 *   Replace the remote host list and reset its expansion state.
 * @property {(deviceId: string, workspaces: readonly RemoteWorkspace[]) => void} setRemoteWorkspaces
 *   Seed or update one host's workspaces without expanding it.
 * @property {(message: string) => void} setRemoteError
 *   Report a remote discovery failure in the panel's status line.
 * @property {(message: string) => void} fail Report a failure.
 * @property {() => void} dispose Detach the panel and its listeners.
 */

/** Marks the panel element. */
export const CONNECTION_LIST_ATTR = 'data-dsh-desktop-tabs-panel'

/** The four foldable groups; `configured` holds every saved connection. */
const GROUP_NAMES = ['configured', 'ssh-hosts', 'wsl-hosts', 'remote-hosts']

/** Search placeholder; the box filters every group. */
const SEARCH_PLACEHOLDER = '搜索连接、SSH 或 WSL 主机'

/** Group headings and the arrows a fold toggles between. */
const GROUP_LABEL = { configured: '已配置', 'ssh-hosts': 'SSH 主机', 'wsl-hosts': 'WSL 主机', 'remote-hosts': '远程主机' }
const EXPANDED = '▾'
const COLLAPSED = '▸'

/** Empty-state hints, split by whether a search is narrowing the group. */
const EMPTY_FILTERED = '没有匹配项'
const EMPTY_ALL = {
  configured: '没有已保存的连接',
  'ssh-hosts': '没有可用的 SSH 主机',
  'wsl-hosts': '没有可用的 WSL 发行版',
  'remote-hosts': '没有可用的远程主机',
}

/** Row action labels (Chinese, shown in `title`/`aria-label`) and their glyphs. */
const EDIT_LABEL = '编辑'
const DELETE_LABEL = '删除'
const EDIT_GLYPH = '✎'
const DELETE_GLYPH = '✕'

/** Remote group heading refresh control. */
const REMOTE_REFRESH_LABEL = '刷新远程主机'
const REMOTE_REFRESH_GLYPH = '⟳'

/** Remote host/workspace expansion copy. */
const REMOTE_LOADING = '正在读取工作区…'
const REMOTE_NO_WORKSPACE = '该主机没有工作区'
const REMOTE_DEVICE_PREFIX = '设备'
const REMOTE_WORKSPACE_PREFIX = '工作区'
const REMOTE_ONLINE = '在线'
const REMOTE_OFFLINE = '离线'

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
    'remote-hosts': createGroup('remote-hosts'),
  }

  const remoteRefresh = document.createElement('button')
  remoteRefresh.type = 'button'
  remoteRefresh.textContent = REMOTE_REFRESH_GLYPH
  remoteRefresh.title = REMOTE_REFRESH_LABEL
  remoteRefresh.setAttribute('aria-label', REMOTE_REFRESH_LABEL)
  remoteRefresh.setAttribute('data-dsh-desktop-tabs-remote-refresh', '')
  groups['remote-hosts'].header.append(remoteRefresh)

  element.append(
    status,
    search,
    groups.configured.root,
    groups['ssh-hosts'].root,
    groups['wsl-hosts'].root,
    groups['remote-hosts'].root,
    closeButton,
  )

  let open = false
  /** A message produced while the panel was closed. */
  let pending
  let connections = []
  let hosts = []
  let wslHosts = []
  let remoteHosts = []
  /** Workspaces per remote host device id, once loaded. */
  const workspacesByHost = new Map()
  /** Remote host device ids whose workspace list is expanded. */
  const expandedRemote = new Set()
  /** Remote host device ids whose workspace list is being loaded. */
  const loadingRemote = new Set()
  const collapsed = { configured: false, 'ssh-hosts': false, 'wsl-hosts': false, 'remote-hosts': false }

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
    renderRemoteGroup()
  }

  /**
   * Render the remote group: one row per visible host, its workspaces beneath an
   * expanded host. A search narrows both levels, and a matching workspace reveals
   * its host even when the host's own name does not match.
   */
  const renderRemoteGroup = () => {
    const rows = []
    const query = search.value.trim()
    for (const host of remoteHosts) {
      const workspaces = workspacesByHost.get(host.deviceId) ?? []
      const matchingWorkspaces = workspaces.filter(matchesRemoteWorkspace)
      const hostMatches = matchesRemoteHost(host)
      if (query !== '' && !hostMatches && matchingWorkspaces.length === 0) continue
      const expanded = expandedRemote.has(host.deviceId) || (query !== '' && matchingWorkspaces.length > 0)
      rows.push(remoteHostRow(host, expanded))
      if (!expanded) continue
      if (loadingRemote.has(host.deviceId)) {
        rows.push(remoteHint(REMOTE_LOADING))
        continue
      }
      if (workspaces.length === 0) {
        rows.push(remoteHint(REMOTE_NO_WORKSPACE))
        continue
      }
      const visible = query === '' || hostMatches ? workspaces : matchingWorkspaces
      for (const workspace of visible) rows.push(remoteWorkspaceRow(host, workspace))
    }
    renderGroup('remote-hosts', rows, remoteHosts.length)
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
    remoteHostName(connection.remote),
    remoteWorkspacePath(connection.remote),
  )

  const matchesHost = (host) => matches(search.value, 'SSH', host.alias, host.hostName, host.user)

  const matchesWslHost = (host) => matches(
    search.value,
    'WSL',
    host.name,
    host.state,
    host.version === undefined ? undefined : String(host.version),
  )

  const matchesRemoteHost = (host) => matches(
    search.value,
    '远程',
    host.name,
    host.deviceId,
    host.platform,
    host.online === undefined ? undefined : host.online ? REMOTE_ONLINE : REMOTE_OFFLINE,
  )

  const matchesRemoteWorkspace = (workspace) => matches(
    search.value,
    workspace.title,
    workspace.path,
    workspace.workspaceId,
    workspace.backend,
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
    // A remote connection has no editable settings in v1: its device and
    // workspace are fixed, so the row offers delete (and add again) only.
    if (!isRemoteConnection(connection)) {
      const edit = actionButton(EDIT_LABEL, EDIT_GLYPH, 'data-dsh-desktop-tabs-connection-edit', connection.id)
      edit.addEventListener('click', (event) => {
        event.stopPropagation()
        handlers.onEdit(connection)
      })
      actions.append(edit)
    }
    const remove = actionButton(DELETE_LABEL, DELETE_GLYPH, 'data-dsh-desktop-tabs-connection-delete', connection.id)
    remove.addEventListener('click', (event) => {
      event.stopPropagation()
      void run(() => handlers.onDelete(connection))
    })
    actions.append(remove)

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
   * One remote host row: a fold arrow, the device name, and a muted
   * platform/online suffix. Clicking it expands the host's workspaces.
   */
  const remoteHostRow = (host, expanded) => {
    const row = document.createElement('div')
    row.setAttribute('data-dsh-desktop-tabs-remote-host-row', host.deviceId)
    const button = document.createElement('button')
    button.type = 'button'
    button.title = describeRemoteHost(host)
    button.setAttribute('data-dsh-desktop-tabs-remote-host', host.deviceId)
    button.setAttribute('aria-expanded', String(expanded))
    const arrow = document.createElement('span')
    arrow.setAttribute('data-dsh-desktop-tabs-remote-host-arrow', '')
    arrow.textContent = expanded ? EXPANDED : COLLAPSED
    const name = document.createElement('span')
    name.setAttribute('data-dsh-desktop-tabs-remote-host-name', '')
    name.textContent = host.name
    const meta = document.createElement('span')
    meta.setAttribute('data-dsh-desktop-tabs-remote-host-meta', '')
    meta.textContent = remoteHostMeta(host)
    button.append(arrow, name, meta)
    button.addEventListener('click', () => { void toggleRemoteHost(host) })
    row.append(button)
    return row
  }

  /** One workspace row beneath an expanded remote host: title and path. */
  const remoteWorkspaceRow = (host, workspace) => {
    const button = document.createElement('button')
    button.type = 'button'
    const title = workspace.title !== '' ? workspace.title : workspace.path
    button.title = `${title}（${workspace.path}）`
    button.setAttribute('data-dsh-desktop-tabs-remote-workspace', workspace.workspaceId)
    button.setAttribute('data-dsh-desktop-tabs-remote-workspace-host', host.deviceId)
    const name = document.createElement('span')
    name.setAttribute('data-dsh-desktop-tabs-remote-workspace-title', '')
    name.textContent = title
    const path = document.createElement('span')
    path.setAttribute('data-dsh-desktop-tabs-remote-workspace-path', '')
    path.textContent = workspace.path
    button.append(name, path)
    button.addEventListener('click', () => { void openRemoteWorkspace(host, workspace) })
    return button
  }

  /** One non-actionable line inside an expanded remote host. */
  const remoteHint = (text) => {
    const hint = document.createElement('p')
    hint.setAttribute('data-dsh-desktop-tabs-remote-hint', '')
    hint.textContent = text
    return hint
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

  /** Report a remote discovery failure without closing the panel. */
  const setRemoteError = (message) => {
    pending = message
    showStatus(message)
  }

  /** Expand or fold one remote host, loading its workspaces on first expand. */
  const toggleRemoteHost = async (host) => {
    if (expandedRemote.has(host.deviceId)) {
      expandedRemote.delete(host.deviceId)
      render()
      return
    }
    expandedRemote.add(host.deviceId)
    // Without a loader (the Tauri shell passes none) the host simply expands empty.
    if (workspacesByHost.has(host.deviceId) || typeof handlers.onRemoteHost !== 'function') {
      render()
      return
    }
    loadingRemote.add(host.deviceId)
    render()
    try {
      const workspaces = await handlers.onRemoteHost(host)
      if (Array.isArray(workspaces)) workspacesByHost.set(host.deviceId, workspaces)
      pending = undefined
      showStatus(undefined)
    } catch (error) {
      setRemoteError(errorMessage(error))
    } finally {
      loadingRemote.delete(host.deviceId)
      render()
    }
  }

  /** Open one remote workspace: the caller persists it and opens its tab. */
  const openRemoteWorkspace = async (host, workspace) => {
    if (typeof handlers.onRemoteWorkspace !== 'function') return
    await run(() => handlers.onRemoteWorkspace(host, workspace))
  }

  /** Reload the remote host list from the group heading. */
  const refreshRemoteHosts = async () => {
    if (typeof handlers.onRefreshRemote !== 'function') return
    try {
      await handlers.onRefreshRemote()
      pending = undefined
      showStatus(undefined)
    } catch (error) {
      setRemoteError(errorMessage(error))
    }
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
  remoteRefresh.addEventListener('click', () => { void refreshRemoteHosts() })
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
    // A new host list invalidates what was expanded for the old one: expansion
    // state, cached workspaces, and in-flight loads all belong to that list.
    setRemoteHosts: (next) => {
      remoteHosts = next
      workspacesByHost.clear()
      expandedRemote.clear()
      loadingRemote.clear()
      render()
    },
    setRemoteWorkspaces: (deviceId, next) => {
      workspacesByHost.set(deviceId, next)
      render()
    },
    setRemoteError,
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

/**
 * One foldable group: a heading row (fold toggle, plus the remote group's
 * refresh control) and the rows body.
 */
function createGroup(name) {
  const root = document.createElement('div')
  root.setAttribute('data-dsh-desktop-tabs-section', name)
  const header = document.createElement('div')
  header.setAttribute('data-dsh-desktop-tabs-section-header', name)
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.setAttribute('data-dsh-desktop-tabs-section-toggle', name)
  header.append(toggle)
  const body = document.createElement('div')
  body.setAttribute('data-dsh-desktop-tabs-section-body', name)
  root.append(header, body)
  return { root, header, toggle, body }
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
 * @returns the label of a connection kind: `SSH`, `WSL`, `远程`, or the kind
 * itself upper-cased. A record without a kind is an SSH connection.
 */
function connectionTypeLabel(type) {
  const normalized = typeof type === 'string' ? type.trim() : ''
  if (normalized === '' || normalized.toLowerCase() === 'ssh') return 'SSH'
  if (normalized.toLowerCase() === 'wsl') return 'WSL'
  if (normalized.toLowerCase() === 'remote') return '远程'
  return normalized.toUpperCase()
}

/** @returns a connection row's visible text: its kind prefix and its title. */
function connectionLabel(connection) {
  return `${connectionTypeLabel(connection.type)} - ${connection.title}`
}

/**
 * @returns the hover text of a connection row: the kind, the title, and the
 * channel detail (remote host/workspace, SSH host, or WSL distribution) with the
 * account when one is set.
 */
function describeConnection(connection) {
  const parts = []
  if (isRemoteConnection(connection)) {
    const host = remoteHostName(connection.remote)
    if (host !== undefined) parts.push(`主机 ${host}`)
    const workspace = remoteWorkspacePath(connection.remote)
    if (workspace !== undefined) parts.push(`工作区 ${workspace}`)
  } else if (typeof connection.type === 'string' && connection.type.toLowerCase() === 'wsl') {
    const distro = hostOfWsl(connection.wsl)
    if (distro !== undefined) parts.push(`发行版 ${distro}`)
  } else {
    const host = hostOfSsh(connection.ssh)
    if (host !== undefined) parts.push(`主机 ${host}`)
  }
  if (connection.account !== undefined) parts.push(`账号 ${connection.account}`)
  return parts.length === 0 ? connectionLabel(connection) : `${connectionLabel(connection)}（${parts.join('，')}）`
}

/** @returns whether a saved connection opens a remote host workspace. */
function isRemoteConnection(connection) {
  return typeof connection.remote === 'object' && connection.remote !== null
}

/** @returns the remote host's display name, or its device id when it has none. */
function remoteHostName(remote) {
  if (typeof remote !== 'object' || remote === null) return undefined
  const name = remote.targetName
  if (typeof name === 'string' && name !== '') return name
  const device = remote.targetDeviceId
  return typeof device === 'string' && device !== '' ? device : undefined
}

/** @returns the workspace path a saved remote connection opens, if any. */
function remoteWorkspacePath(remote) {
  if (typeof remote !== 'object' || remote === null) return undefined
  const path = remote.workspacePath
  return typeof path === 'string' && path !== '' ? path : undefined
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

/**
 * @returns a one-line description of a remote host, e.g.
 * `远程主机 home-server（平台 linux，在线，版本 0.1.0）`.
 */
function describeRemoteHost(host) {
  const parts = []
  if (host.platform !== undefined) parts.push(`平台 ${host.platform}`)
  if (host.online !== undefined) parts.push(host.online ? REMOTE_ONLINE : REMOTE_OFFLINE)
  if (host.version !== undefined) parts.push(`版本 ${host.version}`)
  return parts.length === 0 ? `远程主机 ${host.name}` : `远程主机 ${host.name}（${parts.join('，')}）`
}

/** @returns a remote host row's muted suffix: its platform and online state. */
function remoteHostMeta(host) {
  const parts = []
  if (host.platform !== undefined) parts.push(host.platform)
  if (host.online !== undefined) parts.push(host.online ? REMOTE_ONLINE : REMOTE_OFFLINE)
  return parts.join(' · ')
}

/** @returns an error's message, or its string form. */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
