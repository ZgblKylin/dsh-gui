/**
 * dsh-mcp-on-demand — connect a disabled MCP server only when a skill needs it.
 *
 * The plugin keeps every MCP server off until a bound `skill` is loaded. When
 * the model calls the `skill` tool for a bound skill (or the user submits
 * `/<skill>`), the plugin enables the loader entry that owns the server,
 * waits until its tools are registered, and appends one note to the skill
 * result telling the model the tools are ready for the next step.
 *
 * The server itself is an ordinary `@deepseek-ai/dsh-mcp-client` loader entry:
 * - an existing entry (written in the profile's `cordis.patch.yml`) is adopted
 *   and toggled through `ctx.loader.update()`; its `disabled: true` keeps it
 *   offline across restarts until a skill asks for it;
 * - a server declared under `servers` is created here as a disabled entry and
 *   removed again when this plugin unloads.
 *
 * Zero runtime dependencies: the package imports no `@deepseek-ai/*` module
 * and relies only on the Cordis context (`loader`, `tools`, `logger`).
 *
 * @module dsh-mcp-on-demand
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-on-demand'

/** Host services this plugin consumes. */
export const inject = ['loader', 'tools']

/** Package name of the official MCP client bridge that owns each server entry. */
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/** Default wait for a freshly enabled server to publish its tools. */
const DEFAULT_TIMEOUT_MS = 120_000

/** Poll interval while waiting for tool registration. */
const POLL_INTERVAL_MS = 250

/**
 * Validate the raw loader config, which is passed through unchanged because
 * this package exports no Schemastery schema (see README: keeps the package
 * free of `@deepseek-ai/*` imports).
 * @param {unknown} raw - the `config:` block from `cordis.patch.yml`.
 * @returns {{ bindings: Array<{ skill: string, server: string, timeoutMs: number }>, servers: Record<string, Record<string, unknown>> }}
 * @throws {TypeError} when a binding lacks a skill name or server name.
 */
function normalizeConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const rawBindings = Array.isArray(config.bindings) ? config.bindings : []
  const bindings = []
  for (const item of rawBindings) {
    if (item === null || typeof item !== 'object') {
      throw new TypeError('mcp-on-demand: every binding must be an object')
    }
    const skill = typeof item.skill === 'string' ? item.skill.trim() : ''
    const server = typeof item.server === 'string' ? item.server.trim() : ''
    if (skill === '' || server === '') {
      throw new TypeError('mcp-on-demand: every binding needs non-empty "skill" and "server" fields')
    }
    const timeoutMs = Number.isFinite(item.timeoutMs) && item.timeoutMs > 0 ? item.timeoutMs : DEFAULT_TIMEOUT_MS
    bindings.push({ skill, server, timeoutMs })
  }
  const servers = config.servers !== null && typeof config.servers === 'object' && !Array.isArray(config.servers)
    ? config.servers
    : {}
  return { bindings, servers }
}

/**
 * Extract the skill name of a user-explicit `/<name>` message.
 * @param {unknown} message - one inbox message.
 * @returns {string | undefined} the referenced skill name, if any.
 */
function slashSkillName(message) {
  if (message === null || typeof message !== 'object') return undefined
  const source = message.source
  if (source !== null && typeof source === 'object' && source.kind !== 'user') return undefined
  const blocks = Array.isArray(message.content) ? message.content : []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') continue
    const match = /^\s*\/([A-Za-z0-9][A-Za-z0-9._:-]*)/.exec(block.text)
    return match === null ? undefined : match[1]
  }
  return undefined
}

/**
 * Install the on-demand activation listeners and create inline server entries.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {unknown} rawConfig - the `config:` block from `cordis.patch.yml`.
 * @returns {Promise<void>} settles after inline entries are created (disabled).
 */
