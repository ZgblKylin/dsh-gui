/**
 * Update detection for the auto-update host half.
 *
 * Two modes, mirroring the shell's `local_check` / `check`:
 *
 * - {@link localCheck} reads only local state (project list, package names,
 *   current version, GitHub releases page). It never touches the network, so
 *   the dialog can paint skeleton rows immediately.
 * - {@link check} `git fetch`es the root and every submodule, then compares
 *   each checkout against its remote default branch: `behind`, the newest tag
 *   reachable from that branch (`latestTag`), whether that tag is a usable
 *   target (`latestTagStale`), and whether the row is worth a badge
 *   (`announce`).
 *
 * The semantics are ported from `src-tauri/src/update.rs` (`check_project` /
 * `local_preview_project`), minus everything the desktop scope froze out: no
 * npm publish status, no `pending-updates.json` plan, no update launcher, no
 * `npm` field on a row.
 */

import { isDirectory, listProjects, type ProjectRef } from './paths.ts'
import { gitFetch, gitOriginUrl, gitOutput, gitVersion, isGitRepo, reconcileSubmoduleRemotes, remoteDefaultBranch, tagIsStale } from './git.ts'
import { releasesPageUrl } from './changelog.ts'

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
 */
export async function check(root: string): Promise<UpdateStatus> {
  const started = Date.now()
  // A checkout that was moved (or created from a local origin) can carry the
  // previous location in its submodule remotes; realign them with `.gitmodules`
  // before fetching, so the check never reports a stale path.
  await reconcileSubmoduleRemotes(root)
  const projects: ProjectUpdate[] = []
  for (const project of listProjects(root)) projects.push(await checkProject(project))
  return summarize(root, projects, Math.floor(Date.now() / 1000), started)
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

  const fetchError = await gitFetch(project.dir)
  if (fetchError !== undefined) {
    row.error = fetchError
    return row
  }
  const branch = await remoteDefaultBranch(project.dir)
  if (branch === undefined) {
    row.error = '无法确定远端默认分支'
    return row
  }
  const latestRef = `origin/${branch}`
  const latestSha = await gitOutput(['rev-parse', latestRef], project.dir)
  if (latestSha === undefined) {
    row.error = `远端缺少 ${latestRef}`
    return row
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
