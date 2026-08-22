/**
 * Structural types for the cordis services the dsh-ai-update host half
 * consumes, plus the Context face it uses. This plugin is a standalone package
 * resolved by the profile loader, so the upstream `declare module` augmentations
 * of the DSH monorepo do not reach it; the members below mirror the actual
 * runtime shapes (same containment strategy as dsh-sidebar-qa's
 * context-types.ts). Only the leaf fields this plugin reads are declared; live
 * cordis objects are never serialized.
 *
 * - webServer (@deepseek-ai/dsh-host-webserver): the loopback HTTP server the
 *   web app exposes; the shell reaches this plugin's route over it.
 * - llm (@deepseek-ai/dsh-llm): raw model streaming — no Agent, no Session, so
 *   a summary call never appears in the DSH session list.
 * - agentDefaultModel (@deepseek-ai/dsh-agent-default-model): the default model
 *   the user picked on the Models page; the summary runs with it.
 * - loader (@cordisjs/plugin-loader): the connection row's trustedHosts for the
 *   browser-trust fence.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** One named webserver route (mirror of the host-webserver WebRoute). */
export interface AiUpdateWebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** The webServer service face this plugin uses. */
export interface AiUpdateWebServer {
  register(route: AiUpdateWebRoute): () => void
}

/** One message passed to the model (structural Message mirror). */
export interface AiUpdateLlmMessage {
  id: string
  role: 'system' | 'user' | 'assistant'
  content: readonly { type: 'text'; text: string }[]
  source: { kind: string; plugin?: string }
}

/** One model request, fully assembled (structural GenerateOptions mirror). */
export interface AiUpdateLlmRequest {
  provider: string
  model: string
  messages: AiUpdateLlmMessage[]
  system?: string
  maxTokens?: number
  reasoningEffort?: string
  signal?: AbortSignal
}

/** One raw streaming chunk emitted by the adapter (structural StreamChunk mirror). */
export type AiUpdateStreamChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: { type: string; text?: string } }
  | { type: 'usage'; usage: unknown }
  | { type: 'finish'; reason: { kind?: string } }

/** The llm service face this plugin uses (one-shot stream). */
export interface AiUpdateLlmService {
  stream(options: AiUpdateLlmRequest): AsyncIterable<AiUpdateStreamChunk>
}

/** A provider + model selection (optional adapter-owned reasoning effort). */
export interface AiUpdateModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** The agentDefaultModel service face (read the default selection only). */
export interface AiUpdateDefaultModelService {
  currentSelection(): AiUpdateModelSelection
}

/** One loader entry's options slice (the connection row's resolved config). */
export interface AiUpdateLoaderEntry {
  options: { name: string; config?: { trustedHosts?: string[] } }
}

/** The loader face used to read the connection row's trustedHosts config. */
export interface AiUpdateLoader {
  entries(): Iterable<AiUpdateLoaderEntry>
}

/** The cordis Context face this host half touches. */
export interface AiUpdateContext {
  /** Optional service read; returns undefined while the service is absent. */
  get<T = unknown>(name: string): T | undefined
  /** Defer a callback until the named services exist (never runs when absent). */
  inject(names: string[], callback: (ctx: AiUpdateContext) => void): void
  /** Register an effect; its returned disposer runs at teardown (reload-safe). */
  effect(fn: () => void | (() => void), label?: string): void
}
