// dsh-remote host half — live `/remote-api` end-to-end regression test.
//
// Drives the REAL registered route handler through a temporary loopback HTTP
// server and asserts the retained op surface after SSH/credentials moved to
// `dsh-desktop-tabs`:
//
//   1. `env` — harness discovery + Docker availability (no `ssh` field),
//   2. `probe` — loadable vs merely-reachable URLs,
//   3. `local.list` / `local.stop` — the local-backend registry,
//   4. `docker.available` / `docker.list` — Docker CLI/daemon + container list,
//   5. `diag` — loopback self-probe + live counters (no `tunnels` field),
//   6. every removed SSH/credential op answers `unknown op`,
//   7. the same-origin fence (403) and malformed-body (400) paths.
//
// Needs neither SSH nor a Docker daemon: every Docker assertion only checks the
// response SHAPE, which is stable whether the CLI/daemon exists or not.
//
// Run after `pnpm run build`:
//
//   node tests/transport-e2e.test.mjs
//
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { request } from 'node:http'

const lib = await import('../lib/index.js')

let pass = 0
const step = (name) => { pass += 1; console.log(`  ✓ ${name}`) }

// ── temp loopback server wrapping the plugin's registered route ─
// `/ok` and `/missing` are probe fixtures (2xx / 404); everything else goes
// through the `/remote-api` prefix handler the plugin registers on the harness
// web server.
let routeHandler = null
const server = createServer((req, res) => {
  if (req.url === '/ok') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return }
  if (req.url === '/missing') { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('missing'); return }
  routeHandler(req, res)
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const port = server.address().port
const base = `http://127.0.0.1:${port}`
const disposers = []
const logged = { info: [], error: [] }

lib.apply({
  logger: {
    info: (message) => logged.info.push(message),
    error: (message) => logged.error.push(message),
  },
  effect: (fn) => { disposers.push(fn()) },
  webServer: {
    host: '127.0.0.1',
    port,
    register: (options) => {
      routeHandler = options.handler
      return () => { routeHandler = null }
    },
  },
})
assert.equal(typeof routeHandler, 'function', 'apply() did not register the /remote-api handler')

/** POST one `/remote-api/<op>` body; resolves `{ status, text, json }`. */
function call(op, options = {}) {
  const body = options.body === undefined ? '{}' : options.body
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...(options.headers ?? {}),
  }
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: `/remote-api/${op}`, method: 'POST', headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json
        try { json = JSON.parse(text) } catch { json = undefined }
        resolve({ status: res.statusCode, text, json })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

// ── 1. env: harness discovery + docker availability, no SSH block ─
const env = await call('env')
assert.equal(env.status, 200)
assert.equal(typeof env.json.platform, 'string')
assert.equal(typeof env.json.node, 'string')
assert.ok(env.json.node.length > 0, 'node path missing')
assert.ok(Object.hasOwn(env.json, 'docker'), 'env is missing the docker block')
assert.equal(Object.hasOwn(env.json, 'ssh'), false, 'env still reports an ssh block')
step('env (harness discovery + docker, ssh removed)')

// ── 2. probe: loadable vs merely reachable ──────────────────────
const okProbe = await call('probe', { body: JSON.stringify({ url: `${base}/ok` }) })
assert.deepEqual({ reachable: okProbe.json.reachable, loadable: okProbe.json.loadable, status: okProbe.json.status }, { reachable: true, loadable: true, status: 200 })
const missProbe = await call('probe', { body: JSON.stringify({ url: `${base}/missing` }) })
assert.deepEqual({ reachable: missProbe.json.reachable, loadable: missProbe.json.loadable, status: missProbe.json.status }, { reachable: true, loadable: false, status: 404 })
const deadProbe = await call('probe', { body: JSON.stringify({ url: 'http://127.0.0.1:1/' }) })
assert.equal(deadProbe.json.reachable, false)
assert.equal(deadProbe.json.loadable, false)
step('probe (2xx loadable / 404 reachable-only / closed port)')

// ── 3. local registry: list + stop of an unknown port ───────────
const listed = await call('local.list')
assert.deepEqual(listed.json, { ports: [] })
const stopped = await call('local.stop', { body: JSON.stringify({ port: 65533 }) })
assert.deepEqual(stopped.json, { ok: true, stopped: false })
// `local.start` spawns a real backend, so it is exercised by the shell, not here.
step('local.list / local.stop (no live backend)')

// ── 4. docker: availability + container list shapes ─────────────
const dockerAvail = await call('docker.available')
assert.equal(dockerAvail.status, 200)
assert.ok(Object.hasOwn(dockerAvail.json, 'docker'), 'docker.available is missing the docker field')
if (dockerAvail.json.docker === null) assert.equal(typeof dockerAvail.json.error, 'string')
const dockerList = await call('docker.list')
assert.equal(dockerList.status, 200)
assert.ok(Array.isArray(dockerList.json.containers), 'docker.list is missing containers[]')
step('docker.available / docker.list (shape, daemon-independent)')

// ── 5. diag: loopback self-probe + live counters, no tunnel count ─
const diag = await call('diag')
assert.equal(diag.status, 200)
assert.ok(Object.hasOwn(diag.json, 'env'), 'diag is missing env')
assert.equal(diag.json.probeMe.loadable, true, 'diag self-probe did not report the loopback route loadable')
assert.deepEqual(diag.json.locals, [])
assert.equal(typeof diag.json.dockerTunnels, 'number')
assert.equal(Object.hasOwn(diag.json, 'tunnels'), false, 'diag still reports the removed SSH tunnel count')
step('diag (self-probe + counters, ssh tunnel count removed)')

// ── 6. removed SSH/credential ops are no longer implemented ─────
const REMOVED = [
  'ssh.connect', 'ssh.cancel', 'ssh.status',
  'creds.has', 'creds.read', 'creds.save', 'creds.remove',
  'keyfile.write', 'auth.available', 'tunnel.close',
]
for (const op of REMOVED) {
  const res = await call(op)
  assert.equal(res.status, 200, `${op} did not answer with a JSON envelope`)
  assert.deepEqual(res.json, { ok: false, error: `unknown op: ${op}` }, `${op} is still implemented`)
}
step(`removed ops answer unknown op (${REMOVED.length}: ssh/creds/keyfile/auth/tunnel)`)

// ── 7. fence + body validation ──────────────────────────────────
const crossOrigin = await call('env', { headers: { origin: 'http://evil.invalid' } })
assert.equal(crossOrigin.status, 403)
assert.deepEqual(crossOrigin.json, { ok: false, error: 'untrusted origin' })
const sameOrigin = await call('local.list', { headers: { origin: base } })
assert.equal(sameOrigin.status, 200)
const badBody = await call('probe', { body: 'not json' })
assert.equal(badBody.status, 400)
assert.equal(badBody.json.ok, false)
step('same-origin fence (403) + malformed JSON body (400)')

for (const dispose of disposers) dispose()
await new Promise((resolve) => server.close(resolve))
console.log(`\nALL ${pass} e2e checks passed`)
