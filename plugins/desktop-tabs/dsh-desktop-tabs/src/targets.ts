/**
 * Host-side tab targets: read and write `<DSH_HOME>/gui/desktop-tabs.json`.
 *
 * Config format (every field is optional except `tabs` and each `id`):
 *
 * ```json
 * {
 *   "tabs": [
 *     { "id": "local", "title": "本机" },
 *     { "id": "dev", "title": "测试机", "url": "http://127.0.0.1:19999/?token=<t>" },
 *     { "id": "dev2", "title": "测试机 2", "port": 19999, "tokenFile": "C:/Users/me/.dsh-gui-remote.token" },
 *     { "id": "wsl", "title": "WSL", "ssh": { "host": "WSL" } }
 *   ]
 * }
 * ```
 *
 * A tab carrying `url` is remote, verbatim. A tab carrying `port` is remote too:
 * the bare token is read from `tokenFile` (`~/.dsh-gui-remote.token` by default,
 * the file dsh-remote persists its launch token to) and composed into
 * `http://127.0.0.1:<port>/?token=<token>`. A tab carrying `ssh` is a remote
 * whose address the remote half resolves on activation, so it needs no `url`
 * here; its contents are opaque to this module. A tab with none of the three is
 * the local view. Exactly one local tab is always present and always first.
 *
 * A `port` tab whose token file is missing, empty, or malformed is dropped — a
 * remote that has not published its token yet must not turn into a broken tab.
 *
 * Reading happens per request, so editing the file is picked up by the next
 * client fetch without restarting the host. Writing validates the submitted
 * list, restores a `port` tab's deferred-token form, and replaces the file
 * atomically.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

/** One tab the client half can render; `url` is absent for the local view and on an unresolved ssh tab. */
export interface DesktopTab {
  readonly id: string
  readonly title: string
  readonly url?: string
  /** SSH connection description owned by `./remote/index.ts`; this module round-trips it unread. */
  readonly ssh?: unknown
}

/**
 * One saved connection. A connection outlives the tab that opens it: closing a
 * tab removes the tab, never the connection, so a later click can open it again
 * with the same settings.
 */
export interface DesktopConnection {
  readonly id: string
  readonly title: string
  /** Connection kind; `ssh` is the only kind implemented today. */
  readonly type: string
  /** SSH destination description owned by `./remote/index.ts`; round-tripped unread. */
  readonly ssh?: unknown
  /** Remote working directory; absent means the remote `$HOME`. */
  readonly workdir?: string
  /** Remote start command; absent means the remote half's default. */
  readonly startCommand?: string
}

/** Normalized tab and connection lists plus the non-fatal problems found while reading them. */
export interface DesktopTabs {
  readonly tabs: readonly DesktopTab[]
  readonly connections: readonly DesktopConnection[]
  readonly warnings: readonly string[]
}

/** Rejected tab-list input: the API answers 400 with its message. */
export class TabsValidationError extends Error {}

/** One shape-validated row as it is stored in the config file. */
interface TabRow {
  id: string
  title: string
  url?: string
  ssh?: unknown
  port?: number
  tokenFile?: string
}

/** One shape-validated saved connection. */
interface ConnectionRow {
  id: string
  title: string
  type: string
  ssh?: unknown
  workdir?: string
  startCommand?: string
}

/** Local view used when the config declares none. */
const LOCAL_TAB: DesktopTab = { id: 'local', title: '本机' }

/** Stored form of the fallback local row. */
const LOCAL_ROW: TabRow = { id: 'local', title: '本机' }

/** Default token file, the one dsh-remote writes (see dsh-remote's REMOTE_TOKEN_FILE). */
const DEFAULT_TOKEN_FILE = '~/.dsh-gui-remote.token'

/** Token alphabet dsh-remote persists; anything else is treated as absent. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,}$/

/** Upper bound on one submitted tab list. */
export const MAX_TABS = 64

/** Upper bound on one submitted saved-connection list. */
export const MAX_CONNECTIONS = 64

