/**
 * dsh-desktop-tabs host half — serves and persists the browser half's tab list,
 * and mounts the remote-connection routes.
 *
 * The half owns one route path, `/desktop-tabs/api/tabs`, with two methods:
 * `GET` (and `HEAD`) reflects the configured tabs, `PUT` replaces them. All
 * configuration semantics (file location, `url` vs `port` + `tokenFile` vs
 * `ssh`, normalization, atomic write) live in `./targets.ts`; the SSH
 * connection lifecycle behind `/desktop-tabs/api/connections/*` lives in
 * `./remote/index.ts` and is registered here for its lifetime.
 *
 * A response can carry remote token URLs, so the routes are served only while
 * the web server is bound to the loopback address, with a same-origin fence.
 * The desktop application forwards `dsh-app://app/*` requests to the Host with
 * its own authentication cookie, so the renderer reaches these routes as
 * same-origin `fetch` calls.
 *
 * In an ordinary `dsh web` profile the plugin loads and registers the same
 * routes; nothing becomes visible, because only the desktop shell's browser half
 * mounts the strip.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'

import { registerRemoteConnections } from './remote/index.ts'
import { readDesktopTabs, resolveDshHome, TabsValidationError, tabsFilePath, writeDesktopTabs } from './targets.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: WebServer
  }
}

export const name = 'dsh-desktop-tabs'

/** Required service for route registration. */
export const inject = ['webServer']

/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/desktop-tabs'

/** The tab-list endpoint the browser half reads and writes. */
const TABS_PATH = `${ROUTE_PREFIX}/api/tabs`

/** Maximum accepted `PUT` body. */
const MAX_BODY_BYTES = 256 * 1024

/** Rejected request body over {@link MAX_BODY_BYTES}: the API answers 413. */
class PayloadTooLargeError extends Error {}

/**
 * Register the tab-list route and the remote-connection routes.
 * @param ctx - Host Cordis context carrying the web server service.
 */
export function apply(ctx: Context): void {
  // Responses carry the remote launch tokens; loopback-only, like the
  // equivalent guard in dsh-remote.
  if (ctx.webServer.host !== '127.0.0.1') {
    ctx.logger?.error('[dsh-desktop-tabs] refusing to start: /desktop-tabs carries remote tokens and must stay on the loopback bind (webServer.host is not 127.0.0.1)')
    return
  }
  const dshHome = resolveDshHome()
  // Read failures are permanent for a given config file; report each distinct
  // one once per host boot instead of once per client request.
  const reported = new Set<string>()
  ctx.effect(() => {
    const disposeTabs = ctx.webServer.register({
      kind: 'exact',
      path: TABS_PATH,
      handler: (req, res) => {
        void respond(req, res, dshHome, reported, ctx).catch((error: unknown) => {
          ctx.logger?.warn(`[dsh-desktop-tabs] request failed: ${message(error)}`)
          // A rejection escaping the handler would otherwise be an unhandled
          // rejection; the response is closed best-effort.
          try {
            json(res, 500, { error: 'internal error' })
          } catch {
            // The response is already finished or the client is gone.
          }
        })
      },
    })
    // The manager resolves a tab's connection settings by id. Hand it the same
    // `{ tabs, connections }` rows this half serves the client: the file's tab
    // rows alone carry neither `workdir` nor `startCommand`, which only the
    // saved connections hold. `ssh` is the remote half's own descriptor here.
    const disposeConnections = registerRemoteConnections(ctx, ctx.webServer, {
      dshHome,
      tabs: async () => {
        const stored = readDesktopTabs(dshHome)
        return { tabs: stored.tabs, connections: stored.connections }
      },
    })
    return () => {
      disposeConnections()
      disposeTabs()
    }
  }, 'dsh-desktop-tabs: tab routes')
}

/** Answer one tab-list request. */
async function respond(req: IncomingMessage, res: ServerResponse, dshHome: string, reported: Set<string>, ctx: Context): Promise<void> {
  if (req.method === 'PUT') {
    await respondPut(req, res, dshHome, reported, ctx)
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD, PUT' })
    res.end()
    return
  }
  if (!sameOrigin(req)) {
    json(res, 403, { error: 'untrusted origin' })
    return
  }
  const { tabs, connections, warnings } = readDesktopTabs(dshHome)
  report(warnings, reported, ctx)
  const body = JSON.stringify({ tabs, connections })
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  if (req.method === 'HEAD') res.end()
  else res.end(body)
}

/** Replace the persisted tab and connection lists. */
async function respondPut(req: IncomingMessage, res: ServerResponse, dshHome: string, reported: Set<string>, ctx: Context): Promise<void> {
  if (!sameOrigin(req)) {
    json(res, 403, { error: 'untrusted origin' })
    return
  }
  let body: unknown
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES)
  } catch (error: unknown) {
    json(res, error instanceof PayloadTooLargeError ? 413 : 400, { error: message(error) })
    return
  }
  try {
    const { tabs, connections, warnings } = writeDesktopTabs(dshHome, body)
    report(warnings, reported, ctx)
    json(res, 200, { tabs, connections })
  } catch (error: unknown) {
    if (error instanceof TabsValidationError) {
      json(res, 400, { error: error.message })
      return
    }
    const detail = `could not write ${tabsFilePath(dshHome)}: ${message(error)}`
    ctx.logger?.error(`[dsh-desktop-tabs] ${detail}`)
    json(res, 500, { error: detail })
  }
}

/** Report each distinct non-fatal problem once per host boot. */
function report(warnings: readonly string[], reported: Set<string>, ctx: Context): void {
  for (const warning of warnings) {
    if (reported.has(warning)) continue
    reported.add(warning)
    ctx.logger?.warn(`[dsh-desktop-tabs] ${warning}`)
  }
}

/** Write one JSON response. */
function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Read the whole request body as JSON, bounded by `limit` bytes (an empty body is `undefined`). */
function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > limit) {
        reject(new PayloadTooLargeError(`request body exceeds ${limit} bytes`))
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
        reject(new TabsValidationError(`request body is not valid JSON (${message(error)})`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Minimal same-origin fence, mirroring dsh-remote's posture: a cross-site
 * marker is refused, an absent `origin` (a same-origin request, including the
 * shell's forwarded one) is allowed, and a present one must match `host`.
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

/** @returns an error's message, or its string form. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
