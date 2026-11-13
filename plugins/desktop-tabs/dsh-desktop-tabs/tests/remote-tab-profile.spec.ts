/**
 * Tests of the remote-tab child profile generation, run against the built
 * package (`../lib/index.js`). Every case works in a temporary directory: a
 * fake parent profile provides `package.json` and a partial `node_modules`
 * (only some bundle packages exist, so the whitelist filter is observable), a
 * fake runtime directory provides the `dsh` CLI entry, and a fake parent home
 * provides `settings.yaml`.
 *
 * Usage (from the package directory): node tests/remote-tab-profile.spec.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)

/** One temporary workspace: parent profile, parent home, runtime dir. */
interface Fixture {
  readonly root: string
  readonly parentProfile: string
  readonly parentHome: string
  readonly runtimeDir: string
}

/**
 * Bundles shipped inside the immutable dsh installation (the asar runtime); the
 * loader resolves these from the installation anchor first, never from the
 * profile.
 */
const RUNTIME_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/** Bundles installed into the desktop plugin profile. */
const PROFILE_BUNDLES = ['ds-harness-remote', 'dsh-remote-tab-boot']

/** Every bundle package the fixture's resolution roots expose. */
const PRESENT_BUNDLES = [...RUNTIME_BUNDLES, ...PROFILE_BUNDLES]

/** Write one fake package with a package.json under `nodeModules`. */
function writePackage(nodeModules: string, name: string): void {
  const directory = join(nodeModules, ...name.split('/'))
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
}

/** Create one fixture; `withRemote=false` leaves `ds-harness-remote` out. */
function makeFixture(options: { withRemote?: boolean; withCli?: boolean; withPeer?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-remote-tab-profile-'))
  const parentProfile = join(root, 'parent-profile')
  const parentHome = join(root, 'parent-home')
  const runtimeDir = join(root, 'runtime')
  mkdirSync(parentProfile, { recursive: true })
  mkdirSync(parentHome, { recursive: true })
  mkdirSync(runtimeDir, { recursive: true })
  // The npm/source runtime carries the optional peer the profile install lacks.
  if (options.withPeer !== false) {
    writePackage(join(root, '.harness', 'node_modules'), '@deepseek-ai/dsh-client-connection')
  }
  writeFileSync(join(parentProfile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: { 'ds-harness-remote': '0.6.3', 'dsh-better-sidebar': '0.30.1' },
    dsh: { profile: { bundles: [...PRESENT_BUNDLES, 'dsh-better-sidebar'] } },
  }, null, 2))
  // The in-box bundles exist only in the installation, like the real desktop.
  for (const bundle of RUNTIME_BUNDLES) writePackage(join(runtimeDir, 'node_modules'), bundle)
  const profileBundles = options.withRemote === false
    ? PROFILE_BUNDLES.filter((name) => name !== 'ds-harness-remote')
    : PROFILE_BUNDLES
  for (const bundle of profileBundles) writePackage(join(parentProfile, 'node_modules'), bundle)
  mkdirSync(join(parentProfile, 'node_modules'), { recursive: true })
  if (options.withCli !== false) {
    const cli = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
    mkdirSync(cli, { recursive: true })
    writeFileSync(join(cli, 'bin.js'), '// fake dsh cli\n')
  }
  writeFileSync(join(parentHome, 'settings.yaml'), 'model:\n  provider: fake\n')
  return { root, parentProfile, parentHome, runtimeDir }
}

/** Remove a fixture. */
function cleanup(fixture: Fixture): void {
  rmSync(fixture.root, { recursive: true, force: true })
}

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

