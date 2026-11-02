/**
 * The 自动更新 dialog.
 *
 * Open renders a skeleton first: `?mode=local` gives the module list and each
 * row's current version without any network I/O, so the dialog is never blank
 * while the real `?mode=check` comparison (a `git fetch` per row) runs. The
 * full result then replaces the skeleton in place.
 *
 * Rows mirror the shell's update dialog (`src-tauri/ui/app.js`
 * `renderUpdateDialog` / `updateRow`): module name (linked to its GitHub
 * Releases list when the host reported one), `当前 → 最新`, a tag/commit target
 * selector, the row's error or status, and 「更新」「更新日志」「AI 更新」. A tag
 * target that is not strictly newer than the local HEAD is disabled and the row
 * falls back to the newest commit. 「更新」 streams the host's NDJSON progress
 * into the dialog's log area; 「更新日志」 opens the changelog view;
 * 「AI 更新」 dispatches the `dsh-gui:ai-update` draft and never creates a
 * session itself.
 *
 * There are two row kinds. A git checkout row (the repository root and its
 * non-`plugins/` submodules) is the shell's original row. An npm plugin row is
 * a package whose version is the exact npm pin in a repository install script:
 * it drops the tag/commit selector and 「更新日志」 (a GitHub release cannot be
 * mapped reliably onto an npm version), shows the pin against the registry's
 * latest, and its 「更新」 rewrites that pin and re-runs the wrapper. Batch
 * actions keep filtering by `behind`, so npm plugin rows take part naturally.
 *
 * The footer's post-update hint is built from the host's `buildCommand` — this
 * module never spells a command of its own — and its sentence depends on the
 * row kinds: git rows need a rebuild, while npm plugin rows are reinstalled into
 * the current profile and need the app restarted.
 */

import {
  fetchCachedStatus,
  fetchStatus,
  isNpmProject,
  streamUpdate,
  type UpdateProject,
  type UpdateStatus,
  type UpdateTarget,
} from './api.ts'
import {
  AI_UPDATE_SKILL,
  ROOT_PROJECT_ID,
  aiEligibleProjects,
  buildAiUpdatePrompt,
  isOnTagWithoutNewer,
  type UpdateMode,
} from './ai-prompt.ts'
import { messageOf, requestAiUpdate } from './bridge.ts'
import { showToast } from './button.ts'
import type { ChangelogView } from './changelog-view.ts'

/** Marks the update dialog overlay. */
export const OVERLAY_ATTR = 'data-dsh-auto-update-overlay'

/** The update dialog handle. */
export interface UpdateDialog {
  /** The overlay element; the caller appends it. */
  readonly element: HTMLElement
  /** Open the dialog and start a check (skeleton first). */
  open(): void
  /** Close the dialog; ignored while an update is running. */
  close(): void
  /** Whether the overlay is currently visible. */
  isOpen(): boolean
  /** Remove the element and cancel pending work. */
  dispose(): void
}

/** Options of `createUpdateDialog`. */
export interface UpdateDialogOptions {
  /** The changelog dialog a row's 「更新日志」 opens. */
  readonly changelog: ChangelogView
  /** Called after every completed check with the row count for the entry badge. */
  readonly onNotifyCount?: (count: number) => void
  /** Called whenever the dialog stops being visible. */
  readonly onClosed?: () => void
}

/** Attribute names used by the dialog's parts. */
const DIALOG_ATTR = 'data-dsh-auto-update-dialog'
const HEAD_ATTR = 'data-dsh-auto-update-head'
const HEAD_MAIN_ATTR = 'data-dsh-auto-update-head-main'
const HEAD_ACTIONS_ATTR = 'data-dsh-auto-update-head-actions'
const TITLE_ATTR = 'data-dsh-auto-update-title'
const STATUS_ATTR = 'data-dsh-auto-update-status'
const CLOSE_ATTR = 'data-dsh-auto-update-close'
const REFRESH_ATTR = 'data-dsh-auto-update-refresh'
const BATCH_ATTR = 'data-dsh-auto-update-batch'
const AI_ALL_ATTR = 'data-dsh-auto-update-ai-all'
const BODY_ATTR = 'data-dsh-auto-update-body'
const LOADING_ATTR = 'data-dsh-auto-update-loading'
const SUMMARY_ATTR = 'data-dsh-auto-update-summary'
const ROW_ATTR = 'data-dsh-auto-update-row'
const ROW_INFO_ATTR = 'data-dsh-auto-update-row-info'
const ROW_NAME_ATTR = 'data-dsh-auto-update-row-name'
const ROW_VERSIONS_ATTR = 'data-dsh-auto-update-row-versions'
const ROW_NPM_NOTE_ATTR = 'data-dsh-auto-update-row-npm-note'
const ROW_ERROR_ATTR = 'data-dsh-auto-update-row-error'
const ROW_ACTION_ATTR = 'data-dsh-auto-update-row-action'
const MODE_ATTR = 'data-dsh-auto-update-mode'
const RUN_ATTR = 'data-dsh-auto-update-run'
const LOG_ATTR = 'data-dsh-auto-update-log'
const AI_ATTR = 'data-dsh-auto-update-ai'
const OK_ATTR = 'data-dsh-auto-update-ok'
const UNAVAILABLE_ATTR = 'data-dsh-auto-update-unavailable'
const CHECKING_ATTR = 'data-dsh-auto-update-checking'
const SKELETON_ATTR = 'data-dsh-auto-update-skeleton'
/** Marks a button that is disabled regardless of the busy state (with reason). */
const ALWAYS_DISABLED_ATTR = 'data-dsh-auto-update-always-disabled'
/** Marks a discouraged AI action (grayed out, like the shell's). */
const DISCOURAGED_ATTR = 'data-dsh-auto-update-discouraged'
/** Marks the dialog's primary action. */
const PRIMARY_ATTR = 'data-dsh-auto-update-primary'
const PROGRESS_ATTR = 'data-dsh-auto-update-progress'
const NOTE_ATTR = 'data-dsh-auto-update-note'
const WARNING_ATTR = 'data-dsh-auto-update-warning'
const FOOTER_ATTR = 'data-dsh-auto-update-footer'

