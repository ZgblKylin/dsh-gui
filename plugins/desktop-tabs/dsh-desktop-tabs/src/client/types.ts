/**
 * The shapes shared by the client half's modules: exactly what the host half
 * persists in `<DSH_HOME>/gui/desktop-tabs.json` and returns from
 * `/desktop-tabs/api/tabs` and `/desktop-tabs/api/connections`.
 */

/** One tab as it is stored and rendered. */
export interface DesktopTab {
  readonly id: string
  readonly title: string
  /** Loadable http/https address; absent on the local view and on a remote tab until its connection is up. */
  readonly url?: string
  /** SSH connection description resolved by the host half's remote routes; carried through unread. */
  readonly ssh?: unknown
  /** WSL connection description, as `{ distro }` plus optional remote paths; carried through unread. */
  readonly wsl?: unknown
  /** Device and workspace a remote-tab connection opens; resolved by the host half's remote-tab supervisor. */
  readonly remote?: RemoteConnection
}

/** One saved connection; closing its tab never removes it. */
export interface SavedConnection {
  readonly id: string
  readonly title: string
  /** Connection kind: `ssh` or `wsl`; any other stored string is kept verbatim. */
  readonly type: string
  readonly ssh?: unknown
  readonly wsl?: unknown
  /** Device and workspace a remote-tab connection opens; absent for SSH and WSL connections. */
  readonly remote?: RemoteConnection
  /** Login account: `ssh -l <account>` / `wsl.exe -u <account>`; absent means the channel's own default. */
  readonly account?: string
  /** Remote working directory; absent means the remote `$HOME`. */
  readonly workdir?: string
  /** Remote start command; absent means the remote half's default. */
  readonly startCommand?: string
}

/** One remote connection's live state, as `/desktop-tabs/api/connections` reports it. */
export interface ConnectionStatus {
  readonly id: string
  readonly state: 'idle' | 'connecting' | 'up' | 'error'
  readonly url?: string
  readonly error?: string
  /** Progress lines, oldest first. */
  readonly log?: readonly string[]
}

/**
 * One remote-tab target: the remote host device and the workspace its child
 * Harness opens. Mirrors the host half's `RemoteConnectionSpec`; persisted in the
 * connection row and copied onto the tab, never into a URL.
 */
export interface RemoteConnection {
  /** Device id of the remote host that serves the workspace. */
  readonly targetDeviceId: string
  /** Display name of the remote host, when the panel that created the row knew it. */
  readonly targetName?: string
  /** Workspace path opened in the remote host's Harness. */
  readonly workspacePath: string
  /** Backend that serves the workspace; only `harness` is supported today. */
  readonly backend?: string
}

/**
 * One remote host device offered by the host half's `/desktop-tabs/api/remote-hosts`.
 * Only the device id is needed to ask for its workspaces; the rest describes it
 * for display.
 */
export interface RemoteHost {
  readonly deviceId: string
  readonly name: string
  readonly platform?: string
  readonly online?: boolean
  readonly version?: string
}

/**
 * One workspace offered by the host half's `/desktop-tabs/api/remote-workspaces`.
 * The path plus the device id is the whole specification a new tab needs.
 */
export interface RemoteWorkspace {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly backend?: string
}

/** Both persisted lists, as `/desktop-tabs/api/tabs` reports and accepts them. */
export interface TabsSnapshot {
  readonly tabs: readonly DesktopTab[]
  readonly connections: readonly SavedConnection[]
}

/** Whether a tab is the local view: no address of its own and no remote connection to resolve. */
export function isLocalTab(tab: DesktopTab): boolean {
  return tab.url === undefined && tab.ssh === undefined && tab.wsl === undefined && tab.remote === undefined
}

/**
 * @returns whether a saved connection opens a remote host workspace: it carries
 * the `remote` descriptor, or the host half reports its kind as `remote` (a row
 * whose descriptor was lost must still be deleted through `forget`).
 */
export function isRemoteConnection(connection: SavedConnection): boolean {
  return connection.remote !== undefined || connection.type.trim().toLowerCase() === 'remote'
}

/**
 * One SSH host alias offered by the host half's `/desktop-tabs/api/ssh-hosts`,
 * parsed from the user's `~/.ssh/config`. Only the alias is needed to add a tab;
 * the remaining fields describe the entry for display.
 */
export interface SshHost {
  readonly alias: string
  readonly hostName?: string
  readonly user?: string
  readonly port?: number
}

/**
 * One WSL distribution offered by the host half's `/desktop-tabs/api/wsl-hosts`,
 * parsed from `wsl.exe -l -v`. The name is the whole specification a new tab
 * needs; the remaining fields describe the distribution for display.
 */
export interface WslHost {
  /** Distribution name, as `wsl.exe` reports it (used as `wsl -d <name>`). */
  readonly name: string
  /** Raw state reported by `wsl.exe -l -v`, e.g. `Running`; absent when it could not be read. */
  readonly state?: string
  /** WSL filesystem version, e.g. `2`; absent when it could not be read. */
  readonly version?: number
  /** Whether this is the default distribution. */
  readonly default?: boolean
}

