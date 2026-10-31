/**
 * Focused behavior tests for `dsh-mcp-on-demand`.
 *
 * The plugin talks to the Cordis context only through `loader`, `tools`,
 * `ctx.on`, `ctx.effect`, and `logger`, so a hand-built context exercises the
 * complete path: skill-tool detection, loader entry discovery and toggling,
 * tool-registration wait, note folding, inline entry lifecycle, and the
 * `/<skill>` inbox path. No DSH installation is needed.
 *
 * Run: node --test tests/plugin.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'

/**
 * Build a minimal harness context plus helpers for the two tool-pipeline hooks.
 * @param {object} [options] - initial state.
 * @param {Array<{id: string, server: string, disabled?: boolean}>} [options.entries] - fake mcp-client entries.
 * @param {string[]} [options.tools] - initially registered tool names.
 * @param {boolean} [options.registerToolOnEnable] - push `mcp__<server>__tool` when an entry is enabled.
 * @returns {{ctx: object, updateCalls: any[], createCalls: any[], removeCalls: any[], listeners: Map<string, Function[]>, entryState: Map<string, object>, toolList: string[], dispose: () => Promise<void>}}
 */
function createHarness(options = {}) {
  const entryState = new Map()
  for (const spec of options.entries ?? []) {
    entryState.set(spec.id, {
      id: spec.id,
      options: { id: spec.id, name: MCP_CLIENT, config: { serverName: spec.server, transport: 'stdio' } },
      disabled: spec.disabled ?? true,
    })
  }
  const toolList = [...options.tools ?? []]
  const updateCalls = []
  const createCalls = []
  const removeCalls = []
  const listeners = new Map()
  const disposers = []

  const ctx = {
    loader: {
      entries: () => [...entryState.values()],
      update: async (id, patch) => {
        updateCalls.push([id, patch])
        const entry = entryState.get(id)
        if (entry === undefined) throw new Error(`cannot resolve entry ${id}`)
        if (patch.disabled === false && entry.disabled) {
          entry.disabled = false
          if (options.registerToolOnEnable !== false) {
            toolList.push({ name: `mcp__${entry.options.config.serverName}__ping` })
          }
        }
      },
      create: async (entryOptions) => {
        createCalls.push(entryOptions)
        entryState.set(entryOptions.id, {
          id: entryOptions.id,
          options: { id: entryOptions.id, name: entryOptions.name, config: entryOptions.config },
          disabled: entryOptions.disabled === true,
        })
      },
      remove: async (id) => {
        removeCalls.push(id)
        entryState.delete(id)
      },
    },
    tools: { definitions: () => toolList },
    on: (event, handler) => {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
    effect: (factory) => {
      disposers.push(factory())
    },
    logger: { info() {}, warn() {}, error() {} },
  }

  const call = async (event, ...args) => {
    const handlers = listeners.get(event) ?? []
    assert.ok(handlers.length > 0, `no listener registered for ${event}`)
    // Compose like the real waterfall: each handler receives the downstream `next`.
    const run = (index) => handlers[index](...args, () => (index + 1 < handlers.length ? run(index + 1) : Promise.resolve({ kind: 'accept' })))
    return run(0)
  }

  return {
    ctx,
    updateCalls,
    createCalls,
    removeCalls,
    listeners,
    entryState,
    toolList,
    call,
    dispose: async () => {
      for (const disposer of disposers) await disposer()
    },
  }
}

/** One skill tool execution. */
const skillExec = (skill) => ({ name: 'skill', arguments: { name: skill }, signal: new AbortController().signal })

/** A successful skill tool result. */
const skillResult = () => ({ isError: false, content: [{ type: 'text', text: 'skill body' }] })

test('loads the bound MCP server and appends a ready note to the skill result', async () => {
  const harness = createHarness({ entries: [{ id: 'include:rea-mcp', server: 'rea' }] })
  await apply(harness.ctx, { bindings: [{ skill: 'reverse-engineer-anything', server: 'rea', timeoutMs: 2000 }] })

  const exec = skillExec('reverse-engineer-anything')
  await harness.call('tools/pre-execute', exec)
  const decision = await harness.call('tools/post-execute', exec, skillResult())

  assert.deepEqual(harness.updateCalls, [['include:rea-mcp', { disabled: false }]], 'enables the entry exactly once')
  assert.ok(harness.toolList.some(tool => tool.name === 'mcp__rea__ping'), 'server tools are registered')
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.content.length, 2)
  assert.match(decision.content[1].text, /MCP server "rea" is connected/u)
  assert.match(decision.content[1].text, /mcp__rea__\*/u)
})

