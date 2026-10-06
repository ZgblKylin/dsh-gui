/**
 * The AI-update prompt builder.
 *
 * Semantics are ported from `src-tauri/ui/app.js` (the shell's
 * `buildAiUpdatePrompt`, `buildHarnessUpdatePrompt`, `buildHarnessMergedPrompt`,
 * `aiModuleRow`, `AI_UPDATE_GATE_NOTE`): the prompt carries only the facts the
 * skill cannot know — which modules, at which paths, to which target — while
 * the two-phase upgrade procedure itself is loaded by the `/dsh-gui-update`
 * gesture at the head of the draft.
 *
 * The one systematic difference is the desktop context:
 *
 * - the build command is `npm run build:desktop` throughout (the shell's note
 *   names the shell's own full rebuild, which is not the desktop app's build);
 * - the workspace note states that dsh-ai-update already selected the dsh-gui
 *   workspace and switched the session to the 「创造模式」 preset, instead of
 *   asking the model to confirm a workspace the shell cannot select;
 * - the acceptance gate keeps the shell's criteria verbatim in substance:
 *   verify in the `.staging/dsh-gui` clone first, add a computer-use check of
 *   the GUI when the batch contains deepseek-harness, then report and wait for
 *   the user's approval before touching this checkout.
 */

import type { UpdateProject } from './api.ts'

/** The top-level checkout's id; it is the repository itself, not a module. */
export const ROOT_PROJECT_ID = 'dsh-gui'

/** The engineering base every plugin is built on (a pinned upstream submodule). */
export const HARNESS_PROJECT_ID = 'deepseek-harness'

/**
 * The draft opens with this skill gesture. The harness resolves a
 * whitespace-bounded `/name` in a user message against the skill registry and
 * loads that skill's body into the session before the model answers, so the
 * prompt itself carries only the module rows and the acceptance gate.
 */
export const AI_UPDATE_SKILL = '/dsh-gui-update'

/** Rebuild command for the desktop application — the single source in prompts. */
export const BUILD_COMMAND = 'npm run build:desktop'

/** Selected update target of one row. */
export type UpdateMode = 'tag' | 'commit'

/**
 * deepseek-harness is the engineering base, not a plugin: it lives at the
 * repository root (NOT under plugins/) and has no `plugins/<id>/install.mjs`
 * wrapper, so its prompt states that instead of plugin paths.
 */
export const HARNESS_MODULE_NOTE = '说明：deepseek-harness 是本工程的基座，不是插件——它位于仓库根目录 deepseek-harness/（不在 plugins/ 下），没有 plugins/<id>/install.mjs 安装脚本，文档在 deepseek-harness/docs/ 与仓库根 AGENTS.md。按仓库约定它是 pinned 上游子模块，只用于查证规范：不要编辑其中的任何文件，也不要从该目录向插件源码复制代码。'

/**
 * Closing facts shared by every AI-update prompt: the paths are relative to the
 * repository root, and the session dsh-ai-update prepared already runs in that
 * workspace under the creator preset.
 */
export const AI_UPDATE_WORKSPACE_NOTE = '注意：以上路径均相对于 dsh-gui 仓库根目录。本次会话由 dsh-ai-update 在项目首页选中 dsh-gui 目录并自动切到「创造模式」预设，工作区就是该仓库（包含 plugins/、presets/、deepseek-harness/ 等目录的目录）。'

/**
 * Closing gate of every AI-update prompt: what "verified in the staging clone"
 * means, and the approval barrier before anything reaches this checkout. The
 * per-step commands live in the dsh-gui-update skill (loaded by the gesture
 * above), so this note fixes only the acceptance criteria the skill cannot
 * infer from the dialog.
 */
export const AI_UPDATE_GATE_NOTE = [
  '验证与实装门槛（阶段一全部通过、并经用户审批之前，不得改动本工程）：',
  '1. 先在持久化验证副本 .staging/dsh-gui 中完成更新、适配与构建，不碰本工程。',
  '2. 「验证通过」指副本的 WebUI 能正确加载：以副本自身的 DSH_HOME 在空闲端口启动副本的 web 后端，确认会话界面正常渲染、插件与组合无加载报错或错误覆盖层，然后停掉该实例；构建全绿与配置 dump 无报错都只是前置条件，不算通过。',
  `3. 本次更新包含 deepseek-harness 时，还要用 computer use 验证 GUI 能正常启动和运行：在副本内执行 \`${BUILD_COMMAND}\` 构建 desktop 产物，再启动副本自己的 desktop 应用（指向副本的 DSH_HOME，用空闲端口以免与正在运行的实例争用），确认窗口出现、加载页过渡到标签页、harness 就绪且可正常交互，然后关闭该实例。`,
  `4. 构建命令统一为 \`${BUILD_COMMAND}\`（desktop 应用的构建入口；不要改用它以外的构建入口）。完成实装后由用户在停止运行中的 Desktop 实例时自行重新构建，会话只负责通知，不代跑构建或安装。`,
  '5. 验证全部通过后先向用户报告结论（副本路径、目标修订、验证命令与结果、适配改动清单、屏蔽项与未决风险），等用户明确审批后再执行阶段二，把更新同步到本工程。',
].join('\n')

/**
 * A checkout sitting exactly on a tag while the remote carries only newer
 * commits (no newer tag) must keep its tag version: an AI update would only
 * move the tag onto a non-tag commit. `announce === false` encodes exactly that
 * condition (the host's badge rule), so it doubles as the "tag version locked"
 * test.
 */
export function isOnTagWithoutNewer(project: UpdateProject): boolean {
  return Boolean(project.behind && project.announce === false)
}

