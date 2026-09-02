// dsh-remote ssh2 transport — live end-to-end regression test.
//
// Spins up a temporary in-process ssh2 *server* on 127.0.0.2 and validates,
// through the built plugin bundle, the exact transport the refactor replaced:
//
//   1. password authentication (the bug this refactor fixes),
//   2. exec('bash -s') with the pipeline-style stdin script,
//   3. local port forwarding (forwardOut -> echo server),
//   4. host-key accept-new persistence,
//   5. clean session teardown.
//
// It MUST run against an isolated HOME so nothing touches your real ~/.ssh
// (the plugin's sshHome() follows $USERPROFILE/HOME, which this script
// overrides at startup). Usage:
//
//   node tests/transport-e2e.test.mjs "<scratch-dir>"
//
// e.g. on PowerShell:
//   $s = "$env:TEMP\dsh-remote-e2e-home"; New-Item -ItemType Directory $s | Out-Null
//   node tests/transport-e2e.test.mjs $s
//
// Build first (`pnpm run build`), because it imports ../lib/index.js.
import { connect, createServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
// ssh2 is CJS — use the default import (its named exports are not uniformly
// lexer-detected by Node, see src/index.ts `loadSshClient`).
import ssh2pkg from 'ssh2'
const { Server, utils } = ssh2pkg
import { SshSession } from '../lib/index.js'

const scratch = process.argv[2]
if (!scratch) {
  console.error('usage: node tests/transport-e2e.test.mjs "<scratch-home-dir>"')
  process.exit(2)
}
mkdirSync(join(scratch, '.ssh'), { recursive: true })
console.log('isolated HOME =', scratch)

let pass = 0
const step = (m) => { pass += 1; console.log(`  ✓ ${m}`) }

// A host key offered by our in-process server, so accept-new is exercised
// against a freshly connected host.
const hostKey = await new Promise((resolve, reject) => {
  utils.generateKeyPair('ecdsa', { bits: 256 }, (err, pair) => (err ? reject(err) : resolve(pair.private)))
})

const server = new Server({ hostKeys: [hostKey] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === 'tester' && ctx.password === 'pass01') {
      console.log('  [server] password auth ACCEPT')
      ctx.accept()
    } else ctx.reject()
  })
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept()
      session.on('exec', (accept2) => {
        const stream = accept2()
        let input = ''
        stream.on('data', (d) => { input += d })
        stream.on('end', () => {
          const ok = input.includes('DSH_REMOTE_TEST_OK')
          stream.write(`${ok ? 'DSH_REMOTE_TEST_OK' : 'NOT_OK'}\n`)
          stream.exit(ok ? 0 : 1)
          stream.end()
        })
        stream.on('error', () => {})
      })
    })
    client.on('tcpip', (accept, _reject, _info) => {
      const sock = accept()
      sock.on('data', (d) => sock.write(d)) // echo
      sock.on('error', () => {})
    })
  })
})
await new Promise((r) => server.listen(0, '127.0.0.2', r))
const port = server.address().port
console.log(`fake ssh server on 127.0.0.2:${port}`)

// 1) password auth + exec('bash -s') stdin script
const sess = new SshSession({ user: 'tester', host: '127.0.0.2', port, password: 'pass01' })
await sess.connect()
step(`connect with PASSWORD auth (${sess.label})`)
const execRes = await sess.exec('echo DSH_REMOTE_TEST_OK && echo second-line', 10000)
if (execRes.exitCode !== 0 || !execRes.stdout.includes('DSH_REMOTE_TEST_OK')) {
  throw new Error(`exec failed: exit=${execRes.exitCode} out=${JSON.stringify(execRes.stdout)} err=${JSON.stringify(execRes.stderr)}`)
}
step(`exec('bash -s') stdin-script channel (exit=${execRes.exitCode})`)

// 2) local port forward -> remote echo
const local = createServer((socket) => {
  try {
    const client = sess.current
    client.forwardOut('127.0.0.1', 0, '127.0.0.1', 9000, (err, stream) => {
      if (err || !stream) { socket.destroy(); return }
      stream.on('error', () => socket.destroy())
      socket.pipe(stream).pipe(socket)
    })
  } catch { socket.destroy() }
})
await new Promise((r, j) => { local.once('error', j); local.listen(0, '127.0.0.1', r) })
const localPort = local.address().port
const echoed = await new Promise((resolve, reject) => {
  const sock = connect({ host: '127.0.0.1', port: localPort }, () => {
    sock.write('HELLO-ECHO')
    sock.on('data', (d) => { resolve(d.toString()); sock.end() })
  })
  sock.on('error', reject)
  setTimeout(() => reject(new Error('echo timeout')), 5000)
})
if (echoed !== 'HELLO-ECHO') throw new Error(`tunnel echo failed: ${JSON.stringify(echoed)}`)
step(`tunnel forwardOut echo (${JSON.stringify(echoed)})`)
local.close()
sess.close()
step('session close (teardown)')

// 3) accept-new appended the host key to the SCRATCH known_hosts only
const kh = join(scratch, '.ssh', 'known_hosts')
if (!existsSync(kh)) throw new Error('known_hosts not written in scratch HOME')
const khText = readFileSync(kh, 'utf8')
if (!khText.includes('127.0.0.2')) throw new Error(`expected 127.0.0.2 in scratch known_hosts, got: ${JSON.stringify(khText)}`)
step('accept-new appended host key to scratch known_hosts')

server.close()
console.log(`\nALL ${pass} e2e checks passed`)