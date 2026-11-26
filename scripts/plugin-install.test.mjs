/**
 * Unit tests for the plugin-install up-to-date fast path, the latest-tag
 * resolution and the reinstall switches. Run with `npm run test:scripts`.
 *
 * The fast path decides whether `npm run build` spawns `dsh plugin add` for a
 * plugin, so every branch that must NOT skip is covered here: a changed pin, a
 * missing profile dependency, a stale installed version, a foreign nested
 * `node_modules`, a missing bundle entry, and a legacy install the install path
 * would drop. The link (`link:`) predicate is covered too, including the moved
 * checkout case where the recorded link no longer resolves to the package.
 *
 * The latest resolution is exercised against a stub registry: a wrapper's
 * `<package>@latest` spec must become an exact version before the install, a
 * failed answer must fall back to the tag, and the answer cache must survive
 * repeated lookups without masking a changed registry.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  fetchLatestVersion,
  linkDependencyUpToDate,
  npmPluginUpToDate,
  parseNpmrc,
  reinstallRequested,
  releaseAgeHours,
  resolveInstallableSpec,
  resolveLatestSpec,
} from './plugin-install.mjs'

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

/**
 * Start a stub npm registry that answers `/<name>/latest`.
 *
 * @param {import('node:test').TestContext} t - test context (server cleanup).
 * @param {Record<string, { status?: number, body: string, contentType?: string }>} routes -
 *   keyed by decoded request path without the leading slash.
 * @returns {Promise<{ base: string, requests: string[] }>} registry base URL and
 *   the raw request paths it received.
 */
async function startRegistry(t, routes) {
  const requests = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? '')
    const path = decodeURIComponent((request.url ?? '').replace(/^\//, ''))
    const route = routes[path]
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"not found"}')
      return
    }
    response.writeHead(route.status ?? 200, { 'content-type': route.contentType ?? 'application/json' })
    response.end(route.body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('stub registry has no address')
  return { base: `http://127.0.0.1:${address.port}`, requests }
}

/** Point the pipeline at a stub registry for one test. */
function overrideRegistryEnv(t, base) {
  const previous = process.env.DSH_PLUGIN_NPM_REGISTRY_BASE
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_PLUGIN_NPM_REGISTRY_BASE
    else process.env.DSH_PLUGIN_NPM_REGISTRY_BASE = previous
  })
  process.env.DSH_PLUGIN_NPM_REGISTRY_BASE = base
}

test('npmrc parsing keeps registry keys and drops comments, quotes and blanks', () => {
  const config = parseNpmrc([
    '; line comment',
    '# another comment',
    'registry=https://registry.example/',
    '@scope:registry = "https://scoped.example"',
    "shell-quoted='https://quoted.example'",
    'malformed',
    'empty=',
  ].join('\r\n'))
  assert.equal(config.registry, 'https://registry.example/')
  assert.equal(config['@scope:registry'], 'https://scoped.example')
  assert.equal(config['shell-quoted'], 'https://quoted.example')
  assert.equal(config.malformed, undefined)
  assert.equal(config.empty, undefined)
})

test('a latest spec resolves to the exact registry version', async (t) => {
  const registry = await startRegistry(t, {
    'dsh-demo/latest': { body: JSON.stringify({ version: '1.4.2' }) },
    '@scope/dsh-demo/latest': { body: JSON.stringify({ version: '0.9.0' }) },
  })

  assert.deepEqual(
    await resolveLatestSpec('dsh-demo@latest', { registryBase: registry.base }),
    { name: 'dsh-demo', spec: 'dsh-demo@1.4.2', version: '1.4.2' },
  )
  assert.equal((await resolveLatestSpec('@scope/dsh-demo@latest', { registryBase: registry.base })).spec, '@scope/dsh-demo@0.9.0')
  assert.ok(registry.requests.includes('/dsh-demo/latest'))
  assert.ok(registry.requests.includes('/%40scope%2Fdsh-demo/latest'))
})

test('an unusable registry answer keeps the tag spec', async (t) => {
  const registry = await startRegistry(t, {
    'http-error/latest': { status: 500, body: '{}' },
    'not-json/latest': { body: '<html></html>', contentType: 'text/html' },
    'no-version/latest': { body: JSON.stringify({ name: 'no-version' }) },
  })

  for (const name of ['http-error', 'not-json', 'no-version']) {
    const resolved = await resolveLatestSpec(`${name}@latest`, { registryBase: registry.base })
    assert.equal(resolved.spec, `${name}@latest`)
    assert.equal(typeof resolved.error, 'string')
    assert.equal(resolved.version, undefined)
  }
})

test('a registry answer is cached per harness home and reused', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-gui-npm-cache-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const registry = await startRegistry(t, {
    'dsh-demo/latest': { body: JSON.stringify({ version: '2.0.0' }) },
  })
  overrideRegistryEnv(t, registry.base)

  assert.deepEqual(await fetchLatestVersion('dsh-demo', { dshHome: home }), { version: '2.0.0' })
  assert.deepEqual(await fetchLatestVersion('dsh-demo', { dshHome: home }), { version: '2.0.0' })
  assert.equal(registry.requests.length, 1)

  const cache = JSON.parse(readFileSync(join(home, 'gui', 'npm-latest.json'), 'utf8'))
  assert.equal(cache.registry, registry.base)
  assert.equal(cache.answers['dsh-demo'].version, '2.0.0')
})

