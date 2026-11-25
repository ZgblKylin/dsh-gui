/**
 * Server-sent-events bridge between one chat request and the LLM stream.
 *
 * The wire protocol is fixed by `.work/contract.md` §5: `meta` first, then any
 * number of `delta` events, then exactly one terminal `done` or `error`. The
 * connection is text/event-stream, never cached, and closing it aborts the
 * model call so a dismissed overlay stops paying for tokens.
 */

import type { ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { GenerateOptions, LlmFailure, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'

import type { ModelSelection } from './catalog.ts'
import {
  WEB_TOOL_SCHEMAS, executeWebTool, webToolStatus, webToolsReady,
  type ToolCall, type WebService, type WebToolSchema,
} from './web-tools.ts'

/** One message forwarded to the model. */
export interface LlmMessage {
  /** Fresh identity for this request; the harness never persists it. */
  id: string
  /** Conversation role. */
  role: 'user' | 'assistant'
  /** Text-only content; the quick assistant never sends images or tools. */
  content: readonly { type: 'text'; text: string }[]
  /** Producer source: plain user input, or a model reply with its route. */
  source: { kind: 'user' } | { kind: 'model'; provider: string; model: string }
}

/** One tool invocation the model asked for. */
export interface LlmToolCallBlock {
  type: 'tool-call'
  id: string
  name: string
  arguments: string
}

/** An assistant turn that may carry tool calls. */
export interface LlmAssistantToolTurn {
  id: string
  role: 'assistant'
  content: readonly ({ type: 'text'; text: string } | LlmToolCallBlock)[]
  source: { kind: 'model'; provider: string; model: string }
}

/** One tool result answering a tool call. */
export interface LlmToolTurn {
  id: string
  role: 'tool'
  content: readonly { type: 'text'; text: string }[]
  source: { kind: 'tool'; callId: string }
  toolCallId: string
  isError?: boolean
}

/** One turn of the request history, including the tool turns of a tool loop. */
export type LlmTurn = LlmMessage | LlmAssistantToolTurn | LlmToolTurn

/**
 * Request fields this plugin sets. It reuses the harness option fields while
 * keeping `messages` local: the host builds plain text turns for one auxiliary
 * call rather than replaying durable session messages.
 */
export interface LlmChatRequest extends Pick<GenerateOptions, 'provider' | 'model' | 'system' | 'maxTokens' | 'temperature' | 'signal'> {
  /** Adapter-owned reasoning effort; omitted follows the model default. */
  reasoningEffort?: string
  /** Declared auxiliary purpose (module augmentation in `./index.ts`). */
  purpose: 'quick-assistant'
  /** Conversation turns, oldest first. */
  messages: LlmTurn[]
  /** Web tool declarations, offered only to the ask and explain modes. */
  tools?: readonly WebToolSchema[]
}

/** Structural face of the LLM service used for one auxiliary call. */
export interface LlmStreamService {
  /**
   * Stream one model call as raw chunks.
   * @param options - the complete request.
   * @returns chunk iterable; failures surface as a terminal `finish` chunk.
   */
  stream(options: LlmChatRequest): AsyncIterable<StreamChunk>
}

/** Usage reported by the terminal `done` event. */
export interface DoneUsage {
  /** Non-cached input tokens. */
  inputTokens: number
  /** Generated output tokens. */
  outputTokens: number
}

/** One SSE connection with a single-terminal-event guarantee. */
export interface SseConnection {
  /** Send the first event of a successful run. */
  meta(payload: { mode: string; provider: string; model: string }): void
  /** Append visible text. */
  delta(text: string): void
  /** Append model reasoning text (the thinking stream). */
  reasoning(text: string): void
  /** Announce one tool invocation; `detail` is the query or URL being handled. */
  tool(label: string, detail: string): void
  /** Discard the text streamed so far: the model is calling a tool instead of answering. */
  reset(): void
  /** Terminal event for a completed run. */
  done(usage?: DoneUsage): void
  /** Terminal event for a failed run. */
  error(code: string, message: string): void
  /** Close the underlying response once the run settles. */
  end(): void
  /** Whether a terminal event has been sent. */
  readonly finished: boolean
}

/**
 * Write one SSE frame.
 * @param res - response owning the stream.
 * @param event - event name the client switches on.
 * @param data - JSON-serializable payload.
 */
function writeEvent(res: ServerResponse, event: string, data: unknown): void {
  // A client that vanished mid-stream leaves a destroyed response; writing to
  // it would surface as an unhandled stream error instead of a closed request.
  if (res.writableEnded || res.destroyed) return
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/**
 * Start an SSE response.
 * @param res - response to take over.
 * @returns the connection handle; writes after the terminal event are dropped.
 */
export function openSse(res: ServerResponse): SseConnection {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    'connection': 'keep-alive',
    'x-content-type-options': 'nosniff',
  })
  res.flushHeaders()
  let finished = false
  const connection: SseConnection = {
    get finished() {
      return finished
    },
    meta(payload) {
      if (finished) return
      writeEvent(res, 'meta', payload)
    },
    delta(text) {
      if (finished || text === '') return
      writeEvent(res, 'delta', { text })
    },
    reasoning(text) {
      if (finished || text === '') return
      writeEvent(res, 'reasoning', { text })
    },
    tool(label, detail) {
      if (finished) return
      writeEvent(res, 'tool', { label, detail })
    },
    reset() {
      if (finished) return
      writeEvent(res, 'reset', {})
    },
    done(usage) {
      if (finished) return
      finished = true
      writeEvent(res, 'done', usage === undefined ? {} : { usage })
    },
    error(code, message) {
      if (finished) return
      finished = true
      writeEvent(res, 'error', { code, message })
    },
    end() {
      if (!res.writableEnded) res.end()
    },
  }
  return connection
}

/** Map a usage chunk onto the wire's two counters. */
function doneUsage(usage: TokenUsage): DoneUsage {
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
}

/** Read an error's stable code, falling back to a generic one. */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && code !== '' ? code : 'LLM_ERROR'
}

