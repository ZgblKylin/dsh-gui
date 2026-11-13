/**
 * Child identity for remote tabs, reflected from the running remote plugin.
 *
 * A child `dsh web` authenticates to the Remote server as its own device, so
 * every saved connection mints one owned Client device from the desktop's
 * Remote Host identity. The classes that do this (`IdentityStore`,
 * `ClientServerApi`, `ServerCredentialStore`) live in the installed
 * `ds-harness-remote` package, whose `dist/index.js` imports
 * `@deepseek-ai/dsh-client-connection` — a module that only exists inside the
 * desktop asar runtime and therefore cannot be resolved from an in-tree plugin
 * by specifier or by absolute path. This module therefore never imports the
 * package: it reflects the constructors off the already-loaded Cordis service
 * instances.
 *
 * The shape relied on (verified against ds-harness-remote 0.6.3, whose compiled
 * classes keep plain fields):
 *
 * - `ctx.get('dshRemoteClient', false)` → `ClientModeRuntime`, carrying
 *   `.server` (a bound `ClientServerApi`) and `.identities` (`IdentityStore`).
 * - `.server.store` is the `ServerCredentialStore` bound to the parent client
 *   directory; `.server.baseUrl` is the normalized server URL.
 * - `ctx.get('dshRemote', false)` → `HostPluginRuntime`, carrying `.serverApi`
 *   (a `HostServerApi`) and `currentIdentity()`.
 *
 * The child storage directory is derived exactly as `serverStorageDirectory`
 * does (sha256 of the server origin, first 24 hex chars), so the child lives
 * beside the parent's `remote/servers/<scope>/client` under its own home.
 *
 * No token is ever logged or returned from this module.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { RemoteLogger } from '../remote/types.ts'
import type { RemoteTabIdentity } from './types.ts'

/** Services this module reflects; either may be absent when the plugin is off. */
export interface RemoteTabIdentityServices {
  readonly client?: unknown
  readonly host?: unknown
}

/** Options of one child identity resolution. */
export interface EnsureRemoteTabIdentityOptions extends RemoteTabIdentityServices {
  /** The child's own Harness home. */
  readonly childHome: string
  /** Device name to create/reuse (see `remoteDeviceName`). */
  readonly deviceName: string
  readonly logger?: RemoteLogger
}

/** Options of one child identity revocation. */
export interface RevokeRemoteTabIdentityOptions extends RemoteTabIdentityServices {
  readonly childHome: string
  readonly logger?: RemoteLogger
}

/** The reflected constructors and parent facts one call needs. */
interface Reflection {
  readonly IdentityStore: Constructor
  readonly ClientServerApi: Constructor
  readonly CredentialStore: Constructor
  readonly serverUrl: string
}

/** The child's persisted identity fields this module reads. */
interface RawIdentity {
  readonly deviceId: string
  readonly name: string
}

/** The child's persisted credentials, of which only the account is read here. */
interface RawCredentials {
  readonly account?: string
}

/** A service instance plus its classes; the parent API is only used for its token. */
interface HostReflection {
  readonly hostApi: HostApiLike
  readonly hostIdentity: unknown
}

/** The host server API subset this module drives. */
interface HostApiLike {
  readonly baseUrl?: string
  authenticate(identity?: unknown): Promise<RawCredentials & { readonly accessToken: string }>
}

/** The child server API subset this module drives. */
interface ChildApiLike {
  bindIdentity(identity: unknown): void
  hasStoredAuthorization(): Promise<boolean>
  authorizeOwnedRole(identity: unknown, authorizingAccessToken: string, account?: string): Promise<unknown>
  authenticate(identity?: unknown): Promise<RawCredentials>
  revokeCurrentDevice(): Promise<void>
}

/** The identity store subset this module drives. */
interface IdentityStoreLike {
  loadOrCreate(deviceName: string): Promise<RawIdentity>
  reset(deviceName: string): Promise<RawIdentity>
}

