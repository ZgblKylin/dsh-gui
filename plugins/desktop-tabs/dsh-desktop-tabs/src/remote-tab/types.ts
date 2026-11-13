/**
 * Public types of the remote-tab host module.
 *
 * A remote tab is one saved `ds-harness-remote` connection: the desktop's
 * parent Remote Host identity mints an owned child Client identity, and one
 * child `dsh web` process per connection runs under its own `DSH_HOME`, opens
 * the remote workspace and is embedded as a webview tab. This module owns
 * everything between a persisted row's `remote` descriptor and a loadable
 * `http://127.0.0.1:<port>/?token=...` URL: `./profile.ts` generates the child
 * profile, `./identity.ts` mints/reuses the child device, `./supervisor.ts`
 * owns the child process, and `./routes.ts` serves the panel's discovery routes
 * and the shared connection routes.
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
 * stay inside `./identity.ts`; the profile only needs the server URL, and
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