/**
 * Project one terminal provider failure onto the wire error event.
 *
 * The event carries the failure's own code and message; wrapping it in a
 * plugin-local error object would only re-validate fields the provider chose.
 * @param failure - serializable failure from a terminal `finish` chunk.
 * @returns the `{ code, message }` payload of the `error` event.
 */
export function failureEvent(failure: LlmFailure): { code: string; message: string } {
  return {
    code: failure.code === '' ? 'LLM_ERROR' : failure.code,
    message: failure.message,
  }
}

/** Message of an unknown thrown value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Options of one streamed chat call. */
export interface StreamChatOptions {
  /** LLM service to stream through. */
  llm: LlmStreamService
  /** Response to stream into. */
  res: ServerResponse
  /** Assistant mode reported in the `meta` event and used for the purpose tag. */
  mode: string
  /** Resolved provider/model selection. */
  selection: ModelSelection
  /** Conversation turns, oldest last. */
  messages: LlmMessage[]
  /** Optional system prompt. */
  system?: string
  /** Aborts the model call when the client disconnects. */
  signal: AbortSignal
  /** Web service used to execute tool calls, or `undefined` when unavailable. */
  web?: WebService | undefined
  /** Whether this mode may use the web tools. */
  tools?: boolean
}

/** How many tool rounds one request may run before the answer is forced. */
const MAX_TOOL_ROUNDS = 3

/** Outcome of one streamed model call inside the loop. */
interface CallOutcome {
  /** Visible text produced in this round. */
  text: string
  /** Tool calls the model requested, in emission order. */
  calls: ToolCall[]
  /** Terminal reason; `undefined` when the stream ended without one. */
  finish?: StreamChunk extends never ? never : FinishLike
}

/** The terminal reason a stream reports. */
type FinishLike = Extract<StreamChunk, { type: 'finish' }>['reason']

/**
 * Stream one chat run into an SSE response.
 * @param options - run inputs and the response to stream into.
 * @returns fulfillment after the response closed (or the client vanished).
 */
export async function streamChat(options: StreamChatOptions): Promise<void> {
  const sse = openSse(options.res)
  try {
    const useTools = options.tools === true
      && options.web !== undefined
      && await webToolsReady(options.web, options.selection.provider)
    if (useTools) await runToolLoop(options, sse)
    else await runPlain(options, sse)
  } catch (error) {
    if (!options.signal.aborted) sse.error(errorCode(error), messageOf(error))
  } finally {
    sse.end()
  }
}

/** One plain model call: no tools, the request is exactly the mode's prompt. */
async function runPlain(options: StreamChatOptions, sse: SseConnection): Promise<void> {
  const { llm, mode, selection, messages, system, signal } = options
  const request: LlmChatRequest = {
    ...routeOf(selection),
    ...system === undefined ? {} : { system },
    messages,
    purpose: 'quick-assistant',
    signal,
  }
  sse.meta({ mode, provider: selection.provider, model: selection.model })
  let usage: DoneUsage | undefined
  try {
    for await (const chunk of llm.stream(request)) {
      switch (chunk.type) {
        case 'text-delta':
          sse.delta(chunk.text)
          break
        case 'reasoning-delta':
          sse.reasoning(chunk.text)
          break
        case 'usage':
          usage = doneUsage(chunk.usage)
          break
        case 'finish':
          settle(sse, chunk.reason, usage, signal)
          return
        default:
          break
      }
    }
    // A stream that ended without a terminal chunk still has to close the protocol.
    sse.done(usage)
  } catch (error) {
    if (!signal.aborted) sse.error(errorCode(error), messageOf(error))
  }
}

/**
 * Stream the ask/explain modes with the web tools: the model may call
 * `web_search` / `web_fetch`, each call runs against `ctx.web`, and the loop
 * continues until the model answers or the round budget is spent.
 */