export async function apply(ctx, rawConfig) {
  const { bindings, servers } = normalizeConfig(rawConfig)
  const bindingsBySkill = new Map(bindings.map(binding => [binding.skill, binding]))

  /** In-flight activations, one per server, so parallel skill calls share a connect. */
  const pending = new Map()
  /** Inline entries created by this plugin: server name -> loader entry id. */
  const created = new Map()

  /** @param {'info'|'warn'|'error'} level @param {string} message */
  const log = (level, message) => {
    const logger = ctx.logger
    if (logger === undefined || logger === null) return
    logger[level](`mcp-on-demand: ${message}`)
  }

  /**
   * Resolve the live `mcp-client` entry for one server name.
   * `!!js` config expressions stay raw on `options.config`, so the evaluated
   * value is read from the fiber first.
   * @param {string} serverName - `config.serverName` of the entry.
   * @returns {any} the loader entry, or undefined.
   */
  const findServerEntry = (serverName) => {
    for (const entry of ctx.loader.entries()) {
      if (entry.options === undefined || entry.options.name !== MCP_CLIENT_PACKAGE) continue
      const config = entry.fiber?.config ?? entry.options.config
      if (config !== null && typeof config === 'object' && config.serverName === serverName) return entry
    }
    return undefined
  }

  /**
   * Model-facing tools currently registered by one server.
   * @param {string} serverName - MCP server namespace.
   * @returns {string[]} public tool names (`mcp__<server>__<raw>`).
   */
  const visibleTools = (serverName) => {
    const prefix = `mcp__${serverName}__`
    return ctx.tools.definitions().filter(tool => tool.name.startsWith(prefix)).map(tool => tool.name)
  }

  /**
   * Wait until a server publishes at least one tool.
   * @param {string} serverName - MCP server namespace.
   * @param {number} timeoutMs - overall wait budget.
   * @param {AbortSignal | undefined} signal - cancels the wait with the tool call.
   * @returns {Promise<string[]>} registered tool names (empty on timeout).
   */
  const waitForTools = async (serverName, timeoutMs, signal) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const tools = visibleTools(serverName)
      if (tools.length > 0) return tools
      if (signal !== undefined && signal.aborted) return []
      if (Date.now() >= deadline) return []
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    }
  }

  /**
   * Enable the binding's server (if needed) and wait for its tools.
   * Concurrent calls for one server share the same attempt.
   * @param {{ skill: string, server: string, timeoutMs: number }} binding - one skill/server pair.
   * @param {AbortSignal | undefined} signal - cancellation of the requesting tool call.
   * @returns {Promise<{ ok: true, wasDisabled: boolean, tools: string[] } | { ok: false, error: string }>}
   */
  const activate = (binding, signal) => {
    const running = pending.get(binding.server)
    if (running !== undefined) return running
    const task = (async () => {
      const entry = findServerEntry(binding.server)
      if (entry === undefined) {
        return { ok: false, error: `no "${MCP_CLIENT_PACKAGE}" loader entry declares serverName "${binding.server}"` }
      }
      const wasDisabled = entry.disabled
      if (wasDisabled) {
        try {
          await ctx.loader.update(entry.id, { disabled: false })
        } catch (error) {
          return { ok: false, error: `enabling loader entry "${entry.id}" failed: ${error instanceof Error ? error.message : String(error)}` }
        }
      }
      const tools = await waitForTools(binding.server, binding.timeoutMs, signal)
      if (tools.length === 0) {
        return {
          ok: false,
          error: `server "${binding.server}" did not register any tool within ${binding.timeoutMs} ms`,
        }
      }
      log('info', `server "${binding.server}" is available (${tools.length} tool(s)) after skill "${binding.skill}"`)
      return { ok: true, wasDisabled, tools }
    })()
    pending.set(binding.server, task)
    void task.then(() => {
      if (pending.get(binding.server) === task) pending.delete(binding.server)
    })
    return task
  }

  // Inline server entries: created disabled so nothing connects before a skill
  // asks for it. A same-named entry that already exists in the profile patch is
  // adopted instead of duplicated (one serverName per registration scope).
  for (const [serverName, serverConfig] of Object.entries(servers)) {
    if (findServerEntry(serverName) !== undefined) {
      log('warn', `inline server "${serverName}" is already a loader entry — adopting the existing entry instead`)
      continue
    }
    if (serverConfig === null || typeof serverConfig !== 'object') {
      log('warn', `inline server "${serverName}" skipped: config must be an object`)
      continue
    }
    const id = `mcp-on-demand-${serverName}`
    try {
      await ctx.loader.create({
        id,
        name: MCP_CLIENT_PACKAGE,
        config: { ...serverConfig, serverName },
        disabled: true,
      })
      created.set(serverName, id)
      log('info', `created inline MCP entry "${id}" (stays disabled until its skill loads)`)
    } catch (error) {
      log('error', `inline server "${serverName}" could not be created: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  ctx.effect(() => async () => {
    for (const id of created.values()) {
      try {
        await ctx.loader.remove(id)
      } catch (error) {
        log('warn', `inline MCP entry "${id}" could not be removed on unload: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    created.clear()
  }, 'mcp-on-demand.inline-servers')

  /**
   * Match a tool execution to the binding whose skill it loads.
   * @param {unknown} exec - one `tools/*-execute` execution.
   * @returns {{ skill: string, server: string, timeoutMs: number } | undefined}
   */
  const bindingForExecution = (exec) => {
    if (exec === null || typeof exec !== 'object' || exec.name !== 'skill') return undefined
    const args = exec.arguments
    if (args === null || typeof args !== 'object' || typeof args.name !== 'string') return undefined
    return bindingsBySkill.get(args.name)
  }

  // Start connecting while the skill tool is still reading its file; the
  // post-execute hook below awaits the same attempt, so the note it appends is
  // accurate and the next step's tool list already contains the server's tools.
  ctx.on('tools/pre-execute', (exec, next) => {
    const binding = bindingForExecution(exec)
    if (binding !== undefined) void activate(binding, exec.signal)
    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    const binding = bindingForExecution(exec)
    if (binding === undefined) return downstream
    const outcome = await activate(binding, exec.signal)
    const note = outcome.ok
      ? `MCP server "${binding.server}" is connected; its tools (mcp__${binding.server}__*) `
        + 'are available from the next step. Do not run connection or setup diagnostics for this server.'
      : `MCP server "${binding.server}" could not be activated automatically: ${outcome.error}. `
        + 'Continue with the skill\'s recovery guidance and tell the user if the task needs those tools.'
    // Never replace `value` with `content` (the pipeline rejects both) and never
    // rewrite a blocked result; the note matters only for a successful skill load.
    if (downstream.kind !== 'accept' || Object.hasOwn(downstream, 'value')) return downstream
    const content = downstream.content ?? result.content
    return { ...downstream, content: [...content, { type: 'text', text: `[mcp-on-demand] ${note}` }] }
  })

  // User-explicit `/<skill>` invocation: start connecting as soon as the message
  // enters the inbox, before the loop assembles that step's tool list.
  ctx.on('agent/inbox/inserted', ({ message }) => {
    const skillName = slashSkillName(message)
    if (skillName === undefined) return
    const binding = bindingsBySkill.get(skillName)
    if (binding !== undefined) void activate(binding, undefined)
  })
}
