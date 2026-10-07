/**
 * Update detection for the auto-update host half.
 *
 * Three modes, mirroring the shell's `local_check` / `check` plus the dialog's
 * cached reopen:
 *
 * - {@link localCheck} reads only local state (project list, package names,
 *   current version, GitHub releases page). It never touches the network, so
 *   the dialog can paint skeleton rows immediately, and it neither reads nor
 *   writes the cache.
 * - {@link check} realigns the submodule remotes, runs **one** recursive
 *   `git fetch --prune --recurse-submodules origin` at the top level, and then
 *   compares every row against its remote default branch with local commands
 *   only: `behind`, the newest tag reachable from that branch (`latestTag`),
 *   whether that tag is a usable target (`latestTagStale`), whether the row is
 *   worth a badge (`announce`), and — for a row whose newest tag is a usable
 *   update — the npm publish state of the packages it installs. The finished
 *   status is kept as the module's cache.
 * - {@link cachedCheck} returns the last finished `check` status (partial
 *   failures included), or `undefined` before the first one.
 *
 * The comparison semantics are ported from `src-tauri/src/update.rs`
 * (`check_project` / `local_preview_project`); the fetch strategy is the v2
 * contract's single recursive fetch, and the npm state lives in `./npm.ts`.
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
} from './git.ts'
import { releasesPageUrl } from './changelog.ts'
import { npmPackagesForProject, npmUpdateCheck, type NpmUpdateInfo } from './npm.ts'

/** The command the user runs after an update; the dialog prints it verbatim. */
export const BUILD_COMMAND = 'npm run build:desktop'

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

/** The last finished `check` status; `undefined` before the first one. */
let cachedStatus: UpdateStatus | undefined

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
 * marked `checking`, and no network access at all.
 * @param root - repository root.
 */
export async function localCheck(root: string): Promise<UpdateStatus> {
  const started = Date.now()
  const projects: ProjectUpdate[] = []
  for (const project of listProjects(root)) projects.push(await localPreview(project))
  return summarize(root, projects, null, started)
}

/**
 * Check the root repository and every submodule.
 * @param root - repository root.
 * @param options - diagnostics sink for the recursive fetch.
 */
export async function check(root: string, options: CheckOptions = {}): Promise<UpdateStatus> {
  const started = Date.now()
  // A checkout that was moved (or created from a local origin) can carry the
  // previous location in its submodule remotes; realign them with `.gitmodules`
  // before fetching, so the check never reports a stale path.
  await reconcileSubmoduleRemotes(root)
  // One recursive fetch refreshes the root and every populated submodule's
  // remote-tracking refs. A non-zero exit is recorded, not fatal: the rows that
  // did not get their ref are repaired individually below.
  const capture = await runGit(['fetch', '--prune', '--recurse-submodules', 'origin'], root, GIT_RECURSIVE_FETCH_TIMEOUT_MS)
  if (!capture.ok) options.onWarn?.(gitFailure(capture, 'git fetch --recurse-submodules'))
  const projects: ProjectUpdate[] = []
  for (const project of listProjects(root)) projects.push(await checkProject(project))
  const status = summarize(root, projects, Math.floor(Date.now() / 1000), started)
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

/** Compare one repository against its `origin` default branch. */
async function checkProject(project: ProjectRef): Promise<ProjectUpdate> {
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
    return row
  }
  if (!await isGitRepo(project.dir)) {
    row.error = '不是 git 仓库'
    return row
  }
  if (await gitOriginUrl(project.dir) === undefined) {
    row.error = '没有 origin 远程'
    return row
  }

  const currentSha = await gitOutput(['rev-parse', 'HEAD'], project.dir)
  if (currentSha === undefined) {
    row.error = '无法读取本地 HEAD'
    return row
  }
  row.current = await gitVersion(project.dir, currentSha)

  // The remote is asked first so a stale local `refs/remotes/origin/HEAD`
  // symbolic ref can never point the row at an old branch.
  const branch = await remoteDefaultBranch(project.dir)
  if (branch === undefined) {
    row.error = '无法确定远端默认分支'
    return row
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
      return row
    }
    latestSha = await gitOutput(['rev-parse', latestRef], project.dir)
    if (latestSha === undefined) {
      row.error = `远端缺少 ${latestRef}`
      return row
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
      // the source checkout. A failure here never fails the git row.
      if (hasNewerTag && row.latestTag !== undefined) {
        const packages = npmPackagesForProject(project.dir)
        if (packages.length > 0) row.npm = await npmUpdateCheck(packages, row.latestTag)
      }
    }
  }
  return row
}

/** The row's GitHub Releases list page, from its origin (manifest URL fallback). */
async function releasePageFor(project: ProjectRef): Promise<string | undefined> {
  const origin = await gitOriginUrl(project.dir) ?? project.url
  return releasesPageUrl(origin)
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
