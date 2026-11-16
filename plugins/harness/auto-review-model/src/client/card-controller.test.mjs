/**
 * Behavior tests for the Auto review model card controller.
 *
 * The controller talks to the settings form and the remote model catalog only
 * through injected objects, so hand-built fakes exercise the full staged-edit
 * path without a live Host, React, or the client bundle.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { AutoReviewModelCardController } from './card-controller.ts'

const GROUPS = [
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    models: [
      { id: 'deepseek-v4.1-flash', name: 'Flash' },
      { id: 'deepseek-v4-pro', name: 'Pro' },
    ],
  },
  {
    id: 'command-code',
    name: 'Command Code',
    models: [{ id: 'deepseek/deepseek-v4.1-flash', name: 'CommandCode Flash' }],
  },
]

/** Let the constructor's catalog request settle. */
function tick() {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

/**
 * Build a settings scope fake that applies `set` operations like the Host.
 * @param {object} [value] - initial accepted section values.
 * @param {{ writable?: boolean, revision?: number }} [options] - form state.
 * @returns {object} the scope plus the recorded mutations.
 */
function createScope(value = {}, { writable = true, revision = 3 } = {}) {
  const listeners = new Set()
  let snapshot = { status: 'ready', value, base: {}, user: {}, revision, writable }
  const mutations = []
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async mutate(ops, expectedRevision) {
      mutations.push({ ops, expectedRevision })
      const next = { ...snapshot.value }
      for (const op of ops) {
        if (op.op === 'set') next[op.path[0]] = op.value
        else delete next[op.path[0]]
      }
      snapshot = { ...snapshot, value: next, revision: snapshot.revision + 1 }
      for (const listener of [...listeners]) listener()
      return true
    },
    mutations,
  }
}

/**
 * Build the remote face the controller reads.
 * @param {{ ok?: boolean }} [options] - whether the catalog request succeeds.
 * @returns {object} a minimal client context.
 */
function createContext({ ok = true } = {}) {
  return {
    remote: {
      session: {
        modelCatalog: async () => (ok
          ? { ok: true, value: { groups: GROUPS, failures: [] } }
          : { ok: false, error: { message: 'unavailable' } }),
      },
    },
  }
}

/**
 * Read the current card snapshot from a controller face.
 * @param {object} controller - controller under test.
 * @returns {object} the published state.
 */
function state(controller) {
  return controller.inject().hooks.autoReviewModelCard.getSnapshot()
}

test('loads the adapter catalog and publishes the grouped routes', async () => {
  const controller = new AutoReviewModelCardController(createScope(), createContext())
  assert.equal(state(controller).catalogStatus, 'loading')
  await tick()
  const settled = state(controller)
  assert.equal(settled.catalogStatus, 'ready')
  assert.equal(settled.groups.length, 2)
  assert.equal(settled.catalogPartial, false)
  controller.dispose()
})

test('opening the switch seeds the first advertised route without saving', async () => {
  const scope = createScope()
  const controller = new AutoReviewModelCardController(scope, createContext())
  await tick()
  assert.equal(state(controller).enabled, false, 'no route means the switch reads off')

  controller.inject().toggleEnabled()

  const opened = state(controller)
  assert.equal(opened.enabled, true)
  assert.equal(opened.provider, 'opencode-go')
  assert.equal(opened.model, 'deepseek-v4.1-flash')
  assert.equal(scope.mutations.length, 0, 'seeding the draft must not persist')
  controller.dispose()
})

test('changing the provider resets the model to that provider\'s first entry', async () => {
  const controller = new AutoReviewModelCardController(createScope(), createContext())
  await tick()
  const face = controller.inject()
  face.toggleEnabled()
  face.selectProvider('command-code')

  const staged = state(controller)
  assert.equal(staged.provider, 'command-code')
  assert.equal(staged.model, 'deepseek/deepseek-v4.1-flash')
  controller.dispose()
})

test('saves the switch and route as one revision-fenced mutation', async () => {
  const scope = createScope()
  const controller = new AutoReviewModelCardController(scope, createContext())
  await tick()
  const face = controller.inject()
  face.toggleEnabled()
  face.save()
  await tick()

  const [mutation] = scope.mutations
  assert.equal(mutation.expectedRevision, 3)
  assert.deepEqual(
    mutation.ops.map(op => [op.path[0], op.value]),
    [['enabled', true], ['provider', 'opencode-go'], ['model', 'deepseek-v4.1-flash']],
  )
  assert.equal(state(controller).dirty, false, 'an accepted save clears the draft')
  controller.dispose()
})

test('closing the switch keeps the saved route for reopening', async () => {
  const scope = createScope({ enabled: true, provider: 'command-code', model: 'deepseek/deepseek-v4.1-flash' })
  const controller = new AutoReviewModelCardController(scope, createContext())
  await tick()
  const face = controller.inject()
  face.toggleEnabled()
  face.save()
  await tick()

  const [mutation] = scope.mutations
  assert.equal(mutation.ops[0].value, false, 'the switch persists as off')
  const saved = new Map(mutation.ops.map(op => [op.path[0], op.value]))
  assert.equal(saved.get('provider'), 'command-code')
  assert.equal(saved.get('model'), 'deepseek/deepseek-v4.1-flash')
  controller.dispose()
})

test('reports a catalog failure instead of throwing', async () => {
  const controller = new AutoReviewModelCardController(createScope(), createContext({ ok: false }))
  await tick()
  const settled = state(controller)
  assert.equal(settled.catalogStatus, 'error')
  assert.equal(settled.groups.length, 0)
  controller.dispose()
})

test('marks an open switch without a route invalid and refuses to save it', async () => {
  const scope = createScope()
  const controller = new AutoReviewModelCardController(scope, {
    remote: { session: { modelCatalog: async () => ({ ok: true, value: { groups: [], failures: [] } }) } },
  })
  await tick()
  const face = controller.inject()
  face.toggleEnabled()
  assert.equal(state(controller).invalid, true)
  face.save()
  await tick()
  assert.equal(scope.mutations.length, 0, 'an invalid draft must not be written')
  controller.dispose()
})
