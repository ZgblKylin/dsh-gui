/**
 * The 更新日志 dialog: what one row's pending update brings.
 *
 * The host half answers `GET /api/changelog` with the module's current and
 * target versions, the reachable commits, and — for a tag target on a GitHub
 * origin — the release notes it managed to fetch. This view renders the
 * release body through a safe Markdown subset, falls back to the commit list,
 * and shows a readable line when neither exists.
 *
 * The Markdown renderer is ported from the shell's
 * `src-tauri/ui/app.js` (`renderChangelogMarkdown` and friends): every fragment
 * is HTML-escaped first and only a fixed tag set is ever emitted, with link and
 * image URLs restricted to `http(s)`/`mailto`, so untrusted remote text can
 * never inject markup or scripts. Unsupported constructs degrade to their text
 * form. The dialog intentionally offers a release *list* link (the same page
 * the shell links to), never a `/releases/tag/…` subpage.
 */

import { fetchAiSummary, fetchChangelog, type Changelog, type ChangelogCommit, type UpdateProject } from './api.ts'
import type { UpdateMode } from './ai-prompt.ts'
import { messageOf } from './bridge.ts'
import { showToast } from './button.ts'

/** Marks the changelog overlay. */
export const CHANGELOG_ATTR = 'data-dsh-auto-update-changelog'

/** The changelog dialog handle. */
export interface ChangelogView {
  /** The overlay element; the caller appends it. */
  readonly element: HTMLElement
  /** Open for one row's selected target and load its changelog. */
  open(project: UpdateProject, mode: UpdateMode): void
  /** Close without unloading the view. */
  close(): void
  /** Whether the overlay is currently visible. */
  isOpen(): boolean
  /** Remove the element and cancel pending work. */
  dispose(): void
}

/** Switch the loading line to the long-run note after this delay. */
const STALL_MS = 15_000

/** Initial loading line (verbatim from the shell, app.js:2240-2241). */
const CHANGELOG_LOADING_TEXT = '正在获取更新日志…（tag 目标优先读取 GitHub Release 说明；否则由 dsh AI 汇总提交变更）'

/** After {@link STALL_MS} the line explains the slow part (verbatim from app.js:2247). */
const CHANGELOG_AI_LOADING_TEXT = '正在调用 dsh AI 汇总提交变更，可能需要几分钟…'

/**
 * Prompt cap the dsh-ai-update route enforces (it answers 400 above this), kept
 * in step with the shell's own commit-line bound; the commit list is trimmed
 * from its tail until the prompt fits.
 */
const MAX_PROMPT_CHARS = 20_000

/**
 * Create the changelog dialog.
 * @returns the view handle; `element` must be appended by the caller.
 */
