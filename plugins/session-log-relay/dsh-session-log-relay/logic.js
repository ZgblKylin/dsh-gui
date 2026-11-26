/**
 * `dsh-session-log-relay` 的决策层：配置归一、补发时机判断与模型选择。
 *
 * 全部为纯函数，不访问 `ctx`、不发起请求，因此可以用 `node --test` 直接覆盖边界值。
 * 配置来自用户手写的 profile `cordis.patch.yml`，单个字段写错时回落到默认值而不是
 * 抛错，避免整个插件因一个笔误加载失败。
 *
 * @module dsh-session-log-relay/logic
 */

/** 配置默认值：`normalizeConfig` 逐字段回落到这里。 */
const DEFAULTS = Object.freeze({
  enabled: true,
  everySteps: 10,
  beforeCompaction: true,
  provider: 'deepseek-account',
  model: 'auto',
  maxTokens: 1,
  timeoutMs: 15_000,
  minIntervalMs: 3_000,
  skipProviders: Object.freeze(['deepseek-official', 'deepseek-account']),
  includeSubagentSessions: true,
})

/**
 * 读取布尔字段。
 * @param {unknown} value - 原始字段值。
 * @param {boolean} fallback - 非布尔时使用的默认值。
 * @returns {boolean} 字段的布尔值，或默认值。
 */
function booleanOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * 读取正整数字段。
 * @param {unknown} value - 原始字段值。
 * @param {number} fallback - 非正整数时使用的默认值。
 * @returns {number} 字段的正整数值，或默认值。
 */
function positiveIntegerOr(value, fallback) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/**
 * 读取非空字符串字段，去掉首尾空白。
 * @param {unknown} value - 原始字段值。
 * @param {string} fallback - 非字符串或空字符串时使用的默认值。
 * @returns {string} 去空白后的字段值，或默认值。
 */
function nameOr(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed === '' ? fallback : trimmed
}

/**
 * 读取 provider 跳过列表。元素全为字符串时保留并去掉首尾空白，否则回落到默认列表。
 * 每次返回新数组，调用方修改结果不会影响默认值。
 * @param {unknown} value - 原始字段值。
 * @param {readonly string[]} fallback - 非法时使用的默认列表。
 * @returns {string[]} provider 名列表。
 */
function providerListOr(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  if (!value.every(item => typeof item === 'string')) return [...fallback]
  return value.map(item => item.trim())
}

/**
 * 把 Loader 传入的原始 `config:` 块归一成完整配置。缺失或非法字段逐项回落到默认值，
 * 不抛错。
 * @param {unknown} raw - `cordis.patch.yml` 里的 `config:` 块。
 * @returns {{ enabled: boolean, everySteps: number, beforeCompaction: boolean, provider: string, model: string, maxTokens: number, timeoutMs: number, minIntervalMs: number, skipProviders: string[], includeSubagentSessions: boolean }}
 *   完整配置。
 */
export function normalizeConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    enabled: booleanOr(config.enabled, DEFAULTS.enabled),
    everySteps: positiveIntegerOr(config.everySteps, DEFAULTS.everySteps),
    beforeCompaction: booleanOr(config.beforeCompaction, DEFAULTS.beforeCompaction),
    provider: nameOr(config.provider, DEFAULTS.provider),
    model: nameOr(config.model, DEFAULTS.model),
    maxTokens: positiveIntegerOr(config.maxTokens, DEFAULTS.maxTokens),
    timeoutMs: positiveIntegerOr(config.timeoutMs, DEFAULTS.timeoutMs),
    minIntervalMs: positiveIntegerOr(config.minIntervalMs, DEFAULTS.minIntervalMs),
    skipProviders: providerListOr(config.skipProviders, DEFAULTS.skipProviders),
    includeSubagentSessions: booleanOr(config.includeSubagentSessions, DEFAULTS.includeSubagentSessions),
  }
}