test('an expired answer is looked up again', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-gui-npm-cache-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const registry = await startRegistry(t, {
    'dsh-demo/latest': { body: JSON.stringify({ version: '2.0.0' }) },
  })
  overrideRegistryEnv(t, registry.base)

  await fetchLatestVersion('dsh-demo', { dshHome: home })
  const cachePath = join(home, 'gui', 'npm-latest.json')
  const cache = JSON.parse(readFileSync(cachePath, 'utf8'))
  cache.answers['dsh-demo'].at = Date.now() - 6 * 60_000
  writeFileSync(cachePath, JSON.stringify(cache))

  await fetchLatestVersion('dsh-demo', { dshHome: home })
  assert.equal(registry.requests.length, 2)
})

test('a failed lookup is cached briefly', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-gui-npm-cache-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const registry = await startRegistry(t, {
    'dsh-demo/latest': { status: 500, body: '{}' },
  })
  overrideRegistryEnv(t, registry.base)

  assert.equal(typeof (await fetchLatestVersion('dsh-demo', { dshHome: home })).error, 'string')
  assert.equal(typeof (await fetchLatestVersion('dsh-demo', { dshHome: home })).error, 'string')
  assert.equal(registry.requests.length, 1)
})

test('the release-age window defaults to 24 hours and honors its override', () => {
  const previous = process.env.DSH_PLUGIN_MIN_AGE_HOURS
  try {
    delete process.env.DSH_PLUGIN_MIN_AGE_HOURS
    assert.equal(releaseAgeHours(), 24)
    process.env.DSH_PLUGIN_MIN_AGE_HOURS = '6'
    assert.equal(releaseAgeHours(), 6)
    process.env.DSH_PLUGIN_MIN_AGE_HOURS = 'nonsense'
    assert.equal(releaseAgeHours(), 24)
  } finally {
    if (previous === undefined) delete process.env.DSH_PLUGIN_MIN_AGE_HOURS
    else process.env.DSH_PLUGIN_MIN_AGE_HOURS = previous
  }
})

/** One registry document pair: the `latest` tag and the full packument. */
function packumentRoutes({ latest, time, versions }) {
  return {
    'dsh-demo/latest': { body: JSON.stringify({ version: latest }) },
    'dsh-demo': {
      body: JSON.stringify({
        'dist-tags': { latest },
        time,
        versions: Object.fromEntries(versions.map((version) => [version, {}])),
      }),
    },
  }
}

test('a latest tag inside the window resolves to the newest older release', async (t) => {
  const now = Date.now()
  const registry = await startRegistry(t, packumentRoutes({
    latest: '1.4.2',
    time: {
      created: new Date(now - 30 * 24 * 3_600_000).toISOString(),
      '1.4.1': new Date(now - 30 * 24 * 3_600_000).toISOString(),
      '1.4.2': new Date(now - 3_600_000).toISOString(),
    },
    versions: ['1.4.1', '1.4.2'],
  }))

  assert.deepEqual(
    await resolveInstallableSpec('dsh-demo', { registryBase: registry.base }),
    { version: '1.4.1', rawVersion: '1.4.2', deferred: true },
  )
  assert.ok(registry.requests.includes('/dsh-demo'))
})

test('a latest tag outside the window stays the install target', async (t) => {
  const old = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString()
  const registry = await startRegistry(t, packumentRoutes({
    latest: '1.4.2',
    time: { created: old, '1.4.1': old, '1.4.2': old },
    versions: ['1.4.1', '1.4.2'],
  }))

  assert.deepEqual(
    await resolveInstallableSpec('dsh-demo', { registryBase: registry.base }),
    { version: '1.4.2', rawVersion: '1.4.2', deferred: false },
  )
})

test('an installed latest tag skips the packument walk', async (t) => {
  const registry = await startRegistry(t, {
    'dsh-demo/latest': { body: JSON.stringify({ version: '1.4.2' }) },
  })

  assert.deepEqual(
    await resolveInstallableSpec('dsh-demo', { registryBase: registry.base, installedVersion: '1.4.2' }),
    { version: '1.4.2', rawVersion: '1.4.2', deferred: false },
  )
  assert.deepEqual(registry.requests, ['/dsh-demo/latest'])
})

test('a failed packument keeps the tag version instead of hiding the update', async (t) => {
  const registry = await startRegistry(t, {
    'dsh-demo/latest': { body: JSON.stringify({ version: '1.4.2' }) },
    'dsh-demo': { status: 500, body: '{}' },
  })

  const resolved = await resolveInstallableSpec('dsh-demo', { registryBase: registry.base })
  assert.equal(resolved.version, '1.4.2')
  assert.equal(resolved.rawVersion, '1.4.2')
  assert.equal(resolved.deferred, false)
  assert.equal(resolved.unavailable, true)
})