/**
 * The cost of one click, stated before it is paid.
 *
 * 「更新」 and 「全部更新」 start immediately (no second confirmation). A git row
 * is `git reset --hard` onto the target revision: whatever is uncommitted in
 * that checkout is discarded (untracked files survive, hence the parenthetical).
 * An npm plugin row instead rewrites the exact version pin inside the
 * repository's install script and re-runs that wrapper, so both the current
 * profile and a fresh deployment follow the new pin. The resident dialog
 * warning states both; each row's 「更新」 title repeats only its own kind.
 */
const GIT_UPDATE_WARNING = '更新以 git reset --hard 检出目标版本：所选工程中未提交的改动会被丢弃（未跟踪文件保留）。'
const NPM_UPDATE_WARNING = '插件更新会修改安装脚本中的版本 pin 并重新安装该插件（当前 profile 就地生效；新设备重新部署也会按新的 pin 安装）。'
const UPDATE_WARNING = `${GIT_UPDATE_WARNING}${NPM_UPDATE_WARNING}`

/**
 * The most recent complete status this client rendered, kept at module scope so
 * it survives the dialog's open/close cycle (contract §7.4). A page reload
 * clears it, but the host keeps its own copy behind `?mode=cached`.
 */
let cachedStatus: UpdateStatus | undefined

/**
 * Create the update dialog.
 * @param options - the changelog view it drives and the badge callback.
 * @returns the dialog handle; `element` must be appended by the caller.
 */
