/**
 * dsh-quick-assistant host half.
 *
 * The plugin adds a global-shortcut overlay to the desktop shells. It owns:
 *
 * - the settings file (`<DSH_HOME>/quick-assistant/settings.json`),
 * - the HTTP surface under `/quick-assistant` (`./routes.ts`): the overlay page
 *   and its assets, the SSE chat proxy into `ctx.llm`, the settings page API,
 *   and the native helper state,
 * - the lifecycle of the native helper process (`./helper.ts`), which owns the
 *   global hotkey and the overlay window because neither shell can provide
 *   them for a separate window.
 *
 * Every registration is an effect so a profile reload disposes the routes and
 * terminates the helper. The plugin is inert unless the web server is bound to
 * the loopback address: its routes are an unauthenticated local RPC besides the
 * one-time overlay token, and the native helper is only reachable locally.
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'

import { CatalogCache, type LlmCatalogService, type ModelSelection } from './catalog.ts'
import { NativeHelper, nativeHelperOptions } from './helper.ts'
import { createRouteHandler, ROUTE_PREFIX, type RouteDeps } from './routes.ts'
import { SettingsStore } from './settings.ts'
import type { LlmChatRequest, LlmStreamService } from './stream.ts'

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    /** One quick-assistant chat run; never part of a durable session. */
    'quick-assistant': true
  }
}

/** Plugin name as loaded by the profile. */
export const name = 'dsh-quick-assistant'

/** Hard dependencies: routes need the web server, chat needs the LLM service. */
export const inject = ['webServer', 'llm']

/** Plugin configuration (profile entry config). */
export interface Config {
  /** Explicit native helper executable path; defaults to the file next to the DSH home. */
  helperExe?: string
}

/** Structural face of `ctx.agentDefaultModel`, an optional service. */
interface AgentDefaultModelService {
  /** Main model selection shared by agent entry points. */
  currentSelection(): { provider: string; model: string; reasoningEffort?: unknown }
}

/**
 * Read the main model selection, when the optional service is present.
 * @param ctx - plugin context.
 * @returns the selection, or `undefined` when the service is absent or unset.
 */
function currentDefaultSelection(ctx: Context): ModelSelection | undefined {
  // `agentDefaultModel` is optional in composition and its types come from
  // another package; `ctx.get` returns `any` for a name outside this Context.
  const service: AgentDefaultModelService | undefined = ctx.get('agentDefaultModel')
  if (service === undefined || service === null) return undefined
  const selection = service.currentSelection()
  const provider = typeof selection?.provider === 'string' ? selection.provider : ''
  const model = typeof selection?.model === 'string' ? selection.model : ''
  if (provider === '' || model === '') return undefined
  const effort = selection.reasoningEffort
  return {
    provider,
    model,
    ...typeof effort === 'string' && effort !== '' ? { reasoningEffort: effort } : {},
  }
}

/**
 * Adapt one plugin-local chat request to the harness request type.
 *
 * `messages` carries plain host-built turns rather than durable session
 * messages; the runtime reads only role and text content, and the request
 * never reaches a session log. The effort arrives as a settings string and is
 * the adapter-owned branded id at this boundary.
 * @param request - plugin request.
 * @returns the harness request object.
 */
function toGenerateOptions(request: LlmChatRequest): GenerateOptions {
  const reasoningEffort = request.reasoningEffort === undefined
    ? undefined
    : request.reasoningEffort as GenerateOptions['reasoningEffort']
  return {
    provider: request.provider,
    model: request.model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
    ...request.system === undefined ? {} : { system: request.system },
    ...request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens },
    ...request.temperature === undefined ? {} : { temperature: request.temperature },
    ...request.signal === undefined ? {} : { signal: request.signal },
    messages: request.messages as RequestMessage[],
    purpose: request.purpose,
  }
}

/**
 * Mount the host half.
 * @param ctx - plugin context; `webServer` and `llm` are the declared dependencies.
 * @param config - optional plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const webServer: WebServer = ctx.webServer
  const log = ctx.logger
  if (webServer.host !== '127.0.0.1') {
    log.error(
      `[quick-assistant] refusing to start: the /quick-assistant routes are a local RPC and require the loopback bind (webServer.host is ${webServer.host})`,
    )
    return
  }

  const token = randomUUID().replaceAll('-', '')
  const settings = new SettingsStore()
  const catalog = new CatalogCache()
  let showRequest = 0
  let helper: NativeHelper | undefined

  const llm: LlmStreamService & LlmCatalogService = {
    listProviders: () => ctx.llm.listProviders(),
    listModels: (provider: string) => ctx.llm.listModels(provider),
    resolveModelInfo: (provider: string, model: string) => ctx.llm.resolveModelInfo(provider, model),
    stream: (request: LlmChatRequest) => ctx.llm.stream(toGenerateOptions(request)),
  }

  const deps: RouteDeps = {
    token,
    settings,
    llm,
    catalog,
    defaultSelection: () => currentDefaultSelection(ctx),
    helperStatus: () => helper?.status ?? { running: false, error: '原生助手尚未启动' },
    showRequest: () => showRequest,
    requestShow: () => {
      showRequest += 1
    },
    log,
  }

  ctx.effect(
    () => webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: createRouteHandler(deps) }),
    'dsh-quick-assistant: routes',
  )

  ctx.effect(() => {
    let origin: string
    try {
      origin = webServer.getOrigin()
    } catch (error) {
      log.error('[quick-assistant] cannot start the native helper before the web server bound a port:', error)
      return () => {}
    }
    const instance = new NativeHelper(nativeHelperOptions(
      origin,
      token,
      settings.get().shortcut,
      config.helperExe,
      log,
    ))
    helper = instance
    instance.start()
    return () => {
      helper = undefined
      return instance.dispose()
    }
  }, 'dsh-quick-assistant: native overlay')

  log.info(`[quick-assistant] routes mounted on ${ROUTE_PREFIX}`)
}
