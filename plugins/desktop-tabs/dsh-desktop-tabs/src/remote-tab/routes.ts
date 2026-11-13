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
 * Discovery reads `ctx.get('dshRemoteClient', false)` at request time, so a
 * plugin enabled or logged in after boot starts answering without a restart.
 * Workspace discovery opens a temporary background carrier, which the parent
 * only allows in local mode; while the main UI itself is in remote mode the
 * route refuses instead of opening a second control connection.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { redactToken } from '../remote/text.ts'
import type { RemoteConnectionStatus, RemoteLogger, RemoteWebServer } from '../remote/types.ts'
import type { DesktopTabs } from '../targets.ts'
import type { RemoteTabSupervisor } from './supervisor.ts'
import type {
  RemoteConnectionSpec,
  RemoteHost,
  RemoteTabBridge,
  RemoteTabRequest,
  RemoteWorkspace,
} from './types.ts'

/** Route serving the discoverable Remote hosts. */
export const REMOTE_HOSTS_PATH = '/desktop-tabs/api/remote-hosts'

/** Route serving one host's workspaces. */
export const REMOTE_WORKSPACES_PATH = '/desktop-tabs/api/remote-workspaces'

/** Answer used when ds-harness-remote is not installed or not enabled. */
export const REMOTE_PLUGIN_UNAVAILABLE = 'ds-harness-remote is not installed/enabled'

/** Answer used while the parent UI itself holds a remote control connection. */
export const REMOTE_MODE_WORKSPACE_ERROR = '主界面处于远程模式，请先在 Remote 面板退出后再浏览工作区'

/** Default discovery budget: a background carrier plus backend catalogs. */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 60_000

/** Options of one route registration. */
export interface RemoteTabRegistrationOptions {
  /** The host half's tab/connection rows, read synchronously per request. */
  readonly readTabs: () => DesktopTabs
  /** `ctx.get('dshRemoteClient', false)`, read per request. */
  readonly getClient: () => unknown
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
  const client = asClientRuntime(options.getClient())
  if (client === undefined) {
    writeJson(res, 200, { hosts: [], error: REMOTE_PLUGIN_UNAVAILABLE }, head)
    return
  }
  try {
    const devices = await client.devices(AbortSignal.timeout(timeoutMs))
    const hosts = devices.map(hostOf).filter((host): host is RemoteHost => host !== undefined)
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
  const client = asClientRuntime(options.getClient())
  if (client === undefined) {
    writeJson(res, 200, { workspaces: [], error: REMOTE_PLUGIN_UNAVAILABLE }, head)
    return
  }
  // Opening a tool carrier while the UI already holds the control connection
  // would replace the warm connection on the server, so it is refused here.
  if (client.status()?.mode === 'remote') {
    writeJson(res, 200, { workspaces: [], error: REMOTE_MODE_WORKSPACE_ERROR }, head)
    return
  }
  try {
    const result = await client.discoverToolWorkspaces(targetDeviceId, AbortSignal.timeout(timeoutMs))
    const workspaces = (result.workspaces ?? []).flatMap((raw): RemoteWorkspace[] => {
      const row = asRecord(raw)
      const workspaceId = nonEmptyString(row?.workspaceId)
      const path = nonEmptyString(row?.path)
      if (row === undefined || workspaceId === undefined || path === undefined) return []
      const title = nonEmptyString(row.title) ?? path
      const backend = nonEmptyString(row.backend)
      // v1 opens Harness workspaces only; the catalog may also carry Codex/ACP
      // rows, which the child bootstrap and the target validator do not support.
      if (backend !== undefined && backend !== 'harness') return []
      return [{ workspaceId, path, title, ...(backend === undefined ? {} : { backend }) }]
    })
    const unavailable = (result.unavailable ?? []).flatMap((raw): { backend: string; code: string }[] => {
      const row = asRecord(raw)
      const backend = nonEmptyString(row?.backend)
      const code = nonEmptyString(row?.code)
      return backend === undefined || code === undefined ? [] : [{ backend, code }]
    })
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

/** The client runtime subset the discovery routes drive. */
interface ClientRuntimeLike {
  devices(signal?: AbortSignal): Promise<readonly unknown[]>
  status(): { mode?: string } | undefined
  discoverToolWorkspaces(
    targetDeviceId: string,
    signal?: AbortSignal,
  ): Promise<{ workspaces?: readonly unknown[]; unavailable?: readonly unknown[] }>
}

/** Reflect the optional client runtime, or undefined when it is not a usable runtime. */
function asClientRuntime(value: unknown): ClientRuntimeLike | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const devices = record.devices
  const status = record.status
  const discover = record.discoverToolWorkspaces
  if (typeof devices !== 'function' || typeof status !== 'function' || typeof discover !== 'function') return undefined
  return value as ClientRuntimeLike
}

/** Project one server device descriptor onto the panel shape. */
function hostOf(raw: unknown): RemoteHost | undefined {
  const row = asRecord(raw)
  const deviceId = nonEmptyString(row?.deviceId)
  if (row === undefined || deviceId === undefined) return undefined
  const name = nonEmptyString(row.name) ?? deviceId.slice(0, 8)
  const platform = nonEmptyString(row.platform)
  const version = nonEmptyString(row.harnessVersion) ?? nonEmptyString(row.clientVersion)
  const online = typeof row.online === 'boolean' ? row.online : undefined
  return {
    deviceId,
    name,
    ...(platform === undefined ? {} : { platform }),
    ...(online === undefined ? {} : { online }),
    ...(version === undefined ? {} : { version }),
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

/** Narrow an unknown value to a record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow an unknown value to a record, or undefined. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

/** @returns a trimmed non-empty string, or undefined. */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}

/** First eight characters of an id, for logs. */
function shortId(id: string): string {
  return id.slice(0, 8)
}

/** @returns an error's message, or its string form. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
