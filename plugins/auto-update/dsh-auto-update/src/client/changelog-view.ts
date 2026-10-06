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

import { fetchChangelog, type Changelog, type ChangelogCommit, type UpdateProject } from './api.ts'
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

  /** Render one successful answer. */
  const renderResult = (result: Changelog, project: UpdateProject): void => {
    renderTitle(project.name !== '' ? project.name : project.id, project.releaseUrl)

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

    const releaseBody = typeof result.release?.body === 'string' ? result.release.body.trim() : ''
    if (releaseBody !== '') {
      try {
        body.innerHTML = renderMarkdown(releaseBody)
      } catch {
        // Never lose the content to a renderer edge: fall back to plain text.
        body.innerHTML = `<pre class="dsh-auto-update-plain">${escapeHtml(releaseBody)}</pre>`
      }
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
    } else {
      renderCommits(result.commits)
    }
    body.hidden = false
  }

  /** Load one module's changelog. */
  const load = async (project: UpdateProject, mode: UpdateMode): Promise<void> => {
    const request = ++generation
    const label = project.name !== '' ? project.name : project.id
    renderTitle(label, undefined)
    sub.replaceChildren()
    body.hidden = true
    body.replaceChildren()
    loading.hidden = false
    loading.removeAttribute('data-error')
    loading.textContent = '正在获取更新日志…（tag 目标优先读取 GitHub Release 说明；否则列出该更新范围内的提交）'
    element.hidden = false

    clearStall()
    stallTimer = setTimeout(() => {
      loading.textContent = '正在读取远端提交列表，可能需要一会儿…'
    }, STALL_MS)

    try {
      const result = await fetchChangelog(project.id, mode)
      if (disposed || request !== generation) return
      clearStall()
      loading.hidden = true
      renderResult(result, project)
    } catch (error) {
      if (disposed || request !== generation) return
      clearStall()
      loading.hidden = false
      loading.setAttribute('data-error', '')
      loading.textContent = `无法获取更新日志：${messageOf(error)}`
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
