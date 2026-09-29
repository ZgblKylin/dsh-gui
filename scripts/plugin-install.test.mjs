/**
 * Unit tests for the plugin-install up-to-date fast path and the reinstall
 * switches. Run with `npm run test:scripts`.
 *
 * The fast path decides whether `npm run build` spawns `dsh plugin add` for a
 * plugin, so every branch that must NOT skip is covered here: a changed pin, a
 * missing profile dependency, a stale installed version, a foreign nested
 * `node_modules`, a missing bundle entry, and a legacy install the install path
 * would drop. The link (`link:`) predicate is covered too, including the moved
 * checkout case where the recorded link no longer resolves to the package.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { linkDependencyUpToDate, npmPluginUpToDate, reinstallRequested } from './plugin-install.mjs'

/** Name/version pair used by most cases. */
const NAME = 'dsh-demo'
const SPEC = `${NAME}@1.2.3`

/**
 * Fabricate a web profile holding one installed npm package.
 *
 * @param {import('node:test').TestContext} t - test context (temp cleanup).
 * @param {{ installedVersion?: string, depValue?: string, bundles?: string[] | null,
 *   insertRow?: { id: string, name: string, shape?: 'insert' | 'top' } | null,
 *   nested?: boolean, bundlePatch?: boolean, name?: string, spec?: string }} [options]
 * @returns {{ profileDir: string, name: string, spec: string }}
 */
function makeProfile(t, options = {}) {
  const spec = options.spec ?? SPEC
  const name = options.name ?? spec.slice(0, spec.lastIndexOf('@'))
  const version = options.installedVersion ?? spec.slice(spec.lastIndexOf('@') + 1)
  const root = mkdtempSync(join(tmpdir(), 'dsh-gui-plugin-install-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const profileDir = join(root, 'profiles', 'web')
  const packageDir = join(profileDir, 'node_modules', ...name.split('/'))
  mkdirSync(packageDir, { recursive: true })

  const dependencies = { [name]: options.depValue ?? version }
  const dsh = { profile: { bundles: options.bundles ?? [name] } }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dependencies, dsh }))

  const manifest = { name, version: options.installedVersion ?? version }
  if (options.bundlePatch !== false) manifest.dsh = { bundle: { patch: './cordis.patch.yml' } }
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify(manifest))

  if (options.nested === true) {
    const stale = join(packageDir, 'node_modules', 'stale-peer')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'package.json'), JSON.stringify({ name: 'stale-peer', version: '0.0.1' }))
  }
  const patch = options.insertRow == null
    ? '[]\n'
    : options.insertRow.shape === 'top'
      ? `- id: ${options.insertRow.id}\n  name: ${options.insertRow.name}\n`
      : `- insert:\n    - id: ${options.insertRow.id}\n      name: ${options.insertRow.name}\n`
  writeFileSync(join(profileDir, 'cordis.patch.yml'), patch)
  return { profileDir, name, spec }
}

test('an exact pin that is installed, bundled and unmarked is skipped', (t) => {
  const { profileDir, spec } = makeProfile(t)
  assert.equal(npmPluginUpToDate(profileDir, spec), true)
})

test('a missing profile directory is never skipped', (t) => {
  const { profileDir, spec } = makeProfile(t)
  assert.equal(npmPluginUpToDate(join(profileDir, '..', 'nonexistent'), spec), false)
})

test('a bundle package absent from dsh.profile.bundles is installed again', (t) => {
  const { profileDir, spec } = makeProfile(t, { bundles: [] })
  assert.equal(npmPluginUpToDate(profileDir, spec), false)
})

test('a different installed version is installed again', (t) => {
  const { profileDir, spec } = makeProfile(t, { installedVersion: '1.2.2' })
  assert.equal(npmPluginUpToDate(profileDir, spec), false)
})

test('a profile dependency recorded at another version is installed again', (t) => {
  const { profileDir, spec } = makeProfile(t, { depValue: '1.2.2' })
  assert.equal(npmPluginUpToDate(profileDir, spec), false)
})

test('a foreign nested node_modules blocks the skip', (t) => {
  const { profileDir, spec } = makeProfile(t, { nested: true })
  assert.equal(npmPluginUpToDate(profileDir, spec), false)
})