export function createChangelogView(): ChangelogView {
  let disposed = false
  /** Invalidates an in-flight load when the dialog closes or reopens. */
  let generation = 0
  let stallTimer: ReturnType<typeof setTimeout> | undefined

  const element = document.createElement('div')
  element.setAttribute(CHANGELOG_ATTR, '')
  element.hidden = true

  const dialog = document.createElement('div')
  dialog.setAttribute('data-dsh-auto-update-changelog-dialog', '')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-label', '更新日志')

  const close = document.createElement('button')
  close.type = 'button'
  close.setAttribute('data-dsh-auto-update-close', '')
  close.setAttribute('data-dsh-auto-update-changelog-close', '')
  close.setAttribute('aria-label', '关闭')
  close.title = '关闭'
  close.textContent = '✕'

  const title = document.createElement('h2')
  title.setAttribute('data-dsh-auto-update-changelog-title', '')

  const sub = document.createElement('div')
  sub.setAttribute('data-dsh-auto-update-changelog-sub', '')

  const loading = document.createElement('div')
  loading.setAttribute('data-dsh-auto-update-changelog-loading', '')

  const body = document.createElement('div')
  body.setAttribute('data-dsh-auto-update-changelog-body', '')
  body.hidden = true

  const actions = document.createElement('div')
  actions.setAttribute('data-dsh-auto-update-changelog-actions', '')
  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.textContent = '关闭'
  actions.append(closeButton)

  dialog.append(close, title, sub, loading, body, actions)
  element.append(dialog)

  /** Clear the stall timer. */
  const clearStall = (): void => {
    if (stallTimer !== undefined) clearTimeout(stallTimer)
    stallTimer = undefined
  }

  const hide = (): void => {
    generation += 1
    clearStall()
    element.hidden = true
  }

  close.addEventListener('click', hide)
  closeButton.addEventListener('click', hide)
  // The backdrop closes; clicks inside the card do not.
  element.addEventListener('click', (event) => {
    if (event.target === element) hide()
  })
  // Release-note links: opened explicitly, because a webview only opens a
  // popup when its host opts in (`target="_blank"` alone does nothing here).
  body.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const anchor = target.closest('a')
    if (anchor === null) return
    const href = anchor.getAttribute('href') ?? ''
    if (href === '') return
    event.preventDefault()
    openExternal(href)
  })

  /** Render the title: the module name, linked to its Releases list page. */
  const renderTitle = (label: string, releaseUrl: string | undefined): void => {
    title.replaceChildren()
    const href = safeUrl(releaseUrl)
    if (href === '') {
      title.textContent = `${label} · 更新日志`
      return
    }
    const anchor = document.createElement('a')
    anchor.href = href
    anchor.textContent = label
    anchor.title = `点击在浏览器打开 GitHub Releases：${href}`
    anchor.addEventListener('click', (event) => {
      event.preventDefault()
      openExternal(href)
    })
    title.append(anchor, document.createTextNode(' · 更新日志'))
  }

  /** Render the commit list when no release body is available. */
  const renderCommits = (commits: readonly ChangelogCommit[]): void => {
    if (commits.length === 0) {
      body.textContent = '无可展示的更新日志（远端与本地相同，或本次检测未发现新的提交）。'
      return
    }
    const list = document.createElement('ul')
    list.setAttribute('data-dsh-auto-update-changelog-commits', '')
    for (const commit of commits) {
      const item = document.createElement('li')
      const sha = document.createElement('code')
      sha.textContent = commit.sha
      item.append(sha, document.createTextNode(` ${commit.subject}`))
      if (commit.author !== '' || commit.date !== '') {
        const meta = document.createElement('div')
        meta.className = 'dsh-auto-update-commit-meta'
        meta.textContent = [commit.author, commit.date].filter(part => part !== '').join(' · ')
        item.append(meta)
      }
      list.append(item)
    }
    body.replaceChildren(list)
  }

  /** The version/provenance subtitle, shared by the release and fallback paths. */
  const renderVersionSub = (result: Changelog): void => {
    const subParts: Node[] = []
    subParts.push(document.createTextNode('当前 '))
    subParts.push(code(result.from !== '' ? result.from : 'unknown'))
    subParts.push(document.createTextNode(' → '))
    subParts.push(code(result.to !== '' ? result.to : result.target))
    subParts.push(document.createTextNode(`（目标 ${result.targetKind === 'tag' ? 'tag' : '提交'}：${result.target}）`))
    if (result.truncated) subParts.push(document.createTextNode(' · 提交列表已截断'))
    if (typeof result.error === 'string' && result.error !== '') {
      const failure = document.createElement('div')
      failure.textContent = `本地 git 失败：${result.error}`
      subParts.push(failure)
    }
    sub.replaceChildren(...subParts)
  }

  /** Render Markdown into the body, degrading to plain text on a renderer edge. */
  const renderMarkdownInto = (text: string): void => {
    try {
      body.innerHTML = renderMarkdown(text)
    } catch {
      // Never lose the content to a renderer edge: fall back to plain text.
      body.innerHTML = `<pre class="dsh-auto-update-plain">${escapeHtml(text)}</pre>`
    }
  }

  /** Render a release body plus the commits it brings in. */
  const renderReleaseBody = (result: Changelog, releaseBody: string): void => {
    renderMarkdownInto(releaseBody)
    if (result.commits.length > 0) {
      const caption = document.createElement('h4')
      caption.textContent = '本次包含的提交'
      body.append(caption)
      const list = document.createElement('ul')
      list.setAttribute('data-dsh-auto-update-changelog-commits', '')
      for (const commit of result.commits) {
        const item = document.createElement('li')
        const sha = document.createElement('code')
        sha.textContent = commit.sha
        item.append(sha, document.createTextNode(` ${commit.subject}`))
        list.append(item)
      }
      body.append(list)
    }
  }

  /**
   * Load one module's changelog: the GitHub release notes when the host found
   * them, otherwise a dsh AI summary of the commit range, otherwise (on any AI
   * failure) the plain commit list so the content is never lost.
   */
  const load = async (project: UpdateProject, mode: UpdateMode): Promise<void> => {
    const request = ++generation
    const label = project.name !== '' ? project.name : project.id
    renderTitle(label, undefined)
    sub.replaceChildren()
    body.hidden = true
    body.replaceChildren()
    loading.hidden = false
    loading.removeAttribute('data-error')
    loading.textContent = CHANGELOG_LOADING_TEXT
    element.hidden = false

    clearStall()
    stallTimer = setTimeout(() => {
      loading.textContent = CHANGELOG_AI_LOADING_TEXT
    }, STALL_MS)

    let result: Changelog
    try {
      result = await fetchChangelog(project.id, mode)
    } catch (error) {
      if (disposed || request !== generation) return
      clearStall()
      loading.hidden = false
      loading.setAttribute('data-error', '')
      loading.textContent = `无法获取更新日志：${messageOf(error)}`
      return
    }
    if (disposed || request !== generation) return
    renderTitle(label, project.releaseUrl)

    const releaseBody = typeof result.release?.body === 'string' ? result.release.body.trim() : ''
    if (releaseBody !== '') {
      // A release exists: its notes win and no AI call is made (contract §7.3).
      clearStall()
      loading.hidden = true
      renderVersionSub(result)
      renderReleaseBody(result, releaseBody)
      body.hidden = false
      return
    }
    if (result.commits.length === 0) {
      clearStall()
      loading.hidden = true
      renderVersionSub(result)
      renderCommits(result.commits)
      body.hidden = false
      return
    }

    // No release notes: the commit range is summarized by the dsh AI.
    try {
      const summary = await fetchAiSummary(buildChangelogSummaryPrompt(result))
      if (disposed || request !== generation) return
      clearStall()
      loading.hidden = true
      // Provenance line shared with the shell's `summary_subtitle`: the count is
      // the host's `rev-list --count` (merges included, not the capped list);
      // an older host without the field falls back to the list length.
      sub.textContent = `由 dsh AI 汇总 · ${changelogCount(result)} 条提交 · ${result.from} → ${result.to}`
      renderMarkdownInto(summary)
      body.hidden = false
    } catch (error) {
      if (disposed || request !== generation) return
      clearStall()
      renderVersionSub(result)
      loading.hidden = false
      loading.setAttribute('data-error', '')
      loading.textContent = `AI 汇总失败：${messageOf(error)}`
      // Degrade to the plain commit list: a failed summary must not hide the
      // changes it was meant to describe.
      renderCommits(result.commits)
      body.hidden = false
    }
  }

  return {
    element,
    open(project: UpdateProject, mode: UpdateMode): void {
      if (disposed) return
      void load(project, mode)
    },
    close(): void {
      hide()
    },
    isOpen(): boolean {
      return !element.hidden
    },
    dispose(): void {
      disposed = true
      hide()
      element.remove()
    },
  }
}

