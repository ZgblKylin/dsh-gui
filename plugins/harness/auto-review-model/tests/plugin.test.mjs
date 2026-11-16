import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

import { resolve as resolveSchemastery } from './support/module-hook.mjs'

// The Host half declares its Config schema through a schemastery peer; DSH's
// profile resolver supplies it at runtime, and the test hook supplies the local
// DSH installation here.
registerHooks({ resolve: resolveSchemastery })

const { apply, Config, inject, name } = await import('../index.js')

/**
 * Deep-freeze a request the way auto-review freezes its reviewer options, so a
 * mutation attempt would throw instead of silently succeeding.
 * @param {unknown} value - the value to freeze recursively.
 * @returns {unknown} the same, now-frozen value.
 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

/**
 * Fake Cordis context whose `llm/stream` dispatch mirrors the waterfall: each
 * listener receives the same request plus a `next` continuation, and the
 * terminal records what reached the adapter.
 * @param {{ info?: (message: string) => void }} [options] - logger override.
 * @returns {{
 *   ctx: Record<string, unknown>,
 *   listeners: Function[],
 *   streamCalls: object[],
 *   adapters: object[],
 * }} the context plus the recorded dispatch state.
 */
function makeContext({ info } = {}) {
  const listeners = []
  const streamCalls = []
  const adapters = []

  const dispatch = (request) => {
    const callbacks = [...listeners]
    const run = () => {
      const callback = callbacks.shift()
      if (callback === undefined) {
        adapters.push(request)
        return request
      }
      let called = false
      const next = () => {
        if (called) throw new Error('next() called multiple times')
        called = true
        return run()
      }
      return callback(request, next)
    }
    return run()
  }

  const ctx = {
    logger: { info: info ?? (() => {}), warn() {}, error() {} },
    on(event, listener) {
      assert.equal(event, 'llm/stream')
      listeners.push(listener)
      return () => {}
    },
    llm: {
      stream(request) {
        streamCalls.push(request)
        return dispatch(request)
      },
    },
  }
  return { ctx, listeners, streamCalls, adapters }
}

test('declares the loader identity and its single hard dependency', () => {
  assert.equal(name, 'auto-review-model')
  assert.deepEqual(inject, ['llm'])
})

test('redirects an auto-review request to the configured route', () => {
  const { ctx, streamCalls, adapters } = makeContext()
  apply(ctx, { provider: 'cheap-route', model: 'cheap-model' })

  const messages = [{ role: 'user', content: [{ type: 'text', text: 'REVIEW' }] }]
  const request = deepFreeze({
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
    purpose: 'auto-review',
    sessionId: 'session-1',
    temperature: 0,
    messages,
  })

  const reached = ctx.llm.stream(request)
  const redirect = streamCalls[1]

  assert.equal(redirect.provider, 'cheap-route')
  assert.equal(redirect.model, 'cheap-model')
  assert.equal(redirect.purpose, 'auto-review')
  assert.equal(redirect.sessionId, 'session-1')
  assert.equal(redirect.temperature, 0)
  assert.equal(redirect.messages, messages)
  assert.equal(reached, redirect)
  assert.equal(adapters.length, 1)
  assert.equal(adapters[0], redirect)
})

test('passes a non-auto-review request through untouched', () => {
  const { ctx, streamCalls, adapters } = makeContext()
  apply(ctx, { provider: 'cheap-route', model: 'cheap-model' })

  const request = deepFreeze({ provider: 'opencode-go', model: 'main', purpose: 'compaction', messages: [] })
  const reached = ctx.llm.stream(request)

  assert.equal(reached, request)
  assert.equal(streamCalls.length, 1, 'a non-review request must not be re-dispatched')
  assert.equal(adapters.length, 1)
  assert.equal(adapters[0].provider, 'opencode-go')
})

test('stays inert without a configured route', () => {
  for (const config of [undefined, null, {}]) {
    const infos = []
    const { ctx, listeners, streamCalls } = makeContext({ info: (message) => infos.push(message) })

    apply(ctx, config)

    assert.equal(listeners.length, 1, 'the listener stays mounted so a later save takes effect')
    assert.equal(infos.length, 1)
    assert.match(infos[0], /未配置/)

    const request = deepFreeze({ provider: 'opencode-go', model: 'main', purpose: 'auto-review', messages: [] })
    const reached = ctx.llm.stream(request)
    assert.equal(reached, request)
    assert.equal(streamCalls.length, 1, 'an unconfigured route must not re-dispatch')
  }
})

test('leaves the frozen request unchanged and redirects a copy', () => {
  const { ctx, streamCalls } = makeContext()
  apply(ctx, { provider: 'cheap-route', model: 'cheap-model' })

  const request = deepFreeze({ provider: 'opencode-go', model: 'main', purpose: 'auto-review', messages: [] })
  ctx.llm.stream(request)

  assert.equal(Object.isFrozen(request), true)
  assert.equal(request.provider, 'opencode-go')
  assert.equal(request.model, 'main')

  const redirect = streamCalls[1]
  assert.notEqual(redirect, request)
  assert.equal(redirect.provider, 'cheap-route')
  assert.equal(redirect.model, 'cheap-model')
})

