/**
 * Host routes and the connection bridge for remote tabs.
 *
 * The route posture mirrors `../remote/index.ts`: loopback-only, same-origin
 * fence, `no-store`, and every message passes through `redactToken`. Two
 * discovery routes serve the connection panel —
 * `GET /desktop-tabs/api/remote-hosts` and
 * `GET /desktop-tabs/api/remote-workspaces?targetDeviceId=…` — and the same
 * module exposes the {@link RemoteTabBridge} that `../remote/index.ts` merges
 * into `GET /connections` and dispatches `up`/`down`/`forget` through.
 *
 * Discovery goes through the {@link RemoteTabProvider}: this module knows no
 * backend plugin. The provider reads its services at request time, so a plugin
 * enabled or logged in after boot starts answering without a restart; when it
 * cannot answer (plugin absent, not enabled, or the parent UI already holds the
 * remote control connection) its error text becomes the answer's `error`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { redactToken } from '../remote/text.ts'
import type { RemoteConnectionStatus, RemoteLogger, RemoteWebServer } from '../remote/types.ts'
import type { DesktopTabs } from '../targets.ts'
import type { RemoteTabSupervisor } from './supervisor.ts'
import type {
  RemoteTabBridge,
  RemoteTabProvider,
  RemoteTabRequest,
  RemoteWorkspace,
  RemoteWorkspaceUnavailable,
} from './types.ts'

/** Route serving the discoverable Remote hosts. */
export const REMOTE_HOSTS_PATH = '/desktop-tabs/api/remote-hosts'

/** Route serving one host's workspaces. */
export const REMOTE_WORKSPACES_PATH = '/desktop-tabs/api/remote-workspaces'

/** Answer used when the feature was composed without any backend provider. */
export const REMOTE_PROVIDER_UNAVAILABLE = '远程标签功能不可用：未配置远程后端 provider'

/** Default discovery budget: a background carrier plus backend catalogs. */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 60_000

/** Options of one route registration. */
export interface RemoteTabRegistrationOptions {
  /** The host half's tab/connection rows, read synchronously per request. */
  readonly readTabs: () => DesktopTabs
  /** Backend provider; absent only when the feature is not composed. */
  readonly provider?: RemoteTabProvider
  /** The child-process supervisor owned by this registration. */
  readonly supervisor: RemoteTabSupervisor
  /** Web server owning the routes. */
  readonly webServer: RemoteWebServer
  readonly logger?: RemoteLogger
  /** Discovery budget in milliseconds; defaults to 60 s. */
  readonly discoveryTimeoutMs?: number
}

/** What one registration produced. */
export interface RemoteTabRegistration {
  /** The bridge `../remote/index.ts` merges and dispatches through. */
  readonly bridge: RemoteTabBridge
  /** Remove the routes and stop every child (homes are kept). */
  dispose(): void
}

/**
 * Register the remote-tab discovery routes and build the connection bridge.
 * @param options - web server, row source, service getters, and supervisor.
 * @returns the bridge plus a disposer removing the routes and stopping children.
 */
export function registerRemoteTabRoutes(options: RemoteTabRegistrationOptions): RemoteTabRegistration {
  const logger = options.logger
  const bridge = createBridge(options)
  if (options.webServer.host !== undefined && options.webServer.host !== '127.0.0.1') {
    logger?.error(`[dsh-desktop-tabs] refusing to register ${REMOTE_HOSTS_PATH}: the remote-tab routes carry remote launch tokens and must stay on the loopback bind (webServer.host is ${options.webServer.host})`)
    return { bridge, dispose: () => { void options.supervisor.dispose() } }
  }
  const timeoutMs = options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS
  const routes = [
    options.webServer.register({
      kind: 'exact',
      path: REMOTE_HOSTS_PATH,
      handler: async (req, res) => { await respondHosts(req, res, options, timeoutMs) },
    }),
    options.webServer.register({
      kind: 'exact',
      path: REMOTE_WORKSPACES_PATH,
      handler: async (req, res) => { await respondWorkspaces(req, res, options, timeoutMs) },
    }),
  ]
  return {
    bridge,
    dispose: () => {
      for (const dispose of routes.reverse()) dispose()
      void options.supervisor.dispose()
    },
  }
}

/**
 * Build the bridge between the tab rows and the child supervisor, without
 * registering any route (the host entry wires it into `../remote/index.ts`).
 * @param options - row source and supervisor.
 * @returns the bridge.
 */
export function createRemoteTabBridge(options: {
  readonly readTabs: () => DesktopTabs
  readonly supervisor: RemoteTabSupervisor
}): RemoteTabBridge {
  return createBridge(options)
}