/* ── AI summary prompt (ported from src-tauri/src/changelog.rs build_prompt) ── */

/**
 * The commit count the AI subtitle reports.
 *
 * `count` is the host's `git rev-list --count <from>..<to>` (contract §7.3):
 * merges included and unaffected by the 400-entry list cap, the same quantity
 * the shell's `summary_subtitle` prints. A host that predates the field falls
 * back to the commit list length.
 *
 * @param result - the changelog document being displayed.
 * @returns the number of commits the summary covers.
 */
function changelogCount(result: Changelog): number {
  return typeof result.count === 'number' && Number.isFinite(result.count)
    ? result.count
    : result.commits.length
}

/**
 * Build the prompt for one changelog AI summary.
 *
 * The wording, the required output shape, and the two input blocks are ported
 * from the shell's `build_prompt` (`src-tauri/src/changelog.rs`), so the same
 * model instruction produces the same kind of answer through the reused
 * `/dsh-gui-api/changelog` route: the commit list carries the facts and the
 * model only reorganizes them (no tools, no workspace access).
 *
 * A prompt longer than the route's cap is trimmed by dropping commit lines from
 * the tail (the shell bounds the range the same way); the rare leftover of a
 * huge diffstat is cut with a truncation marker.
 *
 * @param result - the changelog document whose commits are being summarized.
 * @returns the prompt text.
 */
