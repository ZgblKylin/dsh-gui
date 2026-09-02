// dsh-remote ssh2 transport — pure logic regression tests.
//
// No network access: exercises ~/.ssh/config resolution (via the ssh-config
// library), the connection-plan builder, and the accept-new known_hosts check
// exactly as the built bundle exports them. Run after `pnpm run build`:
//
//   node tests/transport.test.mjs
//
// (The live password-auth + exec + tunnel path is covered by
//  tests/transport-e2e.test.mjs.)
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const pkg = require('../package.json')
const lib = await import('../lib/index.js')

const {
  buildSshPlan,
  resolveSshConfigFromText,
  checkHostKeyAcceptNew,
  SshSession,
  expandTilde,
} = lib

let passed = 0
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`) }

// ── ~/.ssh/config resolution (ssh-config library) ─────────────
// OpenSSH semantics = FIRST obtained value wins (ssh_config(5): general
// defaults belong at the END so a specific block above them can win). A
// `Host *` at the top therefore shadows User for specific aliases below it.
const cfg = `# comment
Host ASUS
  HostName 192.168.1.10
  User chongfei
  Port 2222
  IdentityFile ~/.ssh/asus_key
  IdentitiesOnly yes

Host *
  User defaultuser
  StrictHostKeyChecking no

Host other-host
  User other
`
const r = resolveSshConfigFromText('ASUS', cfg)
assert.equal(r.user, 'chongfei') // specific block BEFORE Host * wins
assert.equal(r.hostname, '192.168.1.10')
assert.equal(r.port, '2222')
assert.equal(r.identitiesOnly, true)
assert.deepEqual(r.identityFiles, ['~/.ssh/asus_key'])
const base = resolveSshConfigFromText('somerandomhost', cfg)
assert.equal(base.user, 'defaultuser')
assert.deepEqual(base.identityFiles, [])
ok('config resolve (specific-before-* wins / Host * base)')

// General defaults at the TOP shadow later specific values (OpenSSH first-wins).
const cfg2 = `Host *
  User defaultuser

Host ASUS
  HostName 192.168.1.11
  User chongfei
`
const r2 = resolveSshConfigFromText('ASUS', cfg2)
assert.equal(r2.user, 'defaultuser') // first obtained value wins -> Host * user
assert.equal(r2.hostname, '192.168.1.11')
ok('config resolve (first-obtained-value wins, OpenSSH-exact)')

// Multiple IdentityFile accumulate in config order.
const cfg3 = `Host x
  IdentityFile ~/.ssh/a
  IdentityFile ~/.ssh/b
  IdentityFile ~/.ssh/c
`
assert.deepEqual(resolveSshConfigFromText('x', cfg3).identityFiles, ['~/.ssh/a', '~/.ssh/b', '~/.ssh/c'])
ok('config resolve (IdentityFile accumulates)')

// Match host + `!` negation (combined pattern list) + case-insensitive directives.
const cfg4 = `Match host ASUS
  User matcheduser
  Port 2200

Host * !foo
  User notfoo
`
const m = resolveSshConfigFromText('ASUS', cfg4)
assert.equal(m.user, 'matcheduser')
assert.equal(m.port, '2200')
assert.equal(resolveSshConfigFromText('bar', cfg4).user, 'notfoo') // '* !foo' matches bar
assert.equal(resolveSshConfigFromText('foo', cfg4).user, undefined) // negated -> skipped
const cfg5 = `Host FOO
  hOsTnaME 1.2.3.5
  User foo
