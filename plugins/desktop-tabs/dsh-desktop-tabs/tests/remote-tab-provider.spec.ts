/**
 * Tests of the `ds-harness-remote` provider — the backend-specific half of the
 * remote-tab feature — run against the built package (`../lib/index.js`).
 *
 * The real plugin package cannot be imported here (its `dist` imports a module
 * that only resolves inside the hosting runtime), so — exactly like the
 * production code — these tests reflect fake classes off fake Cordis service
 * instances: `client.server.constructor`, `client.server.store.constructor`,
 * `client.identities.constructor`, and `host.serverApi`. The fake classes
 * simulate the server-side mint/refresh/revoke calls and the discovery routes in
 * memory.
 *
 * Usage (from the package directory): node tests/remote-tab-provider.spec.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

import { cleanup, makeFixture } from './remote-tab-fixtures.ts'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)

const SERVER_URL = 'https://dsh.example.test'

/** One fake device identity, matching the fields the provider reads. */
interface FakeIdentity {
  deviceId: string
  name: string
}

/** Observable effects of the fake services, plus the errors they should throw. */
interface FakeBehavior {
  hasStoredAuthorization: boolean
  storedCredentials?: () => { accessToken: string; account?: string } | undefined
  /** Error thrown by `authenticate`; cleared after it fires once. */
  authenticateError?: Error
  /** Error thrown by `authorizeOwnedRole`. */
  mintError?: Error
  readonly mints: { identity: FakeIdentity; accessToken: string; account?: string }[]
  readonly revoked: FakeIdentity[]
  hostAuthentications: number
  /** Discovery fixtures. */
  hosts?: readonly unknown[]
  workspaces?: readonly unknown[]
  unavailable?: readonly unknown[]
  mode?: string
  discoveryError?: Error
}

/** Build the fake Cordis services; `client` mirrors the real runtime's fields. */
function makeServices(behavior: FakeBehavior): {
  client: Record<string, unknown>
  host: Record<string, unknown>
} {
  let deviceCounter = 0
  const nextDeviceId = (): string => {
    deviceCounter += 1
    return `00000000-0000-4000-8000-${String(deviceCounter).padStart(12, '0')}`
  }

  class FakeIdentityStore {
    readonly directory: string
    private identity: FakeIdentity | undefined
    private readonly seed: FakeIdentity | undefined
    constructor(options: { directory: string; seed?: FakeIdentity }) {
      this.directory = options.directory
      this.seed = options.seed
    }

    async loadOrCreate(name: string): Promise<FakeIdentity> {
      this.identity ??= this.seed ?? { deviceId: nextDeviceId(), name }
      this.identity.name = name
      return this.identity
    }

    async reset(name: string): Promise<FakeIdentity> {
      this.identity = { deviceId: nextDeviceId(), name }
      return this.identity
    }
  }

  class FakeCredentialStore {
    readonly directory: string
    constructor(directory: string) { this.directory = directory }
    async load(): Promise<{ accessToken: string; account?: string } | undefined> {
      return behavior.storedCredentials?.()
    }
  }

  class FakeClientServerApi {
    readonly baseUrl: string
    readonly store: FakeCredentialStore
    identity: FakeIdentity | undefined
    constructor(baseUrl: string, store: FakeCredentialStore) {
      this.baseUrl = baseUrl
      this.store = store
    }

    bindIdentity(identity: FakeIdentity): void { this.identity = identity }
    async hasStoredAuthorization(): Promise<boolean> { return behavior.hasStoredAuthorization }
    async authorizeOwnedRole(identity: FakeIdentity, accessToken: string, account?: string): Promise<unknown> {
      if (behavior.mintError !== undefined) throw behavior.mintError
      behavior.mints.push({ identity, accessToken, ...(account === undefined ? {} : { account }) })
      behavior.hasStoredAuthorization = true
      return { method: 'owned_device' }
    }

    async authenticate(): Promise<{ accessToken: string; account?: string }> {
      const error = behavior.authenticateError
      behavior.authenticateError = undefined
      if (error !== undefined) throw error
      return { accessToken: 'child-access-token', account: 'owner@example.test' }
    }

    async revokeCurrentDevice(): Promise<void> {
      if (this.identity !== undefined) behavior.revoked.push(this.identity)
    }
  }

  const identities = new FakeIdentityStore({ directory: join('unused', 'identities') })
  const server = new FakeClientServerApi(SERVER_URL, new FakeCredentialStore(join('unused', 'credentials')))
  const hostApi = {
    baseUrl: SERVER_URL,
    async authenticate(): Promise<{ accessToken: string; account?: string }> {
      behavior.hostAuthentications += 1
      return { accessToken: 'host-access-token', account: 'owner@example.test' }
    },
  }
  const client: Record<string, unknown> = {
    server,
    identities,
    devices: async () => {
      if (behavior.discoveryError !== undefined) throw behavior.discoveryError
      return behavior.hosts ?? []
    },
    status: () => ({ mode: behavior.mode ?? 'local' }),
    discoverToolWorkspaces: async () => {
      if (behavior.discoveryError !== undefined) throw behavior.discoveryError
      return { workspaces: behavior.workspaces ?? [], unavailable: behavior.unavailable ?? [] }
    },
  }
  return {
    client,
    host: { serverApi: hostApi, currentIdentity: () => ({ deviceId: 'host-device', name: 'host' }) },
  }
}

