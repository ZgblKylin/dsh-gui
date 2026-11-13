/**
 * Tests of the remote-tab discovery routes and the connection bridge, run
 * against the built package (`../lib/index.js`).
 *
 * A fake web server records the registered routes; the handlers are invoked
 * directly with fake request/response objects, so no HTTP listener is started
 * and no remote plugin is needed. The bridge is exercised both directly and
 * through `registerRemoteConnections`, which proves a saved remote connection
 * is dispatched to the remote-tab half instead of the SSH/WSL manager.
 *
 * Usage (from the package directory): node tests/remote-tab-routes.spec.ts
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)

const root = mkdtempSync(join(tmpdir(), 'dsh-remote-tab-routes-'))

/** A minimal ServerResponse double. */
function fakeResponse(): {
  status: number
  headers: Record<string, string>
  body: string
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string): void
} {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status: number, headers?: Record<string, string>) { this.status = status; this.headers = headers ?? {} },
    end(body?: string) { if (body !== undefined) this.body = body },
  }
}

/** A minimal IncomingMessage double for the route handlers. */
function fakeRequest(options: {
  method?: string
  url: string
  headers?: Record<string, string>
  body?: unknown
}): {
  method: string
  url: string
  headers: Record<string, string>
  resume(): void
  on(event: string, listener: (chunk?: unknown) => void): void
} {
  const headers = { host: '127.0.0.1:1', ...options.headers }
  return {
    method: options.method ?? 'GET',
    url: options.url,
    headers,
    resume() {},
    on() {},
  }
}

/** A fake web server recording every registration. */
function fakeWebServer(options: { host?: string } = {}): {
  host?: string
  routes: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => unknown }[]
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => unknown }): () => void
} {
  const routes: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => unknown }[] = []
  return {
    ...(options.host === undefined ? {} : { host: options.host }),
    routes,
    register(route) {
      routes.push(route)
      return () => {
        const at = routes.indexOf(route)
        if (at !== -1) routes.splice(at, 1)
      }
    },
  }
}

/** The parent half's rows, with one saved remote connection and one remote tab. */
function makeReadTabs(rows: { connections?: unknown[]; tabs?: unknown[] } = {}) {
  const remoteSpec = {
    targetDeviceId: 'device-1',
    targetName: 'Desktop-ZgblKylin',
    workspacePath: '/src/app',
    backend: 'harness',
  }
  return () => ({
    tabs: rows.tabs ?? [{ id: 'remote-1', title: 'Desktop · app', remote: remoteSpec }],
    connections: rows.connections ?? [{ id: 'remote-1', title: 'Desktop · app', type: 'remote', remote: remoteSpec }],
    warnings: [],
  })
}

/** A fake supervisor recording every dispatch. */
function fakeSupervisor(): {
  status(): unknown[]
  setStatus(next: unknown[]): void
  up(request: unknown): Promise<{ url: string }>
  down(id: string): Promise<void>
  forget(id: string): Promise<void>
  dispose(): Promise<void>
  readonly calls: { up: unknown[]; down: string[]; forget: string[]; disposed: number }
} {
  const calls = { up: [] as unknown[], down: [] as string[], forget: [] as string[], disposed: 0 }
  let statuses: unknown[] = []
  return {
    calls,
    status: () => statuses,
    setStatus(next: unknown[]) { statuses = next },
    async up(request: unknown) {
      calls.up.push(request)
      return { url: 'http://127.0.0.1:45678/?token=ChildToken' }
    },
    async down(id: string) { calls.down.push(id) },
    async forget(id: string) { calls.forget.push(id) },
    async dispose() { calls.disposed += 1 },
  }
}