test('a legacy installer insert blocks the skip (the install path drops it)', (t) => {
  const { profileDir, spec } = makeProfile(t, { insertRow: { id: 'demo', name: NAME, shape: 'insert' } })
  assert.equal(npmPluginUpToDate(profileDir, spec), false)
})

test('a hand-authored top-level row does not block the skip', (t) => {
  const { profileDir, spec } = makeProfile(t, { insertRow: { id: 'demo', name: NAME, shape: 'top' } })
  assert.equal(npmPluginUpToDate(profileDir, spec), true)
})

test('a non-bundle package needs its mount row, matched by the explicit mount id', (t) => {
  const withRow = makeProfile(t, {
    bundlePatch: false,
    insertRow: { id: 'custom', name: NAME, shape: 'insert' },
  })
  assert.equal(npmPluginUpToDate(withRow.profileDir, withRow.spec), false)
  assert.equal(npmPluginUpToDate(withRow.profileDir, withRow.spec, { id: 'custom', name: NAME }), true)

  const withoutRow = makeProfile(t, { bundlePatch: false })
  assert.equal(npmPluginUpToDate(withoutRow.profileDir, withoutRow.spec), false)
})

test('tags and ranges are never skipped; scoped and prerelease exact pins are', (t) => {
  const pinned = makeProfile(t)
  assert.equal(npmPluginUpToDate(pinned.profileDir, `${NAME}@latest`), false)
  assert.equal(npmPluginUpToDate(pinned.profileDir, `${NAME}@^1.2.0`), false)

  const scoped = makeProfile(t, { spec: '@scope/dsh-demo@0.4.2' })
  assert.equal(npmPluginUpToDate(scoped.profileDir, '@scope/dsh-demo@0.4.2'), true)

  const pre = makeProfile(t, { spec: 'dsh-pre@0.1.7-rc.2' })
  assert.equal(npmPluginUpToDate(pre.profileDir, 'dsh-pre@0.1.7-rc.2'), true)
})

test('a link: dependency is skipped only when it resolves to this package', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gui-plugin-link-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const packageDir = join(root, 'package')
  const otherDir = join(root, 'other')
  const profileDir = join(root, 'profiles', 'web')
  mkdirSync(packageDir, { recursive: true })
  mkdirSync(otherDir, { recursive: true })
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  const manifest = { name: 'dsh-demo-link', version: '0.0.1', dsh: { bundle: { patch: './cordis.patch.yml' } } }
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify(manifest))
  writeFileSync(join(otherDir, 'package.json'), JSON.stringify(manifest))
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-web',
      dependencies: { 'dsh-demo-link': `link:${packageDir}` },
      dsh: { profile: { bundles: ['dsh-demo-link'] } },
    }),
  )
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')

  const link = join(profileDir, 'node_modules', 'dsh-demo-link')
  symlinkSync(packageDir, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(linkDependencyUpToDate(profileDir, packageDir, 'dsh-demo-link', manifest, null), true)

  // A checkout that moved: the profile still records link:<packageDir>, but the
  // link now resolves somewhere else, so `dsh plugin add` must run again.
  rmSync(link, { force: true })
  symlinkSync(otherDir, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(linkDependencyUpToDate(profileDir, packageDir, 'dsh-demo-link', manifest, null), false)
})

test('reinstall switches disable the fast path', (t) => {
  const previousRebuild = process.env.DSH_PLUGIN_REBUILD
  const previousForce = process.env.DSH_PLUGIN_FORCE_INSTALL
  t.after(() => {
    if (previousRebuild === undefined) delete process.env.DSH_PLUGIN_REBUILD
    else process.env.DSH_PLUGIN_REBUILD = previousRebuild
    if (previousForce === undefined) delete process.env.DSH_PLUGIN_FORCE_INSTALL
    else process.env.DSH_PLUGIN_FORCE_INSTALL = previousForce
  })

  delete process.env.DSH_PLUGIN_REBUILD
  delete process.env.DSH_PLUGIN_FORCE_INSTALL
  assert.equal(reinstallRequested(), false)

  process.env.DSH_PLUGIN_REBUILD = '1'
  assert.equal(reinstallRequested(), true)
  delete process.env.DSH_PLUGIN_REBUILD

  process.env.DSH_PLUGIN_FORCE_INSTALL = '1'
  assert.equal(reinstallRequested(), true)
})
