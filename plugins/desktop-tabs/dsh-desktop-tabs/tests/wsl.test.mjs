/**
 * Pure-logic tests of the WSL remote channel, run against the built package
 * (`../lib/index.js`). They cover the `wsl.exe` stream decoder (including the
 * UTF-16LE fallback), the `wsl -l -v` / `-l -q` list parser, the in-WSL port
 * probe script and its output markers, the launch-failure classifier (a taken
 * port versus a genuine harness failure), the activation-error diagnosis
 * (unknown distro / unknown account by stable error code), the control-sequence
 * strip, the WSL target resolution (channel, account, scanned-port override),
 * the fast-failure marker the launch wait prints, and the descriptor reader.
 *
 * Nothing here spawns `wsl.exe` or opens a socket except the one loopback bind
 * probe, so the suite is pure Node.
 *
 * Usage (from the package directory): node tests/wsl.test.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')))

// ---------------------------------------------------------------- output decoding
assert.equal(mod.decodeWslOutput(Buffer.from('WSL_PORT_FREE\n', 'utf8')), 'WSL_PORT_FREE\n', 'UTF-8 bytes decode as UTF-8')
const wide = Buffer.from('WSL_PORT_FREE\n', 'utf16le')
assert.equal(mod.decodeWslOutput(wide), 'WSL_PORT_FREE\n', 'a NUL-interleaved stream falls back to UTF-16LE')
assert.equal(
  mod.decodeWslOutput(Buffer.concat([Buffer.from([0xff, 0xfe]), wide])),
  'WSL_PORT_FREE\n',
  'a UTF-16LE BOM is honoured',
)
assert.equal(mod.decodeWslOutput(new Uint8Array()), '', 'empty output decodes to empty text')

// ---------------------------------------------------------------- text cleaning
// The WSL channel is non-interactive, but a user's login rc may still emit
// OSC/title or colour sequences; parsed values and log lines must not keep them.
assert.equal(mod.stripAnsi('a\u001b]0;title\u0007b'), 'ab', 'OSC sequences terminated by BEL are removed')
assert.equal(mod.stripAnsi('a\u001b]3008;start=1;cwd=/tmp\u001b\\b'), 'ab', 'OSC sequences terminated by ST are removed')
assert.equal(mod.stripAnsi('\u001b[31mred\u001b[0m'), 'red', 'SGR colour codes are still removed')

// ---------------------------------------------------------------- error excerpt
// The excerpt must keep the root-cause line even when stack frames or a
// "Full diagnostics" block follow it (the verifier's P2 finding).
const moduleFailure = [
  'TABS_SESSION_GONE=1',
  'v26.12.1',
  "node:internal/modules/cjs/loader:1213",
  '  throw err;',
  '  ^',
  '',
  "Error: Cannot find module '/nonexistent.js'",
  'Require stack:',
  '- /nonexistent.js',
  'Node.js v26.12.1',
].join('\n')
const moduleExcerpt = mod.errorExcerpt(moduleFailure)
assert.ok(moduleExcerpt.includes("Cannot find module '/nonexistent.js'"), 'the root-cause line survives the excerpt')
assert.ok(moduleExcerpt.includes('TABS_SESSION_GONE=1'), 'the head of the output survives the excerpt')
assert.ok(moduleExcerpt.includes('Node.js v26.12.1'), 'the tail of the output survives the excerpt')
assert.ok(!moduleExcerpt.includes('\n\u001b'), 'the excerpt is control-free single-line text')
assert.ok(moduleExcerpt.length <= 500, 'the excerpt respects the default limit')

// A hint line buried between the head and the tail is still selected.
const buried = [
  'startup line 1',
  'startup line 2',
  'startup line 3',
  ...Array.from({ length: 12 }, (_, index) => `frame ${index}`),
  'Error: EADDRINUSE: address already in use 127.0.0.1:3080',
  ...Array.from({ length: 12 }, (_, index) => `trailing ${index}`),
].join('\n')
const buriedExcerpt = mod.errorExcerpt(buried)
assert.ok(buriedExcerpt.includes('EADDRINUSE'), 'a buried root-cause line is selected explicitly')
assert.ok(buriedExcerpt.indexOf('EADDRINUSE') < buriedExcerpt.length, 'the selected root cause is not cut off')

// The limit is a hard character budget, and a token-like value is neither
// invented nor mangled: redaction still happens at the reporting layer.
const longLines = [
  'h'.repeat(400),
  'h'.repeat(400),
  'Error: failed to bind',
  't'.repeat(400),
  'u'.repeat(400),
  'v'.repeat(400),
  'w'.repeat(400),
  'x'.repeat(400),
].join('\n')
const longExcerpt = mod.errorExcerpt(longLines, 220)
assert.ok(longExcerpt.length <= 220, 'an explicit limit caps the excerpt')
assert.ok(longExcerpt.includes('failed to bind'), 'the root cause survives even when the excerpt is cut')
const tokenExcerpt = mod.errorExcerpt('Error: failed\nsee http://127.0.0.1:3080/?token=SECRET-VALUE-123\nbye')
assert.equal((tokenExcerpt.match(/token=/g) ?? []).length, 1, 'the excerpt does not invent token forms')
assert.ok(!mod.redactToken(tokenExcerpt).includes('SECRET-VALUE-123'), 'the token value stays redactable')
assert.equal(mod.errorExcerpt(''), '', 'empty output yields an empty excerpt')

// ---------------------------------------------------------------- distro list parsing
const verbose = '\uFEFF  NAME              STATE           VERSION\r\n* archlinux         Running         2\r\n  docker-desktop    Stopped         2\r\n\r\n'
const hosts = mod.parseWslDistroList(verbose)
assert.equal(hosts.length, 2, 'the header and blank lines are skipped')
assert.deepEqual(hosts[0], { name: 'archlinux', state: 'Running', version: 2, default: true }, 'the default distro keeps its marker')
assert.deepEqual(hosts[1], { name: 'docker-desktop', state: 'Stopped', version: 2 })
assert.deepEqual(
  mod.parseWslDistroList('* My Distro Running 2\n'),
  [{ name: 'My Distro', state: 'Running', version: 2, default: true }],
  'a name containing spaces survives the end-anchored parse',
)
assert.deepEqual(
  mod.parseWslDistroList('archlinux\ndocker-desktop\n'),
  [{ name: 'archlinux' }, { name: 'docker-desktop' }],
  'the quiet list yields names only',
)
assert.deepEqual(mod.parseWslDistroList(''), [], 'an empty list is empty')
assert.deepEqual(
  mod.parseWslDistroList('适用于 Linux 的 Windows 子系统没有已安装的分发版。\r\n可通过运行以下命令来安装分发版:\r\n    wsl.exe --install\r\n'),
  [],
  'a no-distribution notice is not mistaken for a distro list',
)

// ---------------------------------------------------------------- port probe
const portScript = mod.wslPortFreeScript(3080)
for (const marker of [mod.WSL_PORT_FREE, mod.WSL_PORT_BUSY, mod.WSL_PORT_UNKNOWN]) {
  assert.ok(portScript.includes(marker), `the port probe prints ${marker}`)
}
assert.ok(portScript.includes('ss -ltn'), 'the probe prefers ss')
assert.ok(portScript.includes('netstat -ltn'), 'the probe falls back to netstat')
assert.ok(portScript.includes('(^|[:.])3080$'), 'the probe matches the exact port of a Local Address:Port column')
assert.equal(mod.parseWslPortFree('WSL_PORT_BUSY\n'), 'busy')
assert.equal(mod.parseWslPortFree('noise WSL_PORT_FREE noise'), 'free')
assert.equal(mod.parseWslPortFree('some unrelated output'), 'unknown')
assert.equal(mod.parseWslPortFree(''), 'unknown')

// ---------------------------------------------------------------- failure classification
assert.equal(mod.classifyWslStartFailure('Error: listen EADDRINUSE: address already in use 127.0.0.1:3080'), 'port-in-use')
assert.equal(mod.classifyWslStartFailure('error while binding: address already in use'), 'port-in-use')
assert.equal(mod.classifyWslStartFailure('Error: Cannot find module /x/bin.js'), 'start-failed', 'a harness failure is not a port collision')
assert.equal(mod.classifyWslStartFailure(''), 'start-failed')
assert.equal(mod.classifyWslStartFailure('WSL 工作目录不可进入：/nope'), 'start-failed')

// ---------------------------------------------------------------- activation diagnosis
const distroDiagnosis = mod.wslChannelDiagnosis({ distro: 'nope' }, '不存在具有所提供名称的分发。错误代码： Wsl/Service/WSL_E_DISTRO_NOT_FOUND')
assert.ok(distroDiagnosis.includes('WSL 发行版 nope 不存在'), 'an unknown distro is named in Chinese')
const userDiagnosis = mod.wslChannelDiagnosis({ distro: 'archlinux', account: 'neo' }, '找不到用户。错误代码：Wsl/WSL_E_USER_NOT_FOUND')
assert.ok(userDiagnosis.includes('WSL 账号 neo 不存在'), 'an unknown account is named in Chinese')
assert.equal(mod.wslChannelDiagnosis({ distro: 'archlinux' }, 'other failure'), undefined, 'unrelated failures keep their own text')

const commandError = new mod.WslCommandError('archlinux', 'stdout detail', 'stderr detail', 'exited with code -1')
assert.ok(commandError.message.includes('wsl archlinux'), 'the error names the distro')
assert.ok(commandError.message.includes('exited with code -1'), 'the error names the reason')
assert.ok(commandError.message.includes('stderr detail'), 'the error carries the stderr tail')
assert.equal(commandError.stdout, 'stdout detail', 'stdout is retained for classification')
assert.equal(commandError.stderr, 'stderr detail', 'stderr is retained for classification')

// ---------------------------------------------------------------- target resolution
const sshTarget = mod.resolveTarget('peer', { id: 'peer', ssh: { host: 'peer' } })
assert.equal(sshTarget.channel.kind, 'ssh')
assert.equal(sshTarget.channel.host, 'peer')
assert.equal(sshTarget.channel.user, undefined, 'an empty account leaves ssh_config in charge')
assert.equal(sshTarget.port, 0, 'the SSH default still asks the remote OS to pick a port')
const sshAccount = mod.resolveTarget('peer', { id: 'peer', ssh: { host: 'peer' }, account: 'chongfei' })
assert.equal(sshAccount.channel.user, 'chongfei', 'account becomes ssh -l')

const wslTarget = mod.resolveTarget('wsl-arch', { id: 'wsl-arch', wsl: { distro: 'archlinux' } })
assert.equal(wslTarget.channel.kind, 'wsl')
assert.equal(wslTarget.channel.distro, 'archlinux')
assert.equal(wslTarget.channel.account, undefined)
assert.equal(wslTarget.port, mod.DEFAULT_WSL_PORT)
assert.equal(mod.DEFAULT_WSL_PORT, 3080, 'the WSL scan starts at 3080')
const wslAccount = mod.resolveTarget('wsl-arch', { id: 'wsl-arch', wsl: { distro: 'archlinux', port: 4090 }, account: 'neo' })
assert.equal(wslAccount.channel.account, 'neo', 'account becomes wsl.exe -u')
assert.equal(wslAccount.port, 4090, 'a descriptor port is the first scan candidate')
const defaultDistro = mod.resolveTarget('wsl-default', { id: 'wsl-default', wsl: { distro: '' } })
assert.equal(defaultDistro.channel.distro, '', 'an empty distro means the wsl.exe default')
assert.equal(mod.channelLabel(defaultDistro.channel), '默认发行版')
const both = mod.resolveTarget('both', { id: 'both', ssh: { host: 'peer' }, wsl: { distro: 'archlinux' } })
assert.equal(both.channel.kind, 'ssh', 'ssh wins when a row carries both descriptors')
assert.throws(() => mod.resolveTarget('none', { id: 'none' }), /no "ssh" descriptor/)
assert.throws(() => mod.resolveTarget('bad', { id: 'bad', ssh: { host: 'a b' } }), /unusable ssh host/)

// ---------------------------------------------------------------- start with a scanned port
const configured = { ...wslTarget, workdir: '/src/app', startCommand: 'npm run harness' }
const start = mod.startSessionScript(configured, true)
assert.ok(start.includes(`tmux new-session -d -s ${mod.TMUX_SESSION}`), 'the shared session is created')
assert.ok(start.includes('--host 127.0.0.1') && start.includes('--port 3080'), 'the long form carries the loopback bind and the WSL default port')
const override = mod.startSessionScript(configured, false, 3091)
assert.ok(override.includes('--port 3091'), 'the scanned port overrides the descriptor port')
assert.ok(!override.includes('--port 3080'), 'the descriptor port is not appended as well')
assert.ok(override.includes('npm run harness -- --host 127.0.0.1'), 'a configured command keeps its package-manager separator')
assert.ok(!override.includes('kill-session'), 'a MISSING-branch start must not kill an existing session')
assert.ok(override.includes('"$HOME/.dsh-gui-remote.log"'), 'the shared log path is unchanged')
assert.ok(override.includes('"$HOME/.dsh-gui-remote.token"'), 'the shared token path is unchanged')

// The logged command must name the port the scan selected, not the descriptor's
// first candidate (the startup log used to claim 3080 while dsh ran on 3081).
assert.ok(mod.describeLaunch(configured).includes('--port 3080'), 'describeLaunch defaults to the descriptor port')
const describeScanned = mod.describeLaunch(configured, 3091)
assert.ok(describeScanned.includes('--port 3091'), 'describeLaunch carries the scanned port')
assert.ok(!describeScanned.includes('--port 3080'), 'describeLaunch does not also name the descriptor port')

assert.equal(mod.appendServeFlags('node bin.js web', 3080), 'node bin.js web --host 127.0.0.1 --port 3080')
assert.equal(mod.appendServeFlags('node bin.js web --host 0.0.0.0 --port 1234', 3080), 'node bin.js web --host 0.0.0.0 --port 1234')
assert.ok(!mod.appendServeFlags('node bin.js web --port 3080', 3080).includes('0.0.0.0'), 'the appended bind is never wildcard')

assert.equal(mod.startCommandPinsPort('npm run harness --port 3080'), true)
assert.equal(mod.startCommandPinsPort('node bin.js web --port=3080'), true)
assert.equal(mod.startCommandPinsPort('node bin.js web --port $PORT'), true)
assert.equal(mod.startCommandPinsPort('npm run harness'), false)
assert.equal(mod.startCommandPinsPort(''), false)
assert.equal(mod.parsePinnedPort('node bin.js web --port 3080'), 3080, 'the pinned port is the first scan candidate')
assert.equal(mod.parsePinnedPort('node bin.js web --port=4090'), 4090)
assert.equal(mod.parsePinnedPort('node bin.js web --port $PORT'), 0, 'an unevaluable pin has no numeric port')
assert.equal(mod.parsePinnedPort('npm run harness'), 0)

// ---------------------------------------------------------------- launch wait fast failures
const wait = mod.waitForLaunchUrlScript()
for (const marker of [mod.SESSION_DEAD_MARKER, mod.SESSION_GONE_MARKER, mod.URL_TIMEOUT_MARKER]) {
  assert.ok(wait.includes(marker), `the launch wait reports ${marker}`)
}
assert.ok(wait.includes(`tmux has-session -t ${mod.TMUX_SESSION}`), 'the launch wait detects a vanished session')
assert.ok(wait.includes('exit 4') && wait.includes('exit 5'), 'both the fast-failure exit and the timeout exit are used')
assert.ok(wait.includes('.dsh-gui-remote.log'), 'the launch wait tails the shared log')

// ---------------------------------------------------------------- descriptor reader
const workspace = mkdtempSync(join(tmpdir(), 'dsh-desktop-tabs-wsl-'))
mkdirSync(join(workspace, 'gui'), { recursive: true })
writeFileSync(join(workspace, 'gui', 'desktop-tabs.json'), JSON.stringify({
  tabs: [
    { id: 'local', title: '本机' },
    { id: 'peer', title: 'peer', ssh: { host: 'peer' }, workdir: '/srv/app', startCommand: 'npm run harness' },
    { id: 'wsl-arch', title: 'archlinux', wsl: { distro: 'archlinux', port: 4090 }, account: 'chongfei' },
    { id: 'both', title: 'both', ssh: { host: 'peer' }, wsl: { distro: 'archlinux' } },
    { id: 'broken', title: 'broken', wsl: 42 },
  ],
}))
const configuredRows = mod.readConfiguredRemoteTabs(workspace)
assert.deepEqual(configuredRows.map(row => row.id), ['peer', 'wsl-arch', 'both'], 'only usable descriptors are read')
const readWsl = configuredRows.find(row => row.id === 'wsl-arch')
assert.equal(readWsl.wsl.distro, 'archlinux')
assert.equal(readWsl.wsl.port, 4090)
assert.equal(readWsl.account, 'chongfei', 'the flat account round-trips')
const readBoth = configuredRows.find(row => row.id === 'both')
assert.ok(readBoth.ssh !== undefined && readBoth.wsl !== undefined, 'both descriptors survive the read')
assert.equal(mod.resolveTarget('both', readBoth).channel.kind, 'ssh', 'the reader keeps ssh-first resolution')
assert.deepEqual(mod.readConfiguredSshTabs(workspace).map(row => row.id), ['peer', 'both'], 'the ssh-only reader keeps its old selection')
rmSync(workspace, { recursive: true, force: true })

// ---------------------------------------------------------------- loopback bind probe
const occupied = createServer()
await new Promise((resolve, reject) => {
  occupied.once('error', reject)
  occupied.listen(0, '127.0.0.1', resolve)
})
const occupiedPort = occupied.address().port
assert.equal(await mod.isLoopbackPortFree(occupiedPort), false, 'a bound loopback port is not free')
await new Promise((resolve) => occupied.close(resolve))
assert.equal(await mod.isLoopbackPortFree(occupiedPort), true, 'a released loopback port is free again')

// ---------------------------------------------------------------- availability shape
const availability = mod.wslAvailable()
assert.equal(typeof availability.available, 'boolean')
if (!availability.available) assert.ok(typeof availability.error === 'string' && availability.error !== '', 'an unavailable WSL explains itself')

console.log('wsl tests passed')