// ---------------------------------------------------------------- desktop context
{
  const fixture = makeFixture()
  const context = mod.resolveDesktopContext(
    ['electron.exe', 'host.js', fixture.runtimeDir, fixture.parentProfile],
    { DSH_PROFILE_DIR: join(fixture.root, 'elsewhere') },
  )
  assert.equal(context.runtimeDir, fixture.runtimeDir, 'argv[2] is the runtime directory')
  assert.equal(context.parentProfileDir, fixture.parentProfile, 'argv[3] is the parent profile')
  assert.ok(context.cliPath?.endsWith(join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')), 'the CLI is resolved from the runtime directory')
  assert.ok(context.cliPath?.startsWith(fixture.runtimeDir), 'the CLI comes from the runtime directory when both exist')

  const fromEnv = mod.resolveDesktopContext(
    ['electron.exe', 'host.js', join(fixture.root, 'not-a-runtime'), join(fixture.root, 'not-a-profile')],
    { DSH_PROFILE_DIR: fixture.parentProfile },
  )
  assert.equal(fromEnv.parentProfileDir, fixture.parentProfile, 'DSH_PROFILE_DIR is the profile fallback')
  assert.equal(fromEnv.runtimeDir, undefined, 'an absent runtime directory is left undefined')

  const none = mod.resolveDesktopContext(['node', 'index.js'], {})
  assert.equal(none.runtimeDir, undefined)
  assert.equal(none.parentProfileDir, undefined)
  cleanup(fixture)
}

// ---------------------------------------------------------------- profile write
{
  const fixture = makeFixture()
  const childHome = mod.remoteTabHome(join(fixture.root, 'child-home'), 'remote-deadbeef')
  const profile = mod.writeRemoteTabProfile({
    parentProfileDir: fixture.parentProfile,
    parentDshHome: fixture.parentHome,
    childHome,
    serverUrl: 'https://dsh.example.test',
    runtimeDir: fixture.runtimeDir,
    env: {},
  })

  assert.equal(profile.profileDir, join(childHome, 'profiles', 'remote-tab'), 'the profile lives under the child home')
  assert.ok(existsSync(profile.packagePath), 'the child package.json is written')
  assert.ok(existsSync(profile.patchPath), 'the child cordis.patch.yml is written')
  assert.equal(profile.peerPath, join(fixture.parentProfile, 'node_modules', '@deepseek-ai', 'dsh-client-connection'), 'the missing ds-harness-remote peer is linked into the parent profile')
  assert.ok(existsSync(join(profile.peerPath, 'package.json')), 'the peer link resolves to the runtime package')
  assert.deepEqual(
    profile.bundles,
    ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-harness-remote', 'dsh-remote-tab-boot'],
    'only bundles that resolve in the parent profile are listed, in whitelist order',
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
  assert.ok(patch.includes('role: client'), 'the child runs ds-harness-remote as a client')
  assert.ok(patch.includes('serverUrl: "https://dsh.example.test"'), 'the server URL is quoted into the patch')
  assert.match(patch, /hostControl:\n\s+enabled: false/u, 'hostControl is disabled')
  assert.match(patch, /terminal:\n\s+enabled: false/u, 'the terminal feature is disabled')
  assert.match(patch, /remoteTools:\n\s+enabled: false/u, 'remote tools are disabled')
  assert.match(patch, /codex:\n\s+enabled: false/u, 'codex is disabled')
  assert.match(patch, /acp:\n\s+enabled: false/u, 'local ACP backends are disabled in the child')

  assert.equal(readFileSync(join(childHome, 'settings.yaml'), 'utf8'), 'model:\n  provider: fake\n', 'the parent settings are copied once')
  assert.equal(profile.settingsPath, join(childHome, 'settings.yaml'))

  // Idempotent: a second write refreshes the manifest but keeps the link and
  // the user's own child settings.
  writeFileSync(join(childHome, 'settings.yaml'), 'edited: true\n')
  const again = mod.writeRemoteTabProfile({
    parentProfileDir: fixture.parentProfile,
    parentDshHome: fixture.parentHome,
    childHome,
    serverUrl: 'https://dsh.example.test',
    runtimeDir: fixture.runtimeDir,
    env: {},
  })
  assert.deepEqual(again.bundles, profile.bundles, 'a rewrite keeps the same bundle list')
  assert.ok(existsSync(join(nodeModulesLink, 'ds-harness-remote', 'package.json')), 'a rewrite keeps the node_modules link')
  assert.equal(readFileSync(join(childHome, 'settings.yaml'), 'utf8'), 'edited: true\n', 'a rewrite never overwrites the child settings')
  cleanup(fixture)
}

// ---------------------------------------------------------------- failure paths
{
  const fixture = makeFixture({ withRemote: false })
  assert.throws(() => mod.writeRemoteTabProfile({
    parentProfileDir: fixture.parentProfile,
    parentDshHome: fixture.parentHome,
    childHome: join(fixture.root, 'child'),
    serverUrl: 'https://dsh.example.test',
    runtimeDir: fixture.runtimeDir,
    env: {},
  }), /ds-harness-remote/u, 'a parent profile without the remote plugin is rejected')
  cleanup(fixture)
}

{
  const fixture = makeFixture({ withCli: false })
  assert.throws(() => mod.writeRemoteTabProfile({
    parentProfileDir: fixture.parentProfile,
    parentDshHome: fixture.parentHome,
    childHome: join(fixture.root, 'child'),
    serverUrl: 'https://dsh.example.test',
    runtimeDir: fixture.runtimeDir,
    env: {},
  }), /找不到子后端 CLI/u, 'a runtime without the dsh CLI is rejected')
  cleanup(fixture)
}

{
  const fixture = makeFixture({ withPeer: false })
  assert.throws(() => mod.writeRemoteTabProfile({
    parentProfileDir: fixture.parentProfile,
    parentDshHome: fixture.parentHome,
    childHome: join(fixture.root, 'child'),
    serverUrl: 'https://dsh.example.test',
    runtimeDir: fixture.runtimeDir,
    env: {},
  }), /dsh-client-connection/u, 'a runtime without the ds-harness-remote peer is rejected with an actionable message')
  cleanup(fixture)
}

console.log('remote-tab profile tests passed')