function buildChangelogSummaryPrompt(result: Changelog): string {
  const name = result.name !== '' ? result.name : result.id
  const from = result.from !== '' ? result.from : 'unknown'
  const to = result.to !== '' ? result.to : result.target
  const label = result.target !== '' ? result.target : '最新提交'
  const head = [
    '你是 DeepSeek Harness（dsh-gui 桌面壳）的更新日志助手。',
    `仓库「${name}」（${result.id}）即将从 ${from} 更新到 ${to}（${label}）。`,
    '',
    '请根据下面的 git 提交变更，用中文输出一份 Markdown「变更汇总」，要求：',
    '- 先写一段不超过 3 句话的总览；',
    '- 然后按主题分组（新增 / 改进 / 修复 / 其他），每组用列表条目（- ）逐条概括，只基于给出的提交信息概括，不要臆测；',
    '- 提交列表为空时仅输出「无提交变更」；',
    '- 不要调用任何工具；直接输出汇总正文，不要输出前言、说明或代码块围栏。',
    '',
    '提交列表（hash|作者|日期|主题）：',
  ].join('\n')
  const commitLines = result.commits.map(commit => `${commit.sha}|${commit.author}|${commit.date}|${commit.subject}`)
  const diffstat = typeof result.diffstat === 'string' ? result.diffstat : ''
  const assemble = (lines: readonly string[], stat: string): string =>
    `${head}\n${lines.join('\n')}\n\n变更统计（diff --stat）：\n${stat}`

  let kept = commitLines
  let prompt = assemble(kept, diffstat)
  while (kept.length > 0 && prompt.length > MAX_PROMPT_CHARS) {
    kept = kept.slice(0, -1)
    prompt = assemble(kept, diffstat)
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    // Defensive: even the shortest prompt must fit the route's cap.
    const room = MAX_PROMPT_CHARS - assemble(kept, '').length - 16
    prompt = assemble(kept, `${diffstat.slice(0, Math.max(0, room))}\n…（已截断）`)
  }
  return prompt
}

/* ── Small DOM helpers ─────────────────────────────────────────────────── */

/** A `<code>` element with text content. */
function code(text: string): HTMLElement {
  const element = document.createElement('code')
  element.textContent = text
  return element
}

/**
 * Open one URL in the system browser, reporting a blocked popup instead of
 * silently doing nothing.
 * @param url - an already-validated http(s)/mailto URL.
 */
function openExternal(url: string): void {
  let opened: Window | null = null
  try {
    opened = window.open(url, '_blank', 'noopener,noreferrer')
  } catch {
    opened = null
  }
  if (opened === null) showToast(`无法自动打开浏览器，请手动访问：${url}`)
}

/* ── Safe Markdown subset (ported from src-tauri/ui/app.js) ─────────────── */

const INLINE_RE =
  /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\s][^*\n]*?(?<!\s))\*|_([^_\s][^_\n]*?(?<!\s))_|~~([^~]+?)~~|!\[([^\]]*)\]\((\S+?)\)|\[([^\]]+)\]\((\S+?)\)|<(https?:\/\/[^>\s]+)>/g

/** HTML-escape one fragment before it can reach `innerHTML`. */
function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The URL guard for every external link and image the renderer emits: http(s)
 * and mailto only, so untrusted remote text can never inject a `javascript:`
 * (or any other scheme) target. Anything else returns `""` and the caller
 * degrades the construct to plain text.
 */
function safeUrl(url: unknown): string {
  const value = String(url ?? '').trim()
  if (/^(https?:\/\/|mailto:)/i.test(value)) return value
  return ''
}

