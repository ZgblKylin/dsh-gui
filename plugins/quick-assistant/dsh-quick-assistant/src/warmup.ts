/**
 * Startup warm-up for the model routes the quick assistant can reach.
 *
 * A fresh host pays a provider's lazy implementation import, credential
 * resolution, connection setup, and account bootstrap on its first model call.
 * Asking one cold question can therefore wait many seconds before the first
 * token. This module resolves each route's metadata and runs one minimal stream
 * per distinct route in the background, so the first real question starts from
 * a warm provider connection; the resolved metadata is cached and shared with
 * the request path.
 *
 * A failed warm-up is retried a few times with a delay, because the provider
 * bootstrap that makes the first call slow can also make the warm-up itself
 * fail transiently.
 */

import { randomUUID } from 'node:crypto'

import type { LlmResolvedModel, ModelSelection } from './catalog.ts'
import { ASSISTANT_MODES } from './prompts.ts'
import type { AssistantSettings } from './settings.ts'
import type { LlmChatRequest, LlmStreamService } from './stream.ts'

/** One provider/model route to warm. */
export interface WarmRoute {
  /** Registered provider route id. */
  provider: string
  /** Provider-owned model id. */
  model: string
}

/** Warm-up state of one route, as reported by `/api/health`. */
export interface WarmupRouteStatus {
  /** Registered provider route id. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Current warm-up phase. */
  status: 'warming' | 'ready' | 'failed'
  /** Failure message when `status` is `failed`. */
  error?: string
}

/** Longest warm-up call accepted; a hung provider must not block the queue forever. */
const WARM_TIMEOUT_MS = 90_000
/** How often one route's warm-up is retried after a failure. */
const WARM_MAX_ATTEMPTS = 3
/** Base delay between warm-up retries; multiplied by the attempt number. */
const WARM_RETRY_DELAY_MS = 15_000
/** Prompt of the warm-up call; the model never answers it in practice. */
const WARM_PROMPT = 'ping'

/** One route's warm-up state. */
interface RouteState {
  status: 'warming' | 'ready' | 'failed'
  /** Controller of the in-flight call, present while `warming`. */
  controller?: AbortController
  /** Epoch milliseconds when the current call settled. */
  finishedAt?: number
  /** Failure message shown in the log and `/api/health`. */
  error?: string
  /** Pending retry timer after a failure. */
  retryTimer?: NodeJS.Timeout
  /** Warm-up calls made for this route so far. */
  attempts: number
}

/** Services and log the warm-up needs. */
export interface WarmupOptions {
  /** LLM service the plugin streams through. */
  llm: LlmStreamService & { resolveModelInfo(provider: string, model: string): Promise<LlmResolvedModel> }
  /** Plugin logger. */
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void }
}

/**
 * Every route the plugin can reach: the main model and each mode's override.
 * @param settings - current settings.
 * @param defaultSelection - main model selection, when the service exists.
 * @returns candidate routes; duplicates are collapsed by {@link ModelWarmup.refresh}.
 */
export function routesFromSettings(
  settings: AssistantSettings,
  defaultSelection: ModelSelection | undefined,
): WarmRoute[] {
  const routes: WarmRoute[] = []
  const push = (provider: string | undefined, model: string | undefined): void => {
    if (provider !== undefined && provider !== '' && model !== undefined && model !== '') {
      routes.push({ provider, model })
    }
  }
  push(defaultSelection?.provider, defaultSelection?.model)
  for (const mode of ASSISTANT_MODES) {
    const model = settings.modes[mode].model
    if (model.useDefault) push(defaultSelection?.provider, defaultSelection?.model)
    else push(model.provider, model.model)
  }
  return routes
}

/** Stable cache key of one route. */
function routeKey(route: WarmRoute): string {
  return `${route.provider}\u0000${route.model}`
}

/** Short description of a failure's cause, when the error carries one. */
function causeOf(error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause
  if (cause === undefined) return ''
  if (cause instanceof Error) return `: ${cause.message}`
  return `: ${String(cause)}`
}

/** Whether a route names a complete provider/model pair. */
function isCompleteRoute(route: WarmRoute): boolean {
  return route.provider !== '' && route.model !== ''
}

/**
 * Background model-route warm-up and metadata cache.
 *
 * One instance per plugin mount. `refresh()` is idempotent: routes already warm
 * are left alone, routes that disappeared are dropped, and new routes join a
 * single sequential queue so startup never floods a provider.
 */
export class ModelWarmup {
  private readonly routes = new Map<string, RouteState>()
  private readonly info = new Map<string, Promise<LlmResolvedModel>>()
  private queue: Promise<void> = Promise.resolve()
  private disposed = false

  /**
   * @param options - LLM service and logger.
   */
  constructor(private readonly options: WarmupOptions) {}

