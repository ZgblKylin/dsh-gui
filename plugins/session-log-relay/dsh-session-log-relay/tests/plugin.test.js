/**
 * `dsh-session-log-relay` 的接线测试：用假 ctx 驱动 `apply()`，验证两个触发点、
 * 跳过规则、补发请求形状与错误吞噬，不需要加载真实 harness。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../index.js'

/**
 * 构造一次插件加载所需的假 ctx 与会话表。
 * @param {object} [options] - `config` 传给 `apply()`；`stream` 替换补发流的实现；
 *   `listModels` 替换模型列表查询。
 * @returns {{ ctx: object, listeners: Map<string, Function[]>, relayCalls: object[], chunks: string[], session: object, sessions: Map<string, object>, listModelCalls: string[], warnings: unknown[][] }}
 */
function harness(options = {}) {
  const listeners = new Map()
  const relayCalls = []
  const chunks = []
  const listModelCalls = []
  const warnings = []
  const sessions = new Map()
  const session = { id: 'session-1', header: {} }
  sessions.set(session.id, session)
  const listModels = options.listModels ?? (async () => [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-flash' }])
  const ctx = {
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    llm: {
      async listModels(provider) {
        listModelCalls.push(provider)
        return listModels(provider)
      },
      stream(request) {
        relayCalls.push(request)
        const stream = options.stream ?? (async function* () { yield { type: 'text-delta', text: 'x' } })
        return stream(request)
      },
    },
    sessions: { get(id) { return sessions.get(id) } },
    logger: { warn(...args) { warnings.push(args) } },
  }
  apply(ctx, options.config)
  return { ctx, listeners, relayCalls, chunks, session, sessions, listModelCalls, warnings }
}

/**
 * 调用第一个已注册的处理器。
 * @param {Map<string, Function[]>} listeners - 事件表。
 * @param {string} event - 事件名。
 * @param {object} payload - 事件载荷。
 * @param {Function} next - 下游链。
 * @returns {Promise<unknown>} 处理器结果。
 */
function dispatch(listeners, event, payload, next) {
  const handler = listeners.get(event)?.[0]
  assert.equal(typeof handler, 'function', `missing listener for ${event}`)
  return handler(payload, next)
}

test('每 N 步触发一次补发，请求形状正确', async () => {
  const { listeners, relayCalls, listModelCalls, session } = harness({ config: { everySteps: 2 } })
  const step = (provider) => dispatch(listeners, 'agent/pre-step', {
    agent: { session },
    modelSelection: { provider },
    signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [] }))

  await step('gemini')
  assert.equal(relayCalls.length, 0, 'first step must not relay')
  await step('gemini')
  assert.equal(relayCalls.length, 1, 'second step must relay')

  const request = relayCalls[0]
  assert.equal(request.provider, 'deepseek-account')
  assert.equal(request.model, 'deepseek-v4-pro', 'auto 模式取模型列表第一位')
  assert.equal(request.maxTokens, 1)
  assert.equal(request.sessionId, 'session-1')
  assert.equal(request.purpose, 'session-log-relay')
  assert.equal(request.messages.length, 1)
  assert.ok(request.signal instanceof AbortSignal)
  assert.deepEqual(listModelCalls, ['deepseek-account'])
})

test('DeepSeek provider 的步骤不补发，也不计入步数', async () => {
  const { listeners, relayCalls, session } = harness({ config: { everySteps: 2 } })
  const step = (provider) => dispatch(listeners, 'agent/pre-step', {
    agent: { session },
    modelSelection: { provider },
    signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [] }))

  await step('deepseek-account')
  await step('deepseek-official')
  assert.equal(relayCalls.length, 0)
  await step('gemini')
  assert.equal(relayCalls.length, 0, 'skipped steps must not count toward everySteps')
  await step('gemini')
  assert.equal(relayCalls.length, 1)
})

test('reject 的决定不触发补发', async () => {
  const { listeners, relayCalls, session } = harness({ config: { everySteps: 1 } })
  await dispatch(listeners, 'agent/pre-step', {
    agent: { session }, modelSelection: { provider: 'gemini' }, signal: new AbortController().signal,
  }, async () => ({ kind: 'reject' }))
  assert.equal(relayCalls.length, 0)
})

