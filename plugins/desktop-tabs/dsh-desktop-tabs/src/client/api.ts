/**
 * The host half's HTTP API, as the browser half consumes it.
 *
 * Requests are relative, so the desktop application forwards them from
 * `dsh-app://app/*` to the Host with the shell's own authentication cookie, and
 * an ordinary web page reaches the same origin it was served from. Every call
 * rejects with the host's own `{ error }` text when it can, so callers can show
 * a readable reason instead of a status code.
 */

import {
  connectionOf,
  connectionStatusOf,
  remoteHostOf,
  remoteWorkspaceOf,
  sshHostOf,
  tabOf,
  wslHostOf,
  type ConnectionStatus,
  type RemoteHost,
  type RemoteWorkspace,
  type SavedConnection,
  type SshHost,
  type TabsSnapshot,
  type WslHost,
} from './types.ts'

/** The tab and connection list endpoint. */
const TABS_PATH = '/desktop-tabs/api/tabs'

/** The remote-connection route prefix. */
const CONNECTIONS_PATH = '/desktop-tabs/api/connections'

/** The SSH host list parsed from `~/.ssh/config`. */
const SSH_HOSTS_PATH = '/desktop-tabs/api/ssh-hosts'

/** The WSL distribution list parsed from `wsl.exe -l -v`. */
const WSL_HOSTS_PATH = '/desktop-tabs/api/wsl-hosts'

/** The remote host device list offered by ds-harness-remote. */
const REMOTE_HOSTS_PATH = '/desktop-tabs/api/remote-hosts'

/** One remote host's workspace list, discovered by the host half. */
const REMOTE_WORKSPACES_PATH = '/desktop-tabs/api/remote-workspaces'

/**
 * One remote-host list answer. Discovery may be unavailable (the remote plugin is
 * missing, or the parent is in remote mode), so the hosts that were listed are
 * returned together with the reason the list may be incomplete.
 */
export interface RemoteHostsAnswer {
  readonly hosts: readonly RemoteHost[]
  readonly error?: string
}

/** One remote-workspace list answer: the workspaces found, or why none were. */
export interface RemoteWorkspacesAnswer {
  readonly workspaces: readonly RemoteWorkspace[]
  readonly error?: string
}

/** Read the persisted tabs and saved connections. */
export async function fetchTabs(): Promise<TabsSnapshot> {
  const response = await fetch(TABS_PATH, { headers: { accept: 'application/json' }, cache: 'no-store' })
  if (!response.ok) throw new Error(await failure(response))
  const payload: unknown = await response.json()
  const rows = isRecord(payload) && Array.isArray(payload.tabs) ? payload.tabs : undefined
  if (rows === undefined) throw new Error(`${TABS_PATH} did not return a tabs array`)
  const tabs = rows.flatMap((row) => {
    if (!isRecord(row)) return []
    const tab = tabOf(row)
    return tab === undefined ? [] : [tab]
  })
  const connectionRows = isRecord(payload) && Array.isArray(payload.connections) ? payload.connections : []
  const connections = connectionRows.flatMap((row) => {
    if (!isRecord(row)) return []
    const connection = connectionOf(row)
    return connection === undefined ? [] : [connection]
  })
  return { tabs, connections }
}

/**
 * Replace the persisted tabs and saved connections.
 * @param snapshot - the complete lists to store, local tab included.
 */
export async function putTabs(snapshot: TabsSnapshot): Promise<void> {
  const response = await fetch(TABS_PATH, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tabs: snapshot.tabs, connections: snapshot.connections }),
  })
  if (!response.ok) throw new Error(await failure(response))
}

/** Read every remote connection's live state, progress log, and failure reason. */
export async function fetchConnections(): Promise<ConnectionStatus[]> {
  const response = await fetch(CONNECTIONS_PATH, { headers: { accept: 'application/json' }, cache: 'no-store' })
  if (!response.ok) throw new Error(await failure(response))
  const payload: unknown = await response.json()
  const rows = isRecord(payload) && Array.isArray(payload.connections) ? payload.connections : undefined
  if (rows === undefined) throw new Error(`${CONNECTIONS_PATH} did not return a connections array`)
  const statuses: ConnectionStatus[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const status = connectionStatusOf(row)
    if (status !== undefined) statuses.push(status)
  }
  return statuses
}

/**
 * Bring one ssh connection up.
 * @param id - the connection (and tab) id.
 * @returns the URL to load in a guest.
 */
export async function upConnection(id: string): Promise<string> {
  const path = `${CONNECTIONS_PATH}/${encodeURIComponent(id)}/up`
  const response = await fetch(path, { method: 'POST' })
  if (!response.ok) throw new Error(await failure(response))
  const payload: unknown = await response.json().catch(() => undefined)
  const url = isRecord(payload) && typeof payload.url === 'string' ? payload.url : ''
  if (url === '') throw new Error(`${path} did not return a url`)
  return url
}

