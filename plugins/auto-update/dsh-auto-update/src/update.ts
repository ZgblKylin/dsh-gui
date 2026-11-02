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
 * Batch semantics: the request is executed in units — one git row per unit, and
 * one unit for every npm plugin row that shares an install script. This is what
 * makes "update all" cheap on the multi-package wrappers (deep-whale pins three
 * skins): their pins move together and the wrapper re-runs once instead of once
 * per package. A unit's `target` events are emitted together in request order
 * when the unit finishes, so a request that interleaves a git row between two
 * rows of one script shows those rows grouped in the stream (the client renders
 * the stream append-only, so the grouping only helps the reader).
 *
 * Known limitation: a package pinned by two different install scripts resolves
 * to one row id (`npm:<packageName>`) and the row lookup keeps the first script
 * in scan order, so only that script is updated. No wrapper currently repeats a
 * package.
 *
 * Safety rails, per the contract:
 * - only the root checkout, `.gitmodules`-declared submodule directories, and
 *   plugin install scripts under `plugins/` are ever targets; a request cannot
 *   name a path;
 * - `git clean` is never run;
 * - the only git writes are `git fetch`, `git reset --hard`, `git submodule
 *   update`, and the `.gitmodules`-driven submodule-remote repair in `./git.ts`;
 * - an npm plugin row writes exactly one file — its install script — and only
 *   after re-reading the row it resolved, so a stale dialog cannot rewrite a
 *   script that no longer pins the package.
 */

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
import { listPluginNpmRows, type PluginNpmRow } from './plugin-specs.ts'
import { npmPackageLatest } from './npm.ts'
import { isNewerVersion } from './version.ts'

/**
 * Timeout for one wrapper reinstall. The wrapper runs the pinned pnpm and
 * `dsh plugin add` against the profile, which is slow but finite; a hung
 * installer must not keep the dialog's NDJSON stream open forever.
 */
const UPDATE_INSTALL_TIMEOUT_MS = 10 * 60_000

/** One requested target, after validation. */
export interface UpdateTarget {
  id: string
  mode: 'tag' | 'commit'
}

