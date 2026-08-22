/**
 * dsh-ai-update — the bridge between the dsh-gui desktop shell and the
 * embedded harness page.
 *
 * Browser half (lib/client.js): the page listens for "dsh-gui:ai-update"
 * window messages from the desktop shell, starts a session from the requested
 * agent preset, and prefills the composer.
 *
 * Host half: one HTTP route that serves the shell's 「更新日志」 summaries.
 * The shell posts the commit data (via its loopback HTTP client — no Origin
 * header, which the browser-trust fence accepts); this half runs a raw
 * `ctx.llm.stream` call with the web profile's default model and returns the
 * markdown text. No Agent and no Session is created, so a summary run never
 * appears in the DSH session list — the same approach dsh-sidebar-qa's
 * summarize route uses for its side conversations.
 *
 * The shell keeps the one-shot headless run as its fallback when this route is
 * unavailable (plugin not installed, older harness, non-web profile); that
 * fallback redirects its session store to a temp directory, so it never
 * persists a session either — both paths are runtime-only.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  AiUpdateContext,
  AiUpdateDefaultModelService,
  AiUpdateLlmMessage,
  AiUpdateLlmService,
  AiUpdateLoader,
  AiUpdateStreamChunk,
  AiUpdateWebServer,
} from './context-types.ts'

/** The route prefix the shell calls; one method below it. */
const API_PREFIX = '/dsh-gui-api'
const CHANGELOG_METHOD = '/dsh-gui-api/changelog'

/** How long one summary run may take before the route answers 504. */
const CHANGELOG_TIMEOUT_MS = 300_000

/** Upper bound of the request body bytes (the commit list is bounded by the
 *  shell's prompt cap of ~12 KB; this leaves ample headroom). */
const MAX_BODY_BYTES = 128 * 1024

/** Upper bound of the prompt text the route accepts. */
const MAX_PROMPT_CHARS = 20_000

/** Token ceiling for one summary answer (a 400-commit range stays inside it). */
const CHANGELOG_MAX_TOKENS = 4000

/** The pinned role line; the task instructions themselves arrive with the
 *  prompt (built by the shell from the git commit range). */
const CHANGELOG_SYSTEM =
  '你是 DeepSeek Harness（dsh-gui 桌面壳）的更新日志助手：根据用户消息中的提交信息，输出 Markdown 变更汇总。'

// ── Browser-trust fence (mirror of dsh-sidebar-qa's trust-fence.ts) ─────────
// Behaviorally identical to the /api gateway's fence: Host-header loopback or
// a configured trusted authority passes; cross-site browser markers refuse.
// This is a DNS-rebinding / cross-site defense, not authentication.

/** Normalized URL of a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** Whether a normalized URL hostname names the local loopback authority. */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Canonical authority form: hostname, or hostname:port when a port was written. */
function canonicalAuthority(entry: string, entryUrl: URL): string {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/** Whether the request authority matches a trustedHosts entry (exact or port-less). */
function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

function headerOf(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Whether one request may reach the plugin routes. */
function isTrustedRequest(request: IncomingMessage, trustedHosts: readonly string[]): boolean {
  const host = headerOf(request, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (headerOf(request, 'sec-fetch-site') === 'cross-site') return false
  const origin = headerOf(request, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// ── Minimal JSON request/response helpers ───────────────────────────────────

/** A route failure carrying the HTTP status and a machine-readable code. */
class RouteError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function writeError(res: ServerResponse, error: RouteError): void {
  writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
}

/** Read and JSON.parse the request body (bounded; streaming callers strip it). */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new RouteError(413, 'payload-too-large', 'payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new RouteError(400, 'bad-json', 'invalid JSON body'))
      }
    })
    req.on('error', (error) => reject(new RouteError(400, 'read-failed', String(error.message ?? error))))
  })
}