/**
 * 判断某个 provider 是否跳过补发：provider 为空，或命中 `skipProviders`。
 * 默认列表里的两个 DeepSeek 路由会随正常请求挂带 `dsh_session_log`，无需补发。
 * @param {unknown} provider - 步骤或压缩请求的 provider。
 * @param {ReturnType<typeof normalizeConfig>} cfg - 归一后的配置。
 * @returns {boolean} 是否跳过。
 */
export function shouldSkipProvider(provider, cfg) {
  const name = typeof provider === 'string' ? provider.trim() : ''
  if (name === '') return true
  return cfg.skipProviders.includes(name)
}

/**
 * 判断步骤计数是否命中补发间隔。
 * @param {number} count - 当前会话的可补发步骤数。
 * @param {ReturnType<typeof normalizeConfig>} cfg - 归一后的配置。
 * @returns {boolean} 计数为正且是 `everySteps` 的整数倍时为 true。
 */
export function isStepTrigger(count, cfg) {
  return cfg.everySteps > 0 && count > 0 && count % cfg.everySteps === 0
}

/**
 * 判断压缩请求是否需要在转发前补发。
 * @param {{ provider?: string, purpose?: string } | null | undefined} options - `llm/stream` 的请求选项。
 * @param {ReturnType<typeof normalizeConfig>} cfg - 归一后的配置。
 * @returns {boolean} 开关开启、允许压缩前补发、请求目的为 `compaction` 且 provider 未命中跳过规则时为 true。
 */
export function shouldRelayBeforeCompaction(options, cfg) {
  return cfg.enabled
    && cfg.beforeCompaction
    && options?.purpose === 'compaction'
    && !shouldSkipProvider(options.provider, cfg)
}

/**
 * 从路由返回的模型列表里取第一项的模型 id，作为 `model: 'auto'` 的解析结果。
 * @param {unknown} models - 路由返回的模型列表。
 * @returns {string | undefined} 首项模型 id（去掉首尾空白后非空）；入参非数组、数组为空或首项 id 非法时为 undefined。
 */
export function chooseFirstModel(models) {
  if (!Array.isArray(models) || models.length === 0) return undefined
  const id = models[0]?.id
  if (typeof id !== 'string') return undefined
  const trimmed = id.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 构造一次最小补发请求。`relay()` 调用 `ctx.llm.stream` 时再补上 `signal`。
 * @param {ReturnType<typeof normalizeConfig>} cfg - 归一后的配置。
 * @param {string} sessionId - 目标会话 id。
 * @param {string} model - 实际使用的模型 id：显式配置值，或 `auto` 的解析结果。
 * @returns {{ provider: string, model: string, maxTokens: number, sessionId: string, purpose: 'session-log-relay', messages: Array<{ role: 'user', content: Array<{ type: 'text', text: string }> }> }}
 *   可直接展开给 `ctx.llm.stream` 的请求选项。
 */
export function relayRequest(cfg, sessionId, model) {
  return {
    provider: cfg.provider,
    model,
    maxTokens: cfg.maxTokens,
    sessionId,
    purpose: 'session-log-relay',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'dsh session-log relay' }] }],
  }
}

/**
 * 判断会话是否由 subagent 创建。
 * @param {{ header?: { origin?: string } | null } | null | undefined} session - 会话对象。
 * @returns {boolean} `header.origin === 'subagent'` 时为 true。
 */
export function isSubagentSession(session) {
  return session?.header?.origin === 'subagent'
}

/**
 * 判断同一会话的补发是否仍在本地节流窗口内。
 * @param {number | undefined} lastAt - 上次补发尝试的时间戳。
 * @param {number} now - 当前时间戳。
 * @param {ReturnType<typeof normalizeConfig>} cfg - 归一后的配置。
 * @returns {boolean} 上次尝试存在且距现在不足 `minIntervalMs` 时为 true。
 */
export function throttled(lastAt, now, cfg) {
  return lastAt !== undefined && now - lastAt < cfg.minIntervalMs
}