export function createUpdateDialog(options: UpdateDialogOptions): UpdateDialog {
  let disposed = false
  let busy = false
  let checking = false
  /** Invalidates in-flight checks when the dialog closes or reopens. */
  let generation = 0
  let status: UpdateStatus | undefined
  /** The row target selectors' current values, keyed by project id. */
  const modes = new Map<string, UpdateMode>()
  /** The host's rebuild command; the footer's single source. */
  let buildCommand: string | undefined

  const element = document.createElement('div')
  element.setAttribute(OVERLAY_ATTR, '')
  element.hidden = true

  const dialog = document.createElement('div')
  dialog.setAttribute(DIALOG_ATTR, '')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-label', '自动更新')

  const head = document.createElement('div')
  head.setAttribute(HEAD_ATTR, '')
  const headMain = document.createElement('div')
  headMain.setAttribute(HEAD_MAIN_ATTR, '')
  const title = document.createElement('h2')
  title.setAttribute(TITLE_ATTR, '')
  title.textContent = '自动更新'
  const statusLine = document.createElement('div')
  statusLine.setAttribute(STATUS_ATTR, '')
  headMain.append(title, statusLine)

  const headActions = document.createElement('div')
  headActions.setAttribute(HEAD_ACTIONS_ATTR, '')
  const refreshButton = button('检查更新', REFRESH_ATTR)
  refreshButton.title = '重新检测所有模块与插件的更新状态（仓库与子模块执行 git fetch，插件查询 npm registry）'
  const batchButton = button('全部更新', BATCH_ATTR)
  batchButton.setAttribute(PRIMARY_ATTR, '')
  batchButton.title = `按行顺序更新所有有可用更新的模块与插件（顶层 dsh-gui 优先）。${UPDATE_WARNING}`
  batchButton.hidden = true
  const aiAllButton = button('AI 更新全部', AI_ALL_ATTR)
  aiAllButton.title = `回到项目首页选中 dsh-gui 目录，自动选中「创造模式」预设并预填 ${AI_UPDATE_SKILL} 提示词（发送前可再改）`
  aiAllButton.hidden = true
  headActions.append(refreshButton, batchButton, aiAllButton)
  head.append(headMain, headActions)

  const closeButton = button('✕', CLOSE_ATTR)
  closeButton.setAttribute('aria-label', '关闭')
  closeButton.title = '关闭'

  const body = document.createElement('div')
  body.setAttribute(BODY_ATTR, '')
  const progress = document.createElement('div')
  progress.setAttribute(PROGRESS_ATTR, '')
  progress.hidden = true
  const note = document.createElement('div')
  note.setAttribute(NOTE_ATTR, '')
  note.hidden = true
  // The resident cost-of-click warning: always visible while the dialog is
  // open, pinned above the build hint so it cannot be scrolled out of sight
  // before the user presses 「更新」 or 「全部更新」.
  const warning = document.createElement('div')
  warning.setAttribute(WARNING_ATTR, '')
  warning.setAttribute('role', 'note')
  warning.textContent = UPDATE_WARNING
  const footer = document.createElement('div')
  footer.setAttribute(FOOTER_ATTR, '')
  footer.hidden = true

  dialog.append(head, closeButton, body, progress, note, warning, footer)
  element.append(dialog)

  /* ── Small helpers ─────────────────────────────────────────────────── */

  /** Toggle the busy/checking state of every control. */
  const setControlsDisabled = (disabled: boolean): void => {
    refreshButton.disabled = disabled || checking
    batchButton.disabled = disabled
    aiAllButton.disabled = disabled
    closeButton.disabled = disabled
    body.querySelectorAll('select, button').forEach((control) => {
      const node = control as HTMLSelectElement | HTMLButtonElement
      node.disabled = disabled || node.hasAttribute(ALWAYS_DISABLED_ATTR)
    })
  }

  /** Show one line in the streamed update log. */
  const appendProgress = (text: string): void => {
    progress.hidden = false
    const line = document.createElement('div')
    line.textContent = text
    if (text.startsWith('✅')) line.className = 'dsh-auto-update-log-ok'
    else if (text.startsWith('❌')) line.className = 'dsh-auto-update-log-error'
    progress.append(line)
    progress.scrollTop = progress.scrollHeight
  }

  /** Clear the log and hide it. */
  const clearProgress = (): void => {
    progress.replaceChildren()
    progress.hidden = true
  }

  /** Show or clear the in-dialog note line. */
  const setNote = (text: string): void => {
    note.textContent = text
    note.hidden = text === ''
  }

  /**
   * Which row kinds among `rows` still need an update (behind and not failed).
   * @param rows - the rows the footer is describing.
   * @returns whether a git row and/or an npm plugin row is pending.
   */
  const pendingKinds = (rows: readonly UpdateProject[]): { git: boolean; npm: boolean } => {
    const pending = rows.filter(project => project.behind && (project.error === undefined || project.error === ''))
    return {
      git: pending.some(project => !isNpmProject(project)),
      npm: pending.some(project => isNpmProject(project)),
    }
  }

  /**
   * Keep the footer in step with the host's rebuild command and the kinds of row
   * the hint is describing (the rendered status, or the batch just updated).
   *
   * The command itself always comes from the host (`buildCommand`, the single
   * source) — this only chooses the sentence around it:
   *
   * - git rows need the desktop app rebuilt (and restarted) after the git-layer
   *   update, so the original hint stays;
   * - npm plugin rows only rewrite the install script and reinstall the plugin
   *   into the current profile, so a restart is what makes them take effect —
   *   the command is offered only as the optional way to rebuild desktop
   *   artifacts, never as a mandatory step;
   * - a mixed batch states both, and a list that carries npm rows but nothing
   *   pending gets the neutral two-kind note instead of the git-only one.
   *
   * @param command - the host's rebuild command; the previous one is kept when absent.
   * @param rows - the rows the hint describes.
   */
  const setBuildCommand = (command: string | undefined, rows: readonly UpdateProject[]): void => {
    if (command !== undefined && command !== '') buildCommand = command
    footer.replaceChildren()
    const kinds = pendingKinds(rows)
    const hasNpmRows = rows.some(project => isNpmProject(project))
    /** The host's command as a `<code>` element (only when one was reported). */
    const commandElement = (): HTMLElement => {
      const element = document.createElement('code')
      element.textContent = buildCommand ?? ''
      return element
    }

    if (kinds.git && kinds.npm) {
      if (buildCommand === undefined) {
        footer.textContent = '更新完成后：仓库与子模块需要重新构建 Desktop 应用并重启，插件已重装到当前 profile、重启 Desktop 应用后生效。'
      } else {
        footer.append(
          document.createTextNode('更新完成后：仓库与子模块需要手动执行 '),
          commandElement(),
          document.createTextNode(' 重新构建并重启 Desktop 应用；插件已重装到当前 profile，重启 Desktop 应用后生效。'),
        )
      }
      footer.hidden = false
      return
    }

    if (kinds.npm) {
      if (buildCommand === undefined) {
        footer.textContent = '插件已重装到当前 profile：重启 Desktop 应用后生效。'
      } else {
        footer.append(
          document.createTextNode('插件已重装到当前 profile：重启 Desktop 应用后生效；如需重建 desktop 应用产物，可手动执行 '),
          commandElement(),
          document.createTextNode('。'),
        )
      }
      footer.hidden = false
      return
    }

    if (kinds.git) {
      if (buildCommand === undefined) {
        footer.textContent = '更新只完成 git 层：完成后需要按仓库说明重新构建 Desktop 应用并重启，改动才会生效。'
      } else {
        footer.append(document.createTextNode('更新只完成 git 层：完成后需要手动执行 '), commandElement(), document.createTextNode(' 重新构建，再重启 Desktop 应用。'))
      }
      footer.hidden = false
      return
    }

    // Nothing is pending. When npm plugin rows exist the old git-only sentence
    // would misdescribe their updates, so use the neutral two-kind note.
    if (!hasNpmRows) {
      if (buildCommand === undefined) {
        footer.textContent = '更新只完成 git 层：完成后需要按仓库说明重新构建 Desktop 应用并重启，改动才会生效。'
      } else {
        footer.append(document.createTextNode('更新只完成 git 层：完成后需要手动执行 '), commandElement(), document.createTextNode(' 重新构建，再重启 Desktop 应用。'))
      }
      footer.hidden = false
      return
    }
    if (buildCommand === undefined) {
      footer.textContent = '更新完成后：仓库与子模块需要重新构建 Desktop 应用并重启，插件重启 Desktop 应用后生效。'
    } else {
      footer.append(
        document.createTextNode('更新完成后：仓库与子模块需要手动执行 '),
        commandElement(),
        document.createTextNode(' 重新构建并重启 Desktop 应用，插件重启 Desktop 应用后生效。'),
      )
    }
    footer.hidden = false
  }

  /** Replace the body with one loading/error line. */
  const renderLoading = (text: string, error = false): void => {
    body.replaceChildren()
    const line = document.createElement('div')
    line.setAttribute(LOADING_ATTR, '')
    if (error) line.setAttribute('data-error', '')
    line.textContent = text
    body.append(line)
  }

  /** The rows of the last rendered status. */
  const projects = (): UpdateProject[] => (status === undefined ? [] : [...status.projects])

  /** The row's selected update target. */
  const modeOf = (id: string): UpdateMode => modes.get(id) ?? 'commit'

  /** The row's default target: the newest tag when it is usable, else the commit. */
  const defaultMode = (project: UpdateProject): UpdateMode =>
    project.latestTag !== undefined && project.latestTag !== '' && project.latestTagStale !== true
      ? 'tag'
      : 'commit'

  /* ── Rendering ─────────────────────────────────────────────────────── */

  /** A module name linked to its Releases list page, or plain text. */
  const releaseAnchor = (label: string, releaseUrl: string | undefined): HTMLAnchorElement | undefined => {
    const href = safeUrl(releaseUrl)
    if (href === '') return undefined
    const anchor = document.createElement('a')
    anchor.href = href
    anchor.textContent = label
    anchor.title = `点击在浏览器打开 GitHub Releases：${href}`
    anchor.addEventListener('click', (event) => {
      event.preventDefault()
      openExternal(href)
    })
    return anchor
  }

  /** One module row: a git checkout row, or an npm plugin row (see `renderNpmRow`). */
  const renderRow = (project: UpdateProject, asChecking: boolean): HTMLElement => {
    // npm plugin rows have a different model: their version is the install
    // script's pin, so there is no tag/commit target and no changelog (a GitHub
    // release cannot be mapped reliably onto an npm version).
    if (isNpmProject(project)) return renderNpmRow(project, asChecking)
    const row = document.createElement('div')
    row.setAttribute(ROW_ATTR, '')
    row.setAttribute('data-project-id', project.id)

    const info = document.createElement('div')
    info.setAttribute(ROW_INFO_ATTR, '')
    const name = document.createElement('div')
    name.setAttribute(ROW_NAME_ATTR, '')
    const label = project.name !== '' ? project.name : project.id
    const anchor = releaseAnchor(label, project.releaseUrl)
    if (anchor !== undefined) name.append(anchor)
    else name.textContent = label

    const versions = document.createElement('div')
    versions.setAttribute(ROW_VERSIONS_ATTR, '')
    // When a usable latest tag exists the 最新 column shows the tag name, not a
    // commit hash; an unusable tag stays a hash, matching the disabled option
    // beside it (same rule as the shell's updateRow).
    const usableTag = project.latestTag !== undefined && project.latestTag !== '' && project.latestTagStale !== true
      ? project.latestTag
      : ''
    const latest = document.createElement('code')
    latest.textContent = usableTag !== '' ? usableTag : (project.latest !== '' ? project.latest : '—')
    versions.append(
      document.createTextNode('当前 '),
      code(project.current !== '' ? project.current : 'unknown'),
      document.createTextNode(' → 最新 '),
      latest,
    )
    info.append(name, versions)

    const action = document.createElement('div')
    action.setAttribute(ROW_ACTION_ATTR, '')

    /** The npm publish gap note (contract §7.2), or undefined when it does not apply. */
    const npmNote = (): HTMLElement | undefined => {
      const npm = project.npm
      if (npm === undefined) return undefined
      if (npm.complete === true && npm.error === undefined) return undefined
      const note = document.createElement('div')
      note.setAttribute(ROW_NPM_NOTE_ATTR, '')
      // Verbatim from the shell's updateRow (app.js:1611-1613).
      if (npm.error !== undefined && npm.error !== '') {
        note.textContent = `npm 版本核对失败：${npm.error}（不影响 git 更新检测）`
        return note
      }
      const missing = Array.isArray(npm.missing) ? npm.missing : []
      const latestMap = npm.latest !== undefined && npm.latest !== null && typeof npm.latest === 'object'
        ? npm.latest
        : {}
      const latestText = [...new Set(Object.values(latestMap).map(value => String(value)).filter(Boolean))].join(' / ')
      note.textContent = `⚠ 上游 npm 尚未发布 ${project.latestTag !== undefined && project.latestTag !== '' ? project.latestTag : '新 tag'} 对应版本：${missing.join('、') !== '' ? missing.join('、') : '部分包'}（${latestText !== '' ? `npm 最新 ${latestText}` : 'npm 状态未知'}）。本行更新只移动源码 checkout，已安装插件需等 npm 发布后重新执行插件安装。`
      return note
    }

    if (asChecking) {
      versions.setAttribute(SKELETON_ATTR, '')
      const waiting = document.createElement('span')
      waiting.setAttribute(CHECKING_ATTR, '')
      waiting.textContent = '检测中…'
      action.append(waiting)
      row.append(info, action)
      return row
    }

    // npm publish gap: rendered directly under the version line and before the
    // row's error, exactly where the shell puts it.
    const publishedGap = npmNote()
    if (publishedGap !== undefined) info.append(publishedGap)

    if (project.error !== undefined && project.error !== '') {
      const failure = document.createElement('div')
      failure.setAttribute(ROW_ERROR_ATTR, '')
      failure.textContent = project.error
      info.append(failure)
      const unavailable = document.createElement('span')
      unavailable.setAttribute(UNAVAILABLE_ATTR, '')
      unavailable.textContent = '不可检查'
      action.append(unavailable)
      row.append(info, action)
      return row
    }

    const select = document.createElement('select')
    select.setAttribute(MODE_ATTR, '')
    select.setAttribute('data-project-id', project.id)
    select.title = '更新目标'
    const staleTag = project.latestTagStale === true
    const atCurrentTag = staleTag && project.latestTag === project.current
    const tagOption = new Option(
      project.latestTag === undefined || project.latestTag === ''
        ? '最新tag（无）'
        : atCurrentTag
          ? `最新tag（${project.latestTag} 即当前）`
          : staleTag
            ? `最新tag（${project.latestTag} 早于当前）`
            : `最新tag（${project.latestTag}）`,
      'tag',
    )
    if (project.latestTag === undefined || project.latestTag === '' || staleTag) tagOption.disabled = true
    select.append(tagOption, new Option('最新提交', 'commit'))
    // Keep a target the user already picked; only a now-unusable tag falls back.
    const selected = modes.get(project.id) ?? defaultMode(project)
    modes.set(project.id, selected)
    select.value = selected
    select.addEventListener('change', () => {
      modes.set(project.id, select.value === 'tag' ? 'tag' : 'commit')
    })

    if (!project.behind) {
      const ok = document.createElement('span')
      ok.setAttribute(OK_ATTR, '')
      ok.textContent = '已是最新'
      const disabledRun = button('更新', RUN_ATTR)
      disabledRun.title = '已是最新，无需更新'
      disabledRun.disabled = true
      disabledRun.setAttribute(ALWAYS_DISABLED_ATTR, '')
      action.append(ok, disabledRun)
      row.append(info, action)
      return row
    }

    const changelogButton = button('更新日志', LOG_ATTR)
    changelogButton.title = '查看本次更新会带来的变更：tag 目标优先读取 GitHub Release 说明；否则列出该更新范围内的提交'

    const isRoot = project.id === ROOT_PROJECT_ID
    const runButton = button('更新', RUN_ATTR)
    runButton.setAttribute(PRIMARY_ATTR, '')
    runButton.title = `${isRoot
      ? '在弹窗内直接更新顶层工程（reset --hard 到更新目标并把子模块递归同步到顶层修订记录的提交）；完成后按底部提示重新构建'
      : '在该模块目录内 fetch 并检出所选更新目标'}。${GIT_UPDATE_WARNING}`

    const aiButton = button('AI 更新', AI_ATTR)
    aiButton.title = `回到项目首页选中 dsh-gui 目录，自动选中「创造模式」预设并预填 ${AI_UPDATE_SKILL} 提示词（发送前可再改）`
    // Two cases where the AI flow must not run: a checkout whose tag would be
    // moved onto a non-tag commit (the shell's grayed-out case), and the
    // top-level checkout itself (the dsh-gui-update skill keeps the repository
    // out of the AI flow; its git update is the row's 「更新」).
    if (isOnTagWithoutNewer(project)) {
      aiButton.disabled = true
      aiButton.setAttribute(ALWAYS_DISABLED_ATTR, '')
      aiButton.setAttribute(DISCOURAGED_ATTR, '')
      aiButton.title = '当前正处在 tag（远端没有更新的 tag）；AI 更新会把 tag 移到非 tag 的最新提交，不建议执行。如需跟进请用「更新」流程'
    } else if (isRoot) {
      aiButton.disabled = true
      aiButton.setAttribute(ALWAYS_DISABLED_ATTR, '')
      aiButton.setAttribute(DISCOURAGED_ATTR, '')
      aiButton.title = '顶层仓库本体不进入 AI 更新流程（dsh-gui-update skill 的约定）；请用行内「更新」在本对话框内执行 git 层更新（顶层快进 + 子模块递归同步）'
    }

    changelogButton.addEventListener('click', () => { options.changelog.open(project, modeOf(project.id)) })
    runButton.addEventListener('click', () => { void runUpdate([project]) })
    aiButton.addEventListener('click', () => { void runAiUpdate([project]) })
    action.append(select, changelogButton, runButton, aiButton)
    row.append(info, action)
    return row
  }

  /**
   * One npm plugin row.
   *
   * The row is a package pinned by a repository install script: its version is
   * compared against the registry's latest, so there is no tag/commit target to
   * pick and no 「更新日志」 button (a GitHub release cannot be mapped reliably
   * onto an npm version). Its actions are 「更新」 — rewrite the pin and re-run
   * the wrapper — and 「AI 更新」.
   */
  const renderNpmRow = (project: UpdateProject, asChecking: boolean): HTMLElement => {
    const row = document.createElement('div')
    row.setAttribute(ROW_ATTR, '')
    row.setAttribute('data-project-id', project.id)

    const info = document.createElement('div')
    info.setAttribute(ROW_INFO_ATTR, '')
    const name = document.createElement('div')
    name.setAttribute(ROW_NAME_ATTR, '')
    const label = project.packageName !== undefined && project.packageName !== ''
      ? project.packageName
      : (project.name !== '' ? project.name : project.id)
    const anchor = releaseAnchor(label, project.releaseUrl)
    if (anchor !== undefined) name.append(anchor)
    else name.textContent = label

    const versions = document.createElement('div')
    versions.setAttribute(ROW_VERSIONS_ATTR, '')
    versions.append(
      document.createTextNode('当前 '),
      code(project.current !== '' ? project.current : 'unknown'),
      document.createTextNode(' → 最新 '),
      code(project.latest !== '' ? project.latest : '—'),
    )
    info.append(name, versions)

    const action = document.createElement('div')
    action.setAttribute(ROW_ACTION_ATTR, '')

    if (asChecking) {
      versions.setAttribute(SKELETON_ATTR, '')
      const waiting = document.createElement('span')
      waiting.setAttribute(CHECKING_ATTR, '')
      waiting.textContent = '检测中…'
      action.append(waiting)
      row.append(info, action)
      return row
    }

    if (project.error !== undefined && project.error !== '') {
      const failure = document.createElement('div')
      failure.setAttribute(ROW_ERROR_ATTR, '')
      failure.textContent = project.error
      info.append(failure)
      const unavailable = document.createElement('span')
      unavailable.setAttribute(UNAVAILABLE_ATTR, '')
      unavailable.textContent = '不可检查'
      action.append(unavailable)
      row.append(info, action)
      return row
    }

    if (!project.behind) {
      const ok = document.createElement('span')
      ok.setAttribute(OK_ATTR, '')
      ok.textContent = '已是最新'
      const disabledRun = button('更新', RUN_ATTR)
      disabledRun.title = '已是最新，无需更新'
      disabledRun.disabled = true
      disabledRun.setAttribute(ALWAYS_DISABLED_ATTR, '')
      action.append(ok, disabledRun)
      row.append(info, action)
      return row
    }

    const script = project.installScript !== undefined && project.installScript !== ''
      ? project.installScript
      : project.path
    const target = project.latest !== '' ? project.latest : '最新版本'
    const runButton = button('更新', RUN_ATTR)
    runButton.setAttribute(PRIMARY_ATTR, '')
    runButton.title = `把安装脚本 ${script !== '' ? script : '（未知路径）'} 中的版本 pin 改到 ${target} 并重新执行该脚本，完成本行插件的重新安装（当前 profile 就地生效；新设备重新部署也会按新的 pin 安装）。完成后按底部提示重新构建。`

    const aiButton = button('AI 更新', AI_ATTR)
    aiButton.title = `回到项目首页选中 dsh-gui 目录，自动选中「创造模式」预设并预填 ${AI_UPDATE_SKILL} 提示词（发送前可再改）`

    runButton.addEventListener('click', () => { void runUpdate([project]) })
    aiButton.addEventListener('click', () => { void runAiUpdate([project]) })
    action.append(runButton, aiButton)
    row.append(info, action)
    return row
  }

  /** Render one status document. */
  const render = (next: UpdateStatus, asChecking: boolean): void => {
    status = next
    if (!asChecking) remember(next)
    const rows = [...next.projects]
    // A stored tag target that is no longer usable (the tag moved behind the
    // current commit) falls back to the commit, matching the disabled option.
    // Only git rows have a target to fall back; npm plugin rows have none. The
    // skeleton pass must not touch them: its rows carry no tag information.
    if (!asChecking) {
      for (const project of rows) {
        if (isNpmProject(project)) continue
        if (modes.get(project.id) === 'tag' && defaultMode(project) !== 'tag') modes.set(project.id, 'commit')
      }
    }
    const behind = rows.filter(project => project.behind && (project.error === undefined || project.error === ''))
    const aiEligible = aiEligibleProjects(rows)

    body.replaceChildren()
    const summary = document.createElement('div')
    summary.setAttribute(SUMMARY_ATTR, '')
    if (asChecking) {
      summary.textContent = `${rows.length} 个模块与插件，正在检查更新…`
    } else if (behind.length > 0) {
      summary.textContent = `${behind.length} 个模块/插件有可用更新。点「更新」开始更新，或点「AI 更新」交给 agent。`
    } else {
      summary.textContent = '所有模块与插件均为最新版本。'
    }
    body.append(summary)
    for (const project of rows) body.append(renderRow(project, asChecking))

    statusLine.textContent = formatStatusLine(next, asChecking)
    batchButton.hidden = behind.length === 0
    aiAllButton.hidden = aiEligible.length === 0
    setBuildCommand(next.buildCommand, rows)
    setControlsDisabled(busy)
  }

  /* ── Flows ─────────────────────────────────────────────────────────── */

  /** Remember one complete status as the module-level cache (contract §7.4). */
  const remember = (next: UpdateStatus): void => {
    cachedStatus = next
  }

  /**
   * Run the real comparison (`?mode=check`).
   *
   * Never blanks the rendered list: the rows on screen stay until the result
   * lands and replaces them in place (the shell's `checkForUpdates` does the
   * same for an open dialog). The explicit 「检查更新」 button and the
   * post-update refresh both go through here.
   *
   * @param background - true for the silent refresh of a cached no-update
   *   result: a failure then only toasts, leaving the visible list intact.
   */
  const check = async (background = false): Promise<void> => {
    if (disposed || checking) return
    const request = ++generation
    checking = true
    refreshButton.disabled = true
    setNote('')
    // An explicit check says so in the header while it runs (a cold check can
    // take a minute or more); the rows on screen stay until the result lands.
    // The silent background refresh leaves the previous line in place.
    if (!background) statusLine.textContent = '正在检查更新…'
    try {
      const next = await fetchStatus('check')
      if (disposed || request !== generation) return
      remember(next)
      render(next, false)
      options.onNotifyCount?.(Number.isFinite(next.notifyCount) ? next.notifyCount : 0)
    } catch (error) {
      if (disposed || request !== generation) return
      const message = `检查更新失败：${messageOf(error)}`
      if (!background) {
        renderLoading(message, true)
        batchButton.hidden = true
        aiAllButton.hidden = true
        statusLine.textContent = ''
      }
      showToast(message)
    } finally {
      if (request === generation) {
        checking = false
        refreshButton.disabled = busy
      }
    }
  }

  /**
   * The no-cache open path: ask the host's cache, else skeleton rows from
   * `?mode=local` plus a full check — the order of the shell's
   * `openUpdateDialogWithBestState`.
   */
  const openWithoutCache = async (): Promise<void> => {
    const request = ++generation
    renderLoading('正在检查更新…')
    // The status line must never read as blank while the dialog is still
    // acquiring data: a cold start can be waiting on the host's 45s+ check
    // (contract §8.4), and a user opening the dialog mid-check has to see that
    // a check is running rather than an empty header.
    statusLine.textContent = '正在检查更新…'
    try {
      const fromHost = await fetchCachedStatus()
      if (disposed || request !== generation) return
      if (fromHost !== undefined) {
        remember(fromHost)
        render(fromHost, false)
        options.onNotifyCount?.(Number.isFinite(fromHost.notifyCount) ? fromHost.notifyCount : 0)
        // A cached "no updates" result may be stale; a cached "has updates"
        // one is fresh enough (same rule as the shell).
        if (fromHost.hasUpdates !== true) void check(true)
        return
      }
    } catch {
      // No usable host cache: fall through to the local skeleton.
    }
    if (disposed || request !== generation) return
    try {
      const local = await fetchStatus('local')
      if (disposed || request !== generation) return
      render(local, true)
    } catch {
      // The skeleton is only a convenience: the full check may still work.
    }
    if (disposed || request !== generation) return
    void check()
  }

  /** Run one update over the given rows and stream its log. */
  const runUpdate = async (rows: readonly UpdateProject[]): Promise<void> => {
    if (disposed || busy) return
    // An npm plugin row carries no update target: the host rewrites the install
    // script's pin and re-runs the wrapper, so it is always sent as `commit`.
    const targets: UpdateTarget[] = rows.map(project => ({
      id: project.id,
      mode: isNpmProject(project) ? 'commit' : modeOf(project.id),
    }))
    if (targets.length === 0) return
    const gitOnly = rows.every(project => !isNpmProject(project))
    const npmOnly = rows.every(project => isNpmProject(project))
    busy = true
    setControlsDisabled(true)
    clearProgress()
    appendProgress(gitOnly
      ? `开始更新 ${targets.map(target => target.id).join('、')}（仓库与子模块：按所选目标检出）…`
      : npmOnly
        ? `开始更新 ${targets.map(target => target.id).join('、')}（插件：改写安装脚本中的 pin 并重新安装）…`
        : `开始更新 ${targets.map(target => target.id).join('、')}（仓库与子模块按所选目标检出；插件改写安装脚本中的 pin 并重新安装）…`)
    try {
      const result = await streamUpdate(targets, (entry) => {
        if (disposed) return
        if (entry.type === 'begin') {
          appendProgress(`开始更新 ${(entry.targets ?? []).join('、')}`)
        } else if (entry.type === 'log') {
          appendProgress(`${entry.id !== undefined ? `${entry.id}：` : ''}${entry.line ?? ''}`)
        } else if (entry.type === 'target') {
          appendProgress(entry.ok === true
            ? `✅ ${entry.id ?? ''}：${entry.detail !== undefined && entry.detail !== '' ? entry.detail : '已更新'}`
            : `❌ ${entry.id ?? ''}：${entry.error !== undefined && entry.error !== '' ? entry.error : '更新失败'}`)
        } else if (entry.type === 'end') {
          setBuildCommand(entry.buildCommand, rows)
          appendProgress(entry.ok === true
            ? (gitOnly ? '✅ 更新完成（git 层）。' : npmOnly ? '✅ 更新完成（npm 插件已重装到当前 profile）。' : '✅ 更新完成。')
            : '❌ 更新未全部成功。')
        }
      })
      if (disposed) return
      if (!result.ok && result.error !== undefined && result.error !== '') appendProgress(`❌ ${result.error}`)
      appendProgress(gitOnly
        ? '请按底部提示重新构建并重启 Desktop 应用。'
        : npmOnly
          ? '请按底部提示重启 Desktop 应用，插件更新才会生效。'
          : '请按底部提示处理：仓库与子模块需要重新构建并重启 Desktop 应用，插件重启 Desktop 应用后生效。')
    } catch (error) {
      if (disposed) return
      const message = messageOf(error)
      appendProgress(`❌ 更新失败：${message}`)
      showToast(`更新失败：${message}`)
    } finally {
      busy = false
      if (!disposed) {
        setControlsDisabled(false)
        if (isOpen()) void check()
      }
    }
  }

  /** Build the AI draft and dispatch it through the dsh-ai-update channel. */
  const runAiUpdate = async (rows: readonly UpdateProject[]): Promise<void> => {
    if (disposed || busy) return
    const eligible = aiEligibleProjects(rows)
    const prompt = buildAiUpdatePrompt(eligible, modeOf)
    if (prompt === '') {
      showToast('没有可用的 AI 更新模块或插件')
      return
    }
    busy = true
    setControlsDisabled(true)
    setNote('正在启动 AI 更新会话…')
    try {
      const outcome = await requestAiUpdate(prompt)
      if (disposed) return
      if (outcome.ok) {
        showToast(`已在项目首页选中 dsh-gui 目录并预填 ${AI_UPDATE_SKILL} 提示词，请确认后发送`)
        setNote('')
        hide()
      } else {
        const message = `AI 更新会话未启动：${outcome.error !== undefined && outcome.error !== '' ? outcome.error : '未知原因'}`
        setNote(message)
        showToast(message)
      }
    } finally {
      busy = false
      if (!disposed) setControlsDisabled(false)
    }
  }

  /* ── Open / close ──────────────────────────────────────────────────── */

  const hide = (): void => {
    if (element.hidden) return
    generation += 1
    element.hidden = true
    options.onClosed?.()
  }

  /** Whether the overlay is visible (used by `open` and the Escape handler). */
  const isOpen = (): boolean => !element.hidden

  refreshButton.addEventListener('click', () => { void check() })
  closeButton.addEventListener('click', () => { close() })
  element.addEventListener('click', (event) => {
    if (event.target === element) close()
  })

  const orderedBehind = (): UpdateProject[] => {
    const rows = projects().filter(project => project.behind && (project.error === undefined || project.error === ''))
    return [
      ...rows.filter(project => project.id === ROOT_PROJECT_ID),
      ...rows.filter(project => project.id !== ROOT_PROJECT_ID),
    ]
  }
  batchButton.addEventListener('click', () => { void runUpdate(orderedBehind()) })
  aiAllButton.addEventListener('click', () => { void runAiUpdate(projects()) })

  /**
   * Close the dialog.
   * @returns nothing; a close request during an update is refused with a toast,
   *   because the NDJSON stream is still appending to this dialog's log.
   */
  function close(): void {
    if (disposed) return
    if (busy) {
      showToast('更新进行中，请等待本次更新结束后再关闭')
      return
    }
    hide()
  }

  return {
    element,
    open(): void {
      if (disposed || isOpen()) return
      element.hidden = false
      status = undefined
      modes.clear()
      clearProgress()
      setNote('')
      statusLine.textContent = ''
      batchButton.hidden = true
      aiAllButton.hidden = true
      setControlsDisabled(false)
      // The module-level cache renders immediately: no skeleton, no blank
      // list, and no automatic re-check when it already knows about updates.
      if (cachedStatus !== undefined) {
        render(cachedStatus, false)
        options.onNotifyCount?.(Number.isFinite(cachedStatus.notifyCount) ? cachedStatus.notifyCount : 0)
        if (cachedStatus.hasUpdates !== true) void check(true)
        return
      }
      void openWithoutCache()
    },
    close,
    isOpen(): boolean {
      return !element.hidden
    },
    dispose(): void {
      disposed = true
      generation += 1
      element.remove()
    },
  }
}

