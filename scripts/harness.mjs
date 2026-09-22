#!/usr/bin/env node
/**
 * Start the same dsh web backend the Tauri shell starts, but keep it attached
 * to this terminal. The launch contract mirrors `spawn_harness` in
 * `src-tauri/src/main.rs`: web profile, DSH_GUI_PORT (or 3080), no browser
 * handoff, the resolved runtime's working directory, the repo-local `.dsh` as
 * DSH_HOME, and the agent-config home the build fills from
 * `global_template.agents/` as DSH_AGENTS_HOME (`harness.json` selects the npm
 * or the source runtime). Both pins are load-bearing: the skill provider reads
 * `$DSH_AGENTS_HOME` and otherwise falls back to the machine-wide `~/.agents`,
 * so a backend started without it loses the user-level skills and the
 * always-loaded docs of this installation.
 */

import { spawn } from 'node:child_process'
import { constants as osConstants } from 'node:os'
import { join } from 'node:path'
import { requireHarnessRuntime } from './harness-runtime.mjs'
import { ROOT, WEB_HOME } from './toolchain.mjs'

const DEFAULT_PORT = 3080

function resolvePort() {
  const value = process.env.DSH_GUI_PORT?.trim()
  if (value === undefined || !/^\d+$/.test(value)) return DEFAULT_PORT
  const port = Number(value)
  return Number.isInteger(port) && port <= 65535 ? port : DEFAULT_PORT
}

let cli
try {
  cli = requireHarnessRuntime(ROOT)
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

const port = resolvePort()

// The agent-config home the shell pins too (`spawn_harness` in
// `src-tauri/src/main.rs`): the tree `npm run build` fills from
// `global_template.agents/`. Without it the provider reads the machine-wide
// `~/.agents`, which this installation never writes.
const agentsHome = join(WEB_HOME, '.agents')

const child = spawn('node', [cli.bin, 'web', '--port', String(port), '--no-open'], {
  cwd: cli.cwd,
  env: { ...process.env, DSH_HOME: WEB_HOME, DSH_AGENTS_HOME: agentsHome },
  stdio: 'inherit',
})

// Keep this foreground wrapper alive while the backend performs its bounded
// signal teardown. Both processes normally receive terminal signals together;
// the timer only covers a signal sent to this wrapper alone. A second signal
// escalates immediately, matching the harness CLI contract.
let requestedSignal = null
let signalCount = 0
let signalFallback = null
function handleSignal(signal) {
  signalCount += 1
  requestedSignal ??= signal
  if (signalCount > 1) {
    child.kill(signal)
    return
  }
  signalFallback = setTimeout(() => child.kill(signal), 5500)
  signalFallback.unref()
}
const handleSigint = () => handleSignal('SIGINT')
const handleSigterm = () => handleSignal('SIGTERM')
process.on('SIGINT', handleSigint)
process.on('SIGTERM', handleSigterm)

const result = await new Promise((resolve) => {
  child.once('error', (error) => resolve({ error, status: null, signal: null }))
  child.once('exit', (status, signal) => resolve({ error: null, status, signal }))
})

process.off('SIGINT', handleSigint)
process.off('SIGTERM', handleSigterm)
if (signalFallback !== null) clearTimeout(signalFallback)

if (result.error) {
  console.error(`failed to spawn harness: ${result.error.message}`)
  process.exit(1)
}
if (result.status !== null) process.exit(result.status)
const signal = result.signal ?? requestedSignal
if (signal !== null) {
  const signalNumber = osConstants.signals[signal]
  process.exit(signalNumber === undefined ? 1 : 128 + signalNumber)
}
process.exit(1)
