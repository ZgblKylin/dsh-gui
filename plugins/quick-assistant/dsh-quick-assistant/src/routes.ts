/**
 * HTTP surface of the quick assistant, mounted as the `/quick-assistant`
 * prefix on the harness web server.
 *
 * Two credential models share the prefix:
 *
 * - the overlay and the native helper carry a one-time token (`?token=` or
 *   `x-qa-token`) generated per plugin instance, because they live in a
 *   separate native window rather than the GUI page;
 * - the settings page is the GUI page itself, so its routes require only a
 *   same-origin request — the same fence dsh-desktop-tabs and dsh-auto-update
 *   use for their unauthenticated local RPC.
 *
 * The web server is bound to loopback before these routes are registered
 * (`index.ts`); nothing here is reachable from another machine.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

import { buildCatalog, CatalogCache, NoModelError, resolveRequestSelection, type CatalogSnapshot, type LlmCatalogService, type ModelSelection } from './catalog.ts'
import type { HelperStatus } from './helper.ts'
import { isValidAccelerator, defaultSettings, type AssistantSettings, type SettingsStore } from './settings.ts'
import { LANGUAGES } from './languages.ts'
import { isAssistantMode, renderPrompt, type AssistantMode } from './prompts.ts'
import { systemLanguageName } from './system-language.ts'
import { openSse, streamChat, messageOf, type LlmMessage, type LlmStreamService } from './stream.ts'
import { readAsset, readOverlayPage } from './overlay.ts'

/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/quick-assistant'

/** Maximum accepted JSON request body. */
const MAX_BODY_BYTES = 1024 * 1024

/** Maximum accepted conversation history entries per chat request. */
const MAX_HISTORY_MESSAGES = 200

/** Maximum accepted length of the submitted text. */
const MAX_TEXT_CHARS = 200_000

/** Token header the overlay and helper may use instead of the query parameter. */
const TOKEN_HEADER = 'x-qa-token'

/** One route failure with the HTTP status the client sees. */
export class RouteError extends Error {
  /**
   * @param status - HTTP status to answer with.
   * @param code - stable machine-readable code.
   * @param message - user-facing explanation.
   */
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'RouteError'
  }
}

/** One assistant request parsed from the `POST /api/chat` body. */
interface ChatRequest {
  /** Assistant mode the prompt is rendered for. */
  mode: AssistantMode
  /** Text of the newest turn. */
  text: string
  /** Earlier turns of an `ask` conversation, oldest first. */
  history: { role: 'user' | 'assistant'; content: string }[]
  /** Translate source language, or `auto`. */
  sourceLanguage?: string
  /** Translate target language, or `auto`. */
  targetLanguage?: string
}

/** Everything the routes read from the owning plugin instance. */
export interface RouteDeps {
  /** One-time token for the overlay and helper channels. */
  token: string
  /** Settings store shared with the helper lifecycle. */
  settings: SettingsStore
  /** Main model selection from `agentDefaultModel`, when the service exists. */
  defaultSelection: () => ModelSelection | undefined
  /** LLM service for catalog reads and streaming. */
  llm: LlmStreamService & LlmCatalogService
  /** Cached catalog shared by bootstrap and the settings page. */
  catalog: CatalogCache
  /** Current native helper availability. */
  helperStatus: () => HelperStatus
  /** Current overlay show-request counter. */
  showRequest: () => number
  /** Record one show request from the settings page. */
  requestShow: () => void
  /** Plugin logger. */
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void }
}

/** Whether the request carries the one-time token. */
function hasToken(req: IncomingMessage, url: URL, token: string): boolean {
  const header = req.headers[TOKEN_HEADER]
  const fromHeader = typeof header === 'string' ? header : Array.isArray(header) ? header[0] : undefined
  if (fromHeader !== undefined && fromHeader === token) return true
  return url.searchParams.get('token') === token
}

/**
 * Whether one request may reach the settings-page routes.
 *
 * Mirrors dsh-desktop-tabs: a cross-site marker is refused, an absent origin is
 * a same-origin request, and a present origin must match the Host authority.
 */
function isSameOrigin(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers['origin']
  if (origin === undefined) return true
  const host = req.headers['host']
  if (host === undefined) return false
  try {
    return new URL(origin).host === new URL(`http://${host}`).host
  } catch {
    return false
  }
}

