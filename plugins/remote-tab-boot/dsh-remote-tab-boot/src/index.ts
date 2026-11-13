/**
 * dsh-remote-tab-boot — child-side bootstrap for remote desktop tabs.
 *
 * The desktop app opens a remote Host workspace by generating an isolated
 * `remote-tab` child profile and spawning a `dsh web` for it with
 * `DSH_REMOTE_TAB_TARGET` in the environment. This plugin is mounted in that
 * child profile: it waits for the `dshRemoteClient` service that
 * `ds-harness-remote` provides, opens the requested remote workspace through
 * it, and then prints the sentinel line the parent supervisor waits for:
 *
 *     [remote-tab-boot] ready <targetDeviceId> <workspacePath>
 *
 * In every other profile the variable is absent and `apply` returns
 * immediately, so the plugin is inert.
 *
 * @module dsh-remote-tab-boot
 */

import type { Context } from '@deepseek-ai/cordis'

/** Loader entry name (the package name). */
export const name = 'dsh-remote-tab-boot'

/**
 * No load-time service requirement: whether the child needs `dshRemoteClient`
 * depends on {@link TARGET_ENV}, checked inside {@link apply}. The dependency
 * is declared there through `ctx.inject`, so a parent-profile boot (no target)
 * never waits for a service.
 */
export const inject: string[] = []

/** Environment variable carrying the target JSON into the child process. */
export const TARGET_ENV = 'DSH_REMOTE_TAB_TARGET'

/** Deadline for opening the remote workspace, in milliseconds. */
export const OPEN_TIMEOUT_MS = 60_000

/** Payload the parent supervisor passes through {@link TARGET_ENV}. */
export interface RemoteTabTarget {
  /** Remote Host device id the child connects to. */
  readonly targetDeviceId: string
  /** Workspace path on that Host to open. */
  readonly workspacePath: string
  /** Backend that owns the workspace; only `harness` is supported. */
  readonly backend: 'harness'
  /** Connection title, carried for diagnostics only; parsed but not used by the bootstrap. */
  readonly title?: string
}

/** Structural view of the `dshRemoteClient` service `ds-harness-remote` provides. */
export interface RemoteTabClient {
  openRemoteWorkspace(targetDeviceId: string, path: string, signal?: AbortSignal): Promise<unknown>
}

/** Message text for any thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Write a failure to stderr and return the error to throw. */
function fail(message: string, cause?: unknown): Error {
  console.error(message)
  return cause === undefined ? new Error(message) : new Error(message, { cause })
}

/** Read one required non-empty string field from the target JSON. */
function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw fail(`[remote-tab-boot] ${TARGET_ENV}.${field} must be a non-empty string`)
  }
  return value
}

/**
 * Read the target carried by {@link TARGET_ENV}.
 *
 * A missing, empty or whitespace-only variable means "this boot has no remote
 * tab target" and returns `undefined`. A malformed payload throws after
 * writing the reason to stderr, so the child never opens a workspace on a
 * guess.
 * @returns the parsed target, or `undefined` when the variable is absent/blank.
 */
export function readTarget(): RemoteTabTarget | undefined {
  const raw = process.env[TARGET_ENV]
  const text = raw === undefined ? '' : raw.trim()
  if (text === '') return undefined

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw fail(`[remote-tab-boot] ${TARGET_ENV} is not valid JSON: ${messageOf(error)}`, error)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw fail(`[remote-tab-boot] ${TARGET_ENV} must be a JSON object`)
  }
  const record = value as Record<string, unknown>
  const declared = record.backend
  const backend = typeof declared === 'string' && declared.trim() !== '' ? declared.trim() : 'harness'
  if (backend !== 'harness') {
    throw fail(`[remote-tab-boot] backend '${backend}' is not supported in this release (only 'harness')`)
  }
  const target: RemoteTabTarget = {
    targetDeviceId: requiredString(record, 'targetDeviceId'),
    workspacePath: requiredString(record, 'workspacePath'),
    backend,
  }
  return typeof record.title === 'string' ? { ...target, title: record.title } : target
}

/**
 * Open one remote workspace through the `dshRemoteClient` service and print
 * the sentinel line.
 *
 * The service method is checked explicitly: an installation whose
 * `ds-harness-remote` predates `openRemoteWorkspace` must fail with a message
 * that names the missing method instead of a bare `TypeError`. Both a
 * rejection and the {@link OPEN_TIMEOUT_MS} deadline are reported on stderr
 * and rethrown; the sentinel is printed only after the call resolves.
 * @param client - the `dshRemoteClient` service, when the profile provides it.
 * @param target - the remote Host workspace to open.
 * @param timeoutMs - deadline for the call; defaults to {@link OPEN_TIMEOUT_MS}.
 */
export async function openWorkspace(
  client: RemoteTabClient | undefined,
  target: RemoteTabTarget,
  timeoutMs: number = OPEN_TIMEOUT_MS,
): Promise<void> {
  if (client === undefined || typeof client.openRemoteWorkspace !== 'function') {
    throw fail(
      `[remote-tab-boot] ds-harness-remote does not provide dshRemoteClient.openRemoteWorkspace(targetDeviceId, path, signal); cannot open remote workspace ${target.targetDeviceId} ${target.workspacePath}`,
    )
  }
  try {
    await client.openRemoteWorkspace(target.targetDeviceId, target.workspacePath, AbortSignal.timeout(timeoutMs))
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError'
      ? `timed out after ${timeoutMs}ms`
      : messageOf(error)
    throw fail(`[remote-tab-boot] openRemoteWorkspace failed for ${target.targetDeviceId} ${target.workspacePath}: ${reason}`, error)
  }
  console.log(`[remote-tab-boot] ready ${target.targetDeviceId} ${target.workspacePath}`)
}

/**
 * Open the configured remote workspace once the client service is available.
 *
 * Without a target this is a no-op, which is the normal boot in every parent
 * profile. With a target, `ctx.inject(['dshRemoteClient'], …)` defers the work
 * until `ds-harness-remote` has registered its client service, and re-runs the
 * callback whenever that service is re-provided.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  const target = readTarget()
  if (target === undefined) return
  ctx.inject(['dshRemoteClient'], async (clientCtx: Context) => {
    const client = clientCtx.get('dshRemoteClient') as RemoteTabClient | undefined
    await openWorkspace(client, target)
  })
}
