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
  sshHostOf,
  tabOf,
  type ConnectionStatus,
  type SavedConnection,
  type SshHost,
  type TabsSnapshot,
} from './types.ts'

/** The tab and connection list endpoint. */
const TABS_PATH = '/desktop-tabs/api/tabs'

/** The remote-connection route prefix. */
const CONNECTIONS_PATH = '/desktop-tabs/api/connections'

/** The SSH host list parsed from `~/.ssh/config`. */
const SSH_HOSTS_PATH = '/desktop-tabs/api/ssh-hosts'

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