/**
 * Resolve the Harness home directory: an explicit `DSH_HOME` wins, otherwise
 * the platform home fallback. `~` expands platform-style.
 * @param env - process environment to read `DSH_HOME` from.
 * @param home - platform home directory fallback.
 * @returns the absolute Harness home path.
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const raw = env.DSH_HOME?.trim() ?? ''
  if (raw === '') return join(home, '.dsh')
  const expanded = expandHome(raw, home)
  return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded)
}

/** The config file this plugin reads and writes. */
export function tabsFilePath(dshHome: string): string {
  return join(dshHome, 'gui', 'desktop-tabs.json')
}

/**
 * Read and normalize the tab and connection lists.
 * @param dshHome - Harness home holding `gui/desktop-tabs.json`.
 * @param home - platform home used to expand `~` in `tokenFile`.
 * @returns both normalized lists (tabs always start with the local tab) and warnings.
 */
export function readDesktopTabs(dshHome: string, home: string = homedir()): DesktopTabs {
  const stored = readRows(dshHome)
  const resolved = resolveRows(stored.rows, home)
  return {
    tabs: resolved.tabs,
    connections: stored.connections,
    warnings: [...stored.warnings, ...resolved.warnings],
  }
}

/**
 * Validate a submitted `{ tabs, connections }` payload, replace the config file
 * atomically, and return the new normalized lists.
 *
 * A payload without `connections` keeps the file's current connections: an older
 * caller that only posts tabs must not erase the saved connections.
 *
 * @param dshHome - Harness home holding `gui/desktop-tabs.json`.
 * @param value - parsed request body.
 * @param home - platform home used to expand `~` in `tokenFile`.
 * @returns both normalized lists (tabs always start with the local tab) and warnings.
 * @throws TabsValidationError when the payload is not a tab/connection list this module accepts.
 */
export function writeDesktopTabs(dshHome: string, value: unknown, home: string = homedir()): DesktopTabs {
  if (!isRecord(value) || !Array.isArray(value.tabs)) {
    throw new TabsValidationError('request body must be {"tabs": [...]}')
  }
  if (value.tabs.length > MAX_TABS) {
    throw new TabsValidationError(`at most ${MAX_TABS} tabs are accepted`)
  }
  const rows = parseRows(value.tabs, (problem) => { throw new TabsValidationError(problem) })
  const previous = readRows(dshHome)
  let connections = previous.connections
  if (value.connections !== undefined) {
    if (!Array.isArray(value.connections)) {
      throw new TabsValidationError('"connections" must be an array')
    }
    if (value.connections.length > MAX_CONNECTIONS) {
      throw new TabsValidationError(`at most ${MAX_CONNECTIONS} connections are accepted`)
    }
    connections = parseConnections(value.connections, (problem) => { throw new TabsValidationError(problem) })
  }
  const ordered = orderRows(rows, previous.rows)
  writeJsonAtomically(tabsFilePath(dshHome), { tabs: ordered, connections })
  const resolved = resolveRows(ordered, home)
  return { tabs: resolved.tabs, connections, warnings: resolved.warnings }
}

/** Read the config file into raw rows; every problem becomes a warning instead of a rejection. */
function readRows(dshHome: string): { rows: TabRow[]; connections: ConnectionRow[]; warnings: string[] } {
  const path = tabsFilePath(dshHome)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // No config is the normal first-run state: local view only, nothing to report.
    return { rows: [], connections: [], warnings: [] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    return { rows: [], connections: [], warnings: [`${path} is not valid JSON (${message(error)})`] }
  }
  const warnings: string[] = []
  const problem = (text: string): void => { warnings.push(text) }
  const tabs = isRecord(parsed) ? parsed.tabs : undefined
  if (!Array.isArray(tabs)) warnings.push(`${path} has no "tabs" array`)
  const connections = isRecord(parsed) ? parsed.connections : undefined
  if (connections !== undefined && !Array.isArray(connections)) {
    warnings.push(`${path} has a non-array "connections"`)
  }
  return {
    rows: Array.isArray(tabs) ? parseRows(tabs, problem) : [],
    connections: Array.isArray(connections) ? parseConnections(connections, problem) : [],
    warnings,
  }
}

