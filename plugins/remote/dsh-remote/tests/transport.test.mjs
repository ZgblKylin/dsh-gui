// dsh-remote host half — static regression tests for the post-SSH-removal build.
//
// No network access: checks the built bundle's export surface, the package
// manifest's dependency pins, and the `apply()` loopback fence — the invariants
// that must hold after SSH/credential handling moved to `dsh-desktop-tabs`.
// Behavioural coverage of the retained ops (`env`/`probe`/`local.*`/`docker.*`/
// `diag`) lives in `transport-e2e.test.mjs`.
//
// Run after `pnpm run build`:
//
//   node tests/transport.test.mjs
//
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const pkg = require('../package.json')
const lib = await import('../lib/index.js')

let passed = 0
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`) }

// ── export surface: only the local/Docker half remains ────────
// A built ESM namespace exposes exactly the module's named exports. SSH/credential
// entry points (`SshSession`, `buildSshPlan`, `resolveSshConfigFromText`,
// `checkHostKeyAcceptNew`, `knownHostKey`, `expandTilde`, `defaultStartCommand`,
// `SshChannel`) must be gone — the Tauri shell talks to `/desktop-tabs/api/*`
// for SSH now, and any accidental leftover export would mean dead code shipped.
assert.deepEqual(
  Object.keys(lib).sort(),
  ['apply', 'defaultDockerStartCommand', 'inject', 'name'],
  'unexpected export surface',
)
assert.equal(lib.name, 'dsh-remote')
assert.deepEqual(lib.inject, ['webServer'])
assert.equal(typeof lib.defaultDockerStartCommand(), 'string')
assert.ok(lib.defaultDockerStartCommand().includes('dsh'))
ok('export surface = local/Docker host half only')

// ── manifest: ssh2 / ssh-config / @types/ssh2 unpinned ────────
assert.equal(pkg.version, '0.3.0')
for (const dep of ['ssh2', 'ssh-config']) {
  assert.equal(pkg.dependencies?.[dep], undefined, `${dep} still a dependency`)
}
assert.equal(pkg.devDependencies?.['@types/ssh2'], undefined, '@types/ssh2 still a devDependency')
ok('manifest carries no ssh2 / ssh-config / @types/ssh2')

// ── built bundle: no ssh2 / ssh-config reference ──────────────
// `ssh2` ships an optional native binding and `ssh-config` is a runtime
// dependency; either name surviving in the bundle means the removal missed a
// call site (and an install of the package would break without the deps).
const bundle = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
assert.ok(bundle.length > 0, 'empty lib/index.js')
for (const needle of ['ssh2', 'ssh-config']) {
  assert.equal(bundle.includes(needle), false, `lib/index.js still references ${needle}`)
}
ok('lib/index.js references no ssh2 / ssh-config')

// ── apply(): loopback fence still refuses a non-loopback bind ─
function fakeContext(host) {
  const calls = { registered: null, errors: [], infos: [], disposers: [] }
  const ctx = {
    logger: {
      info: (message) => calls.infos.push(message),
      error: (message) => calls.errors.push(message),
    },
    effect: (fn) => { calls.disposers.push(fn()) },
    webServer: {
      host,
      port: 1,
      register: (options) => {
        calls.registered = options
        return () => { calls.registered = null }
      },
    },
  }
  return { ctx, calls }
}

const refused = fakeContext('0.0.0.0')
lib.apply(refused.ctx)
assert.equal(refused.calls.registered, null, 'registered /remote-api on a non-loopback bind')
assert.equal(refused.calls.errors.length, 1)
assert.match(refused.calls.errors[0], /loopback/)
ok('apply() refuses a non-loopback bind')

const accepted = fakeContext('127.0.0.1')
lib.apply(accepted.ctx)
assert.equal(accepted.calls.registered?.kind, 'prefix')
assert.equal(accepted.calls.registered?.path, '/remote-api')
assert.equal(typeof accepted.calls.registered?.handler, 'function')
assert.equal(accepted.calls.errors.length, 0)
assert.ok(accepted.calls.infos.some((m) => m.includes('host up')))
// The teardown effect must be registered (route + local backends + docker tunnels).
assert.equal(accepted.calls.disposers.length, 1)
assert.equal(typeof accepted.calls.disposers[0], 'function')
accepted.calls.disposers[0]()
assert.equal(accepted.calls.registered, null, 'teardown did not dispose the route')
ok('apply() registers /remote-api + teardown on the loopback bind')

console.log(`\nALL ${passed} tests passed (dsh-remote ${pkg.version})`)
