/**
 * The `ds-harness-remote` provider: everything the remote-tab feature needs from
 * that particular backend plugin.
 *
 * The generic core (`../profile.ts`, `../supervisor.ts`, `../routes.ts`) never
 * names a backend plugin. This module supplies the plugin-specific pieces:
 *
 * - the child-profile patch that pins the plugin in client mode;
 * - the `dsh-remote-tab-boot` bundle that opens the remote workspace;
 * - the child home files the plugin's UI expects (pet config/state);
 * - the owned child Client device: mint/reuse/revoke;
 * - host and workspace discovery for the connection panel;
 * - the optional-peer repair that lets the child import the plugin at all.
 *
 * The plugin package itself is never imported. Its classes are reflected off
 * the already-loaded Cordis services, because `ds-harness-remote`'s `dist`
 * imports `@deepseek-ai/dsh-client-connection`, which only resolves inside the
 * hosting runtime; importing it by specifier or absolute path from in-tree code
 * fails. The shape relied on (verified against ds-harness-remote 0.6.3, whose
 * compiled classes keep plain fields):
 *
 * - `ctx.get('dshRemoteClient', false)` → `ClientModeRuntime`, carrying
 *   `.server` (a bound `ClientServerApi`), `.server.store` (the bound
 *   `ServerCredentialStore`), and `.identities` (`IdentityStore`);
 * - `ctx.get('dshRemote', false)` → `HostPluginRuntime`, carrying `.serverApi`
 *   (a `HostServerApi`) and `currentIdentity()`.
 *
 * When those services are absent the provider reports the feature unavailable;
 * the tab list and the SSH/WSL connections are unaffected.
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { RemoteLogger } from '../../remote/types.ts'
import type {
  RemoteHost,
  RemoteTabHomeFile,
  RemoteTabIdentity,
  RemoteTabParentPreparation,
  RemoteTabProvider,
  RemoteWorkspace,
  RemoteWorkspaceDiscovery,
  RemoteWorkspaceUnavailable,
} from '../types.ts'

/** Plugin package name of the backend this provider drives. */
export const DS_HARNESS_REMOTE_ID = 'ds-harness-remote'

/** Human-readable provider name used in Chinese messages. */
export const DS_HARNESS_REMOTE_LABEL = 'ds-harness-remote'

/** Child-profile bundle that opens the remote workspace and prints the ready sentinel. */
export const DS_HARNESS_REMOTE_BOOT_BUNDLE = 'dsh-remote-tab-boot'

/** Answer used when the backend plugin's runtime services are absent. */
export const DS_HARNESS_REMOTE_UNAVAILABLE = 'ds-harness-remote is not installed/enabled'

/** Answer used while the parent UI itself holds a remote control connection. */
export const REMOTE_MODE_WORKSPACE_ERROR = '主界面处于远程模式，请先在 Remote 面板退出后再浏览工作区'

/** Parent home files the child's local UI keeps outside `settings.yaml`. */
const PARENT_HOME_FILES: readonly RemoteTabHomeFile[] = [
  { source: 'settings.yaml', target: 'settings.yaml' },
  { source: join('dsh-pet', 'main-config.jsonc'), target: join('dsh-pet', 'main-config.jsonc') },
  { source: 'pet.json', target: 'pet.json' },
]

/** Options of one provider instance. */
export interface DsHarnessRemoteProviderOptions {
  /** `ctx.get('dshRemoteClient', false)`, read at call time. */
  readonly getClient: () => unknown
  /** `ctx.get('dshRemote', false)`, read at call time. */
  readonly getHost: () => unknown
  readonly logger?: RemoteLogger
  /** Environment used for optional-peer repair; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Explicit `@deepseek-ai/dsh-client-connection` source, for tests. */
  readonly peerSourceDir?: string
}

/**
 * Create the `ds-harness-remote` provider.
 * @param options - service getters, logger, and environment.
 * @returns the provider the generic core drives.
 */
