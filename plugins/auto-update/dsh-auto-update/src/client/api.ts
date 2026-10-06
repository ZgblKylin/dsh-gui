/**
 * The host half's `/auto-update/api/*` routes, as this browser half consumes
 * them.
 *
 * Requests are relative, so they reach the Host the page was served from (in
 * the desktop application the shell forwards `dsh-app://app/*` with its own
 * authentication cookie). Every failure path — a route that is not there, a
 * 5xx, a body the route refuses — rejects with the host's own `{ error }` text
 * when it can, so the dialog can show a readable Chinese reason instead of a
 * bare status code.
 *
 * The update route answers NDJSON (one JSON object per line) rather than one
 * document, so `streamUpdate` consumes the response body incrementally and
 * reports each line as it lands.
 */

/** One module row, as `GET /api/status` reports it. */
export interface UpdateProject {
  /** Stable id: `dsh-gui` for the top-level checkout, the `.gitmodules` name otherwise. */
  readonly id: string
  /** Display name (the module's `package.json` name, falling back to the id). */
  readonly name: string
  /** Path relative to the repository root, POSIX; empty for the top-level checkout. */
  readonly path: string
  /** Locally checked-out version: an exact tag when on one, else a short sha. */
  readonly current: string
  /** Version on the remote default branch; `检查中…` in `mode=local`. */
  readonly latest: string
  /** Newest tag reachable from the remote default branch, when one exists. */
  readonly latestTag?: string
  /** The newest tag is not strictly newer than the local HEAD: the tag target degrades. */
  readonly latestTagStale?: boolean
  /** Counts towards the badge; false for a tag checkout with no newer tag. */
  readonly announce?: boolean
  /** The remote default branch is strictly ahead of the local HEAD. */
  readonly behind: boolean
  /** True for every row in `mode=local` (skeleton placeholders). */
  readonly checking: boolean
  /** Readable failure for this row (missing submodule directory, git failure…). */
  readonly error?: string
  /** GitHub Releases list page for the row's origin, when it has one. */
  readonly releaseUrl?: string
}

/** The whole `GET /api/status` document. */
export interface UpdateStatus {
  readonly projects: readonly UpdateProject[]
  /** `updateCount > 0`. */
  readonly hasUpdates: boolean
  /** Number of rows with `behind`. */
  readonly updateCount: number
  /** Number of rows with `behind && announce` — what the entry badge shows. */
  readonly notifyCount: number
  /** False when any row failed to check. */
  readonly allChecked: boolean
  /** Unix seconds of the completed check; null in `mode=local`. */
  readonly checkedAt: number | null
  /** Duration of the check in milliseconds. */
  readonly durationMs?: number
  /** Resolved repository root, for diagnostics. */
  readonly root?: string
  /** The rebuild command shown in the dialog footer (single source of truth). */
  readonly buildCommand?: string
}

/** One row's update target, as `POST /api/update` accepts it. */
export interface UpdateTarget {
  /** Project id from the status document. */
  readonly id: string
  /** `tag` = the remote default branch's newest tag, `commit` = that branch's HEAD. */
  readonly mode: 'tag' | 'commit'
}

/** One NDJSON line of the update stream. */
export interface UpdateLogEntry {
  readonly type: 'begin' | 'log' | 'target' | 'end'
  /** Target ids (`begin`). */
  readonly targets?: string[]
  /** Target id (`log` / `target`). */
  readonly id?: string
  /** Progress line (`log`). */
  readonly line?: string
  /** Per-target success (`target` / `end`). */
  readonly ok?: boolean
  /** Success detail, e.g. `已更新到 v1.3.0` (`target`). */
  readonly detail?: string
  /** Per-target or whole-stream failure (`target` / `end`). */
  readonly error?: string
  /** Rebuild command reported by the host (`end`). */
  readonly buildCommand?: string
}

/** The stream's closing outcome. */
export interface UpdateResult {
  readonly ok: boolean
  readonly buildCommand?: string
  readonly error?: string
}

/** One commit of a changelog. */
export interface ChangelogCommit {
  readonly sha: string
  readonly subject: string
  readonly author: string
  readonly date: string
}