// ---------------------------------------------------------------- hosts route
{
  const webServer = fakeWebServer()
  const supervisor = fakeSupervisor()
  const registration = mod.registerRemoteTabRoutes({
    readTabs: makeReadTabs(),
    getClient: () => ({
      devices: async () => [
        { deviceId: 'device-1', name: 'Desktop-ZgblKylin', platform: 'linux', online: true, harnessVersion: '0.1.0' },
        { deviceId: 'device-2', name: '', platform: 'win32' },
        { name: 'missing id' },
      ],
      status: () => ({ mode: 'local' }),
      discoverToolWorkspaces: async () => ({ workspaces: [], unavailable: [] }),
    }),
    supervisor,
    webServer,
  })
  assert.ok(webServer.routes.some((route) => route.path === mod.REMOTE_HOSTS_PATH), 'the hosts route is registered')
  const route = webServer.routes.find((entry) => entry.path === mod.REMOTE_HOSTS_PATH)

  const response = fakeResponse()
  await route.handler(fakeRequest({ url: mod.REMOTE_HOSTS_PATH }), response)
  assert.equal(response.status, 200)
  const body = JSON.parse(response.body)
  assert.deepEqual(body.hosts, [
    { deviceId: 'device-1', name: 'Desktop-ZgblKylin', platform: 'linux', online: true, version: '0.1.0' },
    { deviceId: 'device-2', name: 'device-2', platform: 'win32' },
  ], 'hosts are mapped and rows without a device id are dropped')
  assert.equal(response.headers['cache-control'], 'no-store', 'responses are never cached')

  const wrongMethod = fakeResponse()
  await route.handler(fakeRequest({ method: 'POST', url: mod.REMOTE_HOSTS_PATH }), wrongMethod)
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.allow, 'GET, HEAD')

  const crossSite = fakeResponse()
  await route.handler(fakeRequest({ url: mod.REMOTE_HOSTS_PATH, headers: { 'sec-fetch-site': 'cross-site' } }), crossSite)
  assert.equal(crossSite.status, 403, 'a cross-site request is refused')

  registration.dispose()
  assert.equal(webServer.routes.length, 0, 'the disposer removes every route')
  assert.equal(supervisor.calls.disposed, 1, 'the disposer also stops the child supervisor')
}

// ---------------------------------------------------------------- unavailable plugin
{
  const webServer = fakeWebServer()
  const supervisor = fakeSupervisor()
  const registration = mod.registerRemoteTabRoutes({
    readTabs: makeReadTabs(),
    getClient: () => undefined,
    supervisor,
    webServer,
  })
  const hostsRoute = webServer.routes.find((entry) => entry.path === mod.REMOTE_HOSTS_PATH)
  const response = fakeResponse()
  await hostsRoute.handler(fakeRequest({ url: mod.REMOTE_HOSTS_PATH }), response)
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), { hosts: [], error: mod.REMOTE_PLUGIN_UNAVAILABLE }, 'a missing plugin answers an empty list plus the reason')

  const workspacesRoute = webServer.routes.find((entry) => entry.path === mod.REMOTE_WORKSPACES_PATH)
  const workspaces = fakeResponse()
  await workspacesRoute.handler(fakeRequest({ url: `${mod.REMOTE_WORKSPACES_PATH}?targetDeviceId=device-1` }), workspaces)
  assert.deepEqual(JSON.parse(workspaces.body), { workspaces: [], error: mod.REMOTE_PLUGIN_UNAVAILABLE })
  registration.dispose()
}

// ---------------------------------------------------------------- workspaces route
{
  const webServer = fakeWebServer()
  const supervisor = fakeSupervisor()
  let mode = 'local'
  const registration = mod.registerRemoteTabRoutes({
    readTabs: makeReadTabs(),
    getClient: () => ({
      devices: async () => [],
      status: () => ({ mode }),
      discoverToolWorkspaces: async () => ({
        workspaces: [
          { backend: 'harness', workspaceId: 'ws-1', path: '/src/app', title: 'app' },
          { backend: 'codex', workspaceId: 'ws-2', path: '/src/other' },
          { backend: 'harness', workspaceId: '', path: '/broken' },
        ],
        unavailable: [{ backend: 'cursor', code: 'BACKEND_UNAVAILABLE' }, { code: 'NO_BACKEND' }],
      }),
    }),
    supervisor,
    webServer,
  })
  const route = webServer.routes.find((entry) => entry.path === mod.REMOTE_WORKSPACES_PATH)

  const response = fakeResponse()
  await route.handler(fakeRequest({ url: `${mod.REMOTE_WORKSPACES_PATH}?targetDeviceId=device-1` }), response)
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), {
    // v1 only opens Harness workspaces; the Codex row is dropped and the
    // malformed Harness row is ignored.
    workspaces: [
      { workspaceId: 'ws-1', path: '/src/app', title: 'app', backend: 'harness' },
    ],
    unavailable: [{ backend: 'cursor', code: 'BACKEND_UNAVAILABLE' }],
  }, 'Harness workspaces are mapped; non-Harness and malformed rows are dropped')

  const missing = fakeResponse()
  await route.handler(fakeRequest({ url: mod.REMOTE_WORKSPACES_PATH }), missing)
  assert.match(JSON.parse(missing.body).error, /targetDeviceId/u, 'a missing target device is reported')

  mode = 'remote'
  const remoteMode = fakeResponse()
  await route.handler(fakeRequest({ url: `${mod.REMOTE_WORKSPACES_PATH}?targetDeviceId=device-1` }), remoteMode)
  assert.deepEqual(JSON.parse(remoteMode.body), {
    workspaces: [],
    error: mod.REMOTE_MODE_WORKSPACE_ERROR,
  }, 'workspace discovery is refused while the UI holds a remote control connection')

  const crossSite = fakeResponse()
  await route.handler(fakeRequest({
    url: `${mod.REMOTE_WORKSPACES_PATH}?targetDeviceId=device-1`,
    headers: { 'sec-fetch-site': 'cross-site' },
  }), crossSite)
  assert.equal(crossSite.status, 403)
  registration.dispose()
}

