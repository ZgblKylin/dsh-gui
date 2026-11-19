/**
 * Overlay page of the quick-assistant plugin.
 *
 * Renders the four panels (ask / translate / summary / explain), streams model
 * output from the DSH host over SSE, and drives the native helper window
 * (height, pin, hide) through the Tauri bridge. A plain browser without the
 * bridge still renders and reports missing requests inline.
 */
(function () {
  'use strict'

  const STATE_KEY = 'dsh-quick-assistant.state'
  const MIN_WINDOW_HEIGHT = 240
  const MAX_WINDOW_HEIGHT = 860
  const INPUT_MAX_HEIGHT = 132
  const SCROLL_STICK_THRESHOLD = 48
  const PERSIST_DELAY = 180

  const MODES = [
    { id: 'ask', title: '回答此问题' },
    { id: 'translate', title: '文本翻译' },
    { id: 'summary', title: '内容总结' },
    { id: 'explain', title: '解释说明' },
  ]

  const PLACEHOLDERS = {
    home: '输入内容，按 Enter 开始',
    ask: '继续输入，按 Enter 发送',
    translate: '输入要翻译的文本，按 Enter 翻译',
    summary: '',
    explain: '',
  }

  /** Contract §3 language table, used until bootstrap delivers the host list. */
  const FALLBACK_LANGUAGES = [
    { code: 'en-us', label: '英文' },
    { code: 'zh-cn', label: '简体中文' },
    { code: 'zh-tw', label: '繁体中文' },
    { code: 'ja-jp', label: '日文' },
    { code: 'ko-kr', label: '韩文' },
    { code: 'fr-fr', label: '法文' },
    { code: 'de-de', label: '德文' },
    { code: 'it-it', label: '意大利文' },
    { code: 'es-es', label: '西班牙文' },
    { code: 'pt-pt', label: '葡萄牙文' },
    { code: 'ru-ru', label: '俄文' },
    { code: 'pl-pl', label: '波兰文' },
    { code: 'cs-cz', label: '捷克文' },
    { code: 'ar-sa', label: '阿拉伯文' },
    { code: 'tr-tr', label: '土耳其文' },
    { code: 'th-th', label: '泰文' },
    { code: 'vi-vn', label: '越南文' },
    { code: 'id-id', label: '印尼文' },
    { code: 'ur-pk', label: '乌尔都文' },
    { code: 'ms-my', label: '马来文' },
    { code: 'uk-ua', label: '乌克兰文' },
  ]

  const runtime = {
    view: 'home',
    lastMode: 'ask',
    selected: 0,
    input: '',
    messages: [],
    results: { summary: '', explain: '' },
    translation: createTranslationState(),
    languages: FALLBACK_LANGUAGES.slice(),
    settings: null,
    pinned: false,
    error: null,
  }

  const bridge = createBridge()
  const token = readToken()
  const apiBase = resolveApiBase()
  const dom = cacheDom()
  const selects = { source: null, target: null }
  const openSelects = new Set()
  const stickiness = new WeakMap()
  let activeJob = null
  let sizeFrame = 0
  let lastRequestedHeight = 0
  let persistTimer = 0

  init()

  // ---------------------------------------------------------------- lifecycle

  function init() {
    restoreState()
    renderMenu()
    selects.source = createLanguageSelect(dom.sourceLangHost, 'source')
    selects.target = createLanguageSelect(dom.targetLangHost, 'target')
    refreshLanguageSelects()
    bindEvents()
    renderMessages()
    renderTranslation()
    renderResult('summary')
    renderResult('explain')
    dom.input.value = runtime.input
    applyPinUi()
    showView(runtime.view, { persist: false, focus: false })
    autoGrow()
    bridge.invoke('qa_set_pinned', { pinned: runtime.pinned })
    bridge.listen('qa-shown', onShown)
    bridge.listen('qa-hidden', onHidden)
    scheduleSize()
    bootstrap()
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(scheduleSize).observe(dom.panel)
    }
  }

  function onShown() {
    focusInput()
    autoGrow()
    scheduleSize()
    if (activeJob) return
    const view = runtime.view
    if (view === 'translate' && runtime.translation.source && !runtime.translation.target) {
      runTranslation()
    } else if ((view === 'summary' || view === 'explain') && !runtime.results[view] && runtime.input.trim()) {
      runResult(view)
    }
  }

  function onHidden() {
    abortJob()
    closeAllSelects()
    flushPersist()
  }

  function onPageHide() {
    abortJob()
    flushPersist()
  }

  // -------------------------------------------------------------- boot data

  async function bootstrap() {
    if (!apiBase) {
      showError(runtime.view, '无法确定本地服务地址', bootstrap, 'bootstrap')
      return
    }
    try {
      const url = new URL('api/bootstrap', apiBase)
      if (token) url.searchParams.set('token', token)
      const response = await fetch(url.href, { headers: requestHeaders(), cache: 'no-store' })
      if (!response.ok) throw new Error(await readFailure(response))
      applyBootstrap(await response.json())
      if (runtime.error && runtime.error.source === 'bootstrap') clearError()
    } catch (error) {
      showError(runtime.view, humanizeError(error), bootstrap, 'bootstrap')
    }
  }

  function applyBootstrap(payload) {
    if (!payload || typeof payload !== 'object') return
    if (payload.settings && typeof payload.settings === 'object') runtime.settings = payload.settings
    const languages = normalizeLanguages(payload.languages)
    if (languages) runtime.languages = languages
    refreshLanguageSelects()
    persist()
  }

  function normalizeLanguages(value) {
    if (!Array.isArray(value)) return null
    const languages = []
    const seen = new Set()
    for (const item of value) {
      if (!item || typeof item !== 'object') continue
      const code = typeof item.code === 'string' ? item.code : typeof item.id === 'string' ? item.id : ''
      const label = typeof item.label === 'string' ? item.label : typeof item.name === 'string' ? item.name : ''
      if (!code || !label || seen.has(code)) continue
      seen.add(code)
      languages.push({ code, label })
    }
    return languages.length ? languages : null
  }

  // ---------------------------------------------------------------- binding

  function bindEvents() {
    dom.input.addEventListener('input', onInput)
    dom.input.addEventListener('keydown', onInputKeyDown)
    dom.composer.addEventListener('animationend', () => dom.composer.classList.remove('is-nudged'))
    dom.menuRows.forEach((row, index) => {
      row.addEventListener('click', () => {
        selectMode(index)
        activateMode(row.dataset.mode)
      })
    })
    // Hover selection follows real pointer movement only; a row that appears
    // under a stationary cursor must not steal the keyboard selection.
    dom.menu.addEventListener('pointermove', (event) => {
      const row = event.target.closest('.menu-row')
      if (!row) return
      const index = dom.menuRows.indexOf(row)
      if (index >= 0 && index !== runtime.selected) selectMode(index)
    })
    dom.backBtn.addEventListener('click', goBack)
    dom.closeBtn.addEventListener('click', hidePanel)
    dom.pinBtn.addEventListener('click', togglePin)
    dom.errorRetry.addEventListener('click', retryError)
    document.addEventListener('keydown', onDocumentKeyDown)
    document.addEventListener('pointerdown', onDocumentPointerDown, true)
    window.addEventListener('pagehide', onPageHide)
    trackScroll(dom.messages)
    trackScroll(dom.sourceText)
    trackScroll(dom.targetText)
    trackScroll(dom.results.summary)
    trackScroll(dom.results.explain)
  }

  function onInput() {
    runtime.input = dom.input.value
    autoGrow()
    persist()
  }

  function onInputKeyDown(event) {
    if (event.isComposing || event.keyCode === 229) return
    if (event.key !== 'Enter' || event.shiftKey) return
    if (dom.input.readOnly) return
    event.preventDefault()
    if (runtime.view === 'home') {
      activateMode(MODES[runtime.selected].id)
    } else if (runtime.view === 'ask') {
      submitAskInput()
    } else if (runtime.view === 'translate') {
      retranslateFromInput()
    }
  }

  function onDocumentKeyDown(event) {
    if (event.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      if (closeAllSelects()) {
        event.preventDefault()
        return
      }
      event.preventDefault()
      if (runtime.view === 'home') hidePanel()
      else goBack()
      return
    }
    if (runtime.view !== 'home') return
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    if (event.altKey || event.ctrlKey || event.metaKey) return
    event.preventDefault()
    selectMode(runtime.selected + (event.key === 'ArrowDown' ? 1 : -1))
  }

  function onDocumentPointerDown(event) {
    for (const select of Array.from(openSelects)) {
      if (!select.host.contains(event.target)) select.close()
    }
  }

  function selectMode(index) {
    runtime.selected = ((index % MODES.length) + MODES.length) % MODES.length
    renderMenu()
  }

  function renderMenu() {
    dom.menuRows.forEach((row, index) => {
      const selected = index === runtime.selected
      row.classList.toggle('is-selected', selected)
      row.setAttribute('aria-selected', selected ? 'true' : 'false')
    })
  }

  // ------------------------------------------------------------------ views

  function showView(view, options) {
    const settings = options || {}
    runtime.view = view
    dom.panel.dataset.view = view
    for (const id of Object.keys(dom.views)) dom.views[id].hidden = id !== view
    dom.backBtn.hidden = view === 'home'
    dom.homeHints.hidden = view !== 'home'
    const editable = view === 'home' || view === 'ask' || view === 'translate'
    dom.input.readOnly = !editable
    dom.input.classList.toggle('is-readonly', !editable)
    dom.input.placeholder = PLACEHOLDERS[view] || ''
    renderError()
    autoGrow()
    if (settings.persist !== false) persist()
    if (settings.focus !== false && editable) focusInput()
    scheduleSize()
  }

  function hidePanel() {
    closeAllSelects()
    flushPersist()
    bridge.invoke('qa_hide')
  }

  function activateMode(modeId) {
    const text = runtime.input.trim()
    if (!text) {
      nudgeComposer()
      focusInput()
      return
    }
    runtime.lastMode = modeId
    if (modeId === 'ask') {
      setInput('')
      showView('ask')
      sendAskMessage(text)
      return
    }
    if (modeId === 'translate') {
      const previousSource = runtime.translation.source
      runtime.translation.source = text
      showView('translate')
      renderTranslation()
      if (!runtime.translation.target || previousSource !== text) runTranslation()
      else persist()
      return
    }
    showView(modeId)
    runtime.results[modeId] = ''
    renderResult(modeId)
    runResult(modeId)
  }

  function setInput(value) {
    runtime.input = value
    dom.input.value = value
    autoGrow()
  }

  function goBack() {
    closeAllSelects()
    // Leaving a sub-panel drops the request it started: the answer is no longer
    // visible, and the model call must not keep occupying the provider.
    abortJob()
    showView('home')
  }

  // ------------------------------------------------------- answer rendering

  /** Render markdown into a host element that already exists. */
  function paintMarkdown(host, text) {
    if (window.qaMarkdown && typeof window.qaMarkdown.renderInto === 'function') {
      window.qaMarkdown.renderInto(host, text)
      return
    }
    host.textContent = text
  }

  /** Replace a host's content with markdown text, or clear it when empty. */
  function renderMarkdown(contentHost, text) {
    contentHost.textContent = ''
    if (!text) return
    const body = document.createElement('div')
    body.className = 'markdown'
    paintMarkdown(body, text)
    contentHost.appendChild(body)
  }

  /** Return the markdown body of a streaming host, creating it on first use. */
  function ensureMarkdownBody(contentHost) {
    let body = contentHost.querySelector('.markdown')
    if (!body) {
      body = document.createElement('div')
      body.className = 'markdown'
      contentHost.appendChild(body)
    }
    return body
  }

  /**
   * Add the one-line thinking indicator streaming reasoning into a host. The
   * row keeps the newest text visible and is removed when the answer starts.
   */
  function createThinkingLine(contentHost) {
    const line = document.createElement('div')
    line.className = 'thinking-line'
    const label = document.createElement('span')
    label.className = 'thinking-label'
    label.textContent = '思考中'
    const text = document.createElement('span')
    text.className = 'thinking-text'
    line.appendChild(label)
    line.appendChild(text)
    contentHost.insertBefore(line, contentHost.firstChild)
    return {
      push(chunk) {
        text.textContent += chunk
        // One line only: keep the tail in view as the text outgrows the row.
        text.scrollLeft = text.scrollWidth
      },
      hide() {
        if (line.parentNode) line.parentNode.removeChild(line)
      },
    }
  }

  // ------------------------------------------------------------------- ask

  function submitAskInput() {
    const text = runtime.input.trim()
    if (!text) return
    setInput('')
    sendAskMessage(text)
    focusInput()
  }

  function sendAskMessage(text) {
    const history = runtime.messages.map((message) => ({ role: message.role, content: message.content }))
    runtime.messages.push({ role: 'user', content: text })
    const placeholder = { role: 'assistant', content: '', pending: true }
    runtime.messages.push(placeholder)
    const payload = { mode: 'ask', text }
    if (history.length) payload.messages = history
    runAsk(payload, placeholder)
    persist()
  }

  function retryAskTurn(payload, failed) {
    const last = runtime.messages[runtime.messages.length - 1]
    if (last === failed) runtime.messages.pop()
    const placeholder = { role: 'assistant', content: '', pending: true }
    runtime.messages.push(placeholder)
    runAsk(payload, placeholder)
    persist()
  }

  function runAsk(payload, assistant) {
    abortJob()
    assistant.content = ''
    assistant.pending = true
    renderMessages()
    const index = runtime.messages.indexOf(assistant)
    if (index < 0) return
    const bubble = dom.messageBubbles[index]
    if (!bubble) return
    const body = ensureMarkdownBody(bubble)
    const thinking = createThinkingLine(bubble)
    const writer = createWriter((text) => {
      assistant.content += text
      paintMarkdown(body, assistant.content)
      scrollIfStuck(dom.messages)
    })
    startJob({
      mode: 'ask',
      payload,
      retry: () => retryAskTurn(payload, assistant),
      onReasoning(text) {
        thinking.push(text)
      },
      onDelta(text) {
        thinking.hide()
        if (assistant.pending) {
          assistant.pending = false
          bubble.classList.remove('is-pending')
          bubble.classList.add('is-streaming')
        }
        writer.write(text)
      },
      onDone() {
        writer.flush()
        thinking.hide()
        finishAssistant(assistant, bubble)
        persist()
      },
      onAbort() {
        writer.flush()
        thinking.hide()
        finishAssistant(assistant, bubble)
        persist()
      },
      onError() {
        writer.flush()
        thinking.hide()
        finishAssistant(assistant, bubble)
      },
    })
  }

  function finishAssistant(assistant, bubble) {
    assistant.pending = false
    bubble.classList.remove('is-pending', 'is-streaming')
    if (!assistant.content) removeMessage(assistant)
  }

  function removeMessage(message) {
    const index = runtime.messages.indexOf(message)
    if (index < 0) return
    runtime.messages.splice(index, 1)
    renderMessages()
  }

  function renderMessages() {
    dom.messages.textContent = ''
    dom.messageBubbles = []
    for (const message of runtime.messages) {
      const row = document.createElement('div')
      row.className = 'msg msg-' + message.role
      const bubble = document.createElement('div')
      bubble.className = 'bubble'
      if (message.pending) bubble.classList.add('is-pending')
      if (message.role === 'assistant') {
        const body = document.createElement('div')
        body.className = 'markdown'
        if (message.content) paintMarkdown(body, message.content)
        bubble.appendChild(body)
      } else {
        bubble.textContent = message.content
      }
      row.appendChild(bubble)
      dom.messages.appendChild(row)
      dom.messageBubbles.push(bubble)
    }
    dom.messages.scrollTop = dom.messages.scrollHeight
  }

  // ---------------------------------------------------- translate / results

  function retranslateFromInput() {
    const text = runtime.input.trim()
    if (!text) {
      nudgeComposer()
      return
    }
    runtime.translation.source = text
    renderTranslation()
    runTranslation()
    persist()
  }

  function runTranslation() {
    const source = runtime.translation.source
    renderTranslation()
    if (!source) return
    abortJob()
    runtime.translation.target = ''
    const targetElement = dom.targetText
    targetElement.textContent = ''
    targetElement.classList.add('is-waiting', 'is-streaming')
    const writer = createWriter((text) => {
      runtime.translation.target += text
      targetElement.textContent = runtime.translation.target
      scrollIfStuck(targetElement)
    })
    startJob({
      mode: 'translate',
      payload: {
        mode: 'translate',
        text: source,
        sourceLanguage: runtime.translation.sourceLanguage,
        targetLanguage: runtime.translation.targetLanguage,
      },
      retry: runTranslation,
      onDelta(text) {
        targetElement.classList.remove('is-waiting')
        writer.write(text)
      },
      onDone() {
        writer.flush()
        targetElement.classList.remove('is-waiting', 'is-streaming')
        persist()
      },
      onAbort() {
        writer.flush()
        targetElement.classList.remove('is-waiting', 'is-streaming')
        persist()
      },
      onError() {
        writer.flush()
        targetElement.classList.remove('is-waiting', 'is-streaming')
      },
    })
  }

  function runResult(mode) {
    abortJob()
    runtime.results[mode] = ''
    const element = dom.results[mode]
    element.textContent = ''
    element.classList.add('is-waiting', 'is-streaming')
    const body = document.createElement('div')
    body.className = 'markdown'
    element.appendChild(body)
    const thinking = createThinkingLine(element)
    const writer = createWriter((text) => {
      runtime.results[mode] += text
      paintMarkdown(body, runtime.results[mode])
      scrollIfStuck(element)
    })
    startJob({
      mode,
      payload: { mode, text: runtime.input.trim() },
      retry: () => runResult(mode),
      onReasoning(text) {
        thinking.push(text)
      },
      onDelta(text) {
        element.classList.remove('is-waiting')
        thinking.hide()
        writer.write(text)
      },
      onDone() {
        writer.flush()
        thinking.hide()
        element.classList.remove('is-waiting', 'is-streaming')
        persist()
      },
      onAbort() {
        writer.flush()
        thinking.hide()
        element.classList.remove('is-waiting', 'is-streaming')
        persist()
      },
      onError() {
        writer.flush()
        thinking.hide()
        element.classList.remove('is-waiting', 'is-streaming')
      },
    })
  }

  function renderResult(mode) {
    const element = dom.results[mode]
    element.classList.remove('is-waiting', 'is-streaming')
    renderMarkdown(element, runtime.results[mode])
  }

  function renderTranslation() {
    dom.sourceText.textContent = runtime.translation.source
    dom.targetText.textContent = runtime.translation.target
  }

  // ------------------------------------------------------------- chat jobs

  function startJob(job) {
    abortJob()
    clearError()
    const entry = { controller: new AbortController(), usage: null, hooks: job }
    activeJob = entry
    streamChat(job.payload, entry.controller.signal, {
      delta(text) {
        if (activeJob !== entry) return
        job.onDelta(text)
      },
      reasoning(text) {
        if (activeJob !== entry) return
        if (typeof job.onReasoning === 'function') job.onReasoning(text)
      },
      done(usage) {
        entry.usage = usage
      },
    }).then(
      () => {
        if (activeJob === entry) activeJob = null
        if (entry.controller.signal.aborted) return
        job.onDone(entry.usage)
      },
      (error) => {
        if (activeJob === entry) activeJob = null
        if (entry.controller.signal.aborted) return
        job.onError()
        showError(job.mode, humanizeError(error), job.retry, 'chat')
      },
    )
  }

  function abortJob() {
    const job = activeJob
    if (!job) return
    activeJob = null
    job.controller.abort()
    const hooks = job.hooks
    if (hooks && typeof hooks.onAbort === 'function') hooks.onAbort()
  }

  /**
   * POST /api/chat and read the SSE body without EventSource: bytes are
   * decoded incrementally and dispatched per `event:` / `data:` record.
   */
  async function streamChat(payload, signal, handlers) {
    if (!apiBase) throw new Error('无法访问本地服务（页面地址无效）')
    const url = new URL('api/chat', apiBase)
    const response = await fetch(url.href, {
      method: 'POST',
      headers: requestHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(payload),
      signal,
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(await readFailure(response))
    if (!response.body) throw new Error('服务未返回响应内容')
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('text/event-stream')) {
      throw new Error(extractMessage(await response.text()) || '服务返回了非流式响应')
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        buffer = drainRecords(buffer, handlers)
      }
      buffer += decoder.decode()
      if (buffer.trim()) parseRecord(buffer, handlers)
    } finally {
      reader.cancel().catch(() => undefined)
    }
  }

  function drainRecords(buffer, handlers) {
    for (;;) {
      const match = /\r?\n\r?\n/.exec(buffer)
      if (!match) return buffer
      const record = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      parseRecord(record, handlers)
    }
  }

  function parseRecord(record, handlers) {
    let event = 'message'
    const data = []
    for (const line of record.split(/\r?\n/)) {
      if (!line || line.charAt(0) === ':') continue
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.charAt(0) === ' ') value = value.slice(1)
      if (field === 'event') event = value
      else if (field === 'data') data.push(value)
    }
    if (!data.length) return
    let parsed
    try {
      parsed = JSON.parse(data.join('\n'))
    } catch {
      return
    }
    if (event === 'delta') {
      const text = parsed && typeof parsed.text === 'string' ? parsed.text : ''
      if (text) handlers.delta(text)
    } else if (event === 'reasoning') {
      const text = parsed && typeof parsed.text === 'string' ? parsed.text : ''
      if (text && typeof handlers.reasoning === 'function') handlers.reasoning(text)
    } else if (event === 'done') {
      handlers.done(parsed && typeof parsed === 'object' ? parsed : {})
    } else if (event === 'error') {
      throw new Error(errorMessageFromEvent(parsed))
    }
    // `meta` only announces the resolved provider / model; the page shows no
    // per-request model label, so it needs no rendering.
  }

  function errorMessageFromEvent(parsed) {
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message
      if (typeof parsed.code === 'string' && parsed.code) return '生成失败（' + parsed.code + '）'
    }
    return '生成失败'
  }

  async function readFailure(response) {
    let body = ''
    try {
      body = await response.text()
    } catch {
      body = ''
    }
    return extractMessage(body) || '请求失败（HTTP ' + response.status + '）'
  }

  function extractMessage(body) {
    if (!body) return ''
    try {
      const parsed = JSON.parse(body)
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.error === 'string' && parsed.error) return parsed.error
        if (typeof parsed.message === 'string' && parsed.message) return parsed.message
      }
    } catch {
      // Not JSON; fall through to the bounded plain-text form.
    }
    const text = body.trim()
    return text.length > 0 && text.length <= 200 ? text : ''
  }

  function humanizeError(error) {
    const message = error && typeof error.message === 'string' ? error.message.trim() : ''
    if (!message) return '请求失败'
    if (/Failed to fetch|NetworkError|Load failed|fetch failed/i.test(message)) return '无法连接到本地服务'
    return message
  }

  // ---------------------------------------------------------------- errors

  function showError(view, message, retry, source) {
    runtime.error = { view, message, retry, source }
    renderError()
  }

  function clearError() {
    if (!runtime.error) return
    runtime.error = null
    renderError()
  }

  function renderError() {
    const error = runtime.error
    const visible = Boolean(error) && error.view === runtime.view
    dom.errorRow.hidden = !visible
    if (visible) dom.errorMessage.textContent = error.message
    scheduleSize()
  }

  function retryError() {
    const error = runtime.error
    if (!error) return
    clearError()
    error.retry()
  }

  // ------------------------------------------------------------------ pin

  function togglePin() {
    runtime.pinned = !runtime.pinned
    applyPinUi()
    bridge.invoke('qa_set_pinned', { pinned: runtime.pinned })
    persist()
    scheduleSize()
  }

  function applyPinUi() {
    dom.pinBtn.classList.toggle('is-active', runtime.pinned)
    dom.pinBtn.setAttribute('aria-pressed', runtime.pinned ? 'true' : 'false')
    dom.pinBtn.title = runtime.pinned ? '取消置顶' : '置顶（失焦不关闭）'
    dom.pinLabel.textContent = runtime.pinned ? '已置顶' : '置顶'
  }

  // -------------------------------------------------------------- selectors

  function createLanguageSelect(host, kind) {
    const stateKey = kind === 'source' ? 'sourceLanguage' : 'targetLanguage'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'lang-btn'
    button.setAttribute('aria-haspopup', 'listbox')
    button.setAttribute('aria-expanded', 'false')

    const label = document.createElement('span')
    label.className = 'lang-label'
    const chevron = document.createElement('span')
    chevron.className = 'lang-chevron'
    chevron.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>'
    button.append(label, chevron)

    const menu = document.createElement('div')
    menu.className = 'lang-menu'
    menu.setAttribute('role', 'listbox')
    menu.hidden = true
    host.append(button, menu)

    let open = false
    let activeIndex = 0

    function currentCode() {
      return runtime.translation[stateKey]
    }

    function currentLabel() {
      const code = currentCode()
      if (code === 'auto') return kind === 'source' ? '自动' : autoTargetLabel()
      return languageLabel(code)
    }

    function optionItems() {
      const items = [{ code: 'auto', label: kind === 'source' ? '自动' : autoTargetLabel() }]
      for (const language of runtime.languages) items.push({ code: language.code, label: language.label })
      return items
    }

    function setActive(index, scroll) {
      const options = menu.querySelectorAll('.lang-option')
      if (!options.length) return
      activeIndex = ((index % options.length) + options.length) % options.length
      options.forEach((option, optionIndex) => option.classList.toggle('is-active', optionIndex === activeIndex))
      if (scroll && open) options[activeIndex].scrollIntoView({ block: 'nearest' })
    }

    function renderOptions() {
      menu.textContent = ''
      const items = optionItems()
      items.forEach((item, index) => {
        const option = document.createElement('button')
        option.type = 'button'
        option.className = 'lang-option'
        option.setAttribute('role', 'option')
        option.setAttribute('aria-selected', item.code === currentCode() ? 'true' : 'false')
        option.tabIndex = -1
        option.dataset.index = String(index)
        option.textContent = item.label
        if (item.code === currentCode()) option.classList.add('is-selected')
        menu.appendChild(option)
      })
      const selectedIndex = items.findIndex((item) => item.code === currentCode())
      setActive(selectedIndex < 0 ? 0 : selectedIndex, false)
    }

    function fitMenu() {
      const buttonRect = button.getBoundingClientRect()
      const panelRect = dom.panel.getBoundingClientRect()
      const below = panelRect.bottom - buttonRect.bottom - 14
      const above = buttonRect.top - panelRect.top - 14
      const dropUp = below < 120 && above > below
      menu.classList.toggle('lang-menu-up', dropUp)
      menu.style.maxHeight = Math.round(Math.min(252, Math.max(80, dropUp ? above : below))) + 'px'
    }

    function openMenu() {
      if (open) return
      open = true
      renderOptions()
      menu.hidden = false
      button.setAttribute('aria-expanded', 'true')
      openSelects.add(api)
      fitMenu()
      scheduleSize()
    }

    function closeMenu() {
      if (!open) return
      open = false
      menu.hidden = true
      button.setAttribute('aria-expanded', 'false')
      openSelects.delete(api)
      scheduleSize()
    }

    function refresh() {
      label.textContent = currentLabel()
      button.title = currentLabel()
      if (open) renderOptions()
    }

    function choose(code) {
      closeMenu()
      button.focus({ preventScroll: true })
      if (runtime.translation[stateKey] === code) return
      runtime.translation[stateKey] = code
      refresh()
      persist()
      if (runtime.translation.source) runTranslation()
      else renderTranslation()
    }

    function onButtonKeyDown(event) {
      if (event.isComposing) return
      if (event.key === 'Escape') {
        if (!open) return
        event.preventDefault()
        event.stopPropagation()
        closeMenu()
        button.focus({ preventScroll: true })
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        if (!open) openMenu()
        else setActive(activeIndex + (event.key === 'ArrowDown' ? 1 : -1), true)
        return
      }
      if ((event.key === 'Enter' || event.key === ' ') && open) {
        event.preventDefault()
        event.stopPropagation()
        const option = menu.querySelectorAll('.lang-option')[activeIndex]
        if (option) option.click()
      }
    }

    function onOptionClick(event) {
      const option = event.target.closest('.lang-option')
      if (!option) return
      const item = optionItems()[Number(option.dataset.index)]
      if (item) choose(item.code)
    }

    const api = { host, refresh, close: closeMenu, isOpen: () => open }
    button.addEventListener('click', () => {
      if (open) closeMenu()
      else openMenu()
    })
    button.addEventListener('keydown', onButtonKeyDown)
    menu.addEventListener('click', onOptionClick)
    // Keep keyboard focus on the trigger while the list is used as a popup.
    menu.addEventListener('pointerdown', (event) => event.preventDefault())
    refresh()
    return api
  }

  function refreshLanguageSelects() {
    for (const select of [selects.source, selects.target]) {
      if (select) select.refresh()
    }
  }

  function closeAllSelects() {
    if (!openSelects.size) return false
    for (const select of Array.from(openSelects)) select.close()
    return true
  }

  function autoTargetLabel() {
    const translation = runtime.settings && runtime.settings.translation
    if (!translation) return '自动'
    const primary = languageLabel(translation.primaryLanguage)
    const secondary = languageLabel(translation.secondaryLanguage)
    return primary && secondary ? '自动（' + primary + '/' + secondary + '）' : '自动'
  }

  function languageLabel(code) {
    if (!code) return ''
    const language =
      runtime.languages.find((item) => item.code === code) ||
      FALLBACK_LANGUAGES.find((item) => item.code === code) ||
      null
    return language ? language.label : code
  }

  // ------------------------------------------------------- layout / effects

  function autoGrow() {
    const input = dom.input
    input.style.height = 'auto'
    const height = Math.min(input.scrollHeight, INPUT_MAX_HEIGHT)
    input.style.height = height + 'px'
    input.style.overflowY = input.scrollHeight > INPUT_MAX_HEIGHT ? 'auto' : 'hidden'
    scheduleSize()
  }

  function scheduleSize() {
    if (sizeFrame) return
    sizeFrame = requestAnimationFrame(() => {
      sizeFrame = 0
      const bodyStyle = getComputedStyle(document.body)
      const padding = (parseFloat(bodyStyle.paddingTop) || 0) + (parseFloat(bodyStyle.paddingBottom) || 0)
      const height = Math.round(clamp(dom.panel.offsetHeight + padding, MIN_WINDOW_HEIGHT, MAX_WINDOW_HEIGHT))
      if (Math.abs(height - lastRequestedHeight) < 1) return
      lastRequestedHeight = height
      bridge.invoke('qa_set_height', { height })
    })
  }

  function focusInput() {
    requestAnimationFrame(() => {
      const input = dom.input
      if (document.activeElement === input) return
      input.focus({ preventScroll: true })
      const end = input.value.length
      try {
        input.setSelectionRange(end, end)
      } catch {
        // Inputs that do not expose a selection still accept focus.
      }
    })
  }

  function nudgeComposer() {
    dom.composer.classList.remove('is-nudged')
    void dom.composer.offsetWidth
    dom.composer.classList.add('is-nudged')
  }

  function trackScroll(element) {
    stickiness.set(element, true)
    element.addEventListener(
      'scroll',
      () => {
        const distance = element.scrollHeight - element.scrollTop - element.clientHeight
        stickiness.set(element, distance < SCROLL_STICK_THRESHOLD)
      },
      { passive: true },
    )
  }

  function scrollIfStuck(element) {
    if (!stickiness.get(element)) return
    element.scrollTop = element.scrollHeight
  }

  function createWriter(append) {
    let queued = ''
    let frame = 0
    const flush = () => {
      if (frame) {
        cancelAnimationFrame(frame)
        frame = 0
      }
      if (!queued) return
      const text = queued
      queued = ''
      append(text)
    }
    return {
      write(text) {
        queued += text
        if (frame) return
        frame = requestAnimationFrame(() => {
          frame = 0
          flush()
        })
      },
      flush,
    }
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value))
  }

  // ------------------------------------------------------------ persistence

  function persist() {
    if (persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = 0
      writeState()
    }, PERSIST_DELAY)
  }

  function flushPersist() {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = 0
    }
    writeState()
  }

  function writeState() {
    const state = {
      view: runtime.view,
      mode: runtime.lastMode,
      input: runtime.input,
      messages: runtime.messages.map((message) => ({ role: message.role, content: message.content })),
      translation: {
        sourceLanguage: runtime.translation.sourceLanguage,
        targetLanguage: runtime.translation.targetLanguage,
        source: runtime.translation.source,
        target: runtime.translation.target,
      },
      pinned: runtime.pinned,
    }
    try {
      window.localStorage.setItem(STATE_KEY, JSON.stringify(state))
    } catch {
      // Storage can be unavailable; the session keeps working from memory.
    }
  }

  function restoreState() {
    const stored = readStoredState()
    if (!stored) return
    runtime.input = stored.input
    runtime.messages = stored.messages
    runtime.translation = stored.translation
    runtime.pinned = stored.pinned
    if (MODES.some((mode) => mode.id === stored.mode)) runtime.lastMode = stored.mode
    const view = validView(stored.view)
    runtime.view = normalizeView(view)
    runtime.selected = Math.max(0, MODES.findIndex((mode) => mode.id === runtime.lastMode))
  }

  function readStoredState() {
    let raw
    try {
      raw = window.localStorage.getItem(STATE_KEY)
    } catch {
      return null
    }
    if (!raw) return null
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    if (!parsed || typeof parsed !== 'object') return null
    return {
      view: typeof parsed.view === 'string' ? parsed.view : 'home',
      mode: typeof parsed.mode === 'string' ? parsed.mode : '',
      input: typeof parsed.input === 'string' ? parsed.input : '',
      messages: sanitizeMessages(parsed.messages),
      translation: sanitizeTranslation(parsed.translation),
      pinned: parsed.pinned === true,
    }
  }

  function validView(value) {
    return value === 'home' || MODES.some((mode) => mode.id === value) ? value : 'home'
  }

  function normalizeView(view) {
    if (view === 'ask' && !runtime.messages.length) return 'home'
    if (view === 'translate' && !runtime.translation.source && !runtime.translation.target) return 'home'
    if ((view === 'summary' || view === 'explain') && !runtime.input.trim()) return 'home'
    return view
  }

  function sanitizeMessages(value) {
    if (!Array.isArray(value)) return []
    const messages = []
    for (const item of value) {
      if (!item || typeof item !== 'object') continue
      if (item.role !== 'user' && item.role !== 'assistant') continue
      messages.push({ role: item.role, content: typeof item.content === 'string' ? item.content : '' })
    }
    return messages
  }

  function sanitizeTranslation(value) {
    const translation = createTranslationState()
    if (!value || typeof value !== 'object') return translation
    for (const key of ['sourceLanguage', 'targetLanguage']) {
      if (typeof value[key] === 'string' && value[key]) translation[key] = value[key]
    }
    for (const key of ['source', 'target']) {
      if (typeof value[key] === 'string') translation[key] = value[key]
    }
    return translation
  }

  function createTranslationState() {
    return { sourceLanguage: 'auto', targetLanguage: 'auto', source: '', target: '' }
  }

  // -------------------------------------------------------------- plumbing

  function cacheDom() {
    const results = {
      summary: document.getElementById('summary-result'),
      explain: document.getElementById('explain-result'),
    }
    return {
      panel: document.getElementById('panel'),
      composer: document.getElementById('composer'),
      input: document.getElementById('input'),
      menu: document.getElementById('menu'),
      menuRows: Array.prototype.slice.call(document.querySelectorAll('.menu-row')),
      views: {
        home: document.getElementById('view-home'),
        ask: document.getElementById('view-ask'),
        translate: document.getElementById('view-translate'),
        summary: document.getElementById('view-summary'),
        explain: document.getElementById('view-explain'),
      },
      messages: document.getElementById('messages'),
      messageBubbles: [],
      sourceLangHost: document.getElementById('source-lang'),
      targetLangHost: document.getElementById('target-lang'),
      sourceText: document.getElementById('source-text'),
      targetText: document.getElementById('target-text'),
      results,
      errorRow: document.getElementById('error-row'),
      errorMessage: document.getElementById('error-message'),
      errorRetry: document.getElementById('error-retry'),
      backBtn: document.getElementById('back-btn'),
      homeHints: document.getElementById('home-hints'),
      pinBtn: document.getElementById('pin-btn'),
      pinLabel: document.getElementById('pin-label'),
      closeBtn: document.getElementById('close-btn'),
    }
  }

  function createBridge() {
    const tauri = typeof window.__TAURI__ === 'object' && window.__TAURI__ ? window.__TAURI__ : null
    return {
      invoke(command, args) {
        const invoke = tauri && tauri.core && tauri.core.invoke
        if (typeof invoke !== 'function') return Promise.resolve(undefined)
        try {
          const result = invoke.call(tauri.core, command, args)
          return result && typeof result.then === 'function' ? result.catch(() => undefined) : Promise.resolve(result)
        } catch {
          return Promise.resolve(undefined)
        }
      },
      listen(event, handler) {
        const listen = tauri && tauri.event && tauri.event.listen
        if (typeof listen !== 'function') return
        try {
          const result = listen.call(tauri.event, event, handler)
          if (result && typeof result.catch === 'function') result.catch(() => undefined)
        } catch {
          // The bridge is optional; ignoring a missing listener keeps the page usable.
        }
      },
    }
  }

  function readToken() {
    const injected = typeof window.__QA_TOKEN__ === 'string' ? window.__QA_TOKEN__ : ''
    if (injected && injected !== '__QA_TOKEN__') return injected
    try {
      return new URL(window.location.href).searchParams.get('token') || ''
    } catch {
      return ''
    }
  }

  function resolveApiBase() {
    try {
      const url = new URL(window.location.href)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
      const path = url.pathname.endsWith('/') ? url.pathname : url.pathname + '/'
      return new URL(path, url.origin).href
    } catch {
      return null
    }
  }

  function requestHeaders(extra) {
    const headers = { 'x-qa-token': token }
    if (extra) {
      for (const key of Object.keys(extra)) headers[key] = extra[key]
    }
    return headers
  }
})()
