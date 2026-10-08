/**
 * Update detection for the auto-update host half.
 *
 * Modes, mirroring the shell's `local_check` / `check` plus the dialog's cached
 * reopen:
 *
 * - {@link localCheck} reads only local state (project list, package names,
 *   current version, GitHub releases page). It never touches the network, so
 *   the dialog can paint skeleton rows immediately, and it neither reads nor
 *   writes the cache.
 * - {@link check} runs the real detection, single-flighted: concurrent callers
 *   share one run and one result, so the startup badge probe and the dialog's
 *   own probe never fetch twice. It realigns the submodule remotes, starts the
 *   top-level recursive fetch and every row's remote-branch resolution together,
 *   compares each row against its remote default branch with local commands
 *   only, and finally probes the npm registry for every row in one bounded
 *   phase. The finished status is kept as the module's cache.
 * - {@link cachedCheck} returns the last finished `check` status (partial
 *   failures included), or `undefined` before the first one.
 *
 * Concurrency changes only the scheduling: `projects` keeps the manifest order
 * (root first), and every field is computed by the same local git reads the
 * serial implementation used. The comparison semantics are ported from
 * `src-tauri/src/update.rs` (`check_project` / `local_preview_project`); the
 * fetch strategy is the contract's single recursive fetch.
 */

import { isDirectory, listProjects, type ProjectRef } from './paths.ts'
import {
  gitFailure,
  gitFetch,
  gitOriginUrl,
  gitOutput,
  gitVersion,
  isGitRepo,
  reconcileSubmoduleRemotes,
  remoteDefaultBranch,
  runGit,
  tagIsStale,
  GIT_RECURSIVE_FETCH_TIMEOUT_MS,
  type GitCapture,
} from './git.ts'
import { releasesPageUrl } from './changelog.ts'
import { npmPackagesForProject, npmUpdateChecks, type NpmRequestSpec, type NpmUpdateInfo } from './npm.ts'

/** The command the user runs after an update; the dialog prints it verbatim. */
export const BUILD_COMMAND = 'npm run build:desktop'

/** Git work running at once within one check phase. */
const CHECK_CONCURRENCY = 8

/** One repository row of the status response. */
export interface ProjectUpdate {
  /** Stable id: `dsh-gui` for the root, else the `.gitmodules` name. */
  id: string
  /** `package.json` name of the directory, else the id. */
  name: string
  /** Path relative to the repository root, POSIX; empty for the root row. */
  path: string
  /** Local version: exact tag, else short commit hash, else `"unknown"`. */
  current: string
  /** Latest version on the remote default branch; `"检查中…"` in local mode. */
  latest: string
  /** Newest tag reachable from the remote default branch, when one exists. */
  latestTag?: string
  /** True when `latestTag` is not strictly newer than the local HEAD. */
  latestTagStale: boolean
  /** True when a `behind` row should light the badge. */
  announce: boolean
  /** True when the remote default branch is strictly ahead of the local HEAD. */
  behind: boolean
  /** True while the row is a local-only preview. */
  checking: boolean
  /** Readable failure for this row, when it could not be checked. */
  error?: string
  /** The module's GitHub Releases *list* page, when its origin is GitHub. */
  releaseUrl?: string
  /** npm publish state for the row's newest tag; present only when it is useful. */
  npm?: NpmUpdateInfo
}

/** The complete status response. */
export interface UpdateStatus {
  projects: ProjectUpdate[]
  hasUpdates: boolean
  /** Rows with `behind`. */
  updateCount: number
  /** Rows with `behind && announce`. */
  notifyCount: number
  /** False when at least one row carries an error. */
  allChecked: boolean
  /** Unix seconds of the finished check; `null` in local mode. */
  checkedAt: number | null
  durationMs: number
  /** Absolute repository root the rows were resolved from. */
  root: string
  /** Post-update build command shown by the dialog. */
  buildCommand: string
}

