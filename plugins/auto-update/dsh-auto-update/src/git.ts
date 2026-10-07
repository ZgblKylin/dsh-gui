/**
 * git invocation helpers for the auto-update host half.
 *
 * Every check and every update step goes through {@link runGit}, which wraps
 * `execFile('git', …)` with `windowsHide` (no console flash next to the
 * frameless shell), `GIT_TERMINAL_PROMPT=0` (a background check can never hang
 * on a credential prompt), an explicit timeout, and full stdout/stderr +
 * exit-code capture so a failure can be summarized into readable Chinese text.
 *
 * Nothing here decides *what* to update: the policy (which refs, which
 * directories) lives in `./check.ts`, `./update.ts`, and `./changelog.ts`. The
 * one exception is {@link reconcileSubmoduleRemotes}, the `.gitmodules`-driven
 * self-heal both the check and the update run before touching the network.
 */

import { execFile } from 'node:child_process'
import { isDirectory, submoduleEntries } from './paths.ts'

/** Timeout for one local git read (`rev-parse`, `describe`, `log`, …). */
export const GIT_LOCAL_TIMEOUT_MS = 60_000

/** Timeout for one network-touching git call (`fetch`, `ls-remote`). */
export const GIT_NETWORK_TIMEOUT_MS = 120_000

/**
 * Timeout for the check's single recursive fetch: it reaches the root and every
 * populated submodule, so it needs a larger budget than one plain fetch.
 */
export const GIT_RECURSIVE_FETCH_TIMEOUT_MS = 300_000

/** Timeout for one recursive submodule sync (may clone over the network). */
export const GIT_SUBMODULE_TIMEOUT_MS = 600_000

/** Upper bound on one git invocation's captured stdout/stderr. */
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024

/** One completed `git` invocation. */
export interface GitCapture {
  /** True when git exited 0. */
  ok: boolean
  /** Exit code, or `null` when the process never ran or was killed. */
  code: number | null
  /** True when `git` itself could not be spawned (git missing, policy denial). */
  spawnError: boolean
  /** True when the invocation hit its timeout and was terminated. */
  timedOut: boolean
  /** Captured standard output (empty on spawn failure). */
  stdout: string
  /** Captured standard error (empty on spawn failure). */
  stderr: string
}

/**
 * Run `git <args>` in `cwd`.
 * @param args - git arguments (never shell-interpreted).
 * @param cwd - working directory to run in.
 * @param timeoutMs - wall-clock budget; on expiry the child is killed.
 * @returns the captured result; never rejects.
 */
export async function runGit(
  args: readonly string[],
  cwd: string,
  timeoutMs: number = GIT_LOCAL_TIMEOUT_MS,
): Promise<GitCapture> {
  return await new Promise<GitCapture>((settle) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      },
      (error, stdout, stderr) => {
        const failure = error as (Error & { code?: unknown; killed?: boolean }) | null
        const numericCode = typeof failure?.code === 'number' ? failure.code : null
        const spawnError = failure !== null && typeof failure.code === 'string'
        settle({
          ok: failure === null,
          code: numericCode,
          spawnError,
          timedOut: failure !== null && !spawnError && numericCode === null && failure.killed === true,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
        })
      },
    )
  })
}

/**
 * Run `git <args>` in `cwd`, returning trimmed stdout only on success.
 * @returns the trimmed output, or `undefined` on failure or empty output.
 */
export async function gitOutput(
  args: readonly string[],
  cwd: string,
  timeoutMs: number = GIT_LOCAL_TIMEOUT_MS,
): Promise<string | undefined> {
  const capture = await runGit(args, cwd, timeoutMs)
  if (!capture.ok) return undefined
  const text = capture.stdout.trim()
  return text === '' ? undefined : text
}

/**
 * A short human-readable failure detail: the first three non-empty stderr lines
 * (stdout as fallback), trimmed to 300 characters.
 * @param capture - the completed invocation.
 */
export function gitErrorSummary(capture: GitCapture): string {
  const source = capture.stderr.trim() === '' ? capture.stdout : capture.stderr
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, 3)
    .join(' | ')
    .slice(0, 300)
}

/**
 * A readable Chinese failure message for one invocation.
 * @param capture - the completed invocation.
 * @param action - the human-readable action name, e.g. `git fetch`.
 */
export function gitFailure(capture: GitCapture, action: string): string {
  if (capture.spawnError) return '无法启动 git（PATH 或沙箱策略禁止创建进程）'
  if (capture.timedOut) return `${action} 超时（网络不可达或认证被阻止）`
  const detail = gitErrorSummary(capture)
  return detail === '' ? `${action} 失败（未知原因）` : `${action} 失败：${detail}`
}

/** Whether `dir` is inside a git working tree. */
export async function isGitRepo(dir: string): Promise<boolean> {
  return (await gitOutput(['rev-parse', '--is-inside-work-tree'], dir)) === 'true'
}

/** The repository's `origin` URL, or `undefined` when it has none. */
export async function gitOriginUrl(dir: string): Promise<string | undefined> {
  return await gitOutput(['remote', 'get-url', 'origin'], dir)
}

/**
 * A human-readable local version: the exact tag of `commitish` when one exists,
 * else its short commit hash, else `"unknown"`.
 */