/** Validate a list of raw rows, reporting every problem to `problem` (which may throw). */
function parseRows(list: readonly unknown[], problem: (message: string) => void): TabRow[] {
  const rows: TabRow[] = []
  const seen = new Set<string>()
  list.forEach((raw, index) => {
    const row = readRow(raw, index, problem)
    if (row === undefined) return
    if (seen.has(row.id)) {
      problem(`duplicate tab id '${row.id}'`)
      return
    }
    seen.add(row.id)
    rows.push(row)
  })
  return rows
}

/** Validate one raw row; undefined means it was reported and dropped. */
function readRow(raw: unknown, index: number, problem: (message: string) => void): TabRow | undefined {
  if (!isRecord(raw)) {
    problem(`tabs[${index}] is not an object`)
    return undefined
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (id === '') {
    problem(`tabs[${index}] has no non-empty "id"`)
    return undefined
  }
  const row: TabRow = { id, title: typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title.trim() : id }
  if (raw.url !== undefined) {
    if (typeof raw.url !== 'string') {
      problem(`tab '${id}' has a non-string "url"`)
      return undefined
    }
    const candidate = raw.url.trim()
    if (candidate !== '' && !isLoadableUrl(candidate)) {
      problem(`tab '${id}' has an unusable "url" (only http/https URLs are loadable)`)
      return undefined
    }
    if (candidate !== '') row.url = candidate
  }
  if (raw.ssh !== undefined) {
    if (!isRecord(raw.ssh)) {
      problem(`tab '${id}' has a non-object "ssh"`)
      return undefined
    }
    row.ssh = raw.ssh
  }
  if (raw.port !== undefined && raw.port !== null) {
    if (typeof raw.port !== 'number' || !Number.isInteger(raw.port) || raw.port <= 0 || raw.port > 65535) {
      problem(`tab '${id}' has an invalid "port"`)
      return undefined
    }
    row.port = raw.port
  }
  if (raw.tokenFile !== undefined) {
    if (typeof raw.tokenFile !== 'string' || raw.tokenFile.trim() === '') {
      problem(`tab '${id}' has an invalid "tokenFile"`)
      return undefined
    }
    row.tokenFile = raw.tokenFile.trim()
  }
  return row
}

/** Validate a list of saved connections, reporting every problem to `problem` (which may throw). */
function parseConnections(list: readonly unknown[], problem: (message: string) => void): ConnectionRow[] {
  const rows: ConnectionRow[] = []
  const seen = new Set<string>()
  list.forEach((raw, index) => {
    const row = readConnection(raw, index, problem)
    if (row === undefined) return
    if (seen.has(row.id)) {
      problem(`duplicate connection id '${row.id}'`)
      return
    }
    seen.add(row.id)
    rows.push(row)
  })
  return rows
}

/** Validate one raw saved connection; undefined means it was reported and dropped. */
function readConnection(raw: unknown, index: number, problem: (message: string) => void): ConnectionRow | undefined {
  if (!isRecord(raw)) {
    problem(`connections[${index}] is not an object`)
    return undefined
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (id === '') {
    problem(`connections[${index}] has no non-empty "id"`)
    return undefined
  }
  const row: ConnectionRow = {
    id,
    title: typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title.trim() : id,
    type: typeof raw.type === 'string' && raw.type.trim() !== '' ? raw.type.trim() : 'ssh',
  }
  if (raw.ssh !== undefined) {
    if (!isRecord(raw.ssh)) {
      problem(`connection '${id}' has a non-object "ssh"`)
      return undefined
    }
    row.ssh = raw.ssh
  }
  // An empty string means "not set": the optional fields are omitted rather than stored empty.
  for (const key of ['workdir', 'startCommand'] as const) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== 'string') {
      problem(`connection '${id}' has a non-string "${key}"`)
      return undefined
    }
    const text = value.trim()
    if (key === 'workdir') {
      if (text !== '') row.workdir = text
    } else if (text !== '') {
      row.startCommand = text
    }
  }
  return row
}