export function createDsHarnessRemoteProvider(options: DsHarnessRemoteProviderOptions): RemoteTabProvider {
  return {
    id: DS_HARNESS_REMOTE_ID,
    label: DS_HARNESS_REMOTE_LABEL,
    bundles: [DS_HARNESS_REMOTE_BOOT_BUNDLE],
    requiredBundles: [DS_HARNESS_REMOTE_ID],
    readyBundle: DS_HARNESS_REMOTE_BOOT_BUNDLE,
    homeFiles: PARENT_HOME_FILES,
    prepareParent: (args: RemoteTabParentPreparation) => {
      ensureRemotePluginPeer({
        parentProfileDir: args.parentProfileDir,
        ...(args.runtimeDir === undefined ? {} : { runtimeDir: args.runtimeDir }),
        ...(options.peerSourceDir === undefined ? {} : { peerSourceDir: options.peerSourceDir }),
        ...(args.env === undefined ? {} : { env: args.env }),
      })
    },
    renderPatch: ({ serverUrl }: { readonly serverUrl: string }) => clientConfigPatch(serverUrl),
    ensureIdentity: async (args: { readonly childHome: string; readonly deviceName: string }) => {
      const identity = await ensureRemoteTabIdentity({
        client: options.getClient(),
        host: options.getHost(),
        childHome: args.childHome,
        deviceName: args.deviceName,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      })
      return identity
    },
    revokeIdentity: async (args: { readonly childHome: string }) => {
      await revokeRemoteTabIdentity({
        client: options.getClient(),
        childHome: args.childHome,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      })
    },
    listHosts: async (signal?: AbortSignal) => {
      const client = asClientRuntime(options.getClient())
      if (client === undefined) throw new Error(DS_HARNESS_REMOTE_UNAVAILABLE)
      const devices = await client.devices(signal)
      return devices.map(hostOf).filter((host): host is RemoteHost => host !== undefined)
    },
    discoverWorkspaces: async (targetDeviceId: string, signal?: AbortSignal) => {
      const client = asClientRuntime(options.getClient())
      if (client === undefined) throw new Error(DS_HARNESS_REMOTE_UNAVAILABLE)
      // Opening a tool carrier while the UI already holds the control connection
      // would replace the warm connection on the server, so it is refused here.
      if (client.status()?.mode === 'remote') throw new Error(REMOTE_MODE_WORKSPACE_ERROR)
      const result = await client.discoverToolWorkspaces(targetDeviceId, signal)
      return mapWorkspaceDiscovery(result)
    },
  }
}

/**
 * Ensure the parent profile can resolve the optional peer of the backend plugin.
 *
 * The packaged plugin imports `@deepseek-ai/dsh-client-connection` at module
 * load, but a profile `pnpm install` does not hoist that optional peer. The
 * immutable runtime carries the package, so linking it into the parent profile
 * makes the child's import deterministic. The child's ESM loader also resolves
 * that scope from the runtime first; the link is the fallback for a runtime
 * layout that ships the package under a different location.
 * @param options - parent profile and runtime locations.
 * @returns the peer path when it exists (created or already present), or undefined.
 * @throws Error when no runtime copy of the peer package can be found.
 */
