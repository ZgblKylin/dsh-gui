/**
 * `dsh-session-log-relay`：为使用非 DeepSeek 模型的会话补发会话日志。
 *
 * 会话日志由 `@deepseek-ai/dsh-session-log-deepseek` 贡献成请求体的顶层扩展字段
 * `dsh_session_log`，而读取并发送该扩展字段的只有 DeepSeek 适配器。会话使用其它
 * provider 时，正常请求不经过该适配器，日志停在本地。本插件按策略向配置的 DeepSeek
 * 路由发起一次极小请求：适配器在 HTTP 2xx 之后、读取 SSE 之前执行扩展项的 `accept()`，
 * 会话日志的接受水位因此前进。
 *
 * 两个触发点：
 * - `agent/pre-step`：每 `everySteps` 个可补发步骤补发一次；
 * - `llm/stream`：`purpose === 'compaction'` 的压缩请求转发前补发一次。
 *
 * 补发请求的 `purpose` 是 `session-log-relay`，与压缩请求不同，因此不会再次命中压缩
 * 触发点。补发失败只记录日志，不阻断主流程；同一错误按错误码或消息去重。
 *
 * 本文件只 import 同包的 `./logic.js`，不 import 任何 npm 包或 `@deepseek-ai/*` 模块；
 * `llm`、`sessions` 与 `logger` 都从 `ctx` 取。`ctx.on()` 注册的监听随插件 effect
 * 作用域卸载。
 *
 * @module dsh-session-log-relay
 */

import {
  chooseFirstModel,
  isStepTrigger,
  isSubagentSession,
  normalizeConfig,
  relayRequest,
  shouldRelayBeforeCompaction,
  shouldSkipProvider,
  throttled,
} from './logic.js'

/** Cordis 插件名，用于 Loader 诊断。 */
export const name = 'session-log-relay'

/** 本插件消费的 Host 服务。 */
export const inject = ['llm', 'sessions']

/**
 * 安装两个补发触发点，并构造共用的补发逻辑。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {unknown} rawConfig - `cordis.patch.yml` 的 `config:` 块。
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)

  /** 每个会话最近一次补发尝试的时间戳，只用于本地节流。 */
  const relayedAt = new WeakMap()
  /** 正在补发的会话，避免同一会话并发补发。 */
  const inFlight = new WeakSet()
  /** 已告警过的错误键，避免同一错误反复打印。 */
  const warned = new Set()
  /** 每个会话自本次加载以来进入过的可补发步骤数。 */
  const stepCounts = new WeakMap()

  ctx.on('agent/pre-step', async (payload, next) => {
    // 先让 `next()` 完成下游决定（压缩等）再补发：下游若在同一步里触发压缩请求，
    // 它的上传会先结束，避免第 N 步的请求与本次补发并发、重复上传同一段日志。
    // 代价是这一步的请求要等补发结束：补发流受 `timeoutMs` 约束，`model: 'auto'`
    // 查询模型列表时另加该查询自身的耗时。
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (!cfg.enabled) return decision
    if (shouldSkipProvider(payload?.modelSelection?.provider, cfg)) return decision
    const session = payload?.agent?.session
    if (session === undefined) return decision
    if (!cfg.includeSubagentSessions && isSubagentSession(session)) return decision
    const count = (stepCounts.get(session) ?? 0) + 1
    stepCounts.set(session, count)
    if (!isStepTrigger(count, cfg)) return decision
    await relay(ctx, cfg, session, payload.signal)
    return decision
  })

  // 压缩（阈值触发、溢出触发、手动 /compact）都经过 purpose === 'compaction' 的
  // llm/stream，因此在这里上传；补发请求自身的 purpose 不同，不会递归。
  ctx.on('llm/stream', (options, next) => {
    if (!shouldRelayBeforeCompaction(options, cfg)) return next()
    const sessionId = options.sessionId
    if (sessionId === undefined || sessionId === null || sessionId === '') return next()
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) return next()
    const downstream = next()
    return (async function* relayBeforeCompaction() {
      // 补发完成后才把压缩请求交给下游；两者共用触发点的取消信号。
      await relay(ctx, cfg, session, options.signal)
      yield* downstream
    })()
  })

  /**
   * 向 DeepSeek 路由发出一次最大 `maxTokens` 的请求，让会话日志随 `dsh_session_log`
   * 字段上传。任何错误都在这里消化，绝不向调用方抛出。
   * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
   * @param {ReturnType<typeof normalizeConfig>} cfg - 归一后的配置。
   * @param {{ id: string, header?: { origin?: string } | null }} session - 存活会话。
   * @param {AbortSignal | undefined} outerSignal - 触发点的取消信号。
   * @returns {Promise<void>}
   */
  async function relay(ctx, cfg, session, outerSignal) {
    if (inFlight.has(session)) return
    if (throttled(relayedAt.get(session), Date.now(), cfg)) return
    inFlight.add(session)
    try {
      const timeout = AbortSignal.timeout(cfg.timeoutMs)
      const signal = outerSignal === undefined || outerSignal === null
        ? timeout
        : AbortSignal.any([outerSignal, timeout])
      // `'auto'` 每次补发都向路由要当前模型列表（路由自身有 10 分钟刷新缓存），
      // 官方模型列表更新后无需改配置；显式 `model` 则固定使用。
      let model = cfg.model
      if (model === 'auto') {
        const models = await ctx.llm.listModels(cfg.provider)
        model = chooseFirstModel(models)
      }
      if (model === undefined) {
        throw new Error(`session-log-relay: provider "${cfg.provider}" advertises no usable model`)
      }
      const stream = ctx.llm.stream({ ...relayRequest(cfg, session.id, model), signal })
      // 适配器在 HTTP 2xx 之后、读取 SSE 之前调用扩展项的 accept()，收到首帧即说明
      // 接受事务已经完成，无需把整条流读完。
      for await (const _chunk of stream) break
    } catch (error) {
      warnOnce(ctx, error)
    } finally {
      inFlight.delete(session)
      relayedAt.set(session, Date.now())
    }
  }

  /**
   * 同一个错误键只告警一次。
   * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
   * @param {unknown} error - 补发失败的错误。
   * @returns {void}
   */
  function warnOnce(ctx, error) {
    const key = error?.code ?? String(error?.message ?? error)
    if (warned.has(key)) return
    warned.add(key)
    const detail = error instanceof Error ? error.message : String(error)
    const message = `[session-log-relay] 补发会话日志失败：${detail}`
    if (ctx.logger !== undefined && ctx.logger !== null && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn(message, error)
      return
    }
    console.warn(message, error)
  }
}