test('enabled 为 false 时两个触发点都不补发', async () => {
  const { listeners, relayCalls, session } = harness({ config: { enabled: false, everySteps: 1 } })
  await dispatch(listeners, 'agent/pre-step', {
    agent: { session }, modelSelection: { provider: 'gemini' }, signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [] }))
  const stream = dispatch(listeners, 'llm/stream', { purpose: 'compaction', provider: 'gemini', sessionId: session.id }, () => (async function* () { yield { type: 'finish' } })())
  for await (const _chunk of stream) break
  assert.equal(relayCalls.length, 0)
})

test('压缩请求先补发，再把下游流交给调用方', async () => {
  const { listeners, relayCalls, session } = harness()
  const order = []
  const downstream = (async function* () {
    order.push('downstream')
    yield { type: 'finish' }
  })()
  const stream = dispatch(listeners, 'llm/stream', {
    purpose: 'compaction', provider: 'gemini', sessionId: session.id, signal: new AbortController().signal,
  }, () => downstream)
  const iterator = stream[Symbol.asyncIterator]()
  const first = await iterator.next()
  assert.equal(first.done, false)
  assert.deepEqual(order, ['downstream'])
  assert.equal(relayCalls.length, 1)
  assert.equal(relayCalls[0].purpose, 'session-log-relay')

  const next = await iterator.next()
  assert.equal(next.done, true)
})

test('非压缩请求与非存活会话原样透传', async () => {
  const { listeners, relayCalls, session } = harness()
  const main = dispatch(listeners, 'llm/stream', { provider: 'gemini', sessionId: session.id }, () => (async function* () { yield { type: 'finish' } })())
  for await (const _chunk of main) break
  assert.equal(relayCalls.length, 0)

  const missing = dispatch(listeners, 'llm/stream', { purpose: 'compaction', provider: 'gemini', sessionId: 'missing-session' }, () => (async function* () { yield { type: 'finish' } })())
  for await (const _chunk of missing) break
  assert.equal(relayCalls.length, 0)
})

test('补发失败被吞掉，不阻断 pre-step', async () => {
  const { listeners, session } = harness({
    config: { everySteps: 1 },
    stream: async function* () { throw Object.assign(new Error('no adapter registered for provider "deepseek-account"'), { code: 'NO_ADAPTER' }) },
  })
  const decision = await dispatch(listeners, 'agent/pre-step', {
    agent: { session }, modelSelection: { provider: 'gemini' }, signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [] }))
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
})

test('subagent 会话在 includeSubagentSessions=false 时跳过', async () => {
  const { listeners, relayCalls, sessions } = harness({ config: { everySteps: 1, includeSubagentSessions: false } })
  const child = { id: 'child-1', header: { origin: 'subagent' } }
  sessions.set(child.id, child)
  await dispatch(listeners, 'agent/pre-step', {
    agent: { session: child }, modelSelection: { provider: 'gemini' }, signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(relayCalls.length, 0)
})

test('显式 model 固定使用，不查询模型列表', async () => {
  const { listeners, relayCalls, listModelCalls, session } = harness({ config: { everySteps: 1, model: 'deepseek-flash' } })
  await dispatch(listeners, 'agent/pre-step', {
    agent: { session }, modelSelection: { provider: 'gemini' }, signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(relayCalls.length, 1)
  assert.equal(relayCalls[0].model, 'deepseek-flash')
  assert.deepEqual(listModelCalls, [], '显式模型不查询模型列表')
})

test('模型列表为空时只告警，pre-step 返回原决定', async () => {
  const h = harness({ config: { everySteps: 1 }, listModels: async () => [] })
  const decision = await dispatch(h.listeners, 'agent/pre-step', {
    agent: { session: h.session }, modelSelection: { provider: 'gemini' }, signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [] }))
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
  assert.equal(h.relayCalls.length, 0, '未解析出模型时不发起补发请求')
  assert.equal(h.warnings.length, 1)
  assert.match(String(h.warnings[0][0]), /^\[session-log-relay\].*no usable model/)
})
