/**
 * dsh-desktop-tabs host half, remote-connection module.
 *
 * One tab carrying an `ssh` descriptor becomes a loadable URL by starting a
 * `dsh web` on the remote host, forwarding the remote loopback port through an
 * SSH tunnel, and probing the tunnel before reporting `up`; the chain is the one
 * verified by hand in `docs/dsh-gui/2026-10-03-desktop-tabs-prototype.md`
 * ("远程连接链路"). `./session.ts` implements it.
 *
 * `registerRemoteConnections` exposes the manager over these loopback-only routes:
 *
 * - `GET  /desktop-tabs/api/connections` — state and connection log of every SSH tab
 * - `POST /desktop-tabs/api/connections/<id>/up` — connect, answer `{ url }`
 * - `POST /desktop-tabs/api/connections/<id>/down` — disconnect and reclaim
 * - `GET  /desktop-tabs/api/ssh-hosts` — importable `~/.ssh/config` destinations
 *
 * The route posture (loopback bind, same-origin fence, `no-store`, 405) mirrors
 * `../index.ts`: the connection responses carry a remote launch token, so they
 * are served only while the web server is bound to the loopback address. No
 * route reads credentials, and no ssh command carries a password or key argument.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { readConfiguredSshTabs } from './config.ts'
import { reapStaleRemoteProcesses } from './reap.ts'
import { readSshHosts } from './ssh-config.ts'
import { RemoteConnectionManager } from './session.ts'
import type {
  RemoteConnections,
  RemoteConnectionsOptions,
  RemoteLogger,
  RemoteTargetSource,
  RemoteWebServer,
} from './types.ts'

export type {
  RemoteConnectionStatus,
  RemoteConnections,
  RemoteConnectionsOptions,
  RemoteLogger,
  RemoteRoute,
  RemoteTab,
  RemoteTargetPair,
  RemoteTargetSource,
  RemoteWebServer,
} from './types.ts'
export type { SshSpec } from './config.ts'
export type { SshHostEntry } from './ssh-config.ts'

/** Route prefix owned by the connection routes. */
export const CONNECTIONS_ROUTE_PREFIX = '/desktop-tabs/api/connections'

/** Route serving the importable SSH destinations. */
export const SSH_HOSTS_PATH = '/desktop-tabs/api/ssh-hosts'

/** `/<tabId>/<action>` below the connection prefix. */
const ACTION_PATTERN = /^\/([^/]+)\/(up|down)$/

/**
 * Create the in-process connection manager.
 * @param options - harness home, tab source, and optional logger.
 * @returns the manager the host half drives.
 */
export function createRemoteConnections(options: RemoteConnectionsOptions): RemoteConnections {
  return new RemoteConnectionManager(options)
}

/**
 * Register the remote-connection routes on the host web server.
 *
 * Registration is refused off the loopback bind, exactly as `../index.ts` refuses
 * to publish tab URLs there: these responses carry remote launch tokens.
 * @param ctx - Cordis context; only its optional `logger` is read.
 * @param webServer - web server owning the routes.
 * @param options - harness home plus, optionally, the host half's own target rows
 * (a plain tab array or its `{ tabs, connections }` response); without it the rows
 * are read from `<dshHome>/gui/desktop-tabs.json`.
 * @returns a disposer removing the routes and stopping every connection.
 */
export function registerRemoteConnections(
  ctx: unknown,
  webServer: RemoteWebServer,
  options: { dshHome: string; tabs?: () => Promise<RemoteTargetSource> },
): () => void {
  const logger = loggerOf(ctx)
  if (webServer.host !== undefined && webServer.host !== '127.0.0.1') {
    logger?.error(`[dsh-desktop-tabs] refusing to register ${CONNECTIONS_ROUTE_PREFIX}: the connection routes carry remote launch tokens and must stay on the loopback bind (webServer.host is ${webServer.host})`)
    return () => {}
  }
  const connections = createRemoteConnections({
    dshHome: options.dshHome,
    tabs: options.tabs ?? (async () => readConfiguredSshTabs(options.dshHome)),
    ...(logger === undefined ? {} : { logger }),
  })
  // Leftovers from a run that was killed before `down` are reaped in the background,
  // so a stale port or process is gone before the user opens a tab.
  void reapStaleRemoteProcesses(options.dshHome, logger)
  const routes = [
    webServer.register({
      kind: 'exact',
      path: CONNECTIONS_ROUTE_PREFIX,
      handler: (req, res) => { respondStatus(req, res, connections) },
    }),
    webServer.register({
      kind: 'prefix',
      path: CONNECTIONS_ROUTE_PREFIX,
      handler: async (req, res) => { await respondAction(req, res, connections, logger) },
    }),
    webServer.register({
      kind: 'exact',
      path: SSH_HOSTS_PATH,
      handler: (req, res) => { respondSshHosts(req, res) },
    }),
  ]
  return () => {
    for (const dispose of routes.reverse()) dispose()
    connections.dispose()
  }
}

