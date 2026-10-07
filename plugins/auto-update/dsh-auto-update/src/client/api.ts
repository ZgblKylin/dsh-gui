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

/**
 * One row's npm publish state (contract §7.2), mirroring the shell's
 * `NpmUpdateInfo`. Present only when the row has a usable newer tag and the
 * project provides npm-installed packages; absent means "render no npm note".
 */
export interface NpmUpdateInfo {
  /** The npm-installed packages this project provides, in manifest order. */
  readonly packages: readonly string[]
  /** Each package's `dist-tags.latest`. */
  readonly latest: Readonly<Record<string, string>>
  /** Packages whose published versions do not include the target version. */
  readonly missing: readonly string[]
  /** True only when every package published the target version and no error occurred. */
  readonly complete: boolean
  /** A registry-side failure; the row itself is still updatable. */
  readonly error?: string
}

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
  /** npm publish state of the row's npm-installed packages (contract §7.2). */
  readonly npm?: NpmUpdateInfo
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
  /**
   * `git rev-list --count <from>..<to>` (contract §7.3): every commit in the
   * range, merge commits included and unaffected by the 400-entry list cap.
   * Zero when there is nothing to update. Optional here so the client still
   * works against an older host and falls back to `commits.length`.
   */
  readonly count?: number
  readonly truncated: boolean
  /**
   * `git diff --stat <from>..<to>` verbatim (contract §7.3), the third input of
   * the AI summary prompt; empty when there is nothing to show. Optional here
   * so the client also works against a host that has not shipped v2 yet.
   */
  readonly diffstat?: string
  /** Local git failure only; a missing release is not an error. */
  readonly error?: string
}

/** Route prefix of the host half. */
const API_BASE = '/auto-update/api'

/** The dsh-ai-update host route reused for the changelog AI summary (contract §7.3). */
const AI_SUMMARY_PATH = '/dsh-gui-api/changelog'

/**
 * How long the AI summary call may take before the client gives up. The route
 * itself answers 504 after 300s, so this only fires when the connection stalls
 * without an answer; it sits just above the host's own bound so the host's
 * readable timeout message wins whenever it is alive to send one.
 */
export const AI_SUMMARY_TIMEOUT_MS = 310_000

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
 * Read the host's module-level cached status (`?mode=cached`, contract §7.4).
 *
 * @returns the cached status, or undefined when the host has none (204) — the
 *   caller then falls back to the local skeleton plus a real check.
 */
export async function fetchCachedStatus(): Promise<UpdateStatus | undefined> {
  const path = `${API_BASE}/status?mode=cached`
  const response = await fetch(path, { headers: { accept: 'application/json' }, cache: 'no-store' })
  if (response.status === 204) return undefined
  if (!response.ok) throw new Error(await failure(response))
  const payload: unknown = await response.json().catch(() => undefined)
  if (!isRecord(payload) || !Array.isArray(payload.projects)) {
    throw new Error(`${path} 未返回 projects 列表`)
  }
  return payload as unknown as UpdateStatus
}

/**
 * Ask the dsh-ai-update host route for a changelog summary (contract §7.3).
 *
 * The prompt is built here (the route is a generic one-shot LLM call); the
 * route answers `{ ok: true, text }` on success and `{ ok: false, error }` with
 * a non-2xx status otherwise, so both shapes become a readable Error.
 *
 * @param prompt - the summary prompt built from the changelog document.
 * @returns the Markdown summary text.
 */
export async function fetchAiSummary(prompt: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, AI_SUMMARY_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(AI_SUMMARY_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ prompt }),
      signal: controller.signal,
    })
  } catch (error) {
    throw new Error(controller.signal.aborted
      ? `请求超时（超过 ${Math.round(AI_SUMMARY_TIMEOUT_MS / 1000)}s 无响应）`
      : `无法连接 AI 汇总路由（${messageOf(error)}）`)
  } finally {
    clearTimeout(timer)
  }

  const payload: unknown = await response.json().catch(() => undefined)
  if (!response.ok) throw new Error(await aiFailure(response, payload))
  if (!isRecord(payload) || payload.ok !== true) {
    throw new Error(aiErrorText(payload) ?? '更新日志生成结果为空')
  }
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  if (text === '') throw new Error('更新日志生成结果为空')
  return text
}

/** @returns the route's `{ error: { message } }` text, or a status summary. */
async function aiFailure(response: Response, payload: unknown): Promise<string> {
  return aiErrorText(payload) ?? `HTTP ${response.status}`
}

/** Read the route's `{ ok: false, error: { message } }` reason. */
function aiErrorText(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  const error = payload.error
  if (isRecord(error) && typeof error.message === 'string' && error.message !== '') return error.message
  if (typeof error === 'string' && error !== '') return error
  return undefined
}

/** Human-readable error text. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