/** Callbacks for a check's non-fatal diagnostics. */
export interface CheckOptions {
  /**
   * Receives the recursive fetch's failure summary. A partly failed recursive
   * fetch is not an overall failure: rows that still lack their remote branch
   * ref degrade to their own fetch, and the rest check normally.
   */
  onWarn?: (message: string) => void
}

/** One row's comparison result plus the npm probe it still needs. */
interface RowOutcome {
  row: ProjectUpdate
  npm?: NpmRequestSpec
}

/** The last finished `check` status; `undefined` before the first one. */
let cachedStatus: UpdateStatus | undefined

/** The check currently running, if any; concurrent callers share it. */
let inFlightCheck: Promise<UpdateStatus> | undefined

/**
 * The last finished `check` status, partial failures included — the dialog
 * renders it immediately on reopen instead of checking again.
 * @returns the cached status, or `undefined` when none exists yet.
 */
export function cachedCheck(): UpdateStatus | undefined {
  return cachedStatus
}

/**
 * The cold-start preview: the full project list plus local versions, every row
 * marked `checking`, and no network access at all. The rows are read with the
 * same bound as the full check — one `git` spawn per read, seven rows of them,
 * is what would otherwise leave the dialog blank for half a minute.
 * @param root - repository root.
 */
export async function localCheck(root: string): Promise<UpdateStatus> {
  const started = Date.now()
  const projects = await mapBounded(listProjects(root), CHECK_CONCURRENCY, (project) => localPreview(project))
  return summarize(root, projects, null, started)
}

/**
 * Check the root repository and every submodule.
 *
 * Concurrent callers share the run in flight with the first caller and receive
 * the same status object; the shared run is released as soon as it settles, so
 * the next explicit check starts a fresh one.
 *
 * @param root - repository root.
 * @param options - diagnostics sink for the recursive fetch.
 */
export async function check(root: string, options: CheckOptions = {}): Promise<UpdateStatus> {
  if (inFlightCheck !== undefined) return await inFlightCheck
  let shared: Promise<UpdateStatus>
  shared = runCheck(root, options).finally(() => {
    if (inFlightCheck === shared) inFlightCheck = undefined
  })
  inFlightCheck = shared
  return await shared
}

/** Run one detection without joining a run already in flight. */
async function runCheck(root: string, options: CheckOptions): Promise<UpdateStatus> {
  const started = Date.now()
  // A checkout that was moved (or created from a local origin) can carry the
  // previous location in its submodule remotes; realign them with `.gitmodules`
  // before fetching, so the check never reports a stale path.
  await reconcileSubmoduleRemotes(root)
  const projects = listProjects(root)

  // Phase one: the recursive fetch and every row's remote-branch resolution
  // start together — `ls-remote` does not depend on the fetch result, and the
  // fetch dominates the wall clock.
  const fetchTask = fetchRecursive(root)
  const branches = await mapBounded(projects, CHECK_CONCURRENCY, (project) => resolveRemoteBranch(project))
  const fetchError = await fetchTask
  if (fetchError !== undefined) options.onWarn?.(fetchError)

  // Phase two: per-row local comparison, bounded; rows keep their manifest order.
  const rows: ProjectUpdate[] = new Array(projects.length)
  const npmRequests: Array<{ row: number; spec: NpmRequestSpec }> = []
  await forEachBounded(projects, CHECK_CONCURRENCY, async (project, index) => {
    try {
      const outcome = await checkProject(project, branches[index])
      rows[index] = outcome.row
      if (outcome.npm !== undefined) npmRequests.push({ row: index, spec: outcome.npm })
    } catch (error: unknown) {
      rows[index] = failedRow(project, error)
    }
  })

  // Phase three: every npm probe across all rows, in one bounded phase with its
  // own budget; npm never affects a row's git state.
  if (npmRequests.length > 0) {
    npmRequests.sort((left, right) => left.row - right.row)
    const infos = await npmUpdateChecks(npmRequests.map((entry) => entry.spec))
    npmRequests.forEach((entry, index) => { rows[entry.row]!.npm = infos[index]! })
  }

  const status = summarize(root, rows, Math.floor(Date.now() / 1000), started)
  cachedStatus = status
  return status
}