/* ── Module-level helpers ──────────────────────────────────────────────── */

/** A `<button type="button">` carrying one data attribute. */
function button(label: string, attr: string): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.setAttribute(attr, '')
  element.textContent = label
  return element
}

/** A `<code>` element with text content. */
function code(text: string): HTMLElement {
  const element = document.createElement('code')
  element.textContent = text
  return element
}

/**
 * The status line: last check time, duration, and how many rows failed — ported
 * from the shell's `formatUpdateStatusLine`.
 */
function formatStatusLine(status: UpdateStatus, asChecking: boolean): string {
  if (asChecking) return '正在检查更新…'
  if (status.checkedAt === null) return ''
  const when = new Date(status.checkedAt * 1000)
  const hh = String(when.getHours()).padStart(2, '0')
  const mm = String(when.getMinutes()).padStart(2, '0')
  const ss = String(when.getSeconds()).padStart(2, '0')
  const secs = ((status.durationMs ?? 0) / 1000).toFixed(1)
  // The host counts only git rows into `allChecked` (a registry failure stays a
  // per-row note); mirror that so the header never reports a check failure the
  // rest of the dialog treats as informational.
  const failed = status.projects.filter(project =>
    !isNpmProject(project) && project.error !== undefined && project.error !== '').length
  return `上次检查 ${hh}:${mm}:${ss} · 耗时 ${secs}s` + (failed > 0 ? ` · ${failed} 个工程检查失败` : '')
}

/** The URL guard for links the dialog opens itself (http(s)/mailto only). */
function safeUrl(url: unknown): string {
  const value = String(url ?? '').trim()
  if (/^(https?:\/\/|mailto:)/i.test(value)) return value
  return ''
}

/** Open one URL in the system browser, reporting a blocked popup. */
function openExternal(url: string): void {
  let opened: Window | null = null
  try {
    opened = window.open(url, '_blank', 'noopener,noreferrer')
  } catch {
    opened = null
  }
  if (opened === null) showToast(`无法自动打开浏览器，请手动访问：${url}`)
}