/** A complete behavior record with no discovery fixtures. */
function behavior(overrides: Partial<FakeBehavior> = {}): FakeBehavior {
  return {
    hasStoredAuthorization: false,
    mints: [],
    revoked: [],
    hostAuthentications: 0,
    ...overrides,
  }
}

/** A plugin error carrying the stable code the provider inspects. */
function codeError(code: string): Error {
  return Object.assign(new Error(`rejected with ${code}`), { code })
}

/** Collect logger lines so the tests can prove tokens never reach the log. */
function makeLogger(): { logs: string[]; logger: { info: (m: unknown) => void; warn: (m: unknown) => void; error: (m: unknown) => void } } {
  const logs: string[] = []
  return {
    logs,
    logger: {
      info: (text: unknown) => { logs.push(String(text)) },
      warn: (text: unknown) => { logs.push(String(text)) },
      error: (text: unknown) => { logs.push(String(text)) },
    },
  }
}

/** Create a provider over one fake service pair. */
function providerFor(services: { client?: unknown; host?: unknown }, logger?: ReturnType<typeof makeLogger>['logger']): {
  provider: ReturnType<typeof mod.createDsHarnessRemoteProvider>
} {
  return {
    provider: mod.createDsHarnessRemoteProvider({
      getClient: () => services.client,
      getHost: () => services.host,
      ...(logger === undefined ? {} : { logger }),
    }),
  }
}

const root = mkdtempSync(join(tmpdir(), 'dsh-remote-tab-provider-'))

// ---------------------------------------------------------------- descriptor
{
  const { provider } = providerFor({})
  assert.equal(provider.id, 'ds-harness-remote')
  assert.deepEqual(provider.bundles, ['dsh-remote-tab-boot'], 'the provider adds its bootstrap bundle')
  assert.deepEqual(provider.requiredBundles, ['ds-harness-remote'], 'the provider requires its own bundle')
  assert.equal(provider.readyBundle, 'dsh-remote-tab-boot')
  assert.deepEqual(provider.homeFiles.map((file: { source: string }) => file.source), [
    'settings.yaml',
    join('dsh-pet', 'main-config.jsonc'),
    'pet.json',
  ], 'the provider copies the parent UI files')
  const patch = provider.renderPatch({ serverUrl: SERVER_URL })
  assert.ok(patch.includes('role: client'), 'the child runs as a client')
  assert.ok(patch.includes('serverUrl: "https://dsh.example.test"'), 'the patch carries the server URL')
  assert.match(patch, /hostControl:\n\s+enabled: false/u, 'hostControl is disabled')
  assert.match(patch, /terminal:\n\s+enabled: false/u, 'the terminal feature is disabled')
  assert.match(patch, /remoteTools:\n\s+enabled: false/u, 'remote tools are disabled')
  assert.match(patch, /acp:\n\s+enabled: false/u, 'local ACP backends are disabled in the child')
}