/** Local-only preview of one project. */
async function localPreview(project: ProjectRef): Promise<ProjectUpdate> {
  const row: ProjectUpdate = {
    id: project.id,
    name: project.name,
    path: project.path,
    current: 'unknown',
    latest: '检查中…',
    latestTagStale: false,
    announce: true,
    behind: false,
    checking: true,
  }
  if (isDirectory(project.dir) && await isGitRepo(project.dir)) {
    const sha = await gitOutput(['rev-parse', 'HEAD'], project.dir)
    if (sha !== undefined) row.current = await gitVersion(project.dir, sha)
  }
  const releaseUrl = await releasePageFor(project)
  if (releaseUrl !== undefined) row.releaseUrl = releaseUrl
  return row
}

/**
 * The remote default branch of one row, or `undefined` when the row cannot
 * answer it (missing directory, not a repository, no origin, or no branch).
 * Runs while the recursive fetch is still in flight.
 */
async function resolveRemoteBranch(project: ProjectRef): Promise<string | undefined> {
  if (!isDirectory(project.dir)) return undefined
  if (!await isGitRepo(project.dir)) return undefined
  if (await gitOriginUrl(project.dir) === undefined) return undefined
  return await remoteDefaultBranch(project.dir)
}

/** Compare one repository against its `origin` default branch. */
async function checkProject(project: ProjectRef, branch: string | undefined): Promise<RowOutcome> {
  const row: ProjectUpdate = {
    id: project.id,
    name: project.name,
    path: project.path,
    current: 'unknown',
    latest: '—',
    latestTagStale: false,
    announce: true,
    behind: false,
    checking: false,
  }
  const releaseUrl = await releasePageFor(project)
  if (releaseUrl !== undefined) row.releaseUrl = releaseUrl

  if (!isDirectory(project.dir)) {
    row.error = '目录不存在，请先初始化该 submodule'
    return { row }
  }
  if (!await isGitRepo(project.dir)) {
    row.error = '不是 git 仓库'
    return { row }
  }
  if (await gitOriginUrl(project.dir) === undefined) {
    row.error = '没有 origin 远程'
    return { row }
  }

  const currentSha = await gitOutput(['rev-parse', 'HEAD'], project.dir)
  if (currentSha === undefined) {
    row.error = '无法读取本地 HEAD'
    return { row }
  }
  row.current = await gitVersion(project.dir, currentSha)

  // Resolved in phase one: against the remote when it answers, against the local
  // `refs/remotes/origin/HEAD` when it does not.
  if (branch === undefined) {
    row.error = '无法确定远端默认分支'
    return { row }
  }
  const latestRef = `origin/${branch}`
  let latestSha = await gitOutput(['rev-parse', latestRef], project.dir)
  if (latestSha === undefined) {
    // The recursive fetch did not leave this row's remote branch ref locally
    // (the submodule was skipped, never populated, or its own fetch failed).
    // Degrade to fetching just this row; that failure is this row's error.
    const fetchError = await gitFetch(project.dir)
    if (fetchError !== undefined) {
      row.error = fetchError
      return { row }
    }
    latestSha = await gitOutput(['rev-parse', latestRef], project.dir)
    if (latestSha === undefined) {
      row.error = `远端缺少 ${latestRef}`
      return { row }
    }
  }
  row.latest = await gitVersion(project.dir, latestRef)
  // The "latest tag" update target: the newest tag reachable from the remote
  // default branch. Absent when the branch carries no tags.
  row.latestTag = await gitOutput(['describe', '--tags', '--abbrev=0', latestRef], project.dir)
  // A tag that is not strictly newer than the local HEAD (older, or the very
  // commit currently checked out) is never a usable update target.
  row.latestTagStale = row.latestTag !== undefined && await tagIsStale(project.dir, row.latestTag)

  if (currentSha !== latestSha) {
    const count = await gitOutput(['rev-list', '--count', `${currentSha}..${latestRef}`], project.dir)
    const behind = Number.parseInt(count ?? '0', 10)
    row.behind = Number.isFinite(behind) && behind > 0
    // The badge only announces new-tag updates: while the checkout sits exactly
    // on a tag and the remote adds commits beyond it without a newer tag, the
    // update stays visible in the dialog but is not counted into the badge.
    if (row.behind) {
      const onExactTag = await gitOutput(['describe', '--tags', '--exact-match', 'HEAD'], project.dir) !== undefined
      const hasNewerTag = row.latestTag !== undefined && !row.latestTagStale
      row.announce = !(onExactTag && !hasNewerTag)
      // npm-installed packages: report whether the tag's version is already
      // published, so the dialog can warn that the installed plugins lag behind
      // the source checkout. The probes run in phase three, across all rows.
      if (hasNewerTag && row.latestTag !== undefined) {
        const packages = npmPackagesForProject(project.dir)
        if (packages.length > 0) return { row, npm: { packages, tag: row.latestTag } }
      }
    }
  }
  return { row }
}