  /**
   * Resolve one model's metadata through the shared cache.
   * @param provider - provider route id.
   * @param model - model id.
   * @returns the adapter's model metadata.
   */
  async resolveInfo(provider: string, model: string): Promise<LlmResolvedModel> {
    const key = `${provider}\u0000${model}`
    const cached = this.info.get(key)
    if (cached !== undefined) return cached
    const pending = this.options.llm.resolveModelInfo(provider, model).catch((error: unknown) => {
      // Drop failures so a later call can retry against a recovered provider.
      this.info.delete(key)
      throw error
    })
    this.info.set(key, pending)
    return pending
  }

  /**
   * Replace the desired warm route set and start warming the new routes.
   * @param routes - every route the four modes and the main model can reach.
   */
  refresh(routes: readonly WarmRoute[]): void {
    if (this.disposed) return
    const wanted = new Map<string, WarmRoute>()
    for (const route of routes) {
      if (isCompleteRoute(route)) wanted.set(routeKey(route), route)
    }
    for (const [key, state] of this.routes) {
      if (wanted.has(key)) continue
      state.controller?.abort('warm-up route removed')
      if (state.retryTimer !== undefined) clearTimeout(state.retryTimer)
      this.routes.delete(key)
      this.info.delete(key)
    }
    for (const [key, route] of wanted) {
      const state = this.routes.get(key)
      if (state?.status === 'warming' || state?.status === 'ready') continue
      if (state?.retryTimer !== undefined) continue
      if (state !== undefined && state.attempts >= WARM_MAX_ATTEMPTS) continue
      this.enqueue(route, state?.attempts ?? 0)
    }
  }

  /** Abort every in-flight warm-up call and drop all cached state. */
  dispose(): void {
    this.disposed = true
    for (const state of this.routes.values()) {
      state.controller?.abort('warm-up disposed')
      if (state.retryTimer !== undefined) clearTimeout(state.retryTimer)
    }
    this.routes.clear()
    this.info.clear()
  }

  /**
   * Snapshot the current warm-up states for diagnostics.
   * @returns one entry per tracked route, in insertion order.
   */
  status(): WarmupRouteStatus[] {
    return [...this.routes.entries()].map(([key, state]) => {
      const separator = key.indexOf('\u0000')
      return {
        provider: key.slice(0, separator),
        model: key.slice(separator + 1),
        status: state.status,
        ...state.error === undefined ? {} : { error: state.error },
      }
    })
  }

  /**
   * Queue one route behind the previous warm-up call.
   * @param route - route to warm.
   * @param attempts - warm-up calls already made for this route.
   */
  private enqueue(route: WarmRoute, attempts: number): void {
    const key = routeKey(route)
    const controller = new AbortController()
    this.routes.set(key, { status: 'warming', controller, attempts })
    this.queue = this.queue
      .then(() => this.warm(route, controller, attempts))
      .catch(() => {})
  }

  /**
   * Warm one route: resolve its metadata, then run one minimal stream to
   * completion so the adapter, credential, and provider connection are ready
   * for a real request.
   * @param route - route to warm.
   * @param controller - cancellation of this warm-up call.
   * @param attempts - warm-up calls already made for this route.
   */
  private async warm(route: WarmRoute, controller: AbortController, attempts: number): Promise<void> {
    const key = routeKey(route)
    const timeout = setTimeout(() => controller.abort('warm-up timeout'), WARM_TIMEOUT_MS)
    try {
      await this.resolveInfo(route.provider, route.model)
      if (this.disposed) return
      const request: LlmChatRequest = {
        provider: route.provider,
        model: route.model,
        messages: [{
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: WARM_PROMPT }],
          source: { kind: 'user' },
        }],
        purpose: 'quick-assistant',
        signal: controller.signal,
      }
      // The stream runs to its end instead of stopping at the first chunk:
      // abandoning it would surface inside an adapter as a failed transport.
      let failure: string | undefined
      for await (const chunk of this.options.llm.stream(request)) {
        if (chunk.type !== 'finish') continue
        if (chunk.reason.kind === 'error') failure = chunk.reason.failure.message
        else if (chunk.reason.kind === 'aborted') failure = 'warm-up stream aborted'
      }
      if (this.disposed) return
      if (failure !== undefined) throw new Error(failure)
      this.routes.set(key, { status: 'ready', finishedAt: Date.now(), attempts: attempts + 1 })
      this.options.log.info(`[quick-assistant] model warmed: ${route.provider}/${route.model}`)
    } catch (error) {
      if (this.disposed) return
      const message = `${error instanceof Error ? error.message : String(error)}${causeOf(error)}`
      const used = attempts + 1
      const retrying = used < WARM_MAX_ATTEMPTS
      this.options.log.warn(
        `[quick-assistant] model warm-up failed for ${route.provider}/${route.model} (attempt ${used}/${WARM_MAX_ATTEMPTS}): ${message}`,
      )
      const state: RouteState = { status: 'failed', finishedAt: Date.now(), error: message, attempts: used }
      this.routes.set(key, state)
      if (retrying) {
        state.retryTimer = setTimeout(() => {
          const current = this.routes.get(key)
          if (this.disposed || current === undefined || current.status === 'ready') return
          this.routes.delete(key)
          this.enqueue(route, used)
        }, WARM_RETRY_DELAY_MS * used)
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}