/**
 * Rows the AI flows may act on: behind, checkable, not tag-locked, and not the
 * top-level checkout.
 *
 * The top-level row is excluded on purpose, exactly like the shell's
 * `startAiUpdate` (which turns a root hit into the in-dialog git update): the
 * dsh-gui-update skill states that the repository itself does not enter the
 * AI-update flow — its「更新」button runs git fast-forward plus recursive
 * submodule sync here in the dialog.
 */
export function aiEligibleProjects(projects: readonly UpdateProject[]): UpdateProject[] {
  return projects.filter(project =>
    project.behind
    && project.error === undefined
    && project.id !== ROOT_PROJECT_ID
    && !isOnTagWithoutNewer(project))
}

/** `<name>（<kind>，路径：<path>）` — the module label every prompt uses. */
function aiModuleLabel(project: UpdateProject): string {
  const kind = `submodule ${project.id}`
  const path = project.path !== '' ? `，路径：${project.path}` : ''
  return `${project.name}（${kind}${path}）`
}

/** The module's update target, spelled the way the dialog row selected it. */
function aiUpdateTargetText(project: UpdateProject, mode: UpdateMode): string {
  const current = project.current !== '' ? project.current : 'unknown'
  if (mode === 'tag') {
    const tag = project.latestTag !== undefined && project.latestTag !== ''
      ? `最新 tag「${project.latestTag}」`
      : '最新 tag（用 git describe --tags --abbrev=0 origin/<默认分支> 确定）'
    return `更新目标：${tag}（当前 ${current}）`
  }
  return `更新目标：最新提交（远端默认分支 HEAD；当前 ${current}，最新 ${project.latest !== '' ? project.latest : '?'}）`
}

/** One module row of a batch prompt: name, path, current version, target. */
function aiModuleRow(project: UpdateProject, mode: UpdateMode): string {
  const path = project.path !== '' ? `路径 ${project.path}，` : ''
  const current = project.current !== '' ? project.current : 'unknown'
  const target = mode === 'tag'
    ? `更新到最新 tag${project.latestTag !== undefined && project.latestTag !== '' ? `「${project.latestTag}」` : ''}`
    : `更新到最新提交（最新 ${project.latest !== '' ? project.latest : '?'}）`
  return `- ${project.name}（${path}当前 ${current}，${target}）`
}

/** Prompt for deepseek-harness alone: the engineering base, not a plugin. */
function buildHarnessUpdatePrompt(project: UpdateProject, mode: UpdateMode): string {
  return [
    AI_UPDATE_SKILL,
    '',
    '请更新当前 dsh-gui 仓库中的「deepseek-harness」模块：',
    '',
    `- 模块：${aiModuleLabel(project)}`,
    `- ${aiUpdateTargetText(project, mode)}`,
    '',
    HARNESS_MODULE_NOTE,
    '',
    AI_UPDATE_WORKSPACE_NOTE,
    '',
    AI_UPDATE_GATE_NOTE,
  ].join('\n')
}

/**
 * Prompt for a batch that includes deepseek-harness plus plugin modules: the
 * base first, then every plugin row, all driven by the same skill.
 */
function buildHarnessMergedPrompt(
  harness: UpdateProject,
  others: readonly UpdateProject[],
  modeOf: (id: string) => UpdateMode,
): string {
  const lines = [
    AI_UPDATE_SKILL,
    '',
    '请更新当前 dsh-gui 仓库：先更新工程基座 deepseek-harness，再更新以下插件模块：',
    '',
  ]
  for (const project of [harness, ...others]) lines.push(aiModuleRow(project, modeOf(project.id)))
  lines.push('', HARNESS_MODULE_NOTE, '', AI_UPDATE_WORKSPACE_NOTE, '', AI_UPDATE_GATE_NOTE)
  return lines.join('\n')
}

/**
 * Build the draft for one module or a batch of plugin modules.
 *
 * @param projects - AI-eligible rows (see `aiEligibleProjects`), in dialog order.
 * @param modeOf - the row's selected update target.
 * @returns the prompt, or an empty string when no row is eligible.
 */
export function buildAiUpdatePrompt(
  projects: readonly UpdateProject[],
  modeOf: (id: string) => UpdateMode,
): string {
  if (projects.length === 0) return ''
  if (projects.length === 1) {
    const project = projects[0]
    if (project.id === HARNESS_PROJECT_ID) return buildHarnessUpdatePrompt(project, modeOf(project.id))
    return [
      AI_UPDATE_SKILL,
      '',
      `请更新当前 dsh-gui 仓库中的「${project.name}」模块：`,
      '',
      `- 模块：${aiModuleLabel(project)}`,
      `- ${aiUpdateTargetText(project, modeOf(project.id))}`,
      '',
      AI_UPDATE_WORKSPACE_NOTE,
      '',
      AI_UPDATE_GATE_NOTE,
    ].join('\n')
  }

  const harness = projects.find(project => project.id === HARNESS_PROJECT_ID)
  if (harness !== undefined) {
    return buildHarnessMergedPrompt(
      harness,
      projects.filter(project => project.id !== HARNESS_PROJECT_ID),
      modeOf,
    )
  }
  const lines = [AI_UPDATE_SKILL, '', '请批量更新当前 dsh-gui 仓库中以下模块：', '']
  for (const project of projects) lines.push(aiModuleRow(project, modeOf(project.id)))
  lines.push('', AI_UPDATE_WORKSPACE_NOTE, '', AI_UPDATE_GATE_NOTE)
  return lines.join('\n')
}