/** The bridge implementation shared by both entry points. */
function createBridge(options: {
  readonly readTabs: () => DesktopTabs
  readonly supervisor: RemoteTabSupervisor
}): RemoteTabBridge {
  const supervisor = options.supervisor
  return {
    status(): RemoteConnectionStatus[] {
      const rows = new Map<string, RemoteConnectionStatus>()
      for (const row of supervisor.status()) {
        rows.set(row.id, {
          id: row.id,
          state: row.state,
          log: row.log ?? [],
          ...(row.url === undefined ? {} : { url: row.url }),
          ...(row.error === undefined ? {} : { error: row.error }),
        })
      }
      // Configured rows the supervisor has no record for are idle, exactly like
      // the SSH/WSL manager reports configured-but-closed tabs.
      const stored = options.readTabs()
      for (const row of [...stored.connections, ...stored.tabs]) {
        if (row.remote === undefined || rows.has(row.id)) continue
        rows.set(row.id, { id: row.id, state: 'idle', log: [] })
      }
      return [...rows.values()]
    },
    connectionFor(id: string): RemoteTabRequest | undefined {
      const stored = options.readTabs()
      const connection = stored.connections.find((row) => row.id === id && row.remote !== undefined)
      const tab = stored.tabs.find((row) => row.id === id && row.remote !== undefined)
      const remote = connection?.remote ?? tab?.remote
      if (remote === undefined) return undefined
      return { id, title: connection?.title ?? tab?.title ?? id, remote }
    },
    up(request: RemoteTabRequest): Promise<{ url: string }> {
      return supervisor.up(request)
    },
    async down(id: string): Promise<void> {
      await supervisor.down(id)
    },
    async forget(id: string): Promise<void> {
      await supervisor.forget(id)
    },
    dispose(): void {
      void supervisor.dispose()
    },
  }
}

/** Answer `GET /desktop-tabs/api/remote-hosts`. */
async function respondHosts(
  req: IncomingMessage,
  res: ServerResponse,
  options: RemoteTabRegistrationOptions,
  timeoutMs: number,
): Promise<void> {
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
  const provider = options.provider
  if (provider === undefined) {
    writeJson(res, 200, { hosts: [], error: REMOTE_PROVIDER_UNAVAILABLE }, head)
    return
  }
  try {
    const hosts = await provider.listHosts(AbortSignal.timeout(timeoutMs))
    writeJson(res, 200, { hosts }, head)
  } catch (error: unknown) {
    const reason = discoveryError(error, timeoutMs)
    options.logger?.warn(`[dsh-desktop-tabs] 读取远程主机列表失败：${reason}`)
    writeJson(res, 200, { hosts: [], error: reason }, head)
  }
}

/** Answer `GET /desktop-tabs/api/remote-workspaces?targetDeviceId=…`. */
async function respondWorkspaces(
  req: IncomingMessage,
  res: ServerResponse,
  options: RemoteTabRegistrationOptions,
  timeoutMs: number,
): Promise<void> {
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
  const targetDeviceId = (queryValue(req, 'targetDeviceId') ?? '').trim()
  if (targetDeviceId === '') {
    writeJson(res, 200, { workspaces: [], error: '缺少 targetDeviceId 参数' }, head)
    return
  }
  const provider = options.provider
  if (provider === undefined) {
    writeJson(res, 200, { workspaces: [], error: REMOTE_PROVIDER_UNAVAILABLE }, head)
    return
  }
  try {
    const discovery = await provider.discoverWorkspaces(targetDeviceId, AbortSignal.timeout(timeoutMs))
    const workspaces: readonly RemoteWorkspace[] = discovery.workspaces
    const unavailable: readonly RemoteWorkspaceUnavailable[] = discovery.unavailable
    writeJson(res, 200, {
      workspaces,
      ...(unavailable.length === 0 ? {} : { unavailable }),
    }, head)
  } catch (error: unknown) {
    const reason = discoveryError(error, timeoutMs)
    options.logger?.warn(`[dsh-desktop-tabs] 读取远程工作区失败（${shortId(targetDeviceId)}）：${reason}`)
    writeJson(res, 200, { workspaces: [], error: reason }, head)
  }
}

/** One discovery failure's user-facing text: a timeout is named explicitly. */
function discoveryError(error: unknown, timeoutMs: number): string {
  const name = typeof error === 'object' && error !== null && 'name' in error ? (error as { name?: unknown }).name : undefined
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `获取远程信息超时（${Math.round(timeoutMs / 1000)} 秒）`
  }
  return redactToken(message(error))
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

/** One query parameter of the request URL. */
function queryValue(req: IncomingMessage, name: string): string | undefined {
  try {
    const url = new URL(req.url ?? '/', 'http://x')
    return url.searchParams.get(name) ?? undefined
  } catch {
    return undefined
  }
}

/** First eight characters of an id, for logs. */
function shortId(id: string): string {
  return id.slice(0, 8)
}

/** @returns an error's message, or its string form. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
