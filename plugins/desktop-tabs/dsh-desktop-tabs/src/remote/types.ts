/**
 * Public types of the remote-connection module.
 *
 * The module owns everything between a tab's `ssh` or `wsl` descriptor and a
 * loadable `http://127.0.0.1:<port>/?token=...` URL; `./session.ts` implements
 * it and `./index.ts` is the entry both the host half and the browser half's
 * requests go through. `SshSpec` / `WslSpec` live in `./config.ts` because they
 * are read from the same `gui/desktop-tabs.json` the tab list comes from.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { SshSpec, WslSpec } from './config.ts'

/**
 * One tab the connection manager accepts: a configured tab or a saved
 * connection, plus its remote descriptor. Structurally a superset of
 * `DesktopTab`, so a caller may keep passing the normalized list from
 * `../targets.ts`. A row carrying both descriptors is resolved as SSH.
 */
export interface RemoteTab {
  readonly id: string
  readonly title?: string
  readonly url?: string
  readonly ssh?: SshSpec
  readonly wsl?: WslSpec
  /** Explicit remote login name (`ssh -l` / `wsl.exe -u`). */
  readonly account?: string
  /** Remote working directory of the launch; empty means the remote `$HOME`. */
  readonly workdir?: string
  /** Remote command that starts the backend; empty means the built-in default. */
  readonly startCommand?: string
}

/** The host half's `GET /api/tabs` response: the open tabs and the saved connections. */
export interface RemoteTargetPair {
  readonly tabs?: readonly RemoteTab[]
  readonly connections?: readonly RemoteTab[]
}

/**
 * The rows the manager resolves by id: either a plain array, or the host half's
 * `{ tabs, connections }` response. Both are accepted, so the callback stays
 * compatible with the tab list and with the tab/connection pair.
 */
export type RemoteTargetSource = readonly RemoteTab[] | RemoteTargetPair

/** Connection state of one tab, as the client half displays it. */
export interface RemoteConnectionStatus {
  readonly id: string
  readonly state: 'idle' | 'connecting' | 'up' | 'error'
  /** Present only in state `up`. */
  readonly url?: string
  /** Present only in state `error`. */
  readonly error?: string
  /** Bounded, token-free progress log of the last attempt; empty when idle. */
  readonly log: string[]
}

/** The logger subset the manager uses; a Cordis `ctx.logger` satisfies it. */
export interface RemoteLogger {
  info(message: unknown): void
  warn(message: unknown): void
  error(message: unknown): void
}

/** Construction options of one connection manager. */
export interface RemoteConnectionsOptions {
  /** Harness home whose `gui/desktop-tabs.json` holds the remote descriptors. */
  readonly dshHome: string
  /** Rows to resolve by id: a plain tab array, or the `{ tabs, connections }` response. */
  readonly tabs: () => Promise<RemoteTargetSource>
  /** Optional sink for lifecycle and failure messages. */
  readonly logger?: RemoteLogger
}

/** Connection lifecycle of the tabs on one host. */
export interface RemoteConnections {
  /**
   * Establish or reuse the tab's connection.
   * @param tabId - id of a tab whose descriptor carries `ssh` or `wsl`.
   * @returns the loadable URL.
   */
  up(tabId: string): Promise<{ url: string }>
  /**
   * Tear the connection down: the local tunnel and its ssh/wsl clients. The
   * remote backend keeps running in its tmux session and is reused by the next
   * `up`; no remote or WSL-internal stop command is ever sent.
   * @param tabId - tab to disconnect; an unknown or idle tab is a no-op.
   */
  down(tabId: string): Promise<void>
  /** One row per configured remote tab, plus every tab with recorded state. */
  status(): RemoteConnectionStatus[]
  /** Tear every local connection down; remote backends keep running in tmux. */
  dispose(): void
}

/** One named route as `@deepseek-ai/dsh-host-webserver` registers it. */
export interface RemoteRoute {
  readonly kind: 'exact' | 'prefix'
  /** Absolute pathname, no trailing slash. */
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** The web-server subset route registration needs. */
export interface RemoteWebServer {
  /** Configured bind host; anything but loopback refuses registration. */
  readonly host?: string
  /**
   * Register one named route.
   * @param route - kind, path, and the owning handler.
   * @param label - label form of the harness registration convention.
   * @returns the disposer removing the route.
   */
  register(route: RemoteRoute, label?: string): () => void
}
