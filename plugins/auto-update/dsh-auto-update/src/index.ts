/**
 * dsh-auto-update host half — the update detection, execution, and changelog
 * routes behind the desktop update button.
 *
 * The half owns three exact paths under `/auto-update`:
 *
 * - `GET /auto-update/api/status?mode=local|check` — the dialog's row model
 *   (`./check.ts`); `local` is a network-free skeleton, `check` fetches the root
 *   and every submodule.
 * - `POST /auto-update/api/update` — an NDJSON stream of one in-place update
 *   (`./update.ts`).
 * - `GET /auto-update/api/changelog?id=<projectId>&mode=tag|commit` — the
 *   commit list and, for a GitHub tag target, the Release notes
 *   (`./changelog.ts`).
 *
 * All three drive `git` inside the dsh-gui checkout the desktop runtime is
 * built from, so the routes are served only while the web server is bound to
 * the loopback address, with a same-origin fence on every request. The desktop
 * application forwards `dsh-app://app/*` requests to the Host with its own
 * authentication cookie, so the renderer reaches these routes as same-origin
 * `fetch` calls. Responses are never cacheable, and a request body is capped at
 * 256 KiB.
 *
 * In an ordinary `dsh web` profile the plugin loads and registers the same
 * routes; nothing becomes visible, because only the desktop shell's browser half
 * mounts the update button, and an installation wrapper keeps the plugin out of
 * every non-desktop profile in the first place.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'

import { check, localCheck } from './check.ts'
import { buildChangelog, ChangelogRequestError } from './changelog.ts'
import { GuiRootError, resolveGuiRoot } from './paths.ts'
import { parseUpdateTargets, resolveUpdateTargets, runUpdate, UpdateRequestError } from './update.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: WebServer
  }
}

export const name = 'dsh-auto-update'

/** Required service for route registration. */
export const inject = ['webServer']

/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/auto-update'

/** The status endpoint the dialog reads. */
const STATUS_PATH = `${ROUTE_PREFIX}/api/status`

/** The in-place update endpoint (NDJSON). */
const UPDATE_PATH = `${ROUTE_PREFIX}/api/update`

/** The changelog endpoint. */
const CHANGELOG_PATH = `${ROUTE_PREFIX}/api/changelog`

/** Maximum accepted request body. */
const MAX_BODY_BYTES = 256 * 1024

/** Rejected request body over {@link MAX_BODY_BYTES}: the API answers 413. */
class PayloadTooLargeError extends Error {}

/**
 * Register the three update routes.
 * @param ctx - Host Cordis context carrying the web server service.
 */
export function apply(ctx: Context): void {
  // These routes execute git in the user's checkout; loopback-only, like the
  // equivalent guard in dsh-desktop-tabs and dsh-remote.
  if (ctx.webServer.host !== '127.0.0.1') {
    ctx.logger?.error('[dsh-auto-update] refusing to start: /auto-update runs git in the dsh-gui checkout and must stay on the loopback bind (webServer.host is not 127.0.0.1)')
    return
  }
  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler: (req, res) => { void handle(ctx, res, () => respondStatus(req, res)) },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: UPDATE_PATH,
        handler: (req, res) => { void handle(ctx, res, () => respondUpdate(req, res)) },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: CHANGELOG_PATH,
        handler: (req, res) => { void handle(ctx, res, () => respondChangelog(req, res)) },
      }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-auto-update: update routes')
}

/** Run one request, turning any escaped rejection into a readable response. */
async function handle(ctx: Context, res: ServerResponse, run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (error: unknown) {
    ctx.logger?.warn(`[dsh-auto-update] request failed: ${message(error)}`)
    if (res.headersSent) {
      // The update stream already started; a rejection escaping it would
      // otherwise be an unhandled rejection. Close it best-effort.
      try {
        res.end()
      } catch {
        // The response is already finished or the client is gone.
      }
      return
    }
    json(res, 500, { error: readableError(error) })
  }
}

