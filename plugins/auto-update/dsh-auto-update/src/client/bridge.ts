/**
 * The two window-level contracts this browser half speaks.
 *
 * 1. **The desktop carrier.** The dsh-gui shell publishes `window.dshDesktop`
 *    (protocol version 1) in its own renderer only. An ordinary `dsh web` page,
 *    an iframe, or any other host never sees it, so the whole plugin stays
 *    inert there — the mount decision lives in `./index.ts` and only this
 *    predicate answers it.
 *
 * 2. **The AI-update channel.** `dsh-ai-update` (already installed in the
 *    desktop profile) listens at document top level for a
 *    `dsh-gui:ai-update` v1 message and answers `dsh-gui:ai-update-result`.
 *    Its only origin check is `event.source === window.parent`, and in the
 *    desktop page `window.parent === window`, so a plain `window.postMessage`
 *    is the accepted request path. This half therefore dispatches the request
 *    and waits for the receipt; it never creates a session, picks a workspace,
 *    or selects a preset — that is dsh-ai-update's job.
 */

/** The carrier the shell publishes; only `protocolVersion` is load-bearing here. */
export interface DesktopCarrier {
  readonly protocolVersion?: number
}

/** Request type accepted by dsh-ai-update. */
export const AI_UPDATE_REQUEST_TYPE = 'dsh-gui:ai-update'

/** Result type dsh-ai-update answers with. */
export const AI_UPDATE_RESULT_TYPE = 'dsh-gui:ai-update-result'

/** Protocol version of the AI-update channel. */
export const AI_UPDATE_VERSION = 1

/**
 * How long a dispatched AI-update request waits for its receipt. The plugin
 * has to load workspaces, open the session, and switch the preset, so the wait
 * is generous; a silent channel is reported as a timeout instead of hanging the
 * dialog forever.
 */
export const AI_UPDATE_TIMEOUT_MS = 60_000

/** Outcome of one AI-update dispatch. */
export interface AiUpdateOutcome {
  /** True only when dsh-ai-update confirmed the session and the draft. */
  readonly ok: boolean
  /** Readable reason when `ok` is false. */
  readonly error?: string
}

/** Request id sequence: unique per page, stable across re-mounts. */
let requestSeq = 0

/**
 * Read the desktop carrier published by the shell.
 * @returns the carrier when this document is the desktop renderer, else undefined.
 */
export function desktopCarrier(): DesktopCarrier | undefined {
  const carrier = (globalThis as typeof globalThis & { dshDesktop?: DesktopCarrier }).dshDesktop
  if (carrier?.protocolVersion !== 1) return undefined
  return carrier
}

/**
 * Dispatch one AI-update request and wait for dsh-ai-update's receipt.
 *
 * Resolves (never rejects) so every caller can render a readable outcome: a
 * missing plugin is indistinguishable from a silent one and surfaces as the
 * timeout reason.
 *
 * @param prompt - the draft dsh-ai-update prefills into the composer.
 * @returns the receipt, or a timeout/failure outcome.
 */
export function requestAiUpdate(prompt: string): Promise<AiUpdateOutcome> {
  return new Promise<AiUpdateOutcome>((resolve) => {
    const requestId = `dsh-auto-update-${Date.now().toString(36)}-${++requestSeq}`
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (outcome: AiUpdateOutcome): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      resolve(outcome)
    }

    /** The receipt for *this* request only (type + version + requestId). */
    function onMessage(event: MessageEvent): void {
      const data: unknown = event.data
      if (data === null || typeof data !== 'object') return
      const record = data as Record<string, unknown>
      if (record.type !== AI_UPDATE_RESULT_TYPE) return
      if (record.version !== AI_UPDATE_VERSION) return
      if (record.requestId !== requestId) return
      finish(record.ok === true
        ? { ok: true }
        : {
            ok: false,
            error: typeof record.error === 'string' && record.error !== ''
              ? record.error
              : 'AI 更新未成功（未返回原因）',
          })
    }

    timer = setTimeout(() => {
      finish({ ok: false, error: '内嵌前端无响应（确认 dsh-ai-update 插件已安装并重启）' })
    }, AI_UPDATE_TIMEOUT_MS)
    window.addEventListener('message', onMessage)
    try {
      window.postMessage({
        type: AI_UPDATE_REQUEST_TYPE,
        version: AI_UPDATE_VERSION,
        requestId,
        prompt,
      }, '*')
    } catch (error) {
      finish({ ok: false, error: `AI 更新请求派发失败：${messageOf(error)}` })
    }
  })
}

/** Human-readable error text. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