test('keeps an already-enabled server untouched', async () => {
  const harness = createHarness({
    entries: [{ id: 'include:rea-mcp', server: 'rea', disabled: false }],
    tools: [{ name: 'mcp__rea__search' }],
  })
  await apply(harness.ctx, { bindings: [{ skill: 'reverse-engineer-anything', server: 'rea', timeoutMs: 500 }] })

  const decision = await harness.call('tools/post-execute', skillExec('reverse-engineer-anything'), skillResult())

  assert.equal(harness.updateCalls.length, 0, 'an enabled server is not toggled again')
  assert.match(decision.content[1].text, /is connected/u)
})

test('reports a failure note when no mcp-client entry declares the server', async () => {
  const harness = createHarness()
  await apply(harness.ctx, { bindings: [{ skill: 'reverse-engineer-anything', server: 'rea', timeoutMs: 500 }] })

  const decision = await harness.call('tools/post-execute', skillExec('reverse-engineer-anything'), skillResult())

  assert.equal(harness.updateCalls.length, 0)
  assert.match(decision.content[1].text, /could not be activated automatically/u)
  assert.match(decision.content[1].text, /no "@deepseek-ai\/dsh-mcp-client" loader entry/u)
})

test('ignores unrelated tool calls and unbound skill loads', async () => {
  const harness = createHarness({ entries: [{ id: 'include:rea-mcp', server: 'rea' }] })
  await apply(harness.ctx, { bindings: [{ skill: 'reverse-engineer-anything', server: 'rea', timeoutMs: 500 }] })

  const otherTool = await harness.call('tools/post-execute', { name: 'read', arguments: { path: 'x' } }, skillResult())
  const otherSkill = await harness.call('tools/post-execute', skillExec('dsh-badge'), skillResult())

  assert.equal(harness.updateCalls.length, 0)
  // Accept without a replacement projection: the pipeline keeps the result content.
  assert.equal(otherTool.content, undefined)
  assert.equal(otherSkill.content, undefined)
})

test('creates inline server entries disabled and removes them on unload', async () => {
  const harness = createHarness()
  await apply(harness.ctx, {
    servers: { test: { transport: 'stdio', command: 'node', args: ['server.mjs'] } },
    bindings: [{ skill: 'dsh-badge', server: 'test', timeoutMs: 500 }],
  })

  assert.equal(harness.createCalls.length, 1)
  assert.equal(harness.createCalls[0].id, 'mcp-on-demand-test')
  assert.equal(harness.createCalls[0].disabled, true)
  assert.equal(harness.createCalls[0].config.serverName, 'test')
  assert.equal(harness.entryState.get('mcp-on-demand-test').disabled, true)

  await harness.dispose()
  assert.deepEqual(harness.removeCalls, ['mcp-on-demand-test'])
})

test('adopts an existing entry instead of creating a duplicate inline server', async () => {
  const harness = createHarness({ entries: [{ id: 'include:test-mcp', server: 'test' }] })
  await apply(harness.ctx, { servers: { test: { transport: 'stdio', command: 'node' } } })

  assert.equal(harness.createCalls.length, 0)
})

test('shares one activation attempt between parallel skill calls', async () => {
  const harness = createHarness({ entries: [{ id: 'include:rea-mcp', server: 'rea' }] })
  await apply(harness.ctx, { bindings: [{ skill: 'reverse-engineer-anything', server: 'rea', timeoutMs: 2000 }] })

  await Promise.all([
    harness.call('tools/pre-execute', skillExec('reverse-engineer-anything')),
    harness.call('tools/pre-execute', skillExec('reverse-engineer-anything')),
  ])
  await Promise.all([
    harness.call('tools/post-execute', skillExec('reverse-engineer-anything'), skillResult()),
    harness.call('tools/post-execute', skillExec('reverse-engineer-anything'), skillResult()),
  ])

  assert.equal(harness.updateCalls.length, 1, 'the loader is updated once for concurrent loads')
})

test('starts activation on a user /<skill> message', async () => {
  const harness = createHarness({ entries: [{ id: 'include:rea-mcp', server: 'rea' }] })
  await apply(harness.ctx, { bindings: [{ skill: 'reverse-engineer-anything', server: 'rea', timeoutMs: 2000 }] })

  await harness.call('agent/inbox/inserted', {
    message: { source: { kind: 'user' }, content: [{ type: 'text', text: '  /reverse-engineer-anything analyze this binary' }] },
  })

  assert.deepEqual(harness.updateCalls, [['include:rea-mcp', { disabled: false }]])
})

test('rejects a binding without skill or server', async () => {
  const harness = createHarness()
  await assert.rejects(apply(harness.ctx, { bindings: [{ skill: 'x' }] }), /non-empty "skill" and "server"/u)
})
