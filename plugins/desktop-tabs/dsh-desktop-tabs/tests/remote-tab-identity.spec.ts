/**
 * Tests of the remote-tab child identity resolution, run against the built
 * package (`../lib/index.js`).
 *
 * The real `ds-harness-remote` package cannot be imported here (its dist imports
 * a module that only exists in the desktop asar runtime), so — exactly like the
 * production code — these tests reflect fake classes off fake Cordis service
 * instances: `client.server.constructor`, `client.server.store.constructor`,
 * `client.identities.constructor`, and `host.serverApi`. The fake classes
 * simulate the server-side mint/refresh/revoke calls in memory.
 *
 * Usage (from the package directory): node tests/remote-tab-identity.spec.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)

const SERVER_URL = 'https://dsh.example.test'

/** One fake device identity, matching the fields the module reads. */
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
  readonly hostAuthentications: number
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
  return {
    client: { server, identities },
    host: { serverApi: hostApi, currentIdentity: () => ({ deviceId: 'host-device', name: 'host' }) },
  }
}

/** A plugin error carrying the stable code the module inspects. */
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

const root = mkdtempSync(join(tmpdir(), 'dsh-remote-tab-identity-'))
const childHome = join(root, 'home')
mkdirSync(childHome, { recursive: true })

// ---------------------------------------------------------------- mint path
{
  const behavior: FakeBehavior = {
    hasStoredAuthorization: false,
    mints: [],
    revoked: [],
    hostAuthentications: 0,
  }
  const { client, host } = makeServices(behavior)
  const { logs, logger } = makeLogger()
  const identity = await mod.ensureRemoteTabIdentity({
    client,
    host,
    childHome,
    deviceName: 'Desktop-ZgblKylin · archlinux · 远程标签',
    logger,
  })
  assert.equal(identity.serverUrl, SERVER_URL, 'the server URL comes from the reflected auth endpoints')
  assert.equal(identity.authorization, 'minted', 'a child without credentials is minted')
  assert.equal(behavior.mints.length, 1, 'one owned-role registration happens')
  assert.equal(behavior.mints[0].accessToken, 'host-access-token', 'minting authorizes with the fresh host token')
  assert.equal(behavior.mints[0].account, 'owner@example.test', 'the host account rides along')
  assert.equal(behavior.hostAuthentications, 1, 'the host token is refreshed exactly once')
  assert.ok(identity.deviceId.length > 0, 'the minted device id is returned')

  const expectedChildDir = mod.serverStorageDirectory(join(childHome, 'remote'), SERVER_URL, 'client')
  assert.equal(identity.childDir, expectedChildDir, 'the child lives in the plugin-computed storage directory')
  const clientDir = mod.serverStorageDirectory('/root', SERVER_URL, 'client')
  const hostDir = mod.serverStorageDirectory('/root', SERVER_URL, 'host')
  assert.equal(
    hostDir.replace(/[\\/]host$/u, ''),
    clientDir.replace(/[\\/]client$/u, ''),
    'host and client roles share one per-server scope directory',
  )

  const flat = logs.join('\n')
  assert.ok(!flat.includes('host-access-token'), 'the host token never reaches the log')
  assert.ok(!flat.includes('child-access-token'), 'the child token never reaches the log')
}

// ---------------------------------------------------------------- reuse path
{
  const behavior: FakeBehavior = {
    hasStoredAuthorization: true,
    storedCredentials: () => ({ accessToken: 'stored-token', account: 'owner@example.test' }),
    mints: [],
    revoked: [],
    hostAuthentications: 0,
  }
  const { client, host } = makeServices(behavior)
  const identity = await mod.ensureRemoteTabIdentity({ client, host, childHome: join(root, 'reuse'), deviceName: 'reuse' })
  assert.equal(identity.authorization, 'reused', 'existing child credentials are reused')
  assert.equal(behavior.mints.length, 0, 'reuse never registers a new device')
}

// ---------------------------------------------------------------- recovery path
{
  const behavior: FakeBehavior = {
    hasStoredAuthorization: true,
    storedCredentials: () => ({ accessToken: 'stale-token' }),
    authenticateError: codeError('DEVICE_REVOKED'),
    mints: [],
    revoked: [],
    hostAuthentications: 0,
  }
  const { client, host } = makeServices(behavior)
  const { logs, logger } = makeLogger()
  const identity = await mod.ensureRemoteTabIdentity({ client, host, childHome: join(root, 'recover'), deviceName: 'recover', logger })
  assert.equal(identity.authorization, 'recovered', 'a revoked child device is reset once and re-minted')
  assert.equal(behavior.mints.length, 1, 'the recovery mints exactly one new device')
  assert.ok(behavior.mints[0].identity.deviceId !== '00000000-0000-4000-8000-000000000000', 'the minted identity is the reset one')
  assert.ok(logs.some((line) => line.includes('DEVICE_REVOKED')), 'the recovery reason is logged')
}

// ---------------------------------------------------------------- auth failure path
{
  const behavior: FakeBehavior = {
    hasStoredAuthorization: true,
    authenticateError: codeError('NETWORK_ERROR'),
    mints: [],
    revoked: [],
    hostAuthentications: 0,
  }
  const { client, host } = makeServices(behavior)
  await assert.rejects(
    () => mod.ensureRemoteTabIdentity({ client, host, childHome: join(root, 'network'), deviceName: 'network' }),
    /NETWORK_ERROR|rejected with/u,
    'a non-identity failure is surfaced instead of resetting the device',
  )
}

// ---------------------------------------------------------------- missing services
{
  await assert.rejects(
    () => mod.ensureRemoteTabIdentity({ childHome, deviceName: 'no-remote' }),
    /Remote 面板登录并启用主机授权/u,
    'a missing remote plugin explains where to enable it',
  )
  const behavior: FakeBehavior = { hasStoredAuthorization: false, mints: [], revoked: [], hostAuthentications: 0 }
  const { client } = makeServices(behavior)
  await assert.rejects(
    () => mod.ensureRemoteTabIdentity({ client, childHome, deviceName: 'no-host' }),
    /Remote 面板登录并启用主机授权/u,
    'a host runtime without hostControl explains where to enable it',
  )
}

// ---------------------------------------------------------------- revocation
{
  const behavior: FakeBehavior = { hasStoredAuthorization: true, mints: [], revoked: [], hostAuthentications: 0 }
  const { client } = makeServices(behavior)
  const revokeHome = join(root, 'revoke-home')
  mkdirSync(revokeHome, { recursive: true })
  const childDir = mod.serverStorageDirectory(join(revokeHome, 'remote'), SERVER_URL, 'client')
  mkdirSync(childDir, { recursive: true })
  writeFileSync(join(childDir, 'device.json'), '{}')
  await mod.revokeRemoteTabIdentity({ client, childHome: revokeHome })
  assert.equal(behavior.revoked.length, 1, 'the child device is revoked once')

  // A child that was never minted is a no-op, even with the fake services.
  const emptyHome = join(root, 'empty-home')
  mkdirSync(emptyHome, { recursive: true })
  await mod.revokeRemoteTabIdentity({ client, childHome: emptyHome })
  assert.equal(behavior.revoked.length, 1, 'an unminted child is a no-op')
}

rmSync(root, { recursive: true, force: true })
console.log('remote-tab identity tests passed')
