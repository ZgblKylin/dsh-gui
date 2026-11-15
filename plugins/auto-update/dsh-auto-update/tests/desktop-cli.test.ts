/**
 * Unit tests for the carrier CLI that an npm row update hands to its wrapper.
 *
 * The desktop profile is reserved for the application's own dsh CLI, so a
 * reinstall into it must carry `DSH_PLUGIN_DSH_CLI`. Both the resolution rules
 * and the environment composition are pure functions over a directory layout
 * and an environment object, so each case builds its own layout under a scratch
 * directory instead of reading the installed application.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { desktopCliPath } from '../src/paths.ts'
import { installScriptEnv } from '../src/update.ts'

/** The CLI name the running platform's application packaging installs. */
const platformCliName = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'

/** Create one scratch directory, removed when the test that asked for it ends. */
function scratchDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-cli-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

/** Create an empty file at `path`, with its parent directories. */
function touchFile(path: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '')
  return path
}

test('desktopCliPath returns the DSH_PLUGIN_DSH_CLI override without checking it', (t) => {
  // The override is the caller's explicit choice; a path that does not exist
  // yet must still win over the layout probe.
  const dir = scratchDir(t)
  const override = join(dir, 'not-installed-yet', 'dsh')
  assert.equal(desktopCliPath(join(dir, 'DeepSeek Harness.exe'), { DSH_PLUGIN_DSH_CLI: override }), override)
})

test('desktopCliPath finds the CLI beside the application executable', (t) => {
  const dir = scratchDir(t)
  const exe = join(dir, 'app', 'DeepSeek Harness.exe')
  const cli = touchFile(join(dir, 'app', 'resources', 'runtime', 'cli', 'bin', platformCliName))
  assert.equal(desktopCliPath(exe, {}), cli)
})

test('desktopCliPath finds the CLI in the macOS bundle layout', (t) => {
  const dir = scratchDir(t)
  const exe = join(dir, 'X.app', 'Contents', 'MacOS', 'DeepSeek Harness')
  const cli = touchFile(join(dir, 'X.app', 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh'))
  assert.equal(desktopCliPath(exe, {}), cli)
})

test('desktopCliPath reports an unlocatable CLI as undefined', (t) => {
  const dir = scratchDir(t)
  // A bare executable with no application payload around it, plus a layout
  // whose CLI file is missing: neither candidate resolves.
  mkdirSync(join(dir, 'app', 'resources', 'runtime', 'cli'), { recursive: true })
  const exe = join(dir, 'app', 'DeepSeek Harness.exe')
  assert.equal(desktopCliPath(exe, {}), undefined)
})

test('installScriptEnv carries the carrier CLI only for the reserved profile', (t) => {
  const dir = scratchDir(t)
  const exe = join(dir, 'app', 'DeepSeek Harness.exe')
  const cli = touchFile(join(dir, 'app', 'resources', 'runtime', 'cli', 'bin', platformCliName))

  const desktopEnv = installScriptEnv('desktop', { PATH: 'x' }, exe)
  assert.equal(desktopEnv.DSH_PLUGIN_DSH_CLI, cli)
  assert.equal(desktopEnv.DSH_PLUGIN_PROFILE, 'desktop')
  assert.equal(desktopEnv.DSH_PLUGIN_MIN_AGE, '0')
  // The rest of the environment is inherited untouched.
  assert.equal(desktopEnv.PATH, 'x')

  const webEnv = installScriptEnv('web', { PATH: 'x' }, exe)
  assert.equal(webEnv.DSH_PLUGIN_DSH_CLI, undefined)
  assert.equal(webEnv.DSH_PLUGIN_PROFILE, 'web')
  assert.equal(webEnv.DSH_PLUGIN_MIN_AGE, '0')
})

test('installScriptEnv fails when the reserved profile has no carrier', (t) => {
  const dir = scratchDir(t)
  const exe = join(dir, 'app', 'DeepSeek Harness.exe')
  assert.throws(
    () => installScriptEnv('desktop', { PATH: 'x' }, exe),
    /DSH_PLUGIN_DSH_CLI/,
  )
})