// ---------------------------------------------------------------- workspaces timeout
{
  const webServer = fakeWebServer()
  const supervisor = fakeSupervisor()
  const registration = mod.registerRemoteTabRoutes({
    readTabs: makeReadTabs(),
    getClient: () => ({
      devices: async () => [],
      status: () => ({ mode: 'local' }),
      discoverToolWorkspaces: (_id: string, signal: AbortSignal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) }, { once: true })
      }),
    }),
    supervisor,
    webServer,
    discoveryTimeoutMs: 50,
  })
  const route = webServer.routes.find((entry) => entry.path === mod.REMOTE_WORKSPACES_PATH)
  const response = fakeResponse()
  // `AbortSignal.timeout` does not keep the event loop alive on its own, and
  // this fake client has no sockets; hold the loop until the signal fires.
  const keepAlive = setInterval(() => {}, 50)
  try {
    await route.handler(fakeRequest({ url: `${mod.REMOTE_WORKSPACES_PATH}?targetDeviceId=device-1` }), response)
  } finally {
    clearInterval(keepAlive)
  }
  assert.equal(response.status, 200)
  assert.match(JSON.parse(response.body).error, /超时/u, 'a slow discovery answers the timeout text')
  registration.dispose()
}

// ---------------------------------------------------------------- bridge
{
  const supervisor = fakeSupervisor() as ReturnType<typeof fakeSupervisor> & { setStatus(next: unknown[]): void }
  const bridge = mod.createRemoteTabBridge({ readTabs: makeReadTabs(), supervisor })
  assert.equal(bridge.status().length, 1, 'a configured remote connection is reported idle before any child exists')
  assert.deepEqual(bridge.status()[0], { id: 'remote-1', state: 'idle', log: [] })

  supervisor.setStatus([{ id: 'remote-2', state: 'up', url: 'http://127.0.0.1:1/?token=t', log: ['line'], error: undefined }])
  const merged = bridge.status()
  assert.equal(merged.length, 2, 'records and configured rows are merged')
  const record = merged.find((row: { id: string }) => row.id === 'remote-2')
  assert.equal(record.state, 'up')
  assert.deepEqual(record.log, ['line'])

  const request = bridge.connectionFor('remote-1')
  assert.equal(request.id, 'remote-1', 'a saved connection resolves to a launch request')
  assert.equal(request.title, 'Desktop · app')
  assert.equal(request.remote.workspacePath, '/src/app')
  assert.equal(bridge.connectionFor('local'), undefined, 'a non-remote id has no remote request')

  const tabOnly = mod.createRemoteTabBridge({
    readTabs: makeReadTabs({ connections: [], tabs: [{ id: 'remote-tab-1', title: 'tab', remote: { targetDeviceId: 'd', workspacePath: '/w' } }] }),
    supervisor: fakeSupervisor(),
  })
  assert.equal(tabOnly.connectionFor('remote-tab-1')?.remote.workspacePath, '/w', 'a remote tab row also resolves')
}

