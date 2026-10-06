/**
 * In-place update execution for the auto-update host half.
 *
 * One `POST /auto-update/api/update` request names the rows to move and, per
 * row, the target kind: `commit` resets to the remote default branch HEAD, `tag`
 * resets to the newest tag reachable from that branch. The root row additionally
 * runs `git submodule update --init --recursive` afterwards, so every submodule
 * lands on the commit the new root revision records. A submodule row is updated
 * inside its own directory only, with no recursive sync.
 *
 * This is the *dialog* path, ported from `src-tauri/src/update.rs`
 * (`run_root_update` plus the launcher's per-project steps): it runs while the
 * application stays up, streams one NDJSON line per event, and leaves the
 * follow-up `npm run build:desktop` to the user. The detached updater, the
 * pending-updates plan, and the relaunch are all out of scope.
 *
 * Safety rails, per the contract:
 * - only the root checkout and `.gitmodules`-declared submodule directories are
 *   ever targets; a request cannot name a path;
 * - `git clean` is never run;
 * - the only writes are `git fetch`, `git reset --hard`, `git submodule update`,
 *   and the `.gitmodules`-driven submodule-remote repair in `./git.ts`.
 */

import { isDirectory, listProjects, type ProjectRef } from './paths.ts'
import {
  gitFailure,
  gitFetch,
  gitOutput,
  gitVersion,
  isGitRepo,
  reconcileSubmoduleRemotes,
  remoteDefaultBranch,
  runGit,
  GIT_SUBMODULE_TIMEOUT_MS,
} from './git.ts'
import { BUILD_COMMAND } from './check.ts'

/** One requested target, after validation. */
export interface UpdateTarget {
  id: string
  mode: 'tag' | 'commit'
}

/** A validated target bound to its directory. */
export interface ResolvedTarget {
  id: string
  mode: 'tag' | 'commit'
  project: ProjectRef
}

/** One NDJSON line of the update stream. */
export type UpdateEvent =
  | { type: 'begin'; targets: string[] }
  | { type: 'log'; id: string; line: string }
  | { type: 'target'; id: string; ok: true; detail: string }
  | { type: 'target'; id: string; ok: false; error: string }
  | { type: 'end'; ok: boolean; buildCommand: string }

/** A rejected update request; `status` is the HTTP status the route answers. */
export class UpdateRequestError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'UpdateRequestError'
    this.status = status
  }
}

/**
 * Validate the request body's shape into target descriptors.
 * @param body - parsed JSON body.
 * @returns the requested targets, deduplicated by id, in request order.
 * @throws {UpdateRequestError} with status 400 on any shape violation.
 */
export function parseUpdateTargets(body: unknown): UpdateTarget[] {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new UpdateRequestError('请求体必须是 JSON 对象，形如 {"targets":[{"id":"dsh-gui","mode":"tag"}]}', 400)
  }
  const raw = (body as { targets?: unknown }).targets
  if (!Array.isArray(raw)) throw new UpdateRequestError('targets 必须是数组', 400)
  const targets: UpdateTarget[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new UpdateRequestError('targets 的每一项必须是对象，形如 {"id":"dsh-gui","mode":"tag"}', 400)
    }
    const id = (item as { id?: unknown }).id
    if (typeof id !== 'string' || id.trim() === '') {
      throw new UpdateRequestError('targets 的每一项都必须带非空字符串 id', 400)
    }
    const mode = (item as { mode?: unknown }).mode ?? 'commit'
    if (mode !== 'tag' && mode !== 'commit') {
      throw new UpdateRequestError(`目标「${id.trim()}」的 mode 必须是 tag 或 commit`, 400)
    }
    const trimmed = id.trim()
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    targets.push({ id: trimmed, mode })
  }
  return targets
}

/**
 * Bind requested target ids to the checkout's real project rows.
 * @param root - repository root.
 * @param requested - validated request entries.
 * @throws {UpdateRequestError} with status 400 when an id matches no project.
 */