/** A reflected class constructor; the runtime shapes are checked structurally. */
type Constructor = new (...args: unknown[]) => unknown

/** Credential-storage directory beside one Harness home, as the plugin computes it. */
export function serverStorageDirectory(root: string, serverUrl: string, role: 'host' | 'client'): string {
  const origin = new URL(serverUrl).origin
  const scope = createHash('sha256').update(origin).digest('hex').slice(0, 24)
  return join(root, 'servers', scope, role)
}

/**
 * Resolve, mint, or reuse the child Client identity of one remote tab.
 *
 * The first attempt reuses existing child credentials (refreshing the access
 * token as needed); when none exist it mints an owned Client device from a
 * fresh Host token. A terminal rejection (`DEVICE_REVOKED` / `AUTH_INVALID` and
 * the credential-unusable siblings) resets the child identity once and mints
 * again, which is the documented recovery path for a device removed on the
 * server.
 * @param options - reflected services, child paths and device name.
 * @returns the child identity facts; tokens stay internal.
 * @throws Error with an actionable Chinese message when the parent is not authorized.
 */
export async function ensureRemoteTabIdentity(options: EnsureRemoteTabIdentityOptions): Promise<RemoteTabIdentity> {
  const host = reflectHost(options.host)
  const reflection = reflectClient(options.client, host.hostApi.baseUrl)
  const childDir = serverStorageDirectory(join(options.childHome, 'remote'), reflection.serverUrl, 'client')
  const identityStore = new reflection.IdentityStore({ directory: childDir }) as unknown as IdentityStoreLike
  let childIdentity = await identityStore.loadOrCreate(options.deviceName)
  const childApi = new reflection.ClientServerApi(
    reflection.serverUrl,
    new reflection.CredentialStore(childDir),
  ) as unknown as ChildApiLike
  childApi.bindIdentity(childIdentity)

  // A fresh Host token is what authorizes minting; `authenticate` runs the
  // plugin's cross-process refresh lock and never touches the child's store.
  const hostCredentials = await host.hostApi.authenticate(host.hostIdentity)

  let authorization: NonNullable<RemoteTabIdentity['authorization']> = 'reused'
  try {
    if (!(await childApi.hasStoredAuthorization())) {
      await childApi.authorizeOwnedRole(childIdentity, hostCredentials.accessToken, hostCredentials.account)
      authorization = 'minted'
    }
    await childApi.authenticate(childIdentity)
  } catch (error: unknown) {
    if (!isIdentityRejected(error)) throw error
    options.logger?.info(`[dsh-desktop-tabs] remote-tab child identity was rejected (${errorCode(error)}); resetting and minting a new one`)
    childIdentity = await identityStore.reset(options.deviceName)
    childApi.bindIdentity(childIdentity)
    await childApi.authorizeOwnedRole(childIdentity, hostCredentials.accessToken, hostCredentials.account)
    await childApi.authenticate(childIdentity)
    authorization = 'recovered'
  }

  options.logger?.info(`[dsh-desktop-tabs] remote-tab child identity ready (${authorization}, device ${shortId(childIdentity.deviceId)})`)
  return {
    serverUrl: reflection.serverUrl,
    childHome: options.childHome,
    childDir,
    deviceId: childIdentity.deviceId,
    authorization,
  }
}

/**
 * Revoke the child device of one remote connection.
 *
 * Best-effort by design: a connection whose child was never minted is a no-op,
 * and a child directory without an identity is left alone. The caller removes
 * the child home afterwards.
 * @param options - reflected services and child home.
 * @throws Error when the parent client runtime is unavailable or revocation fails.
 */