// ---------------------------------------------------------------- mint path
{
  const state = behavior()
  const { client, host } = makeServices(state)
  const { logs, logger } = makeLogger()
  const { provider } = providerFor({ client, host }, logger)
  const childHome = join(root, 'mint-home')
  mkdirSync(childHome, { recursive: true })
  const identity = await provider.ensureIdentity({ childHome, deviceName: 'Desktop-ZgblKylin · archlinux · 远程标签' })
  assert.equal(identity.serverUrl, SERVER_URL, 'the server URL comes from the reflected auth endpoints')
  assert.equal(identity.authorization, 'minted', 'a child without credentials is minted')
  assert.equal(state.mints.length, 1, 'one owned-role registration happens')
  assert.equal(state.mints[0].accessToken, 'host-access-token', 'minting authorizes with the fresh host token')
  assert.equal(state.mints[0].account, 'owner@example.test', 'the host account rides along')
  assert.equal(state.hostAuthentications, 1, 'the host token is refreshed exactly once')
  assert.ok(identity.deviceId.length > 0, 'the minted device id is returned')

  const expectedChildDir = mod.serverStorageDirectory(join(childHome, 'remote'), SERVER_URL, 'client')
  assert.equal(identity.childDir, expectedChildDir, 'the child lives in the plugin-computed storage directory')

  const flat = logs.join('\n')
  assert.ok(!flat.includes('host-access-token'), 'the host token never reaches the log')
  assert.ok(!flat.includes('child-access-token'), 'the child token never reaches the log')
}

// ---------------------------------------------------------------- reuse / recovery / failure
{
  const reuse = behavior({ hasStoredAuthorization: true, storedCredentials: () => ({ accessToken: 'stored-token' }) })
  const services = makeServices(reuse)
  const { provider } = providerFor(services)
  const identity = await provider.ensureIdentity({ childHome: join(root, 'reuse'), deviceName: 'reuse' })
  assert.equal(identity.authorization, 'reused', 'existing child credentials are reused')
  assert.equal(reuse.mints.length, 0, 'reuse never registers a new device')
}
{
  const state = behavior({
    hasStoredAuthorization: true,
    storedCredentials: () => ({ accessToken: 'stale-token' }),
    authenticateError: codeError('DEVICE_REVOKED'),
  })
  const services = makeServices(state)
  const { logs, logger } = makeLogger()
  const { provider } = providerFor(services, logger)
  const identity = await provider.ensureIdentity({ childHome: join(root, 'recover'), deviceName: 'recover' })
  assert.equal(identity.authorization, 'recovered', 'a revoked child device is reset once and re-minted')
  assert.equal(state.mints.length, 1, 'the recovery mints exactly one new device')
  assert.ok(logs.some((line) => line.includes('DEVICE_REVOKED')), 'the recovery reason is logged')
}
{
  const state = behavior({ hasStoredAuthorization: true, authenticateError: codeError('NETWORK_ERROR') })
  const { client, host } = makeServices(state)
  const { provider } = providerFor({ client, host })
  await assert.rejects(
    () => provider.ensureIdentity({ childHome: join(root, 'network'), deviceName: 'network' }),
    /NETWORK_ERROR|rejected with/u,
    'a non-identity failure is surfaced instead of resetting the device',
  )
}
{
  const { provider } = providerFor({})
  await assert.rejects(
    () => provider.ensureIdentity({ childHome: join(root, 'no-remote'), deviceName: 'no-remote' }),
    /Remote 面板登录并启用主机授权/u,
    'a missing backend plugin explains where to enable it',
  )
}

// ---------------------------------------------------------------- revocation
{
  const state = behavior({ hasStoredAuthorization: true })
  const { client } = makeServices(state)
  const { provider } = providerFor({ client })
  const revokeHome = join(root, 'revoke-home')
  mkdirSync(revokeHome, { recursive: true })
  const childDir = mod.serverStorageDirectory(join(revokeHome, 'remote'), SERVER_URL, 'client')
  mkdirSync(childDir, { recursive: true })
  writeFileSync(join(childDir, 'device.json'), '{}')
  await provider.revokeIdentity({ childHome: revokeHome })
  assert.equal(state.revoked.length, 1, 'the child device is revoked once')

  const emptyHome = join(root, 'empty-home')
  mkdirSync(emptyHome, { recursive: true })
  await provider.revokeIdentity({ childHome: emptyHome })
  assert.equal(state.revoked.length, 1, 'an unminted child is a no-op')
}

