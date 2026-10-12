/**
 * Injects the OpenCode per-conversation `x-opencode-session` header on LLM
 * requests that reach the loop without a session stamp.
 *
 * The agent loop stamps `GenerateOptions.sessionId` on every conversation
 * request, so those already carry the header through the pi-ai opencode
 * adapters (`withOpenCodeSessionHeader` in `@earendil-works/pi-ai`). Hand-built
 * auxiliary calls — the auto-review gate chief among them — omit it, and
 * opencode-go rejects the request with `400 MissingSessionID`. This plugin
 * attaches the initiating conversation's session id at the `llm/stream`
 * waterfall so every opencode request carries the header.
 *
 * Session identity comes from `ctx.agents.currentInitiator()`, the same value
 * the loop stamps, so auxiliary calls route under the same per-conversation id
 * as their parent conversation (the OpenCode routing/prompt-cache contract; see
 * README for the verified rationale). Requests that already carry a session id
 * or that target a non-OpenCode provider pass through untouched.
 *
 * @module dsh-opencode-session
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'

/** Session identity a replacement request carries in {@link GenerateOptions.sessionId}. */
export type SessionId = NonNullable<GenerateOptions['sessionId']>

/** Provider routes whose pi-ai adapters send the OpenCode session header. */
export const OPENCODE_PROVIDERS = ['opencode', 'opencode-go'] as const

export const name = 'dsh-opencode-session'

export interface Config {
  /**
   * Provider routes that require the OpenCode session header. Defaults to the
   * pi-ai `opencode` and `opencode-go` routes; extend it for other opencode
   * gateways (e.g. a custom route whose api also wraps the header).
   */
  providers?: readonly string[]
  /**
   * Stable id used when no initiator agent attributes the request so a
   * request is never sent headerless. Defaults to a process-stable uuid.
   */
  fallbackSessionId?: string
  /**
   * `conversation` (default) reuses the initiating conversation's DSH session
   * id, matching the loop and the OpenCode per-conversation routing contract.
   * `per-call` gives every unattributed request a fresh id instead, isolating
   * auxiliary calls from the conversation's cached prefix.
   */
  sessionIdMode?: 'conversation' | 'per-call'
}

export const inject = ['llm']

export interface InjectOutcome {
  readonly options: GenerateOptions
  readonly injected: boolean
}

/**
 * Resolve whether one `llm/stream` request needs an injected OpenCode session
 * id and, when it does, return a replacement request carrying it. The original
 * request is never mutated; the replacement is the spread copy with
 * `sessionId`, so a re-dispatched request re-enters the waterfall with its
 * session id set and passes straight through — no recursion marker is needed.
 * @param options - the live `llm/stream` request.
 * @param sessionId - the id to attach, or `undefined` when none is resolvable.
 * @param providers - provider routes that require the header.
 * @returns the request to stream and whether it was replaced.
 */
export function injectRequestSessionId(
  options: GenerateOptions,
  sessionId: SessionId | undefined,
  providers: ReadonlySet<string>,
): InjectOutcome {
  if (options.sessionId !== undefined || !providers.has(options.provider)) {
    return { options, injected: false }
  }
  if (sessionId === undefined) return { options, injected: false }
  return { options: { ...options, sessionId }, injected: true }
}

/**
 * Mount the listener. `config` is optional: this package exports no runtime
 * `Config` schema, so Cordis's `resolveConfig` returns the Loader entry's
 * `config` unchanged and an entry that declares none hands `undefined` here
 * (`resolveConfig` in `@deepseek-ai/cordis`: `if (!runtime.Config) return
 * config`). Default it so such an entry mounts instead of failing its fiber.
 * @param ctx - the plugin context; `llm` is the declared hard dependency.
 * @param config - optional profile configuration; every field has a default.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const providers = new Set<string>(config.providers ?? OPENCODE_PROVIDERS)
  const mode = config.sessionIdMode ?? 'conversation'
  const fallback: SessionId = brandString<SessionId>(
    config.fallbackSessionId ?? `dsh-opencode-${randomUUID()}`,
  )
  ctx.on('llm/stream', function (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) {
    const sessionId: SessionId = mode === 'per-call'
      ? brandString<SessionId>(randomUUID())
      : ctx.get('agents')?.currentInitiator()?.session.id ?? fallback
    const outcome = injectRequestSessionId(options, sessionId, providers)
    if (!outcome.injected) return next()
    return ctx.llm.stream(outcome.options)
  }, { prepend: true })
}