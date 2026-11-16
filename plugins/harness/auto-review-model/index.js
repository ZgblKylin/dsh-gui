/**
 * dsh-auto-review-model：把 Auto review 的审查请求改派到配置的 provider 与模型。
 *
 * Auto review 没有 reviewer 模型配置：它从被审 agent 的最新请求头取 provider 与
 * model，再以 `purpose: 'auto-review'` 标签、深层冻结的对象把审查请求交给
 * `ctx.llm.stream`。本插件在该调用的 waterfall 最前端识别这个标签，构造替换请求并
 * 重新派发；其余请求原样交回后续链。
 *
 * 改派依赖三条 harness 内部约定，升级 harness 后必须按 README 的「Harness 升级检查
 * 清单」逐条复核：
 * - auto-review 仍用 `purpose: 'auto-review'` 标记审查请求；
 * - `llm/stream` 仍是 waterfall，listener 不调用 `next()` 即让整条链短路，其返回值即
 *   最外层返回值；
 * - provider 解析发生在 waterfall 之后，替换请求重新进入 `ctx.llm.stream` 后按新
 *   provider 选择适配器。
 *
 * 审查请求到达时已冻结，禁止原地改写；替换对象记入 `WeakSet`，它重入 waterfall 时
 * 直接放行，因此一次审查只发生一次改派。
 *
 * 除 Schemastery 的 `Config` 声明外，本包不 import 任何 `@deepseek-ai/*` 运行时值，只
 * 使用 Cordis 上下文提供的 `llm` 与 `logger`。schema 让 settings 服务把可编辑字段投影
 * 成插件信息页的表单；因此 `@deepseek-ai/schemastery` 是本包的 peer。
 *
 * 每个字段都声明为 `.volatile()`，Loader 因此传回可变的引用对象而不是定值。引用在每次
 * 审查时重新读取，插件信息页的保存无需重载本 entry 即生效。
 *
 * @module dsh-auto-review-model
 */

import z from '@deepseek-ai/schemastery'

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'auto-review-model'

/** 本插件消费的 Host 服务。 */
export const inject = ['llm']

/**
 * Loader 配置 schema。settings 服务只把 `volatile()` 字段投影到插件信息页的表单，
 * 表单写入 profile 的 Cordis patch，优先级高于包内 `cordis.patch.yml`。
 *
 * `enabled` 缺省为 true，让既有 `config` 块无需改动即保持现有行为；`provider` 与
 * `model` 成对出现才构成改派路由。
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  provider: z.string().volatile(),
  model: z.string().volatile(),
  reasoningEffort: z.string().volatile(),
})

/** auto-review 打在审查请求上的 purpose 标签。 */
const AUTO_REVIEW_PURPOSE = 'auto-review'

/**
 * Read one configuration field. A `.volatile()` field arrives as a reference object
 * whose `get()` returns the current stored value; a plain value passes through so
 * direct callers can configure the plugin without Schemastery.
 * @param {unknown} field - one `config:` entry as the Loader supplied it.
 * @returns {unknown} the current value, or undefined when unset.
 */
function unwrap(field) {
  if (field !== null && typeof field === 'object' && typeof field.get === 'function') return field.get()
  return field
}

/**
 * 读取开关字段。
 * @param {object} config - `config:` 块，字段可能是 volatile 引用。
 * @returns {boolean} 缺省视为开启。
 * @throws {TypeError} 字段存在但不是 boolean 时。
 */
function readEnabled(config) {
  const current = unwrap(config.enabled)
  if (current === undefined) return true
  if (typeof current !== 'boolean') throw new TypeError('auto-review-model: "enabled" must be a boolean')
  return current
}

/**
 * 读取一个可选的路由字段。
 * @param {object} config - `config:` 块，字段可能是 volatile 引用。
 * @param {string} field - 报错时使用的字段名。
 * @returns {string | undefined} 去空格后的字段值；字段缺省或为空时为 undefined。
 * @throws {TypeError} 字段存在但不是字符串时。
 */
function optionalName(config, field) {
  const current = unwrap(config[field])
  if (current === undefined) return undefined
  if (typeof current !== 'string') {
    throw new TypeError(`auto-review-model: "${field}" must be a non-empty string`)
  }
  const trimmed = current.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 校验当前配置。Loader 已按 schema 校验类型，这里再校验成对关系与空值，让直接构造
 * 配置的调用方同样 fail loud。
 * @param {unknown} raw - `cordis.patch.yml` 的 `config:` 块。
 * @returns {{ enabled: boolean, provider?: string, model?: string, reasoningEffort?: string }}
 *   开关状态；配置了路由时附带路由字段。
 * @throws {TypeError} `provider` 与 `model` 不成对或字段类型错误时。
 */
function readRoute(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const enabled = readEnabled(config)
  const provider = optionalName(config, 'provider')
  const model = optionalName(config, 'model')
  const reasoningEffort = optionalName(config, 'reasoningEffort')
  if (provider === undefined && model === undefined) {
    if (reasoningEffort !== undefined) {
      throw new TypeError('auto-review-model: "reasoningEffort" needs both "provider" and "model"')
    }
    return { enabled }
  }
  if (provider === undefined || model === undefined) {
    throw new TypeError('auto-review-model: "provider" and "model" must be configured together')
  }
  return reasoningEffort === undefined
    ? { enabled, provider, model }
    : { enabled, provider, model, reasoningEffort }
}

/**
 * 挂载改派监听。
 *
 * 监听始终注册：字段是 volatile 引用，插件信息页保存后由下一次审查读取新值；未配置
 * 或关闭时该监听直接放行，等于不介入。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文；`llm` 是声明的硬依赖。
 * @param {unknown} rawConfig - `cordis.patch.yml` 的 `config:` 块。
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const initial = readRoute(rawConfig)
  if (!initial.enabled) {
    ctx.logger?.info('auto-review-model: 已关闭自定义审查模型，Auto review 继续使用 agent 当前模型')
  } else if (initial.provider === undefined) {
    ctx.logger?.info('auto-review-model: 未配置 provider/model，Auto review 继续使用 agent 当前模型')
  }

  /** 本次改派构造的请求对象：据此让它们重入 waterfall 时直接放行。 */
  const redirected = new WeakSet()

  ctx.on('llm/stream', (options, next) => {
    if (options?.purpose !== AUTO_REVIEW_PURPOSE) return next()
    if (redirected.has(options)) return next()
    const route = readRoute(rawConfig)
    if (!route.enabled || route.provider === undefined) return next()
    const redirect = {
      ...options,
      provider: route.provider,
      model: route.model,
      ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
    }
    redirected.add(redirect)
    return ctx.llm.stream(redirect)
  }, { prepend: true })
}