export async function gitVersion(dir: string, commitish: string): Promise<string> {
  return (await gitOutput(['describe', '--tags', '--exact-match', commitish], dir))
    ?? (await gitOutput(['rev-parse', '--short', commitish], dir))
    ?? 'unknown'
}

/**
 * Whether `tag` is NOT strictly newer than the local HEAD (an ancestor of HEAD,
 * or the very commit HEAD is on). `git merge-base --is-ancestor` treats a commit
 * as its own ancestor, so one check covers both; resetting to such a tag would
 * downgrade or no-op, and the dialog disables that option.
 * @param dir - repository directory.
 * @param tag - tag name to test.
 * @returns true only when the tag resolves and is an ancestor of HEAD.
 */
export async function tagIsStale(dir: string, tag: string): Promise<boolean> {
  if ((await gitOutput(['rev-parse', `${tag}^{commit}`], dir)) === undefined) return false
  return (await runGit(['merge-base', '--is-ancestor', tag, 'HEAD'], dir)).ok
}

/**
 * The remote default branch (`origin/HEAD`). The remote is asked first so a
 * stale local `refs/remotes/origin/HEAD` symbolic ref can never point the
 * updater at an old branch; the local ref is only the fallback when the extra
 * network roundtrip fails.
 * @returns the bare branch name, or `undefined` when neither source answers.
 */
export async function remoteDefaultBranch(dir: string): Promise<string | undefined> {
  const symrefs = await gitOutput(['ls-remote', '--symref', 'origin', 'HEAD'], dir, GIT_NETWORK_TIMEOUT_MS)
  if (symrefs !== undefined) {
    for (const line of symrefs.split(/\r?\n/)) {
      const match = /^ref:\s+refs\/heads\/([^\t]+)\tHEAD$/.exec(line.trim())
      if (match?.[1] !== undefined) return match[1]
    }
  }
  return await localDefaultBranch(dir)
}

/**
 * The branch recorded by the local `refs/remotes/origin/HEAD` symbolic ref —
 * no network call. The changelog prefers this because the check that just ran
 * left it fresh.
 */
export async function localDefaultBranch(dir: string): Promise<string | undefined> {
  const symbolic = await gitOutput(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], dir)
  if (symbolic?.startsWith('origin/') !== true) return undefined
  const branch = symbolic.slice('origin/'.length)
  return branch === '' ? undefined : branch
}

/**
 * `git fetch --prune origin`.
 * @returns `undefined` on success, else a readable Chinese error.
 */
export async function gitFetch(dir: string): Promise<string | undefined> {
  const capture = await runGit(['fetch', '--prune', 'origin'], dir, GIT_NETWORK_TIMEOUT_MS)
  return capture.ok ? undefined : gitFailure(capture, 'git fetch')
}

/**
 * Whether a configured submodule URL is a filesystem path rather than a remote
 * URL — the signature of a path frozen by a checkout location that no longer
 * exists. `file://` URLs count as local paths for the same reason.
 */
export function isLocalPathUrl(url: string): boolean {
  const value = url.trim()
  if (value === '') return false
  if (value.slice(0, 7).toLowerCase() === 'file://') return true
  // Any real scheme (`https://`, `ssh://`, `git://`, …). An scp-like
  // `git@host:path` remote has no `://` and is handled below.
  if (value.includes('://')) return false
  if (value.startsWith('.') || value.startsWith('/') || value.startsWith('\\')) return true
  // Windows drive path (`E:/x`, `E:\x`) or UNC (`\\server\share`).
  return value.length >= 2 && value.charAt(1) === ':' && /[a-zA-Z]/.test(value.charAt(0))
}

/**
 * Re-point submodules whose recorded remote is a stale filesystem path at the
 * URL their `.gitmodules` entry records.
 *
 * Git freezes the URL it resolved at `git submodule update --init` time into the
 * superproject's own `submodule.<name>.url` override and into each submodule's
 * `remote.origin.url`. When the manifest carried a relative URL resolved against
 * a local origin — or the checkout once lived at another location — those frozen
 * values are absolute paths of a directory that no longer exists, so every fetch
 * fails for the affected submodules. `.gitmodules` is the authority: it lives
 * inside the checkout, so its URL resolves against the current root. Only
 * local-path values are repaired; a remote override (a mirror, a fork) is
 * deliberate configuration and stays untouched.
 *
 * @param root - repository root.
 * @returns how many configured values were repaired.
 */
export async function reconcileSubmoduleRemotes(root: string): Promise<number> {
  let repaired = 0
  for (const entry of submoduleEntries(root)) {
    const url = entry.url.trim()
    if (url === '' || isLocalPathUrl(url)) continue
    if (!isDirectory(entry.dir) || !(await isGitRepo(entry.dir))) continue
    const key = `submodule.${entry.name}.url`
    const configured = await gitOutput(['config', '--get', key], root)
    if (configured !== undefined && isLocalPathUrl(configured) && configured !== url) {
      if ((await runGit(['config', key, url], root)).ok) repaired += 1
    }
    const origin = await gitOriginUrl(entry.dir)
    if (origin !== undefined && isLocalPathUrl(origin) && origin !== url) {
      if ((await runGit(['remote', 'set-url', 'origin', url], entry.dir)).ok) repaired += 1
    }
  }
  return repaired
}
