#!/usr/bin/env node
/**
 * Start the same deepseek-harness web backend used by the Tauri shell, but keep
 * it attached to this terminal. The launch contract intentionally mirrors
 * `spawn_harness` in `src-tauri/src/main.rs`: web profile, DSH_GUI_PORT (or
 * 3080), no browser handoff, the harness checkout as cwd, and the repo-local
 * `.dsh` as DSH_HOME.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { HARNESS, HARNESS_BIN, WEB_HOME } from './toolchain.mjs'

const DEFAULT_PORT = 3080

function resolvePort() {
  const value = process.env.DSH_GUI_PORT?.trim()
  if (value === undefined || !/^\d+$/.test(value)) return DEFAULT_PORT
  const port = Number(value)
  return Number.isInteger(port) && port <= 65535 ? port : DEFAULT_PORT
}

if (!existsSync(HARNESS_BIN)) {
  console.error(`harness is not built: ${HARNESS_BIN} is missing — run "npm run setup" first`)
  process.exit(1)
}

const port = resolvePort()

const child = spawn('node', [HARNESS_BIN, 'web', '--port', String(port), '--no-open'], {
  cwd: HARNESS,
  env: { ...process.env, DSH_HOME: WEB_HOME },
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