// ---------------------------------------------------------------- connection dispatch
{
  const webServer = fakeWebServer()
  const supervisor = fakeSupervisor()
  const registration = mod.registerRemoteTabRoutes({
    readTabs: makeReadTabs(),
    getClient: () => undefined,
    supervisor,
    webServer,
  })
  const disposeConnections = mod.registerRemoteConnections({}, webServer, {
    dshHome: root,
    tabs: async () => ({ tabs: makeReadTabs()().tabs, connections: makeReadTabs()().connections }),
    remote: registration.bridge,
  })
  const statusRoute = webServer.routes.find((route) => route.path === mod.CONNECTIONS_ROUTE_PREFIX && route.kind === 'exact')
  const actionRoute = webServer.routes.find((route) => route.path === mod.CONNECTIONS_ROUTE_PREFIX && route.kind === 'prefix')

  const status = fakeResponse()
  await statusRoute.handler(fakeRequest({ url: mod.CONNECTIONS_ROUTE_PREFIX }), status)
  const statusBody = JSON.parse(status.body)
  assert.deepEqual(statusBody.connections, [{ id: 'remote-1', state: 'idle', log: [] }], 'GET /connections carries the remote row')

  const up = fakeResponse()
  await actionRoute.handler(fakeRequest({ method: 'POST', url: `${mod.CONNECTIONS_ROUTE_PREFIX}/remote-1/up` }), up)
  assert.equal(up.status, 200)
  assert.equal(JSON.parse(up.body).url, 'http://127.0.0.1:45678/?token=ChildToken', 'up dispatches to the remote-tab supervisor')
  assert.equal(supervisor.calls.up.length, 1)
  assert.equal(supervisor.calls.up[0].id, 'remote-1')

  const down = fakeResponse()
  await actionRoute.handler(fakeRequest({ method: 'POST', url: `${mod.CONNECTIONS_ROUTE_PREFIX}/remote-1/down` }), down)
  assert.equal(down.status, 200)
  assert.deepEqual(supervisor.calls.down, ['remote-1'], 'down dispatches to the remote-tab supervisor')

  const forget = fakeResponse()
  await actionRoute.handler(fakeRequest({ method: 'POST', url: `${mod.CONNECTIONS_ROUTE_PREFIX}/remote-1/forget` }), forget)
  assert.equal(forget.status, 200)
  assert.deepEqual(supervisor.calls.forget, ['remote-1'], 'forget dispatches to the remote-tab supervisor')

  const unknownForget = fakeResponse()
  await actionRoute.handler(fakeRequest({ method: 'POST', url: `${mod.CONNECTIONS_ROUTE_PREFIX}/not-remote/forget` }), unknownForget)
  assert.equal(unknownForget.status, 404, 'forget on a non-remote id is a 404')
  assert.match(JSON.parse(unknownForget.body).error, /not a saved remote connection/u)

  const unknownUp = fakeResponse()
  await actionRoute.handler(fakeRequest({ method: 'POST', url: `${mod.CONNECTIONS_ROUTE_PREFIX}/not-remote/up` }), unknownUp)
  assert.equal(unknownUp.status, 502, 'up on an unknown id stays with the SSH/WSL manager and reports its failure')
  assert.equal(supervisor.calls.up.length, 1, 'an unknown id never reaches the remote-tab supervisor')

  disposeConnections()
  registration.dispose()
}

// ---------------------------------------------------------------- plugin wiring
// `apply` is the only entry the desktop host calls; a fake Cordis context proves
// it registers the tab route, both discovery routes, and the connection routes,
// and that its disposer removes them and stops the supervisor.
{
  const registered: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => unknown }[] = []
  const cleanups: (() => void)[] = []
  const services: Record<string, unknown> = {}
  const ctx = {
    webServer: {
      host: '127.0.0.1',
      register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => unknown }) {
        registered.push(route)
        return () => {
          const at = registered.indexOf(route)
          if (at !== -1) registered.splice(at, 1)
        }
      },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect(callback: () => () => void) {
      cleanups.push(callback())
      return () => {}
    },
    get(name: string) {
      return services[name]
    },
  }
  mod.apply(ctx)
  const paths = registered.map((route) => route.path)
  assert.equal(paths.filter((path) => path === '/desktop-tabs/api/tabs').length, 1, 'apply registers the tab-list route')
  assert.ok(paths.includes(mod.REMOTE_HOSTS_PATH), 'apply registers the remote-host route')
  assert.ok(paths.includes(mod.REMOTE_WORKSPACES_PATH), 'apply registers the remote-workspace route')
  assert.equal(paths.filter((path) => path === mod.CONNECTIONS_ROUTE_PREFIX).length, 2, 'apply registers the connection status and action routes')

  // The hosts route answers the "plugin unavailable" shape with no services.
  const hostsRoute = registered.find((route) => route.path === mod.REMOTE_HOSTS_PATH)
  const response = fakeResponse()
  await hostsRoute.handler(fakeRequest({ url: mod.REMOTE_HOSTS_PATH }), response)
  assert.deepEqual(JSON.parse(response.body), { hosts: [], error: mod.REMOTE_PLUGIN_UNAVAILABLE })

  for (const cleanup of cleanups.reverse()) cleanup()
  assert.equal(registered.length, 0, 'the apply disposer removes every route')
}

rmSync(root, { recursive: true, force: true })
console.log('remote-tab routes tests passed')