/** Answer one JSON body. */
function sendJson(res: ServerResponse, status: number, payload: unknown, headOnly = false): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  if (headOnly) res.end()
  else res.end(body)
}

/** Answer one text body. */
function sendText(res: ServerResponse, status: number, body: string | Buffer, contentType: string, headOnly = false): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  if (headOnly) res.end()
  else res.end(body)
}

/** Answer 405 with the allowed methods. */
function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.writeHead(405, { allow, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ error: `不支持的请求方法，允许：${allow}` }))
}

/** Whether the request method is one of the allowed ones. */
function methodIs(req: IncomingMessage, ...allowed: string[]): boolean {
  return allowed.includes(req.method ?? 'GET')
}

/**
 * Read a JSON request body.
 * @param req - request owning the body.
 * @returns the parsed value; `undefined` for an empty body.
 * @throws {RouteError} 413 for an oversized body and 400 for invalid JSON.
 */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        reject(new RouteError(413, 'payload-too-large', `请求体超过 ${MAX_BODY_BYTES} 字节上限`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolvePromise(undefined)
        return
      }
      try {
        resolvePromise(JSON.parse(text))
      } catch {
        reject(new RouteError(400, 'bad-json', '请求体不是合法 JSON'))
      }
    })
    req.on('error', (error: Error) => reject(new RouteError(400, 'read-failed', messageOf(error))))
  })
}

/** Treat a JSON value as a plain object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Validate one chat request body.
 * @param body - parsed JSON body.
 * @returns the validated request.
 * @throws {RouteError} 400 when a required field is missing or malformed.
 */
function parseChatRequest(body: unknown): ChatRequest {
  const record = asRecord(body)
  if (record === undefined) throw new RouteError(400, 'bad-request', '请求体必须是 JSON 对象')
  const mode = record['mode']
  if (!isAssistantMode(mode)) throw new RouteError(400, 'bad-mode', 'mode 必须是 ask、translate、summary 或 explain')
  const text = record['text']
  if (typeof text !== 'string' || text.trim() === '') {
    throw new RouteError(400, 'bad-text', 'text 必须是非空字符串')
  }
  if (text.length > MAX_TEXT_CHARS) {
    throw new RouteError(400, 'text-too-large', `text 超过 ${MAX_TEXT_CHARS} 字符上限`)
  }
  const history: ChatRequest['history'] = []
  const rawMessages = record['messages']
  if (rawMessages !== undefined) {
    if (!Array.isArray(rawMessages)) throw new RouteError(400, 'bad-messages', 'messages 必须是数组')
    if (rawMessages.length > MAX_HISTORY_MESSAGES) {
      throw new RouteError(400, 'too-many-messages', `messages 超过 ${MAX_HISTORY_MESSAGES} 条上限`)
    }
    for (const item of rawMessages) {
      const entry = asRecord(item)
      const role = entry?.['role']
      const content = entry?.['content']
      if (entry === undefined || (role !== 'user' && role !== 'assistant') || typeof content !== 'string') {
        throw new RouteError(400, 'bad-messages', 'messages 的每一项必须是 { role: "user"|"assistant", content: string }')
      }
      if (content.trim() === '') continue
      history.push({ role, content })
    }
  }
  const sourceLanguage = record['sourceLanguage']
  const targetLanguage = record['targetLanguage']
  if (sourceLanguage !== undefined && typeof sourceLanguage !== 'string') {
    throw new RouteError(400, 'bad-language', 'sourceLanguage 必须是字符串')
  }
  if (targetLanguage !== undefined && typeof targetLanguage !== 'string') {
    throw new RouteError(400, 'bad-language', 'targetLanguage 必须是字符串')
  }
  return {
    mode,
    text,
    history,
    ...sourceLanguage === undefined ? {} : { sourceLanguage },
    ...targetLanguage === undefined ? {} : { targetLanguage },
  }
}

/** Build one user-role message for a fresh request. */
function userMessage(content: string): LlmMessage {
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text: content }], source: { kind: 'user' } }
}

/**
 * Build the model-facing turns of one request.
 * @param request - validated chat request.
 * @param prompt - rendered prompt for the newest turn.
 * @param selection - resolved route the reply will come from.
 * @returns turns oldest first; history is included only for `ask`.
 */