/** The `ssh` description a connection carries for an SSH host alias. */
export function sshOfAlias(alias: string): { host: string } {
  return { host: alias }
}

/** @returns the SSH host alias a connection (or tab) describes, if any. */
export function hostOfSsh(ssh: unknown): string | undefined {
  if (typeof ssh !== 'object' || ssh === null) return undefined
  const host = (ssh as { host?: unknown }).host
  return typeof host === 'string' && host !== '' ? host : undefined
}

/** The `wsl` description a connection carries for one distribution. */
export function wslOfDistro(distro: string): { distro: string } {
  return { distro }
}

/**
 * @returns the distribution name a connection (or tab) describes, if any.
 *
 * An empty `distro` is a valid specification (the default distribution), but it
 * names no distribution to display or to build an id from, so it reads as absent.
 */
export function hostOfWsl(wsl: unknown): string | undefined {
  if (typeof wsl !== 'object' || wsl === null) return undefined
  const distro = (wsl as { distro?: unknown }).distro
  return typeof distro === 'string' && distro !== '' ? distro : undefined
}

/** @returns the label of a connection kind: `SSH`, `WSL`, `远程`, or the kind itself upper-cased. */
export function connectionTypeLabel(type: string): string {
  const normalized = type.trim()
  switch (normalized.toLowerCase()) {
    case 'ssh':
      return 'SSH'
    case 'wsl':
      return 'WSL'
    case 'remote':
      return '远程'
    default:
      return normalized.toUpperCase()
  }
}

/** Client-facing tabs only ever carry these six fields, whatever the host adds later. */
export function tabOf(raw: Record<string, unknown>): DesktopTab | undefined {
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (id === '') return undefined
  const title = typeof raw.title === 'string' && raw.title !== '' ? raw.title : id
  const url = typeof raw.url === 'string' && raw.url !== '' ? raw.url : undefined
  const ssh = raw.ssh === undefined ? undefined : raw.ssh
  const wsl = raw.wsl === undefined ? undefined : raw.wsl
  const remote = remoteOf(raw.remote)
  return {
    id,
    title,
    ...(url === undefined ? {} : { url }),
    ...(ssh === undefined ? {} : { ssh }),
    ...(wsl === undefined ? {} : { wsl }),
    ...(remote === undefined ? {} : { remote }),
  }
}

/** Client-facing saved connections only ever carry these nine fields. */
export function connectionOf(raw: Record<string, unknown>): SavedConnection | undefined {
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (id === '') return undefined
  const title = typeof raw.title === 'string' && raw.title !== '' ? raw.title : id
  const ssh = raw.ssh === undefined ? undefined : raw.ssh
  const wsl = raw.wsl === undefined ? undefined : raw.wsl
  const remote = remoteOf(raw.remote)
  const type =
    typeof raw.type === 'string' && raw.type !== ''
      ? raw.type
      : remote !== undefined
        ? 'remote'
        : wsl === undefined
          ? 'ssh'
          : 'wsl'
  const account = typeof raw.account === 'string' && raw.account !== '' ? raw.account : undefined
  const workdir = typeof raw.workdir === 'string' && raw.workdir !== '' ? raw.workdir : undefined
  const startCommand = typeof raw.startCommand === 'string' && raw.startCommand !== '' ? raw.startCommand : undefined
  return {
    id,
    title,
    type,
    ...(ssh === undefined ? {} : { ssh }),
    ...(wsl === undefined ? {} : { wsl }),
    ...(remote === undefined ? {} : { remote }),
    ...(account === undefined ? {} : { account }),
    ...(workdir === undefined ? {} : { workdir }),
    ...(startCommand === undefined ? {} : { startCommand }),
  }
}

/** Client-facing SSH hosts only ever carry these four fields. */
export function sshHostOf(raw: Record<string, unknown>): SshHost | undefined {
  const alias = typeof raw.alias === 'string' ? raw.alias.trim() : ''
  if (alias === '') return undefined
  const hostName = typeof raw.hostName === 'string' && raw.hostName !== '' ? raw.hostName : undefined
  const user = typeof raw.user === 'string' && raw.user !== '' ? raw.user : undefined
  const port = typeof raw.port === 'number' && Number.isInteger(raw.port) ? raw.port : undefined
  return {
    alias,
    ...(hostName === undefined ? {} : { hostName }),
    ...(user === undefined ? {} : { user }),
    ...(port === undefined ? {} : { port }),
  }
}

/** Client-facing WSL distributions only ever carry these four fields. */
export function wslHostOf(raw: Record<string, unknown>): WslHost | undefined {
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (name === '') return undefined
  const state = typeof raw.state === 'string' && raw.state !== '' ? raw.state : undefined
  const version = typeof raw.version === 'number' && Number.isInteger(raw.version) ? raw.version : undefined
  const isDefault = typeof raw.default === 'boolean' ? raw.default : undefined
  return {
    name,
    ...(state === undefined ? {} : { state }),
    ...(version === undefined ? {} : { version }),
    ...(isDefault === undefined ? {} : { default: isDefault }),
  }
}