// ---------------------------------------------------------------- discovery
{
  const state = behavior({
    hosts: [
      { deviceId: 'device-1', name: 'Desktop-ZgblKylin', platform: 'linux', online: true, harnessVersion: '0.1.0' },
      { deviceId: 'device-2', name: '', platform: 'win32' },
      { name: 'missing id' },
    ],
    workspaces: [
      { backend: 'harness', workspaceId: 'ws-1', path: '/src/app', title: 'app' },
      { backend: 'codex', workspaceId: 'ws-2', path: '/src/other' },
      { backend: 'harness', workspaceId: '', path: '/broken' },
    ],
    unavailable: [{ backend: 'cursor', code: 'BACKEND_UNAVAILABLE' }, { code: 'NO_BACKEND' }],
  })
  const services = makeServices(state)
  const { provider } = providerFor(services)
  assert.deepEqual(await provider.listHosts(), [
    { deviceId: 'device-1', name: 'Desktop-ZgblKylin', platform: 'linux', online: true, version: '0.1.0' },
    { deviceId: 'device-2', name: 'device-2', platform: 'win32' },
  ], 'hosts are mapped and rows without a device id are dropped')

  const discovery = await provider.discoverWorkspaces('device-1')
  assert.deepEqual(discovery.workspaces, [
    { workspaceId: 'ws-1', path: '/src/app', title: 'app', backend: 'harness' },
  ], 'only harness workspaces are offered; malformed rows are dropped')
  assert.deepEqual(discovery.unavailable, [{ backend: 'cursor', code: 'BACKEND_UNAVAILABLE' }], 'unavailable backends are reported')

  state.mode = 'remote'
  await assert.rejects(
    () => provider.discoverWorkspaces('device-1'),
    new RegExp(mod.REMOTE_MODE_WORKSPACE_ERROR, 'u'),
    'workspace discovery is refused while the UI holds a remote control connection',
  )
}
{
  const state = behavior({ discoveryError: new Error('network down') })
  const { client } = makeServices(state)
  const { provider } = providerFor({ client })
  await assert.rejects(() => provider.listHosts(), /network down/u, 'a discovery failure is surfaced')
}
{
  const { provider } = providerFor({})
  await assert.rejects(() => provider.listHosts(), new RegExp(mod.DS_HARNESS_REMOTE_UNAVAILABLE, 'u'), 'a missing plugin reports the unavailable text')
  await assert.rejects(() => provider.discoverWorkspaces('device-1'), new RegExp(mod.DS_HARNESS_REMOTE_UNAVAILABLE, 'u'))
}

// ---------------------------------------------------------------- optional peer
{
  const fixture = makeFixture()
  const peerPath = mod.ensureRemotePluginPeer({
    parentProfileDir: fixture.parentProfile,
    runtimeDir: fixture.runtimeDir,
    env: {},
  })
  assert.equal(peerPath, join(fixture.parentProfile, 'node_modules', '@deepseek-ai', 'dsh-client-connection'), 'the peer is linked into the parent profile')
  assert.ok(peerPath !== undefined, 'the peer path is returned')
  const again = mod.ensureRemotePluginPeer({ parentProfileDir: fixture.parentProfile, runtimeDir: fixture.runtimeDir, env: {} })
  assert.equal(again, peerPath, 'a second repair reuses the existing link')
  cleanup(fixture)
}
{
  const fixture = makeFixture({ withPeer: false })
  assert.throws(() => mod.ensureRemotePluginPeer({
    parentProfileDir: fixture.parentProfile,
    runtimeDir: fixture.runtimeDir,
    env: {},
  }), /dsh-client-connection/u, 'a runtime without the peer reports an actionable error')
  cleanup(fixture)
}

// ---------------------------------------------------------------- storage scope
{
  const clientDir = mod.serverStorageDirectory('/root', SERVER_URL, 'client')
  const hostDir = mod.serverStorageDirectory('/root', SERVER_URL, 'host')
  assert.equal(
    hostDir.replace(/[\\/]host$/u, ''),
    clientDir.replace(/[\\/]client$/u, ''),
    'host and client roles share one per-server scope directory',
  )
}

rmSync(root, { recursive: true, force: true })
console.log('remote-tab provider tests passed')