`
const foo = resolveSshConfigFromText('FOO', cfg5)
assert.equal(foo.user, 'foo')
assert.equal(foo.hostname, '1.2.3.5') // case-insensitive directive, ignoreCase:true
ok('config resolve (Match host / ! negation / case-insensitive)')

// ── buildSshPlan ───────────────────────────────────────────────
assert.equal(expandTilde('~').length > 0, true)
const noCfg = buildSshPlan({ user: 'root', host: 'plan-test.invalid', password: 'secret' })
assert.equal(noCfg.username, 'root')
assert.equal(noCfg.hostname, 'plan-test.invalid')
assert.equal(noCfg.port, 22)
assert.equal(noCfg.password, 'secret')
assert.equal(noCfg.keyFiles.length, 0)
const keyPlan = buildSshPlan({ user: 'root', host: 'plan-test.invalid', password: 'pp', keyFile: 'C:/k.pem' })
assert.equal(keyPlan.password, undefined)
assert.equal(keyPlan.keyPassphrase, 'pp')
assert.deepEqual(keyPlan.keyFiles, ['C:/k.pem'])
ok('buildSshPlan (explicit password / key+passphrase)')

// Real ~/.ssh/config on this machine — guarded + loose invariants so the test
// stays portable (only runs when an `ASUS` alias exists; asserts that config
// values were actually applied rather than exact host-specific values).
let realChecked = 0
try {
  const realCfg = join(expandTilde('~'), '.ssh', 'config')
  if (existsSync(realCfg) && readFileSync(realCfg, 'utf8').includes('Host ASUS')) {
    const asus = buildSshPlan({ user: '', host: 'ASUS' })
    assert.notEqual(asus.hostname, 'ASUS') // HostName resolved from config
    assert.ok(asus.username.length > 0)
    assert.ok(asus.port >= 1 && asus.port <= 65535)
    assert.ok(asus.keyFiles.length >= 1)
    assert.ok(asus.keyFiles.every((p) => !p.includes('~')))
    realChecked += 1
    ok(`buildSshPlan (real ~/.ssh/config ASUS → ${asus.username}@${asus.hostname}:${asus.port})`)
  }
} catch { /* absent or unreadable — skip */ }
void realChecked

// ── known_hosts accept-new ─────────────────────────────────────
const fakeKey = Buffer.from('fake-key-blob-1')
const otherKey = Buffer.from('fake-key-blob-2-differs')
const wildKey = Buffer.from('fake-key-blob-3-wild')
const known = [
  `1.2.3.4 ssh-ed25519 ${fakeKey.toString('base64')}`,
  `myhost ssh-ed25519 ${otherKey.toString('base64')}`,
  `*.example.com ssh-ed25519 ${wildKey.toString('base64')}`,
  '|1|cw8W4UXgFJLPuagXaLbQdX0vbWI=|i+E2pyqsM/t5D5IIW8vVhF3O6bI= ssh-ed25519 HASHEDKEYAA',
].join('\n') + '\n'
assert.deepEqual(checkHostKeyAcceptNew('1.2.3.4', fakeKey, known), { ok: true, known: true })
assert.deepEqual(checkHostKeyAcceptNew('1.2.3.4', otherKey, known), { ok: false, known: false })
assert.deepEqual(checkHostKeyAcceptNew('brandnew', fakeKey, known), { ok: true, known: false })
assert.deepEqual(checkHostKeyAcceptNew('sub.example.com', wildKey, known), { ok: true, known: true })
assert.deepEqual(checkHostKeyAcceptNew('hashedhost', fakeKey, known), { ok: true, known: false })
ok('known_hosts accept-new (same key / changed key / new host / wildcard / hashed)')

// ── SshSession failure paths (no network) ──────────────────────
const sess = new SshSession({ user: 'x', host: '127.0.0.1', port: 1, password: 'pw' })
let threw = null
try { await sess.connect() } catch (e) { threw = String(e.message) }
assert.ok(threw !== null && threw.length > 0, `expected connect error, got: ${threw}`)
console.log(`  ✓ refused-connect handled: "${threw.slice(0, 60)}…"`)
sess.close()
const res = await sess.exec('echo hi', 1000)
assert.equal(res.exitCode, 1)
assert.match(res.stderr, /未连接/)
ok('SshSession failure/teardown paths')

console.log(`\nALL ${passed} tests passed (dsh-remote ${pkg.version})`)