async function runToolLoop(options: StreamChatOptions, sse: SseConnection): Promise<void> {
  const { llm, mode, selection, system, signal, web } = options
  if (web === undefined) return
  const history: LlmTurn[] = [...options.messages]
  sse.meta({ mode, provider: selection.provider, model: selection.model })
  let usage: DoneUsage | undefined
  for (let round = 0; ; round += 1) {
    const offerTools = round < MAX_TOOL_ROUNDS
    const request: LlmChatRequest = {
      ...routeOf(selection),
      ...system === undefined ? {} : { system },
      messages: history,
      purpose: 'quick-assistant',
      signal,
      ...offerTools ? { tools: WEB_TOOL_SCHEMAS } : {},
    }
    const outcome = await streamOneCall(llm, request, sse, signal)
    if (outcome.usage !== undefined) usage = outcome.usage
    if (signal.aborted) return
    const finish = outcome.finish
    if (finish === undefined || finish.kind === 'stop' || finish.kind === 'max-tokens') {
      sse.done(usage)
      return
    }
    if (finish.kind === 'error') {
      // A model or adapter that cannot take tool declarations still has to
      // answer: retry the plain request once when the first round produced no
      // visible output.
      if (round === 0 && outcome.text === '') {
        await runPlain(options, sse)
        return
      }
      const event = failureEvent(finish.failure)
      sse.error(event.code, event.message)
      return
    }
    if (finish.kind === 'aborted') {
      // A client-side abort closed the connection; nothing will read an event.
      if (!signal.aborted) sse.error('ABORTED', finish.failure.message)
      return
    }
    if (outcome.calls.length === 0 || !offerTools) {
      // The model asked for tools it was not offered, or produced none: the text
      // already streamed is the whole answer.
      sse.done(usage)
      return
    }
    history.push({
      id: randomUUID(),
      role: 'assistant',
      content: [
        ...outcome.text === '' ? [] : [{ type: 'text' as const, text: outcome.text }],
        ...outcome.calls.map(call => ({ type: 'tool-call' as const, ...call })),
      ],
      source: { kind: 'model', provider: selection.provider, model: selection.model },
    })
    for (const call of outcome.calls) {
      // Text streamed before a tool call is narration, not the answer: the page
      // drops it and shows the tool status in its place.
      sse.reset()
      const status = webToolStatus(call)
      sse.tool(status.label, status.detail)
      const result = await executeWebTool(web, call, selection.provider, signal)
      if (signal.aborted) return
      history.push({
        id: randomUUID(),
        role: 'tool',
        content: [{ type: 'text', text: result.text }],
        source: { kind: 'tool', callId: call.id },
        toolCallId: call.id,
        isError: result.isError,
      })
    }
  }
}

/** One streamed model call that accumulates text, tool calls, and usage. */
async function streamOneCall(
  llm: LlmStreamService,
  request: LlmChatRequest,
  sse: SseConnection,
  signal: AbortSignal,
): Promise<{ text: string; calls: ToolCall[]; usage?: DoneUsage; finish?: FinishLike }> {
  let text = ''
  let usage: DoneUsage | undefined
  let finish: FinishLike | undefined
  const pending = new Map<number, ToolCall>()
  for await (const chunk of llm.stream(request)) {
    switch (chunk.type) {
      case 'text-delta':
        text += chunk.text
        sse.delta(chunk.text)
        break
      case 'reasoning-delta':
        sse.reasoning(chunk.text)
        break
      case 'tool-call-delta': {
        const call = pending.get(chunk.index) ?? { id: '', name: '', arguments: '' }
        if (chunk.id !== '') call.id = chunk.id
        if (chunk.name !== undefined && chunk.name !== '') call.name = chunk.name
        call.arguments += chunk.argumentsDelta
        pending.set(chunk.index, call)
        break
      }
      case 'usage':
        usage = doneUsage(chunk.usage)
        break
      case 'finish':
        finish = chunk.reason
        break
      default:
        break
    }
  }
  const calls = [...pending.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => call)
    .filter(call => call.name !== '')
    .map(call => ({ ...call, id: call.id === '' ? randomUUID() : call.id }))
  return { text, calls, ...usage === undefined ? {} : { usage }, ...finish === undefined ? {} : { finish } }
}

/** Route fields every request shares. */
function routeOf(selection: ModelSelection): Pick<LlmChatRequest, 'provider' | 'model'> & { reasoningEffort?: string } {
  return {
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
  }
}

/** Send the terminal event of one finished stream. */
function settle(sse: SseConnection, reason: FinishLike, usage: DoneUsage | undefined, signal: AbortSignal): void {
  if (reason.kind === 'error') {
    const event = failureEvent(reason.failure)
    sse.error(event.code, event.message)
    return
  }
  if (reason.kind === 'aborted') {
    // A client-side abort closed the connection; nothing will read an event.
    if (!signal.aborted) sse.error('ABORTED', reason.failure.message)
    return
  }
  sse.done(usage)
}