/** One release-note anchor. */
function anchorTag(href: string, inner: string): string {
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="Ctrl+点击在浏览器打开">${inner}</a>`
}

/** Inline Markdown: code, emphasis, strikethrough, images, links. */
function inline(text: string): string {
  // A fresh regex per call: this function recurses for emphasis content, and a
  // shared mutable lastIndex would make the outer scan loop forever.
  const inlineRe = new RegExp(INLINE_RE.source, 'g')
  let out = ''
  let last = 0
  let match: RegExpExecArray | null
  while ((match = inlineRe.exec(text)) !== null) {
    out += escapeHtml(text.slice(last, match.index))
    const [, backticks, codeText, bold1, bold2, em1, em2, strike, imgAlt, imgUrl, linkText, linkUrl, autoUrl] = match
    if (backticks !== undefined) {
      out += `<code>${escapeHtml(codeText)}</code>`
    } else if (bold1 !== undefined || bold2 !== undefined) {
      out += `<strong>${inline(bold1 ?? bold2)}</strong>`
    } else if (em1 !== undefined || em2 !== undefined) {
      out += `<em>${inline(em1 ?? em2)}</em>`
    } else if (strike !== undefined) {
      out += `<del>${inline(strike)}</del>`
    } else if (imgUrl !== undefined) {
      const safe = safeUrl(imgUrl)
      out += safe !== ''
        ? `<img src="${escapeHtml(safe)}" alt="${escapeHtml(imgAlt)}" loading="lazy" />`
        : escapeHtml(match[0])
    } else if (linkUrl !== undefined) {
      const safe = safeUrl(linkUrl)
      out += safe !== '' ? anchorTag(safe, inline(linkText)) : escapeHtml(match[0])
    } else if (autoUrl !== undefined) {
      const safe = safeUrl(autoUrl)
      out += safe !== '' ? anchorTag(safe, escapeHtml(autoUrl)) : escapeHtml(match[0])
    } else {
      out += escapeHtml(match[0])
    }
    last = match.index + match[0].length
  }
  out += escapeHtml(text.slice(last))
  return out
}

/** Whether line `index` opens a GitHub-style table. */
function isTableStart(lines: readonly string[], index: number): boolean {
  return lines[index].includes('|')
    && index + 1 < lines.length
    && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[index + 1])
}

/** Split one table line into trimmed cells. */
function tableRow(line: string): string[] {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|')) row = row.slice(0, -1)
  return row.split('|').map(cell => cell.trim())
}

/** Column alignments of a table's delimiter row. */
function tableAligns(line: string): string[] {
  return tableRow(line).map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return left ? 'left' : ''
  })
}

/**
 * Render a safe HTML subset of GitHub-flavoured Markdown. Block structure:
 * headings, fenced code, blockquotes, tables, unordered/ordered lists
 * (checkboxes kept), hr, and paragraphs (single newlines become `<br>`, like
 * the GitHub release view). Nested lists and raw inline HTML are not supported
 * and stay as text.
 *
 * @param src - the release body or a plain-text fallback.
 * @returns HTML that only contains the fixed tag set above.
 */
export function renderMarkdown(src: string): string {
  const lines = String(src ?? '').split(/\r?\n/)
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i++
      continue
    }
    const fence = line.match(/^\s*```[ \t]*(\S*)\s*$/)
    if (fence !== null) {
      const codeLines: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        codeLines.push(lines[i])
        i++
      }
      if (i < lines.length) i++
      out.push(`<pre class="dsh-auto-update-code"><code${fence[1] !== '' ? ` data-lang="${escapeHtml(fence[1])}"` : ''}>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading !== null) {
      const level = heading[1].length
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      i++
      continue
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr>')
      i++
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      out.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`)
      continue
    }
    if (isTableStart(lines, i)) {
      const header = tableRow(line)
      const aligns = tableAligns(lines[i + 1])
      const alignStyle = (value: string): string => (value !== '' ? ` style="text-align:${value}"` : '')
      let table = `<table><thead><tr>${header
        .map((cell, index) => `<th${alignStyle(aligns[index] ?? '')}>${inline(cell) || '&nbsp;'}</th>`)
        .join('')}`
      table += '</tr></thead><tbody>'
      i += 2
      while (i < lines.length && lines[i].includes('|') && !isTableStart(lines, i)) {
        table += `<tr>${tableRow(lines[i])
          .map((cell, index) => `<td${alignStyle(aligns[index] ?? '')}>${inline(cell) || '&nbsp;'}</td>`)
          .join('')}</tr>`
        i++
      }
      table += '</tbody></table>'
      out.push(table)
      continue
    }
    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/)
    if (listMatch !== null) {
      const ordered = /\d+\./.test(listMatch[2])
      const items: string[] = []
      while (i < lines.length) {
        const item = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/)
        if (item === null || /\d+\./.test(item[2]) !== ordered) break
        items.push(item[3])
        i++
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items
        .map((item) => {
          const task = item.match(/^\[( |x|X)\]\s+(.*)$/)
          if (task !== null) {
            return `<li class="dsh-auto-update-task">${task[1].toLowerCase() === 'x' ? '☑ ' : '☐ '}${inline(task[2])}</li>`
          }
          return `<li>${inline(item)}</li>`
        })
        .join('')}</${ordered ? 'ol' : 'ul'}>`)
      continue
    }
    const paragraph: string[] = []
    while (
      i < lines.length
      && lines[i].trim() !== ''
      && !/^(#{1,6})\s+|^\s*>\s?|^\s*```|^\s*(\s*)([-*+]|\d+\.)\s+/.test(lines[i])
      && !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
      && !isTableStart(lines, i)
    ) {
      paragraph.push(lines[i])
      i++
    }
    if (paragraph.length > 0) {
      out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`)
    } else {
      // Defensive: never spin on a line no block accepted.
      i++
    }
  }
  return out.join('\n')
}