function buildMessages(request: ChatRequest, prompt: string, selection: ModelSelection): LlmMessage[] {
  const turns: LlmMessage[] = []
  if (request.mode === 'ask') {
    for (const entry of request.history) {
      turns.push(entry.role === 'user'
        ? userMessage(entry.content)
        : {
          id: randomUUID(),
          role: 'assistant',
          content: [{ type: 'text', text: entry.content }],
          source: { kind: 'model', provider: selection.provider, model: selection.model },
        })
    }
  }
  turns.push(userMessage(prompt))
  return turns
}

/** Helper state reported to the overlay bootstrap. */
function helperReport(deps: RouteDeps, settings: AssistantSettings): Record<string, unknown> {
  const status = deps.helperStatus()
  const shortcutValid = isValidAccelerator(settings.shortcut)
  const error = status.error ?? (shortcutValid ? undefined : `快捷键格式无效：${settings.shortcut || '（空）'}`)
  return {
    running: status.running,
    shortcutOk: status.running && shortcutValid,
    ...error === undefined ? {} : { error },
  }
}

/** Dispatch one request under the plugin prefix. */
async function dispatch(req: IncomingMessage, res: ServerResponse, deps: RouteDeps): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = url.pathname
  const method = req.method ?? 'GET'

  if (pathname === ROUTE_PREFIX || pathname === `${ROUTE_PREFIX}/`) {
    if (!methodIs(req, 'GET', 'HEAD')) return methodNotAllowed(res, 'GET, HEAD')
    if (!hasToken(req, url, deps.token)) return sendJson(res, 403, { error: '无效的访问令牌' })
    const page = await readOverlayPage(deps.token)
    if (page === undefined) {
      return sendJson(res, 404, { error: '覆盖页资源缺失：assets/overlay.html' })
    }
    return sendText(res, 200, page, 'text/html; charset=utf-8', method === 'HEAD')
  }

  if (pathname.startsWith(`${ROUTE_PREFIX}/assets/`)) {
    if (!methodIs(req, 'GET', 'HEAD')) return methodNotAllowed(res, 'GET, HEAD')
    if (!hasToken(req, url, deps.token)) return sendJson(res, 403, { error: '无效的访问令牌' })
    const encoded = pathname.slice(`${ROUTE_PREFIX}/assets/`.length)
    let fileName: string
    try {
      fileName = decodeURIComponent(encoded)
    } catch {
      return sendJson(res, 400, { error: '非法的资源路径' })
    }
    const asset = await readAsset(fileName)
    if (asset === undefined) return sendJson(res, 404, { error: `未找到资源：${fileName}` })
    return sendText(res, 200, asset.body, asset.contentType, method === 'HEAD')
  }

  switch (pathname) {
    case `${ROUTE_PREFIX}/api/bootstrap`: {
      if (!methodIs(req, 'GET', 'HEAD')) return methodNotAllowed(res, 'GET, HEAD')
      if (!hasToken(req, url, deps.token)) return sendJson(res, 403, { error: '无效的访问令牌' })
      const settings = deps.settings.get()
      let catalog: CatalogSnapshot
      try {
        catalog = await deps.catalog.get(() => buildCatalog(deps.llm, deps.defaultSelection()))
      } catch (error) {
        deps.log.warn('[quick-assistant] catalog read failed:', error)
        catalog = { default: { provider: '', model: '' }, providers: [], failures: [{ id: 'catalog', name: 'catalog', message: messageOf(error) }] }
      }
      return sendJson(res, 200, {
        settings,
        languages: LANGUAGES,
        catalog,
        helper: helperReport(deps, settings),
      }, method === 'HEAD')
    }

    case `${ROUTE_PREFIX}/api/chat`: {
      if (method !== 'POST') return methodNotAllowed(res, 'POST')
      if (!hasToken(req, url, deps.token)) return sendJson(res, 403, { error: '无效的访问令牌' })
      const body = await readJsonBody(req)
      const request = parseChatRequest(body)
      const settings = deps.settings.get()
      const modeSettings = settings.modes[request.mode]
      const prompt = renderPrompt(request.mode, modeSettings.prompt, {
        text: request.text,
        systemLanguage: systemLanguageName(),
        ...request.sourceLanguage === undefined ? {} : { sourceLanguage: request.sourceLanguage },
        ...request.targetLanguage === undefined ? {} : { targetLanguage: request.targetLanguage },
        primaryLanguage: settings.translation.primaryLanguage,
        secondaryLanguage: settings.translation.secondaryLanguage,
      })
      let selection: ModelSelection
      try {
        selection = await resolveRequestSelection(deps.llm, modeSettings.model, deps.defaultSelection())
      } catch (error) {
        const sse = openSse(res)
        sse.error(error instanceof NoModelError ? error.code : 'NO_MODEL', messageOf(error))
        sse.end()
        return
      }
      const controller = new AbortController()
      res.on('close', () => {
        if (!res.writableEnded) controller.abort()
      })
      await streamChat({
        llm: deps.llm,
        res,
        mode: request.mode,
        selection,
        messages: buildMessages(request, prompt, selection),
        signal: controller.signal,
      })
      return
    }

    case `${ROUTE_PREFIX}/api/native`: {
      if (!methodIs(req, 'GET', 'HEAD')) return methodNotAllowed(res, 'GET, HEAD')
      if (!hasToken(req, url, deps.token)) return sendJson(res, 403, { error: '无效的访问令牌' })
      const settings = deps.settings.get()
      return sendJson(res, 200, { shortcut: settings.shortcut, showRequest: deps.showRequest() }, method === 'HEAD')
    }

    case `${ROUTE_PREFIX}/api/settings`: {
      if (!methodIs(req, 'GET', 'HEAD', 'PUT')) return methodNotAllowed(res, 'GET, HEAD, PUT')
      if (!isSameOrigin(req)) return sendJson(res, 403, { error: '跨站请求被拒绝' })
      if (req.method === 'GET' || req.method === 'HEAD') {
        return sendJson(res, 200, {
          settings: deps.settings.get(),
          defaults: defaultSettings(),
          languages: LANGUAGES,
        }, req.method === 'HEAD')
      }
      const body = await readJsonBody(req)
      const record = asRecord(body)
      if (record === undefined || !('settings' in record)) {
        return sendJson(res, 400, { ok: false, error: '请求体必须是 { settings: {...} }' })
      }
      try {
        const settings = await deps.settings.save(record['settings'])
        return sendJson(res, 200, { ok: true, settings })
      } catch (error) {
        deps.log.error('[quick-assistant] settings save failed:', error)
        return sendJson(res, 500, { ok: false, error: `设置保存失败：${messageOf(error)}` })
      }
    }

    case `${ROUTE_PREFIX}/api/catalog`: {
      if (!methodIs(req, 'GET', 'HEAD')) return methodNotAllowed(res, 'GET, HEAD')
      if (!isSameOrigin(req)) return sendJson(res, 403, { error: '跨站请求被拒绝' })
      try {
        const catalog = await deps.catalog.get(() => buildCatalog(deps.llm, deps.defaultSelection()))
        return sendJson(res, 200, catalog, method === 'HEAD')
      } catch (error) {
        deps.log.warn('[quick-assistant] catalog read failed:', error)
        return sendJson(res, 502, { error: `模型目录读取失败：${messageOf(error)}` })
      }
    }

    case `${ROUTE_PREFIX}/api/show`: {
      if (method !== 'POST') return methodNotAllowed(res, 'POST')
      if (!isSameOrigin(req)) return sendJson(res, 403, { error: '跨站请求被拒绝' })
      deps.requestShow()
      return sendJson(res, 200, { ok: true })
    }

    case `${ROUTE_PREFIX}/api/health`: {
      if (!methodIs(req, 'GET', 'HEAD')) return methodNotAllowed(res, 'GET, HEAD')
      const status = deps.helperStatus()
      return sendJson(res, 200, {
        ok: true,
        helperRunning: status.running,
        ...status.error === undefined ? {} : { error: status.error },
      }, method === 'HEAD')
    }

    default:
      return sendJson(res, 404, { error: `未知的接口：${pathname}` })
  }
}

/**
 * Create the `/quick-assistant` prefix handler.
 * @param deps - plugin-instance services the routes read.
 * @returns the webserver handler owning the response lifecycle.
 */
export function createRouteHandler(deps: RouteDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const log = deps.log
  return async (req, res) => {
    try {
      await dispatch(req, res, deps)
    } catch (error) {
      const status = error instanceof RouteError ? error.status : 500
      const message = messageOf(error)
      if (error instanceof RouteError) {
        if (!res.headersSent) sendJson(res, status, { error: message })
        else res.destroy()
        return
      }
      log.warn('[quick-assistant] request failed:', error)
      if (!res.headersSent) sendJson(res, status, { error: `请求处理失败：${message}` })
      else res.destroy()
    }
  }
}
