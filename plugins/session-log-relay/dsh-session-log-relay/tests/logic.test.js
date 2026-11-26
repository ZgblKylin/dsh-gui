import assert from 'node:assert/strict'
import test from 'node:test'

import {
  chooseFirstModel,
  isStepTrigger,
  isSubagentSession,
  normalizeConfig,
  relayRequest,
  shouldRelayBeforeCompaction,
  shouldSkipProvider,
  throttled,
} from '../logic.js'

/** 全部字段回落到默认值时的结果，供逐项对照。 */
const DEFAULTS = {
  enabled: true,
  everySteps: 10,
  beforeCompaction: true,
  provider: 'deepseek-account',
  model: 'auto',
  maxTokens: 1,
  timeoutMs: 15_000,
  minIntervalMs: 3_000,
  skipProviders: ['deepseek-official', 'deepseek-account'],
  includeSubagentSessions: true,
}

test('normalizeConfig：缺失、null 与非对象输入返回默认值', () => {
  for (const raw of [undefined, null, {}, 'enabled: true', 42, []]) {
    assert.deepEqual(normalizeConfig(raw), DEFAULTS)
  }
})

test('normalizeConfig：非法字段逐项回落到默认值', () => {
  const cfg = normalizeConfig({
    enabled: 'true',
    everySteps: 0,
    beforeCompaction: 1,
    provider: '   ',
    model: null,
    maxTokens: 1.5,
    timeoutMs: -1,
    minIntervalMs: 0,
    skipProviders: ['deepseek-official', 7],
    includeSubagentSessions: 'yes',
  })
  assert.deepEqual(cfg, DEFAULTS)
})

test('normalizeConfig：合法覆盖值被保留并去掉首尾空白', () => {
  const cfg = normalizeConfig({
    enabled: false,
    everySteps: 3,
    beforeCompaction: false,
    provider: ' deepseek-account ',
    model: 'deepseek-flash',
    maxTokens: 8,
    timeoutMs: 500,
    minIntervalMs: 250,
    skipProviders: [' deepseek-official ', 'custom'],
    includeSubagentSessions: false,
  })
  assert.deepEqual(cfg, {
    enabled: false,
    everySteps: 3,
    beforeCompaction: false,
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    maxTokens: 8,
    timeoutMs: 500,
    minIntervalMs: 250,
    skipProviders: ['deepseek-official', 'custom'],
    includeSubagentSessions: false,
  })
})

test('normalizeConfig：每次返回独立的 skipProviders 数组，空列表合法', () => {
  const first = normalizeConfig(undefined)
  first.skipProviders.push('injected')
  assert.deepEqual(normalizeConfig(undefined).skipProviders, DEFAULTS.skipProviders)
  assert.deepEqual(normalizeConfig({ skipProviders: [] }).skipProviders, [])
})

test('shouldSkipProvider：空 provider 与命中列表的 provider 跳过', () => {
  const cfg = normalizeConfig(undefined)
  for (const provider of [undefined, null, '', '   ', 42, 'deepseek-official', 'deepseek-account', ' deepseek-account ']) {
    assert.equal(shouldSkipProvider(provider, cfg), true, String(provider))
  }
  assert.equal(shouldSkipProvider('opencode-go', cfg), false)
})

test('shouldSkipProvider：空跳过列表不拦截任何非空 provider', () => {
  const cfg = normalizeConfig({ skipProviders: [] })
  assert.equal(shouldSkipProvider('deepseek-account', cfg), false)
  assert.equal(shouldSkipProvider('deepseek-official', cfg), false)
  assert.equal(shouldSkipProvider('', cfg), true)
})

test('isStepTrigger：正计数命中 everySteps 的整数倍才触发', () => {
  const cfg = normalizeConfig({ everySteps: 3 })
  assert.equal(isStepTrigger(1, cfg), false)
  assert.equal(isStepTrigger(3, cfg), true)
  assert.equal(isStepTrigger(6, cfg), true)
  assert.equal(isStepTrigger(7, cfg), false)
  assert.equal(isStepTrigger(0, cfg), false)
  assert.equal(isStepTrigger(-3, cfg), false)
  assert.equal(isStepTrigger(3.5, cfg), false)
})

test('isStepTrigger：everySteps 非正时不触发', () => {
  const base = normalizeConfig(undefined)
  assert.equal(isStepTrigger(10, { ...base, everySteps: 0 }), false)
  assert.equal(isStepTrigger(10, { ...base, everySteps: -2 }), false)
  assert.equal(isStepTrigger(10, { ...base, everySteps: 1 }), true)
})

