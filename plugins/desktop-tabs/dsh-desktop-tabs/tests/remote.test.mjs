/**
 * Pure-logic tests of the remote-connection module, run against the built
 * package (`../lib/index.js`). They cover the tmux session-ensure scripts (the
 * MISSING/ALIVE states and the restart command), the launch-token file helpers,
 * remote port discovery (the pane command and the launch log), the liveness
 * verdict, and — at the script level — that `down` no longer carries any remote
 * stop/kill machinery.
 *
 * Usage (from the package directory): node tests/remote.test.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const entryPath = join(here, '..', 'lib', 'index.js')
const built = readFileSync(entryPath, 'utf8')
const mod = await import(pathToFileURL(entryPath))

/** One resolved remote target, matching {@link RemoteLaunch} construction. */
const target = {
  id: 'peer',
  host: 'peer',
  dshHome: '~/dsh-gui-home/.dsh',
  dshBin: '~/dsh-gui-home/.harness/node_modules/@deepseek-ai/dsh/lib/bin.js',
  node: 'node',
  port: 0,
  workdir: '',
  startCommand: '',
}

// ---------------------------------------------------------------- session ensure
assert.ok(mod.sessionStateScript().includes('tmux has-session -t dsh-gui'), 'state script reads the shared session')
assert.ok(mod.sessionStateScript().includes('#{pane_dead}'), 'state script reads pane liveness')
assert.equal(mod.parseSessionState('output with ALIVE'), 'ALIVE')
assert.equal(mod.parseSessionState('output with STALE'), 'STALE')
assert.equal(mod.parseSessionState('no session here'), 'MISSING')
assert.equal(mod.parseSessionState(''), 'MISSING')

// MISSING 分支不 kill（并发首连互不杀会话），重启/STALE 分支才先 kill。
const startMissing = mod.startSessionScript(target, false)
assert.ok(!startMissing.includes('kill-session'), 'a MISSING-branch start must not kill an existing session')
assert.ok(startMissing.includes('tmux new-session -d -s dsh-gui'), 'a MISSING-branch start still creates the session')

const start = mod.startSessionScript(target, true)
assert.ok(start.includes(`tmux kill-session -t ${mod.TMUX_SESSION}`), 'restart path kills an existing session')
assert.ok(start.includes('rm -f') && start.includes('$HOME'), 'restart path clears the stale token')
assert.ok(start.includes('tmux new-session -d -s dsh-gui'), 'restart path creates the shared session')
assert.ok(start.includes('bash -l -i -c'), 'the pane runs as an interactive login bash')
assert.ok(start.includes('--host 127.0.0.1') && start.includes('--port 0'), 'the launch carries the loopback bind and the configured port')
assert.ok(!start.includes('nohup'), 'tmux detaches the pane, no nohup is needed')

const configured = { ...target, workdir: '/src/myapp', startCommand: 'npm run harness' }
const startConfigured = mod.startSessionScript(configured, true)
// 工作目录与命令在 pane 脚本里还会被嵌套引号包裹，路径文本本身保持原样。
assert.ok(startConfigured.includes('/src/myapp'), 'a configured workdir is entered')
assert.ok(startConfigured.includes('npm run harness -- --host 127.0.0.1 --port 0'), 'a configured command gets the serve flags')

const describe = mod.describeLaunch(configured)
assert.ok(describe.includes('/src/myapp') && describe.includes('npm run harness'), 'describeLaunch names the workdir and command')

// 共享日志与 token 文件必须指向真实的 `$HOME/...` 路径：`homePathWord` 用双引号整体
// 包裹（`$HOME` 展开、后缀字面、防空格 home 分词）。坏形态 `"$HOME'..."` 会把撇号当
// 字面量，生成带撇号的垃圾文件，并破坏与 dsh-remote 的共享后端契约。
// （`$HOME'...'` 不出现在双引号内时为合法 POSIX，用于 dshHome/dshBin 等 remotePath；
// 断言只针对共享日志/token 文件的 `homePathWord` 形态。）
const GOOD_LOG = '"$HOME/.dsh-gui-remote.log"'
const GOOD_TOKEN = '"$HOME/.dsh-gui-remote.token"'
const BAD_LOG = "\"$HOME'/.dsh-gui-remote.log'\""
const BAD_TOKEN = "\"$HOME'/.dsh-gui-remote.token'\""

assert.ok(mod.storedTokenScript().includes(GOOD_TOKEN) && !mod.storedTokenScript().includes(BAD_TOKEN), 'stored-token read uses the real shared token path')
assert.ok(mod.waitForLaunchUrlScript().includes(GOOD_LOG) && !mod.waitForLaunchUrlScript().includes(BAD_LOG), 'the wait reads the real shared log path')
assert.ok(mod.launchUrlFromLogScript().includes(GOOD_LOG) && !mod.launchUrlFromLogScript().includes(BAD_LOG), 'the log tail uses the real shared log path')
assert.ok(mod.persistTokenScript('AbCdEf_gH-123456').includes(GOOD_TOKEN) && !mod.persistTokenScript('AbCdEf_gH-123456').includes(BAD_TOKEN), 'the token write uses the real shared token path')
for (const scriptText of [start, startMissing, startConfigured]) {
  assert.ok(scriptText.includes(GOOD_LOG) && scriptText.includes(GOOD_TOKEN), 'the start scripts redirect to and clear the real shared log/token paths')
  assert.ok(!scriptText.includes(BAD_LOG) && !scriptText.includes(BAD_TOKEN), 'the start scripts carry no apostrophe-glued shared paths')
}