export async function revokeRemoteTabIdentity(options: RevokeRemoteTabIdentityOptions): Promise<void> {
  const reflection = reflectClient(options.client, undefined)
  const childDir = serverStorageDirectory(join(options.childHome, 'remote'), reflection.serverUrl, 'client')
  if (!existsSync(join(childDir, 'device.json'))) return
  const identityStore = new reflection.IdentityStore({ directory: childDir }) as unknown as IdentityStoreLike
  const identity = await identityStore.loadOrCreate('远程标签')
  const childApi = new reflection.ClientServerApi(
    reflection.serverUrl,
    new reflection.CredentialStore(childDir),
  ) as unknown as ChildApiLike
  childApi.bindIdentity(identity)
  await childApi.revokeCurrentDevice()
  options.logger?.info(`[dsh-desktop-tabs] remote-tab child device ${shortId(identity.deviceId)} revoked`)
}

/** Reflect the Host runtime's server API and identity, or explain what is missing. */
function reflectHost(host: unknown): HostReflection {
  const record = asRecord(host)
  const hostApi = record?.serverApi
  if (record === undefined || !isRecord(hostApi) || typeof hostApi.authenticate !== 'function') {
    throw new Error('请先在 Remote 面板登录并启用主机授权：桌面 Host 授权不可用（ds-harness-remote 未启用 hostControl 或尚未登录）')
  }
  let hostIdentity: unknown
  if (typeof record.currentIdentity === 'function') {
    hostIdentity = (record.currentIdentity as () => unknown)()
  } else {
    hostIdentity = record.identity
  }
  if (hostIdentity === undefined || hostIdentity === null) {
    throw new Error('请先在 Remote 面板登录并启用主机授权：Host 身份尚未就绪')
  }
  return { hostApi: hostApi as unknown as HostApiLike, hostIdentity }
}

/** Reflect the Client runtime's classes and server URL, or explain what is missing. */
function reflectClient(client: unknown, fallbackServerUrl: string | undefined): Reflection {
  const record = asRecord(client)
  if (record === undefined) {
    throw new Error('ds-harness-remote 不可用：请在 Remote 面板启用以开启远程标签')
  }
  const server = record.server
  const identities = record.identities
  if (!isRecord(server) || !isRecord(identities)) {
    throw new Error('ds-harness-remote 运行时结构不受支持（缺少 client.server / client.identities）')
  }
  const IdentityStore = constructorOf(identities, 'IdentityStore')
  const ClientServerApi = constructorOf(server, 'ClientServerApi')
  const credentialStore = server.store
  const CredentialStore = credentialStore === undefined
    ? undefined
    : constructorOf(credentialStore, 'ServerCredentialStore')
  if (CredentialStore === undefined) {
    throw new Error('ds-harness-remote 运行时结构不受支持（缺少 client.server.store）')
  }
  const serverUrl = nonEmptyString(server.baseUrl) ?? nonEmptyString(fallbackServerUrl)
  if (serverUrl === undefined) {
    throw new Error('无法确定 ds-harness-remote 服务器地址：请先在 Remote 面板登录')
  }
  return { IdentityStore, ClientServerApi, CredentialStore, serverUrl }
}

/** The constructor of a class instance, or a clear error when the shape is unexpected. */
function constructorOf(instance: Record<string, unknown>, label: string): Constructor {
  const ctor = instance.constructor
  if (typeof ctor !== 'function') {
    throw new Error(`ds-harness-remote 运行时结构不受支持（${label} 不是类实例）`)
  }
  return ctor as Constructor
}

/** Whether a remote server rejected the child credentials terminally. */
function isIdentityRejected(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'DEVICE_REVOKED'
    || code === 'AUTH_INVALID'
    || code === 'ACCOUNT_AUTH_REQUIRED'
    || code === 'SERVER_CREDENTIALS_INVALID'
    || code === 'TOKEN_EXPIRED'
}

/** The stable `code` of a plugin error, when it carries one. */
function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return 'UNKNOWN'
}

/** First eight characters of a device id, for logs. */
function shortId(deviceId: string): string {
  return deviceId.slice(0, 8)
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
