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
}

/** One saved connection; closing its tab never removes it. */
export interface SavedConnection {
  readonly id: string
  readonly title: string
  /** Connection kind: `ssh` or `wsl`; any other stored string is kept verbatim. */
  readonly type: string
  readonly ssh?: unknown
  readonly wsl?: unknown
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

/** Both persisted lists, as `/desktop-tabs/api/tabs` reports and accepts them. */
export interface TabsSnapshot {
  readonly tabs: readonly DesktopTab[]
  readonly connections: readonly SavedConnection[]
}

/** Whether a tab is the local view: no address of its own and no remote connection to resolve. */
export function isLocalTab(tab: DesktopTab): boolean {
  return tab.url === undefined && tab.ssh === undefined && tab.wsl === undefined
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

/** @returns the upper-case label of a connection kind: `SSH`, `WSL`, or the kind itself upper-cased. */
export function connectionTypeLabel(type: string): string {
  const normalized = type.trim()
  switch (normalized.toLowerCase()) {
    case 'ssh':
      return 'SSH'
    case 'wsl':
      return 'WSL'
    default:
      return normalized.toUpperCase()
  }
}

/** Client-facing tabs only ever carry these five fields, whatever the host adds later. */
export function tabOf(raw: Record<string, unknown>): DesktopTab | undefined {
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (id === '') return undefined
  const title = typeof raw.title === 'string' && raw.title !== '' ? raw.title : id
  const url = typeof raw.url === 'string' && raw.url !== '' ? raw.url : undefined
  const ssh = raw.ssh === undefined ? undefined : raw.ssh
  const wsl = raw.wsl === undefined ? undefined : raw.wsl
  return {
    id,
    title,
    ...(url === undefined ? {} : { url }),
    ...(ssh === undefined ? {} : { ssh }),
    ...(wsl === undefined ? {} : { wsl }),
  }
}

/** Client-facing saved connections only ever carry these eight fields. */
export function connectionOf(raw: Record<string, unknown>): SavedConnection | undefined {
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (id === '') return undefined
  const title = typeof raw.title === 'string' && raw.title !== '' ? raw.title : id
  const ssh = raw.ssh === undefined ? undefined : raw.ssh
  const wsl = raw.wsl === undefined ? undefined : raw.wsl
  const type =
    typeof raw.type === 'string' && raw.type !== '' ? raw.type : wsl === undefined ? 'ssh' : 'wsl'
  const account = typeof raw.account === 'string' && raw.account !== '' ? raw.account : undefined
  const workdir = typeof raw.workdir === 'string' && raw.workdir !== '' ? raw.workdir : undefined
  const startCommand = typeof raw.startCommand === 'string' && raw.startCommand !== '' ? raw.startCommand : undefined
  return {
    id,
    title,
    type,
    ...(ssh === undefined ? {} : { ssh }),
    ...(wsl === undefined ? {} : { wsl }),
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