export function ensureRemotePluginPeer(options: {
  readonly parentProfileDir: string
  readonly runtimeDir?: string
  readonly peerSourceDir?: string
  readonly env?: NodeJS.ProcessEnv
}): string | undefined {
  const env = options.env ?? process.env
  const peerPath = join(options.parentProfileDir, 'node_modules', '@deepseek-ai', 'dsh-client-connection')
  if (isDirectory(peerPath)) return peerPath
  const repoRoot = env.DSH_GUI_ROOT?.trim()
  const candidates: Array<string | undefined> = [
    options.peerSourceDir,
    ...(options.runtimeDir === undefined
      ? []
      : [join(options.runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-client-connection')]),
    ...(repoRoot === undefined
      ? []
      : [join(repoRoot, 'deepseek-harness', 'node_modules', '@deepseek-ai', 'dsh-client-connection')]),
  ]
  const source = candidates.find((candidate): candidate is string => candidate !== undefined && isDirectory(candidate))
  if (source === undefined) {
    throw new Error(
      '缺少 @deepseek-ai/dsh-client-connection（ds-harness-remote 的 peer）：运行时与源码树中都没有找到，'
      + `无法让子后端加载远程插件；请检查 dsh 运行时安装完整，或手动把它链接到 ${peerPath}`,
    )
  }
  mkdirSync(dirname(peerPath), { recursive: true })
  linkDirectory(source, peerPath)
  return peerPath
}

/**
 * The child profile's `ds-harness-remote` patch layer.
 *
 * `role: client` plus `hostControl.enabled: false` keeps a child from ever
 * registering itself as a host or opening a host connection; the interactive
 * features the embedded page does not need are disabled.
 * @param serverUrl - remote server the child's client connects to.
 * @returns the patch text.
 */
export function clientConfigPatch(serverUrl: string): string {
  return [
    '# Generated by dsh-desktop-tabs: remote-tab child client mode.',
    '- id: ds-harness-remote',
    '  name: ds-harness-remote',
    '  config:',
    '    enabled: true',
    '    role: client',
    `    serverUrl: ${JSON.stringify(serverUrl)}`,
    '    hostControl:',
    '      enabled: false',
    '    terminal:',
    '      enabled: false',
    '    remoteTools:',
    '      enabled: false',
    '    codex:',
    '      enabled: false',
    '    acp:',
    '      enabled: false',
    '',
  ].join('\n')
}

/**
 * One credential-storage directory beside a Harness home, exactly as the plugin
 * computes it (`serverStorageDirectory`).
 * @param root - Harness home whose `remote/` holds the server scopes.
 * @param serverUrl - remote server URL.
 * @param role - device role directory.
 * @returns the role directory path.
 */
export function serverStorageDirectory(root: string, serverUrl: string, role: 'host' | 'client'): string {
  const origin = new URL(serverUrl).origin
  const scope = createHash('sha256').update(origin).digest('hex').slice(0, 24)
  return join(root, 'servers', scope, role)
}

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

/** The reflected constructors and parent facts one identity call needs. */
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

/** The client runtime subset the discovery calls drive. */
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

/**
 * Map the plugin's tool-workspace discovery onto the panel shapes, keeping only
 * Harness workspaces: this release cannot open Codex/ACP/Cursor workspaces, and
 * listing them would offer a choice that fails on open.
 */
function mapWorkspaceDiscovery(result: {
  readonly workspaces?: readonly unknown[]
  readonly unavailable?: readonly unknown[]
}): RemoteWorkspaceDiscovery {
  const workspaces = (result.workspaces ?? []).flatMap((raw): RemoteWorkspace[] => {
    const row = asRecord(raw)
    const workspaceId = nonEmptyString(row?.workspaceId)
    const path = nonEmptyString(row?.path)
    if (row === undefined || workspaceId === undefined || path === undefined) return []
    const title = nonEmptyString(row.title) ?? path
    const backend = nonEmptyString(row.backend)
    if (backend !== undefined && backend !== 'harness') return []
    return [{ workspaceId, path, title, ...(backend === undefined ? {} : { backend }) }]
  })
  const unavailable = (result.unavailable ?? []).flatMap((raw): RemoteWorkspaceUnavailable[] => {
    const row = asRecord(raw)
    const backend = nonEmptyString(row?.backend)
    const code = nonEmptyString(row?.code)
    return backend === undefined || code === undefined ? [] : [{ backend, code }]
  })
  return { workspaces, unavailable }
}

/** Reflect the Host runtime's server API and identity, or explain what is missing. */
function reflectHost(host: unknown): HostReflection {
  const record = asRecord(host)
  const hostApi = record?.serverApi
  if (record === undefined || !isRecord(hostApi) || typeof hostApi.authenticate !== 'function') {
    throw new Error('请先在 Remote 面板登录并启用主机授权：宿主授权不可用（ds-harness-remote 未启用 hostControl 或尚未登录）')
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
    throw new Error(`${DS_HARNESS_REMOTE_UNAVAILABLE}：请在 Remote 面板启用以开启远程标签`)
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

/** Create a directory link (a junction on Windows) to one package directory. */
function linkDirectory(target: string, link: string): void {
  let existing: ReturnType<typeof lstatSync> | undefined
  try {
    existing = lstatSync(link)
  } catch {
    existing = undefined
  }
  if (existing !== undefined) {
    if (existing.isSymbolicLink() || existing.isDirectory()) return
    rmSync(link, { recursive: true, force: true })
  }
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
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

/** Whether the path names an existing directory. */
function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}
