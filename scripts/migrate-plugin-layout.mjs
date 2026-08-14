#!/usr/bin/env node
/**
 * migrate-plugin-layout.mjs — one-shot manual migration for the plugins/ layout.
 *
 * Run ONCE from the repository root AFTER closing dsh-gui:
 *
 *   npm run migrate:plugins
 *
 * The new layout is preset-style: every `plugins/<id>/` wrapper owns an
 * `install.mjs` plus the plugin package/repo in a second-level directory
 * (`plugins/remote/dsh-remote`, `plugins/terminal/dsh-terminal`,
 * `plugins/file-explorer/dsh-file-explorer`). The remote and terminal moves are
 * already recorded by git in this checkout; the remaining step is the
 * dsh-file-explorer submodule, which the running dsh-gui holds open and which
 * therefore cannot be renamed from inside the app.
 *
 * This script is idempotent: after the move it simply re-runs the plugin
 * install scripts so the web profile links every plugin at its new path.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OLD = join(ROOT, 'plugins', 'dsh-file-explorer')
const NEW = join(ROOT, 'plugins', 'file-explorer', 'dsh-file-explorer')

function fail(message) {
  console.error(`[migrate-plugin-layout] ${message}`)
  process.exit(1)
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' })
  if (result.error) fail(`failed to spawn ${command}: ${result.error.message}`)
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited with code ${result.status}`)
}

/** Ensure .gitmodules records the new submodule path (git mv normally writes it). */
function ensureGitmodulesPath() {
  const path = join(ROOT, '.gitmodules')
  const text = readFileSync(path, 'utf8')
  const oldLine = '\tpath = plugins/dsh-file-explorer'
  const newLine = '\tpath = plugins/file-explorer/dsh-file-explorer'
  if (text.includes(oldLine)) {
    if (text.includes(newLine)) fail(`${path} contains both old and new dsh-file-explorer paths — resolve it manually`)
    writeFileSync(path, text.replace(oldLine, newLine))
    console.log('updated .gitmodules: plugins/file-explorer/dsh-file-explorer')
  }
}

/** True when the old checkout can be renamed (no running app holds it open). */
function lockReleased() {
  const probe = `${OLD}.rename-probe`
  try {
    renameSync(OLD, probe)
    renameSync(probe, OLD)
    return true
  } catch {
    return false
  }
}

console.log(`[migrate-plugin-layout] repository: ${ROOT}`)

if (existsSync(OLD)) {
  if (existsSync(NEW)) fail(`both ${OLD} and ${NEW} exist — remove one before re-running`)
  if (!lockReleased()) {
    fail(
      'plugins/dsh-file-explorer is still locked — dsh-gui (or one of its harness children) '
      + 'is holding it open. Close dsh-gui, wait for its processes to disappear, then run this script again',
    )
  }
  console.log('moving plugins/dsh-file-explorer -> plugins/file-explorer/dsh-file-explorer')
  // `git mv` refuses to run while .gitmodules has unstaged changes; staging it
  // first also records the terminal wrapper-path update already made in this checkout.
  run('git', ['add', '.gitmodules'])
  run('git', ['mv', 'plugins/dsh-file-explorer', 'plugins/file-explorer/dsh-file-explorer'])
  if (!existsSync(NEW)) fail(`git mv reported success but ${NEW} does not exist`)
  console.log('submodule moved')
} else if (!existsSync(NEW)) {
  fail(
    `${NEW} is missing — initialize the submodule with: `
    + 'git submodule update --init plugins/file-explorer/dsh-file-explorer',
  )
} else {
  console.log('dsh-file-explorer already lives at its new path — nothing to move')
}

ensureGitmodulesPath()
console.log('re-installing every plugin at its new path (node scripts/dsh-gui.mjs install)')
run(process.execPath, ['scripts/dsh-gui.mjs', 'install'])
console.log('\nDone. Stage the layout changes with `git add -A` and restart dsh-gui.')