/** Answer `GET /desktop-tabs/api/connections`. */
function respondStatus(req: IncomingMessage, res: ServerResponse, connections: RemoteConnections): void {
  const head = req.method === 'HEAD'
  if (req.method !== 'GET' && !head) {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  if (!sameOrigin(req)) {
    writeJson(res, 403, { error: 'untrusted origin' }, head)
    return
  }
  writeJson(res, 200, { connections: connections.status() }, head)
}

/** Answer `POST /desktop-tabs/api/connections/<id>/up|down`. */
async function respondAction(
  req: IncomingMessage,
  res: ServerResponse,
  connections: RemoteConnections,
  logger: RemoteLogger | undefined,
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  if (!sameOrigin(req)) {
    writeJson(res, 403, { error: 'untrusted origin' }, false)
    return
  }
  const pathname = pathnameOf(req)
  const match = pathname === undefined ? null : ACTION_PATTERN.exec(pathname.slice(CONNECTIONS_ROUTE_PREFIX.length))
  if (match === null) {
    writeJson(res, 404, { error: 'not found' }, false)
    return
  }
  let id: string
  try {
    id = decodeURIComponent(match[1])
  } catch {
    writeJson(res, 400, { error: 'malformed tab id' }, false)
    return
  }
  // The action body carries nothing; the request is drained so the socket can close.
  req.resume()
  if (match[2] === 'up') {
    try {
      const { url } = await connections.up(id)
      writeJson(res, 200, { id, url }, false)
    } catch (error) {
      const reason = message(error)
      logger?.warn(`[dsh-desktop-tabs] remote '${id}' failed to connect: ${reason}`)
      writeJson(res, 502, { id, error: reason }, false)
    }
    return
  }
  await connections.down(id)
  writeJson(res, 200, { id, ok: true }, false)
}

/** Answer `GET /desktop-tabs/api/ssh-hosts`. */
function respondSshHosts(req: IncomingMessage, res: ServerResponse): void {
  const head = req.method === 'HEAD'
  if (req.method !== 'GET' && !head) {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  if (!sameOrigin(req)) {
    writeJson(res, 403, { error: 'untrusted origin' }, head)
    return
  }
  writeJson(res, 200, { hosts: readSshHosts() }, head)
}

/** Write one JSON response; `no-store` because the payload can carry a token. */
function writeJson(res: ServerResponse, status: number, payload: unknown, head: boolean): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  if (head) res.end()
  else res.end(body)
}

/**
 * Minimal same-origin fence, mirroring `../index.ts`: a cross-site marker is
 * refused, an absent `origin` (a same-origin request, including the desktop
 * shell's forwarded one, which drops both markers) is allowed, and a present one
 * must match `host`.
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

/** @returns the request pathname, or undefined for an unparsable URL. */
function pathnameOf(req: IncomingMessage): string | undefined {
  try {
    return new URL(req.url ?? '/', 'http://x').pathname
  } catch {
    return undefined
  }
}

/** Read the Cordis logger off a loosely typed context, if it carries a full one. */
function loggerOf(ctx: unknown): RemoteLogger | undefined {
  if (typeof ctx !== 'object' || ctx === null) return undefined
  const candidate = (ctx as { logger?: Partial<RemoteLogger> }).logger
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const { info, warn, error } = candidate
  if (typeof info !== 'function' || typeof warn !== 'function' || typeof error !== 'function') return undefined
  return candidate as RemoteLogger
}

/** @returns an error's message, or its string form. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