/**
 * A row whose comparison threw unexpectedly: the response keeps one row per
 * project and reports the failure instead of failing the whole request.
 */
function failedRow(project: ProjectRef, error: unknown): ProjectUpdate {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    current: 'unknown',
    latest: '—',
    latestTagStale: false,
    announce: true,
    behind: false,
    checking: false,
    error: `检查失败：${error instanceof Error ? error.message : String(error)}`,
  }
}

/** The row's GitHub Releases list page, from its origin (manifest URL fallback). */
async function releasePageFor(project: ProjectRef): Promise<string | undefined> {
  const origin = await gitOriginUrl(project.dir) ?? project.url
  return releasesPageUrl(origin)
}

/**
 * The check's single recursive fetch, with the git-side parallel job count.
 * A git that does not know `-j` is retried once without it, so the flag never
 * turns a working fetch into a failed row.
 * @returns `undefined` on success, else the failure summary.
 */
async function fetchRecursive(root: string): Promise<string | undefined> {
  const withJobs = await runGit(
    ['fetch', '--prune', '--recurse-submodules', '-j', '8', 'origin'],
    root,
    GIT_RECURSIVE_FETCH_TIMEOUT_MS,
  )
  if (withJobs.ok) return undefined
  if (!rejectsJobsFlag(withJobs)) return gitFailure(withJobs, 'git fetch --recurse-submodules')
  const withoutJobs = await runGit(
    ['fetch', '--prune', '--recurse-submodules', 'origin'],
    root,
    GIT_RECURSIVE_FETCH_TIMEOUT_MS,
  )
  return withoutJobs.ok ? undefined : gitFailure(withoutJobs, 'git fetch --recurse-submodules')
}

/** Whether a failed fetch rejected the `-j` flag itself. */
function rejectsJobsFlag(capture: GitCapture): boolean {
  const detail = `${capture.stderr}\n${capture.stdout}`
  return /unknown option/i.test(detail) || /usage:/i.test(detail)
}

/** Run `worker` over `items` with at most `limit` in flight at once. */
async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      await worker(items[index]!, index)
    }
  })
  await Promise.all(runners)
}

/** {@link forEachBounded} keeping the results in the input's order. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  await forEachBounded(items, limit, async (item, index) => {
    results[index] = await worker(item, index)
  })
  return results
}

/** Fold the finished rows into the wire status. */
function summarize(root: string, projects: ProjectUpdate[], checkedAt: number | null, started: number): UpdateStatus {
  const updateCount = projects.filter((row) => row.behind).length
  return {
    projects,
    hasUpdates: updateCount > 0,
    updateCount,
    notifyCount: projects.filter((row) => row.behind && row.announce).length,
    allChecked: projects.every((row) => row.error === undefined),
    checkedAt,
    durationMs: Date.now() - started,
    root,
    buildCommand: BUILD_COMMAND,
  }
}