/** The GitHub release a tag target resolved to, when one was found. */
export interface ChangelogRelease {
  readonly tag: string
  readonly name: string
  readonly url: string
  readonly body: string
}

/** `GET /api/changelog` document. */
export interface Changelog {
  readonly id: string
  readonly name: string
  /** Local version the update starts from. */
  readonly from: string
  /** Version the update lands on. */
  readonly to: string
  /** Tag name or `origin/<branch>`. */
  readonly target: string
  readonly targetKind: 'tag' | 'commit'
  readonly release?: ChangelogRelease
  readonly commits: readonly ChangelogCommit[]
  readonly truncated: boolean
  /** Local git failure only; a missing release is not an error. */
  readonly error?: string
}

/** Route prefix of the host half. */
const API_BASE = '/auto-update/api'

/**
 * Read the update status.
 * @param mode - `local` renders skeleton rows without network I/O, `check` runs the real comparison.
 * @returns the status document.
 */
export async function fetchStatus(mode: 'local' | 'check'): Promise<UpdateStatus> {
  const path = `${API_BASE}/status?mode=${mode}`
  const response = await fetch(path, { headers: { accept: 'application/json' }, cache: 'no-store' })
  if (!response.ok) throw new Error(await failure(response))
  const payload: unknown = await response.json().catch(() => undefined)
  if (!isRecord(payload) || !Array.isArray(payload.projects)) {
    throw new Error(`${path} 未返回 projects 列表`)
  }
  return payload as unknown as UpdateStatus
}

/**
 * Run one update and report its NDJSON lines as they arrive.
 *
 * A failure before the stream starts (400/409/500, or a dead route) rejects
 * with the host's message; a per-target failure inside the stream is a
 * `target` line with `ok: false` and does not throw.
 *
 * @param targets - rows to update, in the order the host should process them.
 * @param onEntry - called for every parsed line, in order.
 * @returns the stream's closing `end` outcome.
 */
export async function streamUpdate(
  targets: readonly UpdateTarget[],
  onEntry: (entry: UpdateLogEntry) => void,
): Promise<UpdateResult> {
  const response = await fetch(`${API_BASE}/update`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targets }),
  })
  if (!response.ok) throw new Error(await failure(response))

  let end: UpdateResult | undefined
  /** One parsed line: report it and remember the closing outcome. */
  const consume = (text: string): void => {
    const entry = parseEntry(text)
    if (entry === undefined) return
    onEntry(entry)
    if (entry.type === 'end') {
      end = { ok: entry.ok === true, buildCommand: entry.buildCommand, error: entry.error }
    }
  }

  const body = response.body
  if (body === null) {
    // No streaming body (an older host, or a buffered proxy): split the text.
    for (const line of (await response.text()).split(/\r?\n/)) consume(line)
    return end ?? { ok: false, error: '更新流未返回结束行' }
  }

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      consume(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
    }
  }
  buffer += decoder.decode()
  consume(buffer)
  return end ?? { ok: false, error: '更新流未返回结束行' }
}

/**
 * Read the changelog for one row.
 * @param id - project id from the status document.
 * @param mode - the row's selected update target.
 * @returns the changelog document.
 */
export async function fetchChangelog(id: string, mode: 'tag' | 'commit'): Promise<Changelog> {
  const path = `${API_BASE}/changelog?id=${encodeURIComponent(id)}&mode=${mode}`
  const response = await fetch(path, { headers: { accept: 'application/json' }, cache: 'no-store' })
  if (!response.ok) throw new Error(await failure(response))
  const payload: unknown = await response.json().catch(() => undefined)
  if (!isRecord(payload)) throw new Error(`${path} 未返回更新日志`)
  const commits = Array.isArray(payload.commits) ? payload.commits : []
  return { ...(payload as unknown as Changelog), commits }
}

/** Parse one NDJSON line, ignoring blank and malformed ones. */
function parseEntry(text: string): UpdateLogEntry | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!isRecord(value) || typeof value.type !== 'string') return undefined
  return value as unknown as UpdateLogEntry
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