export function resolveUpdateTargets(root: string, requested: readonly UpdateTarget[]): ResolvedTarget[] {
  const projects = listProjects(root)
  return requested.map((target) => {
    const project = projects.find((row) => row.id === target.id)
    if (project === undefined) throw new UpdateRequestError(`未知目标：${target.id}`, 400)
    return { id: target.id, mode: target.mode, project }
  })
}

/**
 * Run one update, emitting NDJSON events in order: `begin`, then per target
 * `log*` followed by `target`, then `end`. A failing target never aborts the
 * run — the remaining targets still execute, and `end.ok` reports whether every
 * target succeeded.
 *
 * @param root - repository root.
 * @param targets - resolved targets (root first is the caller's choice).
 * @param emit - receives each event in order.
 */
export async function runUpdate(
  root: string,
  targets: readonly ResolvedTarget[],
  emit: (event: UpdateEvent) => void,
): Promise<void> {
  emit({ type: 'begin', targets: targets.map((target) => target.id) })
  let ok = true
  for (const target of targets) {
    const log = (line: string): void => { emit({ type: 'log', id: target.id, line }) }
    try {
      const detail = await updateOne(root, target, log)
      emit({ type: 'target', id: target.id, ok: true, detail })
    } catch (error: unknown) {
      ok = false
      emit({ type: 'target', id: target.id, ok: false, error: message(error) })
    }
  }
  emit({ type: 'end', ok, buildCommand: BUILD_COMMAND })
}

/**
 * Update one target.
 * @returns the success detail line (`已更新到 …`).
 * @throws {Error} with a readable Chinese message on any failure.
 */
async function updateOne(root: string, target: ResolvedTarget, log: (line: string) => void): Promise<string> {
  const { project, mode } = target
  const isRoot = project.id === 'dsh-gui'
  const label = isRoot ? '顶层工程' : `子模块「${project.id}」`
  const dir = project.dir

  if (isRoot) {
    // Same realignment as the check: the recursive submodule sync below must
    // not fetch through an absolute path from a previous checkout location.
    const repaired = await reconcileSubmoduleRemotes(root)
    if (repaired > 0) log(`已按 .gitmodules 修正 ${repaired} 个子模块的过期本地路径远端`)
  }
  if (!isDirectory(dir)) throw new Error('目录不存在，请先初始化该 submodule')
  if (!await isGitRepo(dir)) throw new Error('不是 git 仓库')
  if (await gitOutput(['remote', 'get-url', 'origin'], dir) === undefined) throw new Error('没有 origin 远程')

  log(`fetch origin（${label}）`)
  const fetchError = await gitFetch(dir)
  if (fetchError !== undefined) throw new Error(fetchError)

  const branch = await remoteDefaultBranch(dir)
  if (branch === undefined) throw new Error('无法确定远端默认分支')

  let resetTo: string
  if (mode === 'tag') {
    const tag = await gitOutput(['describe', '--tags', '--abbrev=0', `origin/${branch}`], dir)
    if (tag === undefined) throw new Error(`origin/${branch} 上没有可用 tag`)
    resetTo = tag
    log(`reset --hard 到最新 tag「${tag}」`)
  } else {
    resetTo = `origin/${branch}`
    log(`reset --hard 到 ${resetTo}`)
  }

  const reset = await runGit(['reset', '--hard', resetTo], dir)
  if (!reset.ok) throw new Error(gitFailure(reset, `git reset --hard ${resetTo}`))
  const version = await gitVersion(dir, 'HEAD')
  log(`${label}已更新到 ${version}`)

  if (isRoot) {
    log('递归同步子模块（git submodule update --init --recursive）…')
    const sync = await runGit(['submodule', 'update', '--init', '--recursive'], root, GIT_SUBMODULE_TIMEOUT_MS)
    if (!sync.ok) throw new Error(gitFailure(sync, '子模块同步'))
    log('子模块已同步到顶层修订记录的提交（个别子模块若自身还有更新，仍会在列表中单独显示）')
  }
  return `已更新到 ${version}`
}

/** @returns an error's message, or its string form. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