/** A validated target bound to its source: a git checkout or an npm plugin row. */
export interface ResolvedTarget {
  id: string
  mode: 'tag' | 'commit'
  /** Row source: `git` rows move a checkout, `npm` rows rewrite an install pin. */
  kind: 'git' | 'npm'
  /** Git rows: the checkout row this id resolved to. */
  project?: ProjectRef
  /** npm rows: the install row this id resolved to. */
  plugin?: PluginNpmRow
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
 * Bind requested target ids to the checkout's real rows — the git project list
 * first, then the npm plugin rows from `./plugin-specs.ts`.
 * @param root - repository root.
 * @param requested - validated request entries.
 * @returns one resolved target per entry, in request order.
 * @throws {UpdateRequestError} with status 400 when an id matches no row.
 */
export async function resolveUpdateTargets(
  root: string,
  requested: readonly UpdateTarget[],
): Promise<ResolvedTarget[]> {
  const projects = listProjects(root)
  const plugins = await listPluginNpmRows(root)
  return requested.map((target) => {
    const project = projects.find((row) => row.id === target.id)
    if (project !== undefined) {
      return { id: target.id, mode: target.mode, kind: 'git', project }
    }
    const plugin = plugins.find((row) => row.id === target.id)
    if (plugin !== undefined) {
      return { id: target.id, mode: target.mode, kind: 'npm', plugin }
    }
    throw new UpdateRequestError(`未知目标：${target.id}`, 400)
  })
}

/**
 * Run one update, emitting NDJSON events: `begin`, then every requested id's
 * `target` event (its `log*` lines precede it), then `end`. A failing target
 * never aborts the run — the remaining targets still execute, and `end.ok`
 * reports whether every target succeeded.
 *
 * The request is split into execution units (see {@link buildUpdateUnits}).
 * Units run in the request order of their first target; each unit's `target`
 * events are emitted together, in request order, once the unit finishes. Every
 * requested id gets exactly one `target` event.
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
  for (const unit of buildUpdateUnits(targets)) {
    const unitOk = await runUpdateUnit(root, unit, emit)
    if (!unitOk) ok = false
  }
  emit({ type: 'end', ok, buildCommand: BUILD_COMMAND })
}

/** One execution unit: a git row alone, or every npm row of one install script. */
interface UpdateUnit {
  /** The requested targets this unit completes, in request order. */
  targets: ResolvedTarget[]
}

/**
 * Group the request into execution units.
 *
 * A git row is a unit of its own; npm plugin rows that share an install script
 * are one unit so the script is rewritten and re-run once. Units keep the
 * request order of their first target, and each unit's targets keep the request
 * order too (a Map preserves insertion order).
 */
function buildUpdateUnits(targets: readonly ResolvedTarget[]): UpdateUnit[] {
  const units: UpdateUnit[] = []
  const byScript = new Map<string, UpdateUnit>()
  for (const target of targets) {
    const script = target.kind === 'npm' ? target.plugin?.installScript : undefined
    if (script === undefined) {
      units.push({ targets: [target] })
      continue
    }
    const existing = byScript.get(script)
    if (existing !== undefined) {
      existing.targets.push(target)
      continue
    }
    const unit: UpdateUnit = { targets: [target] }
    byScript.set(script, unit)
    units.push(unit)
  }
  return units
}

/** Run one unit and emit exactly one `target` event per target in it. */
async function runUpdateUnit(
  root: string,
  unit: UpdateUnit,
  emit: (event: UpdateEvent) => void,
): Promise<boolean> {
  const first = unit.targets[0]
  if (first === undefined) return true
  if (first.kind === 'npm') return await runNpmUnit(root, unit.targets, emit)
  // A git unit holds exactly one target (buildUpdateUnits never groups them).
  const log = (line: string): void => { emit({ type: 'log', id: first.id, line }) }
  try {
    const detail = await updateOne(root, first, log)
    emit({ type: 'target', id: first.id, ok: true, detail })
    return true
  } catch (error: unknown) {
    emit({ type: 'target', id: first.id, ok: false, error: message(error) })
    return false
  }
}

/**
 * Run one install-script unit: one registry phase, one rewrite, one reinstall,
 * then one `target` event per row in request order.
 */
async function runNpmUnit(
  root: string,
  targets: readonly ResolvedTarget[],
  emit: (event: UpdateEvent) => void,
): Promise<boolean> {
  const outcomes = await updateNpmGroup(root, targets, (target, line) => {
    emit({ type: 'log', id: target.id, line })
  })
  let ok = true
  for (const outcome of outcomes) {
    if (outcome.error !== undefined) {
      ok = false
      emit({ type: 'target', id: outcome.id, ok: false, error: outcome.error })
    } else {
      emit({ type: 'target', id: outcome.id, ok: true, detail: outcome.detail ?? '已更新' })
    }
  }
  return ok
}

/**
 * Update one git checkout target.
 * @returns the success detail line (`已更新到 …`).
 * @throws {Error} with a readable Chinese message on any failure.
 */
async function updateOne(root: string, target: ResolvedTarget, log: (line: string) => void): Promise<string> {
  // npm rows never reach this function: runUpdateUnit routes them to
  // updateNpmGroup, which batches a script's rows into one reinstall.
  const project = target.project
  if (project === undefined) throw new Error('git 目标缺少工程信息')
  const { mode } = target
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

/** One member of an install-script group, with its resolved update state. */
interface NpmGroupItem {
  target: ResolvedTarget
  /** The install row re-scanned for this run; present unless the script lost it. */
  row?: PluginNpmRow
  /** The registry version the row must move to; present when it needs a rewrite. */
  nextVersion?: string
  /** A readable per-row failure; already final. */
  error?: string
  /** The success detail for a row that needs no move. */
  detail?: string
}

/** One finished row of an install-script group. */
interface NpmGroupOutcome {
  id: string
  detail?: string
  error?: string
}

/**
 * Update every requested row of one install script.
 *
 * A batch over several packages of one wrapper is the normal case (deep-whale
 * pins three skins): the script is read and rewritten once, all pins move
 * together, and the wrapper re-runs once. Each step isolates its own failures:
 *
 * - a row whose package disappeared from the script fails alone;
 * - a row whose registry query fails fails alone and never blocks the others;
 * - a row already at the registry version reports `已是最新（<pin>）` and is not
 *   part of the rewrite;
 * - the remaining rows are written together; if one pin can no longer be
 *   replaced (the script changed under the dialog) nothing is written and the
 *   rows that needed a move fail together;
 * - if the installer fails or times out, the script is restored from the
 *   in-memory backup and those rows fail with the same reason.
 *
 * @param root - repository root.
 * @param targets - the group's requested targets, in request order.
 * @param logFor - progress sink bound to one row's id.
 * @returns one outcome per target, in request order.
 */
async function updateNpmGroup(
  root: string,
  targets: readonly ResolvedTarget[],
  logFor: (target: ResolvedTarget, line: string) => void,
): Promise<NpmGroupOutcome[]> {
  const items: NpmGroupItem[] = targets.map((target) => ({ target }))
  // Re-scan instead of trusting the resolved rows: the dialog may have been
  // open while the script changed on disk (another editor, a git pull).
  const rows = await listPluginNpmRows(root)
  for (const item of items) {
    const plugin = item.target.plugin
    if (plugin === undefined) {
      item.error = 'npm 插件目标缺少安装信息'
      continue
    }
    const row = rows.find((candidate) => candidate.id === plugin.id)
    if (row === undefined) {
      item.error = `安装脚本中已找不到插件「${plugin.packageName}」，请重新打开更新对话框`
      continue
    }
    if (row.installScript !== plugin.installScript) {
      item.error = `插件「${plugin.packageName}」的安装脚本已变化，请重新打开更新对话框`
      continue
    }
    item.row = row
  }

  // One registry phase for the whole group. A failed package only marks its own
  // row, so the other pins still move.
  const pending = items.filter((item) => item.row !== undefined)
  if (pending.length > 0) {
    const answers = await npmPackageLatest(pending.map((item) => item.row!.packageName))
    pending.forEach((item, index) => {
      const row = item.row!
      const answer = answers[index]
      if (answer === undefined) {
        item.error = 'npm registry 未返回版本信息'
        return
      }
      if (answer.error !== undefined) {
        item.error = `npm 版本查询失败：${answer.error}`
        return
      }
      if (answer.latest === undefined) {
        item.error = 'npm registry 未返回版本号'
        return
      }
      if (!isNewerVersion(answer.latest, row.pinnedVersion)) {
        item.detail = `已是最新（${row.pinnedVersion}）`
        return
      }
      item.nextVersion = answer.latest
    })
  }

  // Only the rows that need a move take part in the shared rewrite/reinstall.
  const updates = items.filter((item) => item.nextVersion !== undefined)
  if (updates.length > 0) await applyNpmGroup(root, updates, logFor)

  return items.map((item) => {
    if (item.error !== undefined) return { id: item.target.id, error: item.error }
    if (item.detail !== undefined) return { id: item.target.id, detail: item.detail }
    return { id: item.target.id, detail: '已更新' }
  })
}

/**
 * Rewrite a group's pins into its install script and re-run the wrapper once.
 *
 * The script is the only file written. Its previous content is the in-memory
 * backup written back when the wrapper fails (non-zero exit, spawn error, or the
 * install timeout), so a failed reinstall never strands the checkout on pins the
 * profile does not have. On success every member gets its own
 * `已更新到 <version>` detail.
 *
 * @param root - repository root.
 * @param items - the group members that need a version move.
 * @param logFor - progress sink bound to one row's id.
 */
async function applyNpmGroup(
  root: string,
  items: readonly NpmGroupItem[],
  logFor: (target: ResolvedTarget, line: string) => void,
): Promise<void> {
  const first = items[0]!
  // Every member shares the group's install script; the re-scanned rows agree
  // with the group key (updateNpmGroup rejects a moved script).
  const installScript = first.row!.installScript
  const scriptPath = join(root, ...installScript.split('/'))
  let original: string
  try {
    original = readFileSync(scriptPath, 'utf8')
  } catch (error: unknown) {
    failNpmGroup(items, `无法读取安装脚本 ${installScript}：${message(error)}`)
    return
  }

  let rewritten = original
  for (const item of items) {
    const member = item.row!
    const nextSpec = `${member.packageName}@${item.nextVersion!}`
    try {
      rewritten = replacePinnedVersion(rewritten, member.spec, nextSpec)
    } catch (error: unknown) {
      // A pin that is no longer in the script means the file changed under the
      // dialog; aborting the whole write keeps it from landing half updated.
      failNpmGroup(items, `${message(error)}（请重新打开更新对话框）`)
      return
    }
    logFor(item.target, `已把安装脚本 ${installScript} 的 pin 改为 ${nextSpec}`)
  }

  try {
    writeFileSync(scriptPath, rewritten)
  } catch (error: unknown) {
    // The write may have clipped the file before failing; best-effort restore so
    // the checkout keeps the pins that match what is installed.
    try {
      writeFileSync(scriptPath, original)
    } catch {
      // The restore failed too; the error below reports the original write.
    }
    failNpmGroup(items, `无法写入安装脚本 ${installScript}：${message(error)}`)
    return
  }

  try {
    // The wrapper writes the profile state; its output is streamed under the
    // group's first row id so the stream stays readable.
    await runInstallScript(root, scriptPath, (line) => logFor(first.target, line))
  } catch (error: unknown) {
    let rollback = '已把安装脚本回滚到原内容'
    try {
      writeFileSync(scriptPath, original)
    } catch (rollbackError: unknown) {
      rollback = `安装脚本回滚失败：${message(rollbackError)}`
    }
    failNpmGroup(items, `${message(error)}（${rollback}）`)
    return
  }
  logFor(first.target, '安装脚本已按新 pin 重新安装')
  for (const item of items) item.detail = `已更新到 ${item.nextVersion!}`
}

/** Mark every member of one group with the same failure. */
function failNpmGroup(items: readonly NpmGroupItem[], error: string): void {
  for (const item of items) item.error = error
}

/**
 * Rewrite every occurrence of one exact spec literal in an install script.
 *
 * The pin is a plain string literal (`'pkg@1.2.3'`), so a literal split/join is
 * exactly what the source needs; a regex would have to escape the package name
 * and could still match a longer version sharing the prefix. Every occurrence is
 * replaced, because a constant and a comment that mirror the pin describe the
 * same install target.
 *
 * @param text - the script's current content.
 * @param oldSpec - the pinned spec as the row parser read it.
 * @param newSpec - the spec to write (`<name>@<version>`).
 * @returns the rewritten content.
 * @throws {Error} when `oldSpec` is empty or absent (the script changed under
 *   the dialog), or when the result does not contain `newSpec`.
 */
export function replacePinnedVersion(text: string, oldSpec: string, newSpec: string): string {
  if (oldSpec === '') throw new Error('安装脚本中的 spec 为空，无法替换')
  if (newSpec === '') throw new Error('目标 spec 为空，无法替换')
  if (!text.includes(oldSpec)) throw new Error(`安装脚本中已找不到 ${oldSpec}`)
  const updated = text.split(oldSpec).join(newSpec)
  if (!updated.includes(newSpec)) throw new Error(`安装脚本中没有写入 ${newSpec}`)
  return updated
}

/**
 * Re-run one wrapper installer and stream its output as log lines.
 *
 * The profile is selected with `DSH_PLUGIN_PROFILE` exactly like the desktop
 * build does (`DSH_PROFILE` names the profile this host runs in, `desktop` is
 * the default because the auto-update plugin itself is desktop-only).
 * `DSH_PLUGIN_MIN_AGE=0` bypasses pnpm's release-age gate for the freshly
 * published version, mirroring the wrapper convention. `DSH_HOME` is inherited
 * from `process.env` untouched, so the reinstall lands in the same home the host
 * was built against. The installer is killed after
 * {@link UPDATE_INSTALL_TIMEOUT_MS}; the caller sees the timeout as a regular
 * failure and rolls the install script back.
 *
 * @throws {Error} on a non-zero exit, a spawn failure, or the install timeout.
 */
function runInstallScript(root: string, scriptPath: string, log: (line: string) => void): Promise<void> {
  const profile = process.env.DSH_PROFILE?.trim() || 'desktop'
  return new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(process.execPath, [scriptPath], {
        cwd: root,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DSH_PLUGIN_PROFILE: profile,
          DSH_PLUGIN_MIN_AGE: '0',
        },
      })
    } catch (error: unknown) {
      // spawn can throw synchronously (policy/permission denial, malformed
      // arguments) instead of emitting `error`; report it like a spawn failure
      // so the caller's rollback path is the same either way.
      reject(new Error(`无法启动安装脚本：${message(error)}`))
      return
    }
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
    }, UPDATE_INSTALL_TIMEOUT_MS)
    // stdout and stderr are buffered separately so a partial line from one
    // stream never fuses with a partial line from the other.
    const stdout = lineForwarder(log)
    const stderr = lineForwarder(log)
    child.stdout?.on('data', (chunk: Buffer) => { stdout.push(chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr.push(chunk) })
    child.on('error', (error: unknown) => {
      clearTimeout(timeout)
      reject(new Error(`无法启动安装脚本：${message(error)}`))
    })
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeout)
      stdout.flush()
      stderr.flush()
      if (timedOut) reject(new Error('安装脚本超时（10 分钟）'))
      else if (code === 0) resolve()
      else if (code === null) reject(new Error(`安装脚本被信号 ${signal ?? '未知'} 终止`))
      else reject(new Error(`安装脚本退出码 ${code}`))
    })
  })
}

/** Split one child stream into lines, forwarding each line to the log sink. */
function lineForwarder(log: (line: string) => void): { push: (chunk: Buffer) => void; flush: () => void } {
  let buffer = ''
  return {
    push(chunk: Buffer): void {
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) log(line)
    },
    flush(): void {
      if (buffer !== '') {
        log(buffer)
        buffer = ''
      }
    },
  }
}