/** Client-facing connection states only ever carry these five fields. */
export function connectionStatusOf(raw: Record<string, unknown>): ConnectionStatus | undefined {
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (id === '') return undefined
  const state = raw.state
  if (state !== 'idle' && state !== 'connecting' && state !== 'up' && state !== 'error') return undefined
  const url = typeof raw.url === 'string' && raw.url !== '' ? raw.url : undefined
  const error = typeof raw.error === 'string' && raw.error !== '' ? raw.error : undefined
  const log = Array.isArray(raw.log) ? raw.log.filter((line): line is string => typeof line === 'string') : undefined
  return {
    id,
    state,
    ...(url === undefined ? {} : { url }),
    ...(error === undefined ? {} : { error }),
    ...(log === undefined ? {} : { log }),
  }
}

/**
 * Parse one persisted (or tab-carried) remote-tab spec.
 * @returns the spec when it names both a device and a workspace path, else undefined.
 */
export function remoteOf(remote: unknown): RemoteConnection | undefined {
  if (typeof remote !== 'object' || remote === null) return undefined
  const raw = remote as Record<string, unknown>
  const targetDeviceId = typeof raw.targetDeviceId === 'string' ? raw.targetDeviceId.trim() : ''
  const workspacePath = typeof raw.workspacePath === 'string' ? raw.workspacePath : ''
  if (targetDeviceId === '' || workspacePath.trim() === '') return undefined
  const targetName = typeof raw.targetName === 'string' && raw.targetName.trim() !== '' ? raw.targetName.trim() : undefined
  const backend = typeof raw.backend === 'string' && raw.backend.trim() !== '' ? raw.backend.trim() : undefined
  return {
    targetDeviceId,
    ...(targetName === undefined ? {} : { targetName }),
    workspacePath,
    ...(backend === undefined ? {} : { backend }),
  }
}

/** Client-facing remote hosts only ever carry these five fields. */
export function remoteHostOf(raw: Record<string, unknown>): RemoteHost | undefined {
  const deviceId = typeof raw.deviceId === 'string' ? raw.deviceId.trim() : ''
  if (deviceId === '') return undefined
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : deviceId
  const platform = typeof raw.platform === 'string' && raw.platform !== '' ? raw.platform : undefined
  const online = typeof raw.online === 'boolean' ? raw.online : undefined
  const version = typeof raw.version === 'string' && raw.version !== '' ? raw.version : undefined
  return {
    deviceId,
    name,
    ...(platform === undefined ? {} : { platform }),
    ...(online === undefined ? {} : { online }),
    ...(version === undefined ? {} : { version }),
  }
}

/** Client-facing remote workspaces only ever carry these four fields. */
export function remoteWorkspaceOf(raw: Record<string, unknown>): RemoteWorkspace | undefined {
  const path = typeof raw.path === 'string' ? raw.path : ''
  if (path === '') return undefined
  const workspaceId = typeof raw.workspaceId === 'string' && raw.workspaceId !== '' ? raw.workspaceId : path
  const title = typeof raw.title === 'string' && raw.title !== '' ? raw.title : path
  const backend = typeof raw.backend === 'string' && raw.backend !== '' ? raw.backend : undefined
  return {
    workspaceId,
    path,
    title,
    ...(backend === undefined ? {} : { backend }),
  }
}

/**
 * @returns the stable connection id of one device + workspace pair:
 * `remote-<hash>`, so reopening the same workspace reuses its saved connection
 * (and its child Harness) instead of minting a second one.
 */
export function remoteConnectionId(targetDeviceId: string, workspacePath: string): string {
  return `remote-${fnv1a(`${targetDeviceId}\u0000${workspacePath}`)}`
}

/**
 * @returns the tab (and connection) title of one remote workspace: the host name
 * and the workspace title, e.g. `home-server · dsh-gui`.
 */
export function remoteTabTitle(host: RemoteHost, workspace: RemoteWorkspace): string {
  const label = workspace.title !== '' ? workspace.title : workspace.path
  return host.name === '' ? label : `${host.name} · ${label}`
}

/**
 * Build the saved remote connection for one host workspace: stable id, the
 * `remote` spec, and the display title. This is what the panel's workspace pick
 * persists before asking the host half to bring the child up.
 */
export function savedRemoteConnection(host: RemoteHost, workspace: RemoteWorkspace): SavedConnection {
  return {
    id: remoteConnectionId(host.deviceId, workspace.path),
    title: remoteTabTitle(host, workspace),
    type: 'remote',
    remote: {
      targetDeviceId: host.deviceId,
      ...(host.name === '' ? {} : { targetName: host.name }),
      workspacePath: workspace.path,
      ...(workspace.backend === undefined ? {} : { backend: workspace.backend }),
    },
  }
}

/** 32-bit FNV-1a of one string, as eight lower-case hex digits. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