/** Answer one status request. */
async function respondStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    methodNotAllowed(res, 'GET, HEAD')
    return
  }
  if (!sameOrigin(req)) {
    json(res, 403, { error: '跨站请求被拒绝' })
    return
  }
  const mode = new URL(req.url ?? '/', 'http://localhost').searchParams.get('mode') ?? 'check'
  if (mode !== 'local' && mode !== 'check') {
    json(res, 400, { error: `mode 参数必须是 local 或 check，收到「${mode}」` })
    return
  }
  const root = resolveGuiRoot()
  const status = mode === 'local' ? await localCheck(root) : await check(root)
  sendJson(res, 200, status, req.method === 'HEAD')
}

/** Answer one update request, streaming the run as NDJSON. */
async function respondUpdate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    methodNotAllowed(res, 'POST')
    return
  }
  if (!sameOrigin(req)) {
    json(res, 403, { error: '跨站请求被拒绝' })
    return
  }
  let body: unknown
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES)
  } catch (error: unknown) {
    json(res, error instanceof PayloadTooLargeError ? 413 : 400, { error: message(error) })
    return
  }
  // Shape errors and an empty target list are decided before anything streams;
  // the route's own error contract requires a plain JSON body for them.
  let requested
  try {
    requested = parseUpdateTargets(body)
  } catch (error: unknown) {
    json(res, error instanceof UpdateRequestError ? error.status : 400, { error: message(error) })
    return
  }
  if (requested.length === 0) {
    json(res, 409, { error: '没有可用目标' })
    return
  }
  const root = resolveGuiRoot()
  let targets
  try {
    targets = resolveUpdateTargets(root, requested)
  } catch (error: unknown) {
    json(res, error instanceof UpdateRequestError ? error.status : 400, { error: message(error) })
    return
  }
  if (targets.length === 0) {
    json(res, 409, { error: '没有可用目标' })
    return
  }
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  await runUpdate(root, targets, (event) => { res.write(`${JSON.stringify(event)}\n`) })
  res.end()
}

/** Answer one changelog request. */
async function respondChangelog(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    methodNotAllowed(res, 'GET, HEAD')
    return
  }
  if (!sameOrigin(req)) {
    json(res, 403, { error: '跨站请求被拒绝' })
    return
  }
  const params = new URL(req.url ?? '/', 'http://localhost').searchParams
  const id = params.get('id')?.trim() ?? ''
  if (id === '') {
    json(res, 400, { error: '缺少 id 参数（工程 id，例如 dsh-gui）' })
    return
  }
  const mode = params.get('mode') ?? 'commit'
  if (mode !== 'tag' && mode !== 'commit') {
    json(res, 400, { error: `mode 参数必须是 tag 或 commit，收到「${mode}」` })
    return
  }
  const root = resolveGuiRoot()
  let result
  try {
    result = await buildChangelog(root, id, mode)
  } catch (error: unknown) {
    json(res, error instanceof ChangelogRequestError ? 400 : 500, { error: readableError(error) })
    return
  }
  sendJson(res, 200, result, req.method === 'HEAD')
}

/** Write one JSON response. */
function json(res: ServerResponse, status: number, payload: unknown): void {
  sendJson(res, status, payload, false)
}

/** Write one JSON response, optionally with the body suppressed (`HEAD`). */
function sendJson(res: ServerResponse, status: number, payload: unknown, headOnly: boolean): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  if (headOnly) res.end()
  else res.end(body)
}

/** Answer a method mismatch. */
function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.writeHead(405, {
    allow,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify({ error: `不支持的请求方法，允许：${allow}` }))
}

/** Read the whole request body as JSON, bounded by `limit` bytes. */
function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > limit) {
        reject(new PayloadTooLargeError(`请求体超过 ${limit} 字节上限`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (error: unknown) {
        reject(new Error(`请求体不是合法 JSON（${message(error)}）`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Minimal same-origin fence, mirroring dsh-desktop-tabs: a cross-site marker is
 * refused, an absent `origin` (a same-origin request, including the shell's
 * forwarded one) is allowed, and a present one must match `host`.
 */
function sameOrigin(req: IncomingMessage): boolean {
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

/** @returns an error message fit for the dialog. */
function readableError(error: unknown): string {
  if (error instanceof GuiRootError) return error.message
  if (error instanceof UpdateRequestError || error instanceof ChangelogRequestError) return error.message
  return `服务内部错误：${message(error)}`
}

/** @returns an error's message, or its string form. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
