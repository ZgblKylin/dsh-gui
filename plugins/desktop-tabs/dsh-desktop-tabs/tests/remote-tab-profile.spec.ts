/**
 * Tests of the generic remote-tab child profile generation and context
 * resolution, run against the built package (`../lib/index.js`).
 *
 * The profile mirrors the parent composition verbatim and adds only the
 * provider's bundles, patch, and home files; the loader is generated beside the
 * profile with the runtime and profile anchors. Every case works in a temporary
 * fixture (`remote-tab-fixtures.ts`), so the real profile and runtime are never
 * touched.
 *
 * Usage (from the package directory): node tests/remote-tab-profile.spec.ts
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

import {
  PROFILE_BUNDLES,
  RUNTIME_BUNDLES,
  cleanup,
  fakeProvider,
  makeFixture,
  writePackage,
} from './remote-tab-fixtures.ts'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)

// ---------------------------------------------------------------- naming helpers
const safe = mod.safeConnectionId('remote-1a2b3c4d')
assert.match(safe, /^remote-1a2b3c4d-[0-9a-f]{8}$/u, 'a safe connection id keeps the readable part and appends a hash')
assert.equal(mod.safeConnectionId('remote-1a2b3c4d'), safe, 'the safe id is stable')
assert.match(mod.safeConnectionId('../../etc/passwd'), /^etc-passwd-[0-9a-f]{8}$/u, 'a path-traversing id is neutralized')
assert.notEqual(mod.safeConnectionId('a/b'), mod.safeConnectionId('a\\b'), 'different ids hash apart even when they sanitize alike')

const home = join('C:', 'dsh-home')
assert.equal(
  mod.remoteTabHome(home, 'remote-1a2b3c4d'),
  join(home, 'gui', 'remote-tabs', safe, 'home'),
  'the child home is <DSH_HOME>/gui/remote-tabs/<safe id>/home',
)
assert.equal(mod.remoteTabProfileDir(join(home, 'child')), join(home, 'child', 'profiles', 'remote-tab'))

const deviceName = mod.remoteDeviceName('Desktop-ZgblKylin · archlinux')
assert.equal(deviceName, 'Desktop-ZgblKylin · archlinux · 远程标签', 'the device name carries the connection title and the suffix')
const longName = mod.remoteDeviceName('x'.repeat(200))
assert.equal([...longName].length, mod.MAX_DEVICE_NAME, 'the device name is truncated to the identity schema limit')
assert.equal(longName, 'x'.repeat(mod.MAX_DEVICE_NAME), 'the truncated name keeps whole ASCII characters')
const wideName = mod.remoteDeviceName('喵'.repeat(100))
assert.equal([...wideName].length, mod.MAX_DEVICE_NAME, 'a wide CJK name is truncated to the limit')
assert.equal([...wideName].every((character) => character === '喵'), true, 'a CJK name is truncated between characters')
const emojiName = mod.remoteDeviceName('😀'.repeat(100))
assert.ok(emojiName.length <= mod.MAX_DEVICE_NAME, 'the limit counts UTF-16 units, like the identity schema')
assert.equal(emojiName.length, mod.MAX_DEVICE_NAME, 'emoji fill the limit in whole code points')
assert.equal([...emojiName].every((character) => character === '😀'), true, 'truncation never splits a surrogate pair')
assert.equal(mod.remoteDeviceName('   '), '远程标签', 'a blank title falls back to the suffix')

// ---------------------------------------------------------------- generic context
{
  const fixture = makeFixture()
  const direct = mod.resolveRemoteTabContext(
    ['electron.exe', 'host.js', fixture.runtimeDir, fixture.parentProfile],
    { DSH_PROFILE_DIR: join(fixture.root, 'elsewhere') },
  )
  assert.equal(direct.runtimeDir, fixture.runtimeDir, 'argv[2] is the runtime directory')
  assert.equal(direct.parentProfileDir, fixture.parentProfile, 'argv[3] is the parent profile')
  assert.equal(direct.cliPath, join(fixture.runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'the CLI comes from the runtime directory')

  // A plain `dsh` boot puts the CLI in argv[1]; the runtime root is derived by
  // walking up to the package that owns it.
  const fromEntry = mod.resolveRemoteTabContext(
    ['node.exe', join(fixture.runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')],
    { DSH_PROFILE_DIR: fixture.parentProfile },
  )
  assert.equal(fromEntry.runtimeDir, fixture.runtimeDir, 'the runtime is derived from argv[1]')
  assert.equal(fromEntry.cliPath, direct.cliPath, 'the derived runtime yields the same CLI')
  assert.equal(fromEntry.parentProfileDir, fixture.parentProfile, 'DSH_PROFILE_DIR is the profile fallback')

  // No profile argument and no DSH_PROFILE_DIR: fall back to
  // <DSH_HOME>/profiles/<DSH_PROFILE>.
  const fallbackProfile = join(fixture.root, 'custom-home', 'profiles', 'web')
  mkdirSync(fallbackProfile, { recursive: true })
  writeFileSync(join(fallbackProfile, 'package.json'), JSON.stringify({ name: 'dsh-profile-web' }, null, 2))
  const fromHome = mod.resolveRemoteTabContext(
    ['node.exe', join(fixture.runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')],
    { DSH_HOME: join(fixture.root, 'custom-home'), DSH_PROFILE: 'web' },
  )
  assert.equal(mod.resolveParentProfileDir([], { DSH_HOME: join(fixture.root, 'custom-home'), DSH_PROFILE: 'web' }, fixture.root), fallbackProfile)
  assert.equal(fromHome.parentProfileDir, fallbackProfile, 'DSH_HOME/profiles/<DSH_PROFILE> is the last profile fallback')

  const none = mod.resolveRemoteTabContext(['node', 'index.js'], {}, fixture.root)
  assert.equal(none.runtimeDir, undefined, 'no runtime directory is reported when none can be resolved')
  assert.equal(none.parentProfileDir, undefined, 'no parent profile is reported when none can be resolved')
  assert.equal(mod.resolveChildCli(undefined), undefined, 'no runtime means no child CLI')
  cleanup(fixture)
}

// ---------------------------------------------------------------- profile write
{
  const fixture = makeFixture()
  const childHome = mod.remoteTabHome(join(fixture.root, 'child-home'), 'remote-deadbeef')
  const { provider, calls } = fakeProvider()
  const profile = mod.writeRemoteTabProfile({
    parentProfileDir: fixture.parentProfile,
    parentDshHome: fixture.parentHome,
    childHome,
    serverUrl: 'https://dsh.example.test',
    provider,
    runtimeDir: fixture.runtimeDir,
    env: {},
  })

  assert.equal(profile.profileDir, join(childHome, 'profiles', 'remote-tab'), 'the profile lives under the child home')
  assert.ok(existsSync(profile.packagePath), 'the child package.json is written')
  assert.ok(existsSync(profile.patchPath), 'the child cordis.patch.yml is written')
  assert.deepEqual(calls.prepared, [{ parentProfileDir: fixture.parentProfile, runtimeDir: fixture.runtimeDir }], 'the provider prepares the parent profile')
  assert.deepEqual(calls.patchRequests, ['https://dsh.example.test'], 'the provider renders the patch for the resolved server URL')
  assert.deepEqual(
    profile.bundles,
    [...RUNTIME_BUNDLES, ...PROFILE_BUNDLES, 'dsh-remote-tab-boot'],
    'the child carries the parent bundle composition verbatim plus the provider bundles',
  )

  const childPackage = JSON.parse(readFileSync(profile.packagePath, 'utf8'))
  assert.deepEqual(childPackage.dependencies, { 'ds-harness-remote': '0.6.3', 'dsh-better-sidebar': '0.30.1' }, 'parent dependencies are copied')
  assert.deepEqual(childPackage.dsh.profile.bundles, profile.bundles, 'the package manifest carries the bundle list')
  assert.equal(childPackage.private, true)

  const nodeModulesLink = join(profile.profileDir, 'node_modules')
  // A Windows junction resolves transparently but `lstat` may report it as a
  // directory, so the link is proven by writing through it: the probe must land
  // in the parent profile's tree, which a copied directory would not do.
  assert.ok(existsSync(join(nodeModulesLink, 'ds-harness-remote', 'package.json')), 'the child node_modules reaches the parent dependency tree')
  writeFileSync(join(nodeModulesLink, '__remote-tab-link-probe__'), 'probe\n')
  assert.ok(existsSync(join(fixture.parentProfile, 'node_modules', '__remote-tab-link-probe__')), 'the child node_modules is a link, not a copy')
  rmSync(join(fixture.parentProfile, 'node_modules', '__remote-tab-link-probe__'), { force: true })

  const patch = readFileSync(profile.patchPath, 'utf8')
  assert.ok(patch.includes('# parent user patch'), 'the parent user patch is copied verbatim')
  assert.ok(patch.indexOf('# parent user patch') < patch.indexOf('# provider patch'), 'the provider patch is appended last')
  assert.ok(patch.includes('- id: ds-harness-remote'), 'the provider patch carries its entry')
  assert.ok(patch.includes('"https://dsh.example.test"'), 'the provider patch carries the server URL')

  assert.equal(profile.runtimeAnchor, join(fixture.runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'the loader runtime anchor is the hosting runtime')
  assert.equal(profile.profileAnchor, join(fixture.parentProfile, 'package.json'), 'the loader profile anchor is the parent profile manifest')
  assert.equal(profile.loaderPath, mod.remoteTabLoaderPath(childHome), 'the loader lives in the child home')
  const loader = readFileSync(profile.loaderPath, 'utf8')
  assert.ok(loader.includes(JSON.stringify(profile.runtimeAnchor)), 'the loader embeds the runtime anchor')
  assert.ok(loader.includes(JSON.stringify(profile.profileAnchor)), 'the loader embeds the profile anchor')
  assert.ok(loader.includes('startsWith(SCOPE)'), 'the loader scopes its remapping')

  assert.deepEqual(profile.homeFiles, [
    join(childHome, 'settings.yaml'),
    join(childHome, 'dsh-pet', 'main-config.jsonc'),
    join(childHome, 'pet.json'),
  ], 'the provider home files are copied')
  assert.equal(readFileSync(join(childHome, 'settings.yaml'), 'utf8'), 'model:\n  provider: fake\n', 'the parent settings are copied')
  assert.equal(readFileSync(join(childHome, 'dsh-pet', 'main-config.jsonc'), 'utf8'), '// pet config\n', 'the pet configuration is copied')
  assert.equal(readFileSync(join(childHome, 'pet.json'), 'utf8'), '{"name":"parent-pet"}\n', 'the pet state entry is copied')

  // Idempotent: a second write refreshes the manifest but keeps the link and
  // the user's own child files.
  writeFileSync(join(childHome, 'settings.yaml'), 'edited: true\n')
  const again = mod.writeRemoteTabProfile({
    parentProfileDir: fixture.parentProfile,
    parentDshHome: fixture.parentHome,
    childHome,
    serverUrl: 'https://dsh.example.test',
    provider,
    runtimeDir: fixture.runtimeDir,
    env: {},
  })
  assert.deepEqual(again.bundles, profile.bundles, 'a rewrite keeps the same bundle list')
  assert.ok(existsSync(join(nodeModulesLink, 'ds-harness-remote', 'package.json')), 'a rewrite keeps the node_modules link')
  assert.equal(readFileSync(join(childHome, 'settings.yaml'), 'utf8'), 'edited: true\n', 'a rewrite never overwrites the child settings')
  cleanup(fixture)
}

// ---------------------------------------------------------------- source-layout runtime
{
  // A source checkout supplies the CLI and loader anchor explicitly; bundle
  // resolution still uses that anchor, so in-box packages resolve through the
  // source workspace tree.
  const fixture = makeFixture()
  const sourceRoot = join(fixture.root, 'source-runtime')
  mkdirSync(join(sourceRoot, 'apps', 'cli', 'lib'), { recursive: true })
  writeFileSync(join(sourceRoot, 'apps', 'cli', 'lib', 'bin.js'), '// source dsh cli\n')
  writeFileSync(join(sourceRoot, 'apps', 'cli', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }, null, 2))
  // Source workspaces keep dependencies at the checkout root.
  writePackage(join(sourceRoot, 'node_modules'), '@deepseek-ai/dsh-base')
  writePackage(join(sourceRoot, 'node_modules'), '@deepseek-ai/dsh-web-app')
  const childHome = join(fixture.root, 'source-child')
  const profile = mod.writeRemoteTabProfile({
    parentProfileDir: fixture.parentProfile,
    parentDshHome: fixture.parentHome,
    childHome,
    serverUrl: 'https://dsh.example.test',
    provider: fakeProvider().provider,
    runtimeDir: sourceRoot,
    runtimeAnchor: join(sourceRoot, 'apps', 'cli', 'package.json'),
    cliPath: join(sourceRoot, 'apps', 'cli', 'lib', 'bin.js'),
    env: {},
  })
  assert.equal(profile.cliPath, join(sourceRoot, 'apps', 'cli', 'lib', 'bin.js'), 'the source CLI is used')
  assert.equal(profile.runtimeAnchor, join(sourceRoot, 'apps', 'cli', 'package.json'), 'the source dsh manifest is the loader anchor')
  const loader = readFileSync(profile.loaderPath, 'utf8')
  assert.ok(loader.includes(JSON.stringify(profile.runtimeAnchor)), 'the loader anchors at the source installation')
  assert.ok(profile.bundles.includes('@deepseek-ai/dsh-base'), 'in-box bundles resolve from the source anchor')
  cleanup(fixture)
}

// ---------------------------------------------------------------- provider requirements
{
  const fixture = makeFixture({ withRemote: false })
  assert.throws(() => mod.writeRemoteTabProfile({
    parentProfileDir: fixture.parentProfile,
    parentDshHome: fixture.parentHome,
    childHome: join(fixture.root, 'child'),
    serverUrl: 'https://dsh.example.test',
    provider: fakeProvider().provider,
    runtimeDir: fixture.runtimeDir,
    env: {},
  }), /ds-harness-remote/u, 'a missing required provider bundle is rejected with an actionable message')
  cleanup(fixture)
}

{
  // A provider bundle that does not resolve is simply not listed; the
  // supervisor's readiness check turns that into a fail-fast error instead of a
  // 90-second timeout.
  const fixture = makeFixture({ withBoot: false })
  const childHome = join(fixture.root, 'child')
  const profile = mod.writeRemoteTabProfile({
    parentProfileDir: fixture.parentProfile,
    parentDshHome: fixture.parentHome,
    childHome,
    serverUrl: 'https://dsh.example.test',
    provider: fakeProvider().provider,
    runtimeDir: fixture.runtimeDir,
    env: {},
  })
  assert.ok(!profile.bundles.includes('dsh-remote-tab-boot'), 'an unresolvable provider bundle is not listed')
  cleanup(fixture)
}

{
  const fixture = makeFixture({ withCli: false })
  assert.throws(() => mod.writeRemoteTabProfile({
    parentProfileDir: fixture.parentProfile,
    parentDshHome: fixture.parentHome,
    childHome: join(fixture.root, 'child'),
    serverUrl: 'https://dsh.example.test',
    provider: fakeProvider().provider,
    runtimeDir: fixture.runtimeDir,
    env: {},
  }), /找不到子后端 CLI/u, 'a runtime without the dsh CLI is rejected')
  cleanup(fixture)
}

console.log('remote-tab profile tests passed')
