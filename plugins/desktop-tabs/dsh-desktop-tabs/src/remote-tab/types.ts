/**
 * Public types of the remote-tab host module.
 *
 * A remote tab is one saved connection to a remote Harness workspace: one child
 * `dsh` process per connection runs under its own `DSH_HOME`, opens the remote
 * workspace, and is embedded as a webview tab. This module owns everything
 * between a persisted row's `remote` descriptor and a loadable
 * `http://127.0.0.1:<port>/?token=...` URL: `./profile.ts` generates the child
 * profile from the parent composition, `./loader.ts` generates the child's ESM
 * resolver, `./supervisor.ts` owns the child process, `./routes.ts` serves the
 * panel's discovery routes and the shared connection routes, and a
 * {@link RemoteTabProvider} supplies the backend-specific half.
 *
 * The token in a returned URL never enters a log line or an error message.
 */

import type { RemoteConnectionStatus } from '../remote/types.ts'

/** The `remote` descriptor persisted on a tab or a saved connection row. */
export interface RemoteConnectionSpec {
  /** The Remote host device the child connects to. */
  readonly targetDeviceId: string
  /** Display name of that host, for logs and the connection title. */
  readonly targetName?: string
  /** Remote working directory the child opens. */
  readonly workspacePath: string
  /** Only the harness backend is implemented in this release. */
  readonly backend?: 'harness'
}

/** One discoverable Remote host device. */
export interface RemoteHost {
  readonly deviceId: string
  readonly name: string
  readonly platform?: string
  readonly online?: boolean
  readonly version?: string
}

/** One remote workspace the selected host advertises. */
export interface RemoteWorkspace {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly backend?: string
}

/** Lifecycle of one remote tab's child backend, as the client panel displays it. */
export interface RemoteTabStatus {
  readonly id: string
  readonly state: 'idle' | 'connecting' | 'up' | 'error'
  /** Present only in state `up`; carries the child launch token. */
  readonly url?: string
  /** Present only in state `error`. */
  readonly error?: string
  /** Bounded, token-free progress log of the last attempt. */
  readonly log?: string[]
}

/**
 * One row resolved to a child launch: the saved row's id and title plus the
 * `remote` descriptor of the tab or saved connection behind it.
 */
export interface RemoteTabRequest {
  readonly id: string
  readonly title: string
  readonly remote: RemoteConnectionSpec
}

/**
 * Facts about the minted child identity. The child's access and refresh tokens
 * stay inside the provider module; the profile only needs the server URL, and
 * revocation only needs the directory.
 */
export interface RemoteTabIdentity {
  readonly serverUrl: string
  readonly childHome: string
  readonly childDir: string
  readonly deviceId: string
  /** How this call obtained the child credentials; for diagnostics only. */
  readonly authorization?: 'reused' | 'minted' | 'recovered'
}

/** One parent file copied once into the child home; both paths are home-relative. */
export interface RemoteTabHomeFile {
  /** Path relative to the parent Harness home. */
  readonly source: string
  /** Path relative to the child Harness home. */
  readonly target: string
}

/** Backends whose workspace catalog could not be read while discovering. */
export interface RemoteWorkspaceUnavailable {
  readonly backend: string
  readonly code: string
}

/** One host's workspace discovery result. */
export interface RemoteWorkspaceDiscovery {
  readonly workspaces: readonly RemoteWorkspace[]
  readonly unavailable: readonly RemoteWorkspaceUnavailable[]
}

/** Parent-profile facts a provider may need before a child profile is written. */
export interface RemoteTabParentPreparation {
  readonly parentProfileDir: string
  readonly parentDshHome: string
  readonly runtimeDir?: string
  readonly env?: NodeJS.ProcessEnv
}

/**
 * One remote-backend provider: everything the remote-tab feature needs that is
 * specific to a backend plugin.
 *
 * The generic core (`./profile.ts`, `./supervisor.ts`, `./routes.ts`) never
 * names a backend plugin; it asks the provider for its bundle additions, patch
 * layer, home files, child identity, and discovery calls. `desktop-tabs` loads
 * without the backend plugin at all: the reflection-based provider reports the
 * feature unavailable while the tab list and the SSH/WSL connections keep
 * working.
 */
export interface RemoteTabProvider {
  /** Stable provider id, for logs and error text (the backend plugin package name). */
  readonly id: string
  /** Human-readable name used in Chinese error messages. */
  readonly label: string
  /** Child-profile bundles the provider appends to the parent composition. */
  readonly bundles: readonly string[]
  /** Bundles that must resolve for the provider to work at all. */
  readonly requiredBundles: readonly string[]
  /** Bundle that opens the workspace and prints the readiness sentinel. */
  readonly readyBundle?: string
  /** Parent files copied into the child home on first creation. */
  readonly homeFiles: readonly RemoteTabHomeFile[]
  /** Set up the parent profile before the child boots (optional peer links etc.). */
  prepareParent?(args: RemoteTabParentPreparation): void
  /** Patch layer appended after the parent profile's own patch copy. */
  renderPatch(args: { readonly serverUrl: string }): string
  /** Mint or reuse the child identity; tokens stay inside the provider. */
  ensureIdentity(args: { readonly childHome: string; readonly deviceName: string }): Promise<RemoteTabIdentity>
  /** Revoke the child identity, best-effort. */
  revokeIdentity(args: { readonly childHome: string }): Promise<void>
  /** Discover the backend's remote hosts. */
  listHosts(signal?: AbortSignal): Promise<readonly RemoteHost[]>
  /** Discover one host's workspaces. */
  discoverWorkspaces(targetDeviceId: string, signal?: AbortSignal): Promise<RemoteWorkspaceDiscovery>
}

/**
 * The remote-tab manager as `../remote/index.ts` drives it: one status list
 * merged into `GET /connections`, and the same `up`/`down`/`forget` actions a
 * saved row can trigger.
 */
export interface RemoteTabBridge {
  /** One row per remote tab record plus every configured remote connection. */
  status(): RemoteConnectionStatus[]
  /** The remote request behind a tab or saved-connection id, or undefined. */
  connectionFor(id: string): RemoteTabRequest | undefined
  /** Start or reuse the child backend and answer its loadable URL. */
  up(request: RemoteTabRequest): Promise<{ url: string }>
  /** Stop the child backend; the child home and identity are kept. */
  down(id: string): Promise<void>
  /** Stop the child, revoke its device, and remove its home. */
  forget(id: string): Promise<void>
  /** Stop every child; homes and identities are kept. */
  dispose(): void
}
