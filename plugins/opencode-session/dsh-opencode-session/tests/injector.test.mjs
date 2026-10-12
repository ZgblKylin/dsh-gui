import test from 'node:test'
import assert from 'node:assert/strict'
import { injectRequestSessionId } from '../lib/index.js'

const PROVIDERS = new Set(['opencode', 'opencode-go'])

function base(overrides = {}) {
  return { provider: 'opencode-go', model: 'm', messages: [], ...overrides }
}

test('injects the session id on a target provider without one', () => {
  const options = base()
  const outcome = injectRequestSessionId(options, 'session-1', PROVIDERS)
  assert.equal(outcome.injected, true)
  assert.equal(outcome.options.sessionId, 'session-1')
  assert.notEqual(outcome.options, options)
  assert.equal('sessionId' in options, false, 'the original request must not be mutated')
})

test('passes a non-target provider through untouched', () => {
  const options = base({ provider: 'calmcar' })
  const outcome = injectRequestSessionId(options, 'session-1', PROVIDERS)
  assert.equal(outcome.injected, false)
  assert.equal(outcome.options, options)
})

test('passes a request that already carries a session id through untouched', () => {
  const options = base({ sessionId: 'loop-session' })
  const outcome = injectRequestSessionId(options, 'session-1', PROVIDERS)
  assert.equal(outcome.injected, false)
  assert.equal(outcome.options, options)
  assert.equal(outcome.options.sessionId, 'loop-session')
})

test('passes through when no session id is resolvable', () => {
  const options = base()
  const outcome = injectRequestSessionId(options, undefined, PROVIDERS)
  assert.equal(outcome.injected, false)
  assert.equal(outcome.options, options)
})

test('does not inject twice when the replacement is re-fed', () => {
  const first = injectRequestSessionId(base(), 'session-1', PROVIDERS)
  assert.equal(first.injected, true)
  const second = injectRequestSessionId(first.options, 'session-2', PROVIDERS)
  assert.equal(second.injected, false)
  assert.equal(second.options.sessionId, 'session-1')
})