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
 * The footer's rebuild hint is built from the host's `buildCommand` — this
 * module never spells a command of its own.
 */

import {
  fetchStatus,
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
 * 「更新」 and 「全部更新」 start immediately (no second confirmation) and the
 * host's semantics are `git reset --hard` onto the target revision: whatever is
 * uncommitted in the selected checkout is discarded. Untracked files survive
 * `reset --hard`, so they are called out separately — the sentence has to be
 * one the user can act on, not a generic caution. It is rendered once as a
 * resident dialog warning and appended verbatim to the two buttons' titles.
 */
const UPDATE_WARNING = '更新以 git reset --hard 检出目标版本：所选工程中未提交的改动会被丢弃（未跟踪文件保留）。'

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
  refreshButton.title = '重新检测所有工程的更新状态（每行会执行 git fetch）'
  const batchButton = button('全部更新', BATCH_ATTR)
  batchButton.setAttribute(PRIMARY_ATTR, '')
  batchButton.title = `按行顺序更新所有有可用更新的工程（顶层 dsh-gui 优先）。${UPDATE_WARNING}`
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

  /** Keep the footer in step with the host's rebuild command. */
  const setBuildCommand = (command: string | undefined): void => {
    if (command !== undefined && command !== '') buildCommand = command
    footer.replaceChildren()
    if (buildCommand === undefined) {
      footer.textContent = '更新只完成 git 层：完成后需要按仓库说明重新构建 Desktop 应用并重启，改动才会生效。'
      footer.hidden = false
      return
    }
    footer.append(document.createTextNode('更新只完成 git 层：完成后需要手动执行 '))
    const commandElement = document.createElement('code')
    commandElement.textContent = buildCommand
    footer.append(commandElement, document.createTextNode(' 重新构建，再重启 Desktop 应用。'))
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

  /** One module row. */
  const renderRow = (project: UpdateProject, asChecking: boolean): HTMLElement => {
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
      ? '在弹窗内直接更新顶层工程（快进到更新目标并把子模块递归同步到顶层修订记录的提交）；完成后按底部提示重新构建'
      : '在该模块目录内 fetch 并检出所选更新目标'}。${UPDATE_WARNING}`

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

  /** Render one status document. */
  const render = (next: UpdateStatus, asChecking: boolean): void => {
    status = next
    const rows = [...next.projects]
    // A stored tag target that is no longer usable (the tag moved behind the
    // current commit) falls back to the commit, matching the disabled option.
    // The skeleton pass must not touch them: its rows carry no tag information.
    if (!asChecking) {
      for (const project of rows) {
        if (modes.get(project.id) === 'tag' && defaultMode(project) !== 'tag') modes.set(project.id, 'commit')
      }
    }
    const behind = rows.filter(project => project.behind && (project.error === undefined || project.error === ''))
    const aiEligible = aiEligibleProjects(rows)

    body.replaceChildren()
    const summary = document.createElement('div')
    summary.setAttribute(SUMMARY_ATTR, '')
    if (asChecking) {
      summary.textContent = `${rows.length} 个工程，正在检查更新…`
    } else if (behind.length > 0) {
      summary.textContent = `${behind.length} 个工程有可用更新。每行默认以最新 tag 为更新目标（tag 早于当前提交时该项不可用，自动改以最新提交为目标）；「更新」在弹窗内执行 git 层更新并逐行回显日志。`
    } else {
      summary.textContent = '所有工程均为最新版本。'
    }
    body.append(summary)
    for (const project of rows) body.append(renderRow(project, asChecking))

    statusLine.textContent = formatStatusLine(next, asChecking)
    batchButton.hidden = behind.length === 0
    aiAllButton.hidden = aiEligible.length === 0
    setBuildCommand(next.buildCommand)
    setControlsDisabled(busy)
  }

  /* ── Flows ─────────────────────────────────────────────────────────── */

  /** Check updates: local skeleton first, then the full comparison. */
  const check = async (): Promise<void> => {
    if (disposed) return
    const request = ++generation
    checking = true
    refreshButton.disabled = true
    setNote('')
    renderLoading('正在检查更新…')
    try {
      const local = await fetchStatus('local')
      if (disposed || request !== generation) return
      render(local, true)
    } catch {
      // The skeleton is only a convenience: the full check may still work.
    }
    try {
      const next = await fetchStatus('check')
      if (disposed || request !== generation) return
      render(next, false)
      options.onNotifyCount?.(Number.isFinite(next.notifyCount) ? next.notifyCount : 0)
    } catch (error) {
      if (disposed || request !== generation) return
      const message = `检查更新失败：${messageOf(error)}`
      renderLoading(message, true)
      batchButton.hidden = true
      aiAllButton.hidden = true
      statusLine.textContent = ''
      showToast(message)
    } finally {
      if (request === generation) {
        checking = false
        refreshButton.disabled = busy
      }
    }
  }

  /** Run one update over the given rows and stream its log. */
  const runUpdate = async (rows: readonly UpdateProject[]): Promise<void> => {
    if (disposed || busy) return
    const targets: UpdateTarget[] = rows.map(project => ({ id: project.id, mode: modeOf(project.id) }))
    if (targets.length === 0) return
    busy = true
    setControlsDisabled(true)
    clearProgress()
    appendProgress(`开始更新 ${targets.map(target => target.id).join('、')}（git 层：按所选目标 fetch 并检出）…`)
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
          if (entry.buildCommand !== undefined) setBuildCommand(entry.buildCommand)
          appendProgress(entry.ok === true ? '✅ 更新完成（git 层）。' : '❌ 更新未全部成功。')
        }
      })
      if (disposed) return
      if (!result.ok && result.error !== undefined && result.error !== '') appendProgress(`❌ ${result.error}`)
      appendProgress('请按底部提示重新构建并重启 Desktop 应用。')
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
      showToast('没有可用的 AI 更新工程')
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
      renderLoading('正在检查更新…')
      setControlsDisabled(false)
      void check()
    },
    close,
    isOpen(): boolean {
      return !element.hidden
    },    dispose(): void {
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
  const failed = status.projects.filter(project => project.error !== undefined && project.error !== '').length
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
