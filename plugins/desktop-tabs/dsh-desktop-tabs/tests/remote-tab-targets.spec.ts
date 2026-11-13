/**
 * Tests of the persisted `remote` descriptor on tab and connection rows, run
 * against the built package (`../lib/index.js`). These rows are the shared
 * contract between the browser half (which writes them) and the host half
 * (which dispatches `up`/`down`/`forget` by id), so the round-trip and the
 * validation rules are asserted through the same `readDesktopTabs` /
 * `writeDesktopTabs` the routes use.
 *
 * Usage (from the package directory): node tests/remote-tab-targets.spec.ts
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)

const root = mkdtempSync(join(tmpdir(), 'dsh-remote-tab-targets-'))
const dshHome = join(root, 'home')
mkdirSync(join(dshHome, 'gui'), { recursive: true })

const spec = {
  targetDeviceId: 'device-1',
  targetName: 'Desktop-ZgblKylin',
  workspacePath: '/home/me/src/app',
  backend: 'harness',
}

/** Write one raw config file. */
function writeConfig(value: unknown): void {
  writeFileSync(join(dshHome, 'gui', 'desktop-tabs.json'), `${JSON.stringify(value, null, 2)}\n`)
}

// ---------------------------------------------------------------- read round-trip
{
  writeConfig({
    tabs: [
      { id: 'local', title: '本机' },
      { id: 'remote-1a2b3c4d', title: 'Desktop · app', remote: spec },
    ],
    connections: [
      { id: 'remote-1a2b3c4d', title: 'Desktop · app', type: 'remote', remote: spec },
    ],
  })
  const read = mod.readDesktopTabs(dshHome)
  assert.deepEqual(read.warnings, [], 'a valid remote config reads without warnings')
  assert.equal(read.tabs.length, 2, 'the remote tab is kept, not folded into the local view')
  assert.equal(read.tabs[0].id, 'local', 'the local view stays first')
  const remoteTab = read.tabs[1]
  assert.equal(remoteTab.id, 'remote-1a2b3c4d')
  assert.equal(remoteTab.url, undefined, 'a remote tab carries no persisted URL')
  assert.deepEqual(remoteTab.remote, spec, 'the remote descriptor round-trips')
  assert.equal(read.connections.length, 1)
  assert.equal(read.connections[0].type, 'remote', 'the connection type is kept')
  assert.deepEqual(read.connections[0].remote, spec)
}

// ---------------------------------------------------------------- write round-trip
{
  const written = mod.writeDesktopTabs(dshHome, {
    tabs: [
      { id: 'local', title: '本机' },
      { id: 'remote-1a2b3c4d', title: 'Desktop · app', remote: spec },
    ],
    connections: [
      { id: 'remote-1a2b3c4d', title: 'Desktop · app', type: 'remote', remote: spec },
    ],
  })
  assert.equal(written.tabs[1].remote?.workspacePath, spec.workspacePath, 'a submitted remote tab is stored')
  const reread = mod.readDesktopTabs(dshHome)
  assert.deepEqual(reread.tabs[1].remote, spec, 'the stored remote descriptor survives a reload')
}

// ---------------------------------------------------------------- runtime-only URL
{
  // A client that posts back a resolved remote-tab URL must not persist its
  // token; the child backend mints a fresh one on every open.
  const written = mod.writeDesktopTabs(dshHome, {
    tabs: [
      { id: 'local', title: '本机' },
      { id: 'remote-1a2b3c4d', title: 'Desktop · app', url: 'http://127.0.0.1:9999/?token=SecretToken123', remote: spec },
    ],
  })
  assert.equal(written.tabs[1].url, undefined, 'the in-memory answer never carries a persisted remote URL')
  const text = readFileSync(join(dshHome, 'gui', 'desktop-tabs.json'), 'utf8')
  assert.ok(!text.includes('SecretToken123'), 'the remote-tab launch token never reaches the config file')
  assert.deepEqual(mod.readDesktopTabs(dshHome).tabs[1].remote, spec, 'the descriptor is still stored')
}

// ---------------------------------------------------------------- type inference
{
  writeConfig({
    tabs: [
      { id: 'local', title: '本机' },
      { id: 'remote-notype', title: 'no type', remote: spec },
    ],
    connections: [{ id: 'remote-notype', title: 'no type', remote: spec }],
  })
  const read = mod.readDesktopTabs(dshHome)
  assert.equal(read.connections[0].type, 'remote', 'a connection row with `remote` and no `type` is a remote connection')
}

// ---------------------------------------------------------------- validation
{
  // A tab row with only `remote` must never be mistaken for the local view.
  writeConfig({
    tabs: [
      { id: 'local', title: '本机' },
      { id: 'broken', title: 'broken', remote: { workspacePath: '/w' } },
    ],
    connections: [],
  })
  const read = mod.readDesktopTabs(dshHome)
  assert.equal(read.tabs.length, 1, 'a remote row without a target device is dropped')
  assert.ok(read.warnings.some((line) => line.includes('targetDeviceId')), 'the missing target device is reported')

  writeConfig({
    tabs: [
      { id: 'local', title: '本机' },
      { id: 'broken', title: 'broken', remote: { targetDeviceId: 'device-1' } },
    ],
  })
  assert.ok(
    mod.readDesktopTabs(dshHome).warnings.some((line) => line.includes('workspacePath')),
    'a missing workspace path is reported',
  )

  writeConfig({
    tabs: [
      { id: 'local', title: '本机' },
      { id: 'unsupported', title: 'unsupported', remote: { targetDeviceId: 'device-1', workspacePath: '/w', backend: 'codex' } },
    ],
  })
  assert.ok(
    mod.readDesktopTabs(dshHome).warnings.some((line) => line.includes('backend')),
    'an unsupported backend is reported',
  )

  assert.throws(
    () => mod.writeDesktopTabs(dshHome, {
      tabs: [{ id: 'local', title: '本机' }],
      connections: [{ id: 'remote-x', title: 'x', type: 'remote' }],
    }),
    (error: Error) => error instanceof mod.TabsValidationError && /remote/u.test(error.message),
    'a remote connection without a descriptor is rejected on write',
  )
}

rmSync(root, { recursive: true, force: true })
console.log('remote-tab targets tests passed')