test('shouldRelayBeforeCompaction：压缩请求且 provider 未命中跳过规则时触发', () => {
  const cfg = normalizeConfig(undefined)
  assert.equal(shouldRelayBeforeCompaction({ provider: 'opencode-go', purpose: 'compaction' }, cfg), true)
  assert.equal(shouldRelayBeforeCompaction({ provider: 'opencode-go', purpose: 'chat' }, cfg), false)
  assert.equal(shouldRelayBeforeCompaction({ provider: 'opencode-go' }, cfg), false)
  assert.equal(shouldRelayBeforeCompaction({ provider: 'deepseek-official', purpose: 'compaction' }, cfg), false)
  assert.equal(shouldRelayBeforeCompaction({ provider: 'deepseek-account', purpose: 'compaction' }, cfg), false)
  assert.equal(shouldRelayBeforeCompaction({ provider: '', purpose: 'compaction' }, cfg), false)
  assert.equal(shouldRelayBeforeCompaction(null, cfg), false)
})

test('shouldRelayBeforeCompaction：开关关闭时不触发', () => {
  const request = { provider: 'opencode-go', purpose: 'compaction' }
  assert.equal(shouldRelayBeforeCompaction(request, normalizeConfig({ enabled: false })), false)
  assert.equal(shouldRelayBeforeCompaction(request, normalizeConfig({ beforeCompaction: false })), false)
})

test('relayRequest：构造最小补发请求且不含 signal', () => {
  const request = relayRequest(normalizeConfig(undefined), 'session-1', 'deepseek-v4-pro')
  assert.deepEqual(request, {
    provider: 'deepseek-account',
    model: 'deepseek-v4-pro',
    maxTokens: 1,
    sessionId: 'session-1',
    purpose: 'session-log-relay',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'dsh session-log relay' }] }],
  })
  assert.equal(Object.hasOwn(request, 'signal'), false)
  assert.equal(Object.hasOwn(request, 'system'), false)
  assert.equal(Object.hasOwn(request, 'tools'), false)
})

test('relayRequest：使用配置中的路由与输出上限，模型取自参数', () => {
  const cfg = normalizeConfig({ provider: 'deepseek-official', maxTokens: 4 })
  const request = relayRequest(cfg, 'session-2', 'deepseek-v4-pro')
  assert.equal(request.provider, 'deepseek-official')
  assert.equal(request.model, 'deepseek-v4-pro')
  assert.equal(request.maxTokens, 4)
  assert.equal(request.sessionId, 'session-2')
  assert.notEqual(request.model, cfg.model)
})

test('chooseFirstModel：取首项 id 并去掉首尾空白', () => {
  assert.equal(chooseFirstModel([{ id: ' deepseek-v4-pro ', provider: 'deepseek-account' }, { id: 'deepseek-flash' }]), 'deepseek-v4-pro')
  assert.equal(chooseFirstModel([{ id: 'deepseek-flash' }, { id: 42 }]), 'deepseek-flash')
})

test('chooseFirstModel：首项 id 非法时返回 undefined', () => {
  for (const models of [
    [{ id: '' }],
    [{ id: '   ' }],
    [{ id: 42 }],
    [{ name: 'deepseek-flash' }],
    [null],
    ['deepseek-flash'],
  ]) {
    assert.equal(chooseFirstModel(models), undefined)
  }
})

test('chooseFirstModel：空数组与非数组入参返回 undefined', () => {
  for (const models of [undefined, null, 'deepseek-flash', {}, []]) {
    assert.equal(chooseFirstModel(models), undefined)
  }
})

test('throttled：缺少上次尝试时间时不节流', () => {
  assert.equal(throttled(undefined, 10_000, normalizeConfig(undefined)), false)
})

test('throttled：窗口内节流，达到窗口即放行', () => {
  const cfg = normalizeConfig({ minIntervalMs: 3_000 })
  assert.equal(throttled(1_000, 3_999, cfg), true)
  assert.equal(throttled(1_000, 4_000, cfg), false)
  assert.equal(throttled(1_000, 4_001, cfg), false)
  assert.equal(throttled(0, 2_999, cfg), true)
})

test('throttled：使用配置的最小间隔', () => {
  const cfg = normalizeConfig({ minIntervalMs: 100 })
  assert.equal(throttled(1_000, 1_050, cfg), true)
  assert.equal(throttled(1_000, 1_100, cfg), false)
})

test('isSubagentSession：只认 header.origin 为 subagent 的会话', () => {
  assert.equal(isSubagentSession({ header: { origin: 'subagent' } }), true)
  assert.equal(isSubagentSession({ header: { origin: 'user' } }), false)
  assert.equal(isSubagentSession({ header: {} }), false)
  assert.equal(isSubagentSession({}), false)
  assert.equal(isSubagentSession({ header: null }), false)
  assert.equal(isSubagentSession(undefined), false)
  assert.equal(isSubagentSession(null), false)
})