/**
 * Tear one ssh connection down.
 * @param id - the connection (and tab) id.
 */
export async function downConnection(id: string): Promise<void> {
  const path = `${CONNECTIONS_PATH}/${encodeURIComponent(id)}/down`
  const response = await fetch(path, { method: 'POST' })
  if (!response.ok) throw new Error(await failure(response))
}

/**
 * Forget one saved remote-tab connection: the host half stops the child Harness,
 * revokes its client device, and removes its home directory.
 * @param id - the connection (and tab) id.
 */
export async function forgetConnection(id: string): Promise<void> {
  const path = `${CONNECTIONS_PATH}/${encodeURIComponent(id)}/forget`
  const response = await fetch(path, { method: 'POST' })
  if (!response.ok) throw new Error(await failure(response))
}

/**
 * Read the remote host devices ds-harness-remote reports.
 * @returns the listed hosts and, when discovery is unavailable, the reason; a
 * network or protocol failure rejects instead.
 */
export async function fetchRemoteHosts(): Promise<RemoteHostsAnswer> {
  const response = await fetch(REMOTE_HOSTS_PATH, { headers: { accept: 'application/json' }, cache: 'no-store' })
  if (!response.ok) throw new Error(await failure(response))
  const payload: unknown = await response.json()
  const rows = isRecord(payload) && Array.isArray(payload.hosts) ? payload.hosts : undefined
  if (rows === undefined) throw new Error(`${REMOTE_HOSTS_PATH} did not return a hosts array`)
  const hosts: RemoteHost[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const host = remoteHostOf(row)
    if (host !== undefined) hosts.push(host)
  }
  const error = isRecord(payload) && typeof payload.error === 'string' && payload.error !== '' ? payload.error : undefined
  return { hosts, ...(error === undefined ? {} : { error }) }
}

/**
 * Discover one remote host's workspaces.
 * @param targetDeviceId - the remote host device id.
 * @returns the workspaces found and, when discovery is unavailable, the reason; a
 * network or protocol failure rejects instead.
 */
export async function fetchRemoteWorkspaces(targetDeviceId: string): Promise<RemoteWorkspacesAnswer> {
  const path = `${REMOTE_WORKSPACES_PATH}?targetDeviceId=${encodeURIComponent(targetDeviceId)}`
  const response = await fetch(path, { headers: { accept: 'application/json' }, cache: 'no-store' })
  if (!response.ok) throw new Error(await failure(response))
  const payload: unknown = await response.json()
  const rows = isRecord(payload) && Array.isArray(payload.workspaces) ? payload.workspaces : undefined
  if (rows === undefined) throw new Error(`${REMOTE_WORKSPACES_PATH} did not return a workspaces array`)
  const workspaces: RemoteWorkspace[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const workspace = remoteWorkspaceOf(row)
    if (workspace !== undefined) workspaces.push(workspace)
  }
  const error = isRecord(payload) && typeof payload.error === 'string' && payload.error !== '' ? payload.error : undefined
  return { workspaces, ...(error === undefined ? {} : { error }) }
}

/** Read the SSH host aliases the user's `~/.ssh/config` declares. */
export async function fetchSshHosts(): Promise<SshHost[]> {
  const response = await fetch(SSH_HOSTS_PATH, { headers: { accept: 'application/json' }, cache: 'no-store' })
  if (!response.ok) throw new Error(await failure(response))
  const payload: unknown = await response.json()
  const rows = isRecord(payload) && Array.isArray(payload.hosts) ? payload.hosts : undefined
  if (rows === undefined) throw new Error(`${SSH_HOSTS_PATH} did not return a hosts array`)
  const hosts: SshHost[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const host = sshHostOf(row)
    if (host !== undefined) hosts.push(host)
  }
  return hosts
}

/** Read the WSL distributions `wsl.exe -l -v` reports. */
export async function fetchWslHosts(): Promise<WslHost[]> {
  const response = await fetch(WSL_HOSTS_PATH, { headers: { accept: 'application/json' }, cache: 'no-store' })
  if (!response.ok) throw new Error(await failure(response))
  const payload: unknown = await response.json()
  const rows = isRecord(payload) && Array.isArray(payload.hosts) ? payload.hosts : undefined
  if (rows === undefined) throw new Error(`${WSL_HOSTS_PATH} did not return a hosts array`)
  const hosts: WslHost[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const host = wslHostOf(row)
    if (host !== undefined) hosts.push(host)
  }
  return hosts
}

/** @returns the response's `{ error }` message, or a status summary. */
async function failure(response: Response): Promise<string> {
  const payload: unknown = await response.json().catch(() => undefined)
  if (isRecord(payload) && typeof payload.error === 'string' && payload.error !== '') return payload.error
  return `HTTP ${response.status}`
}

/** Narrow an unknown JSON value to an object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Re-exported so callers can name the connection kind they persist. */
export type { SavedConnection }