function newMessageId(): string {
  const cryptoLike = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (cryptoLike?.randomUUID) return cryptoLike.randomUUID()
  return `dsh-gui-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Build a user-role message carrying the summary prompt. */
function userMessage(text: string): AiUpdateLlmMessage {
  return {
    id: newMessageId(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-ai-update' },
  }
}

/** Collapse a raw stream into the answer text plus a failure flag. */
async function assembleText(chunks: AsyncIterable<AiUpdateStreamChunk>): Promise<{ text: string; failed: boolean }> {
  let text = ''
  let failed = false
  for await (const chunk of chunks) {
    if (chunk.type === 'text-delta') {
      text += chunk.text
    } else if (chunk.type === 'finish') {
      const kind = chunk.reason.kind
      if (kind === 'error' || kind === 'aborted') failed = true
    }
  }
  return { text, failed }
}

/** The connection row's resolved trustedHosts (live read for the fence). */
function trustedHostsOf(loader: AiUpdateLoader): string[] {
  for (const entry of loader.entries()) {
    if (entry.options.name === 'connection') {
      return entry.options.config?.trustedHosts ?? []
    }
  }
  return []
}

/** One changelog summary request: prompt text only (the shell builds it). */
async function handleChangelog(
  req: IncomingMessage,
  res: ServerResponse,
  services: {
    llm: AiUpdateLlmService
    defaultModel: AiUpdateDefaultModelService
    loader: AiUpdateLoader
  },
): Promise<void> {
  const trustedHosts = trustedHostsOf(services.loader)
  if (!isTrustedRequest(req, trustedHosts)) {
    writeError(res, new RouteError(403, 'forbidden', 'forbidden'))
    return
  }
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
    return
  }
  const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
  if (pathname !== CHANGELOG_METHOD) {
    writeError(res, new RouteError(404, 'not-found', 'unknown dsh-gui-api method'))
    return
  }

  let payload: unknown
  try {
    payload = await readJsonBody(req)
  } catch (error) {
    writeError(res, error instanceof RouteError ? error : new RouteError(400, 'bad-request', 'bad request'))
    return
  }
  const prompt = (payload as { prompt?: unknown } | null)?.prompt
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    writeError(res, new RouteError(400, 'bad-request', 'prompt must be a non-empty string'))
    return
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    writeError(res, new RouteError(400, 'prompt-too-large', `prompt exceeds ${MAX_PROMPT_CHARS} characters`))
    return
  }

  const selection = services.defaultModel.currentSelection()
  if (selection.provider === '' || selection.model === '') {
    writeError(res, new RouteError(503, 'no-default-model', 'no default model is configured (Models page)'))
    return
  }

  try {
    const chunks = services.llm.stream({
      provider: selection.provider,
      model: selection.model,
      messages: [userMessage(prompt)],
      system: CHANGELOG_SYSTEM,
      maxTokens: CHANGELOG_MAX_TOKENS,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      signal: AbortSignal.timeout(CHANGELOG_TIMEOUT_MS),
    })
    const { text, failed } = await assembleText(chunks)
    if (failed) {
      writeError(res, new RouteError(502, 'stream-failed', 'the model stream ended with an error'))
      return
    }
    if (text.trim() === '') {
      writeError(res, new RouteError(502, 'empty-result', 'the model produced no text'))
      return
    }
    writeJson(res, 200, { ok: true, text: text.trim() })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      writeError(res, new RouteError(504, 'timeout', `summary timed out after ${CHANGELOG_TIMEOUT_MS / 1000}s`))
      return
    }
    writeError(res, new RouteError(502, 'llm-error', error instanceof Error ? error.message : String(error)))
  }
}

/**
 * Mount the host-half services: the changelog route when the web runtime is
 * present, nothing otherwise (a base-only or headless deployment keeps this
 * plugin inert).
 * @param ctx - the loader entry's plugin context.
 */
export function apply(ctx: AiUpdateContext): void {
  ctx.inject(['webServer', 'llm', 'agentDefaultModel', 'loader'], () => {
    const webServer = ctx.get<AiUpdateWebServer>('webServer')
    const llm = ctx.get<AiUpdateLlmService>('llm')
    const defaultModel = ctx.get<AiUpdateDefaultModelService>('agentDefaultModel')
    const loader = ctx.get<AiUpdateLoader>('loader')
    if (webServer === undefined || llm === undefined || defaultModel === undefined || loader === undefined) {
      return
    }
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        void handleChangelog(req, res, { llm, defaultModel, loader })
          .catch((error: unknown) => {
            writeError(res, error instanceof RouteError ? error : new RouteError(500, 'internal', String(error instanceof Error ? error.message : error)))
          })
      },
    }), 'dsh-ai-update: /dsh-gui-api route')
  })
}