/**
 * Order the submitted rows for storage: the local row first, then the remote
 * rows in submission order. Any further row with no address source is dropped —
 * only one local view can be shown. A `port` tab posted back with its resolved
 * URL is restored to the deferred-token form, so the next read composes a fresh
 * token instead of persisting a stale one.
 */
function orderRows(rows: readonly TabRow[], previous: readonly TabRow[]): TabRow[] {
  const prior = new Map(previous.map((row) => [row.id, row]))
  const local = rows.find((row) => isLocalRow(row)) ?? { ...LOCAL_ROW }
  const remotes = rows
    .filter((row) => !isLocalRow(row))
    .map((row) => restoreDeferred(row, prior.get(row.id)))
  return [local, ...remotes]
}

/** A row with no address source at all is the local view. */
function isLocalRow(row: TabRow): boolean {
  return row.url === undefined && row.port === undefined && row.ssh === undefined
}

/** Restore a `port` tab's stored form when the submitted row carries its resolved URL. */
function restoreDeferred(row: TabRow, previous: TabRow | undefined): TabRow {
  if (previous === undefined || previous.port === undefined || row.url === undefined || row.ssh !== undefined) return row
  const restored: TabRow = { id: row.id, title: row.title, port: previous.port }
  if (previous.tokenFile !== undefined) restored.tokenFile = previous.tokenFile
  return restored
}

/** Resolve stored rows into client-facing tabs, one local first. */
function resolveRows(rows: readonly TabRow[], home: string): { tabs: DesktopTab[]; warnings: string[] } {
  const warnings: string[] = []
  const remotes: DesktopTab[] = []
  let local: DesktopTab | undefined
  for (const row of rows) {
    let url = row.url
    if (url === undefined && row.port !== undefined) {
      const tokenFile = row.tokenFile ?? DEFAULT_TOKEN_FILE
      const token = readToken(expandHome(tokenFile, home))
      if (token === undefined) {
        // A remote that has not written its token yet, or wrote it midway: the
        // tab simply does not exist yet. Reported once per host boot, never per request.
        warnings.push(`tab '${row.id}' has no usable token in ${tokenFile} — hidden until the file holds one`)
        continue
      }
      url = `http://127.0.0.1:${row.port}/?token=${encodeURIComponent(token)}`
    }
    if (url === undefined && row.ssh === undefined) {
      if (local === undefined) local = tabOf(row, undefined)
      else warnings.push('more than one tab has no resolvable url — only the first is kept as the local view')
      continue
    }
    remotes.push(tabOf(row, url))
  }
  return { tabs: [local ?? LOCAL_TAB, ...remotes], warnings }
}

/** Project a stored row onto the client-facing tab shape. */
function tabOf(row: TabRow, url: string | undefined): DesktopTab {
  return {
    id: row.id,
    title: row.title,
    ...(url === undefined ? {} : { url }),
    ...(row.ssh === undefined ? {} : { ssh: row.ssh }),
  }
}

/** Replace a JSON file in one step: write a sibling temporary file, then rename it over the target. */
function writeJsonAtomically(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(temporary, path)
  } catch (error: unknown) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // The temporary file is best-effort cleanup; the original error is the report.
    }
    throw error
  }
}

/** Read a bare token, trimmed; undefined when missing, unreadable, or malformed. */
function readToken(path: string): string | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8').trim()
  } catch {
    return undefined
  }
  return TOKEN_PATTERN.test(text) ? text : undefined
}

/** Whether a declared URL is one the guest shell will load. */
function isLoadableUrl(value: string): boolean {
  if (!URL.canParse(value)) return false
  const protocol = new URL(value).protocol
  return protocol === 'http:' || protocol === 'https:'
}

/** Expand a leading `~` (or `~/`, `~\`) platform-style. */
function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return path
}

/** Narrow an unknown JSON value to an object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @returns an error's message, or its string form. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