test('enters the redirect exactly once', () => {
  const { ctx, streamCalls, adapters } = makeContext()
  apply(ctx, { provider: 'cheap-route', model: 'cheap-model' })

  const request = deepFreeze({ provider: 'opencode-go', model: 'main', purpose: 'auto-review', messages: [] })
  ctx.llm.stream(request)

  assert.equal(streamCalls.length, 2, 'the request under test plus one redirect')
  assert.equal(adapters.length, 1)
  assert.equal(adapters[0], streamCalls[1])
})

test('carries the configured reasoning effort on the redirect', () => {
  const { ctx, streamCalls } = makeContext()
  apply(ctx, { provider: 'cheap-route', model: 'cheap-model', reasoningEffort: 'low' })

  ctx.llm.stream(deepFreeze({ provider: 'opencode-go', model: 'main', purpose: 'auto-review', messages: [] }))

  assert.equal(streamCalls[1].reasoningEffort, 'low')
})

test('rejects an incomplete or malformed route configuration', () => {
  const configs = [
    { provider: 'cheap-route' },
    { model: 'cheap-model' },
    { provider: 'cheap-route', model: 3 },
    { reasoningEffort: 'high' },
  ]
  for (const config of configs) {
    const { ctx, listeners } = makeContext()
    assert.throws(() => apply(ctx, config), TypeError)
    assert.equal(listeners.length, 0, 'a rejected configuration must not mount a listener')
  }
})

test('treats blank route fields as unconfigured', () => {
  const { ctx, listeners, streamCalls } = makeContext()
  apply(ctx, { provider: '  ', model: '', reasoningEffort: ' ' })
  assert.equal(listeners.length, 1)

  const request = deepFreeze({ provider: 'opencode-go', model: 'main', purpose: 'auto-review', messages: [] })
  ctx.llm.stream(request)
  assert.equal(streamCalls.length, 1, 'blank fields must not re-dispatch')
})

test('stays inert while the switch is off', () => {
  const infos = []
  const { ctx, listeners, streamCalls } = makeContext({ info: (message) => infos.push(message) })

  apply(ctx, { enabled: false, provider: 'cheap-route', model: 'cheap-model' })

  assert.equal(listeners.length, 1)
  assert.equal(infos.length, 1)
  assert.match(infos[0], /已关闭/)

  const request = deepFreeze({ provider: 'opencode-go', model: 'main', purpose: 'auto-review', messages: [] })
  const reached = ctx.llm.stream(request)
  assert.equal(reached, request)
  assert.equal(streamCalls.length, 1, 'a disabled override must keep the agent model')
})

test('reads volatile references and follows a later save', () => {
  const state = { enabled: true, provider: 'route-a', model: 'model-a', reasoningEffort: 'low' }
  const reference = key => ({ get: () => state[key] })
  const config = {
    enabled: reference('enabled'),
    provider: reference('provider'),
    model: reference('model'),
    reasoningEffort: reference('reasoningEffort'),
  }
  const { ctx, streamCalls } = makeContext()

  apply(ctx, config)

  const request = () => deepFreeze({ provider: 'opencode-go', model: 'main', purpose: 'auto-review', messages: [] })

  ctx.llm.stream(request())
  assert.equal(streamCalls[1].provider, 'route-a')
  assert.equal(streamCalls[1].model, 'model-a')
  assert.equal(streamCalls[1].reasoningEffort, 'low')

  // A settings save mutates the referenced value; no entry reload happens.
  state.provider = 'route-b'
  state.model = 'model-b'
  state.reasoningEffort = undefined
  ctx.llm.stream(request())
  assert.equal(streamCalls[3].provider, 'route-b')
  assert.equal(streamCalls[3].model, 'model-b')
  assert.equal(streamCalls[3].reasoningEffort, undefined)

  state.enabled = false
  const reached = ctx.llm.stream(request())
  assert.equal(streamCalls.length, 5, 'the disabled reference must not re-dispatch')
  assert.equal(reached.purpose, 'auto-review')
})

test('rejects a non-boolean enabled flag', () => {
  for (const config of [{ enabled: 'no' }, { enabled: 1 }, { enabled: null }]) {
    const { ctx, listeners } = makeContext()
    assert.throws(() => apply(ctx, config), TypeError)
    assert.equal(listeners.length, 0)
  }
})

test('exports the volatile configuration schema the settings form renders', () => {
  assert.equal(typeof Config, 'function')
  for (const field of ['enabled', 'provider', 'model', 'reasoningEffort']) {
    assert.ok(Config.dict[field], `${field} must be declared`)
    assert.equal(Config.dict[field].meta?.volatile, true, `${field} must be volatile`)
  }
  assert.equal(Config.dict.enabled.meta?.default, true, 'enabled defaults to true')
})