// ---------------------------------------------------------------- token helpers
assert.equal(mod.isValidToken('AbCdEf_gH-123456'), true)
assert.equal(mod.isValidToken('short'), false)
assert.equal(mod.isValidToken('has space value'), false)
assert.equal(mod.isValidToken('has.dot'), false)
assert.ok(mod.storedTokenScript().includes('.dsh-gui-remote.token'), 'stored-token read names the shared file')
const persist = mod.persistTokenScript('AbCdEf_gH-123456')
assert.ok(persist.includes('umask 077'), 'token write uses an owner-only file mode')
assert.ok(persist.includes('AbCdEf_gH-123456'), 'token write carries the value')

// ---------------------------------------------------------------- port discovery
const paneScript = mod.paneStartCommandScript()
assert.ok(paneScript.includes('tmux list-panes -t dsh-gui'), 'pane read targets the shared session')
assert.equal(mod.parsePanePort('bash -l -i -c \'... --port 0 ...\''), 0, '--port 0 must fall back to the log')
assert.equal(mod.parsePanePort('bash -l -i -c \'... --port 3080 ...\''), 3080)
assert.equal(mod.parsePanePort('... --port=2412 ...'), 2412)
assert.equal(mod.parsePanePort(''), 0)
assert.equal(mod.parsePanePort('no port here'), 0)

const launchLine = 'dsh web: http://127.0.0.1:33111/?token=aBcDeFgHiJkLmNpQ'
const parsed = mod.parseLaunchUrl('peer', launchLine)
assert.equal(parsed.remotePort, 33111, 'the launch URL names the real port (--port 0 case)')
assert.equal(parsed.token, 'aBcDeFgHiJkLmNpQ')
const legacy = mod.parseLaunchUrl('peer', 'dsh web: http://127.0.0.1:33111/')
assert.equal(legacy.remotePort, 33111)
assert.equal(legacy.token, null, 'a legacy dsh has no token')
assert.throws(() => mod.parseLaunchUrl('peer', 'nothing to parse'), /no launch URL/)

const waitScript = mod.waitForLaunchUrlScript()
assert.ok(waitScript.includes('dsh web:.*https?://'), 'the wait polls the shared log for the launch URL')
assert.ok(waitScript.includes('#{pane_dead}'), 'the wait detects a pane that died during boot')
assert.ok(waitScript.includes('TABS_SESSION_DEAD'), 'the wait reports a dead pane')
assert.ok(waitScript.includes('.dsh-gui-remote.log'), 'the wait reads the shared log')

assert.equal(mod.parseLaunchToken(launchLine), 'aBcDeFgHiJkLmNpQ')
assert.equal(mod.parseLaunchToken('dsh web: http://127.0.0.1:33111/'), null)
assert.equal(mod.parseLaunchToken('nothing'), null)

// ---------------------------------------------------------------- liveness verdict
assert.equal(mod.healthVerdict(200, undefined), true, 'legacy bare 2xx is alive')
assert.equal(mod.healthVerdict(204, undefined), true)
assert.equal(mod.healthVerdict(401, 303), true, 'token 303 is alive')
assert.equal(mod.healthVerdict(401, 200), true, 'token 2xx is alive')
assert.equal(mod.healthVerdict(401, undefined), false, 'token-gated backend pending without a token')
assert.equal(mod.healthVerdict(401, 302), false, 'a bare redirect is not an alive token answer')
assert.equal(mod.healthVerdict(401, 404), false)
assert.equal(mod.healthVerdict(undefined, 303), false, 'nothing answering is not alive')
assert.equal(mod.healthVerdict(403, undefined), false)

// ---------------------------------------------------------------- down teardown
// `down`/`dispose` tear the local tunnel only; the module must no longer export
// or define any remote stop/kill/reap machinery. Script-level assertions against
// both the export surface and the built artifact.
for (const symbol of [
  'startScript', 'stopScript', 'waitScript', 'parseLaunch',
  'spawnSshDetached', 'reapStaleRemoteProcesses',
  'rememberRemoteProcess', 'forgetRemoteProcess', 'remoteSurvived',
]) {
  assert.equal(symbol in mod, false, `${symbol} must no longer be exported`)
}
assert.ok(!built.includes('stopScript('), 'no remote stop command in the built bundle')
assert.ok(!built.includes('spawnSshDetached'), 'no detached-remote cleanup in the built bundle')
assert.ok(!built.includes('TABS_PID'), 'no pid-marker launch output in the built bundle')
assert.ok(!built.includes('TABS_PGID'), 'no pgid-marker launch output in the built bundle')
assert.ok(!built.includes('TABS_REMOTE_STILL_ALIVE'), 'no survival-marker cleanup in the built bundle')
assert.ok(!built.includes('desktop-tabs-remote.json'), 'no orphan-process record file in the built bundle')

console.log(`remote tests passed (${built.length} built bytes)`)