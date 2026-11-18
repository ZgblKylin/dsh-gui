/**
 * Server-sent-events bridge between one chat request and the LLM stream.
 *
 * The wire protocol is fixed by `.work/contract.md` §5: `meta` first, then any
 * number of `delta` events, then exactly one terminal `done` or `error`. The
 * connection is text/event-stream, never cached, and closing it aborts the
 * model call so a dismissed overlay stops paying for tokens.
 */

import type { ServerResponse } from 'node:http'
import type { GenerateOptions, LlmFailure, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'

import type { ModelSelection } from './catalog.ts'

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
  messages: LlmMessage[]
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
}

/**
 * Stream one chat run into an SSE response.
 * @param options - run inputs and the response to stream into.
 * @returns fulfillment after the response closed (or the client vanished).
 */
export async function streamChat(options: StreamChatOptions): Promise<void> {
  const { llm, res, mode, selection, messages, system, signal } = options
  const sse = openSse(res)
  const request: LlmChatRequest = {
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
    ...system === undefined ? {} : { system },
    messages,
    purpose: 'quick-assistant',
    signal,
  }
  let usage: DoneUsage | undefined
  try {
    let chunks: AsyncIterable<StreamChunk>
    try {
      chunks = llm.stream(request)
    } catch (error) {
      sse.error(errorCode(error), messageOf(error))
      return
    }
    sse.meta({ mode, provider: selection.provider, model: selection.model })
    for await (const chunk of chunks) {
      switch (chunk.type) {
        case 'text-delta':
          sse.delta(chunk.text)
          break
        case 'usage':
          usage = doneUsage(chunk.usage)
          break
        case 'finish': {
          const reason = chunk.reason
          if (reason.kind === 'error') {
            const event = failureEvent(reason.failure)
            sse.error(event.code, event.message)
          } else if (reason.kind === 'aborted') {
            // A client-side abort closed the connection; nothing will read an event.
            if (!signal.aborted) sse.error('ABORTED', reason.failure.message)
          } else {
            sse.done(usage)
          }
          break
        }
        default:
          // Block markers and tool deltas are not part of this protocol.
          break
      }
    }
    // A stream that ended without a terminal chunk still has to close the protocol.
    sse.done(usage)
  } catch (error) {
    if (!signal.aborted) sse.error(errorCode(error), messageOf(error))
  } finally {
    sse.end()
  }
}
