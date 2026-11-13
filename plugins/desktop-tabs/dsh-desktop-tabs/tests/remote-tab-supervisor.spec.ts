/**
 * Tests of the remote-tab child supervisor, run against the built package
 * (`../lib/index.js`).
 *
 * The child processes are emulated by an in-process fake: the injected spawner
 * records the spawn plan the production code would run and returns a
 * `FakeChild` whose stdout/stderr are real streams and whose exit and SIGTERM
 * behaviour are driven by timers. That keeps the readiness handshake, timeout,
 * early exit, redaction, down, forget, and dispose paths real without starting a
 * second `dsh` — the test sandbox refuses a nested child with piped stdio, and a
 * real child is not needed to exercise the supervisor's own logic. The plan of a
 * real child (arguments, scrubbed environment) is asserted directly as a pure
 * function.
 *
 * Usage (from the package directory): node tests/remote-tab-supervisor.spec.ts
 */

import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)

const root = mkdtempSync(join(tmpdir(), 'dsh-remote-tab-supervisor-'))
const CHILD_URL = 'http://127.0.0.1:34567/?token=SecretChildToken123'

/** How one fake child should behave after "spawn". */
type FakeMode = 'ready' | 'no-boot' | 'exit1' | 'token-error' | 'ignore-sigterm'

let nextPid = 1000

/**
 * An in-process stand-in for a spawned child. It exposes the subset of
 * `ChildProcess` the supervisor drives: `stdout`/`stderr` data events, `once`
 * lifecycle listeners, `exitCode`, and `kill`.
 */
class FakeChild extends EventEmitter {
  readonly pid = nextPid++
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = 0

  constructor(mode: FakeMode) {
    super()
    // Emit after the supervisor has attached its listeners (the spawner returns
    // before the first tick), exactly like a fresh process's output.
    setTimeout(() => { this.start(mode) }, 5)
  }

  private start(mode: FakeMode): void {
    if (this.exitCode !== null) return
    if (mode === 'ready') {
      this.stdout.write(`dsh web: ${CHILD_URL}\n`)
      this.stdout.write('[remote-tab-boot] ready device-1 /src/app\n')
      return
    }
    if (mode === 'no-boot') {
      this.stdout.write(`dsh web: ${CHILD_URL}\n`)
      return
    }
    if (mode === 'exit1') {
      this.stderr.write('boom: startup failed\n')
      setTimeout(() => { this.exit(1) }, 5)
      return
    }
    if (mode === 'token-error') {
      this.stderr.write(`failed with ${CHILD_URL}\n`)
      setTimeout(() => { this.exit(3) }, 5)
    }
    // 'ignore-sigterm' does nothing: the child keeps running.
  }

  /** Terminate the fake child and report the exit exactly once. */
  exit(code: number | null): void {
    if (this.exitCode !== null) return
    this.exitCode = code
    this.emit('exit', code, null)
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed += 1
    this.exit(0)
    return true
  }
}

/** One supervisor under test, its captured plans, and its children. */
interface Harness {
  readonly supervisor: ReturnType<typeof mod.createRemoteTabSupervisor>
  readonly plans: { args: readonly string[]; env: NodeJS.ProcessEnv; cwd: string; command: string }[]
  readonly children: FakeChild[]
}

/** Build a supervisor whose "children" are `FakeChild` instances in `mode`. */
function makeHarness(mode: FakeMode, overrides: Record<string, unknown> = {}): Harness {
  const plans: Harness['plans'] = []
  const children: FakeChild[] = []
  const spawn = (plan: { args: readonly string[]; env: NodeJS.ProcessEnv; cwd: string; command: string }) => {
    plans.push(plan)
    const child = new FakeChild(mode)
    children.push(child)
    return child
  }
  const supervisor = mod.createRemoteTabSupervisor({
    dshHome: join(root, 'parent-home'),
    parentProfileDir: join(root, 'parent-profile'),
    runtimeDir: join(root, 'runtime'),
    spawn,
    readyTimeoutMs: 2_000,
    terminateTimeoutMs: 500,
    resolveIdentity: async () => ({ serverUrl: 'https://dsh.example.test', deviceId: 'device-12345678' }),
    prepareProfile: async ({ childHome }: { childHome: string }) => {
      mkdirSync(childHome, { recursive: true })
      writeFileSync(join(childHome, 'marker.txt'), 'child home\n')
      return { cliPath: '/fake/bin.js' }
    },
    ...overrides,
  })
  return { supervisor, plans, children }
}

/** A unique request per test, so records do not bleed across cases. */
function requestFor(id: string): { id: string; title: string; remote: Record<string, string> } {
  return {
    id,
    title: 'Desktop-ZgblKylin · archlinux',
    remote: { targetDeviceId: 'device-1', targetName: 'Desktop-ZgblKylin', workspacePath: '/src/app', backend: 'harness' },
  }
}

/** Poll until the predicate holds; throws the named condition after the budget. */
async function until(predicate: () => boolean, label = 'condition', budgetMs = 3_000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => { setTimeout(resolve, 20) })
  }
  throw new Error(`${label} did not become true in time`)
}

/** Let pending timers run once. */
async function tick(ms = 30): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, ms) })
}

// ---------------------------------------------------------------- spawn plan
{
  const plan = mod.childSpawnPlan({
    cliPath: 'C:/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',
    childHome: 'C:/children/one/home',
    target: { targetDeviceId: 'device-1', workspacePath: '/src/app', backend: 'harness' },
    electron: false,
    execPath: 'C:/runtime/node.exe',
    env: {
      PATH: 'C:/bin',
      DSH_PROFILE: 'desktop',
      DSH_PROFILE_DIR: 'C:/profiles/desktop',
      DSH_PLUGIN_PROFILE: 'desktop',
      DSH_PLUGIN_DSH_CLI: 'C:/elsewhere/bin.js',
      DSH_SESSION_ID: 'session-1',
      DSH_SHELL: '1',
      DSH_WEB_URL: 'http://127.0.0.1:1/?token=leak',
      DSH_GUI_ROOT: 'C:/gui',
    },
  })
  assert.equal(plan.command, 'C:/runtime/node.exe', 'the configured executable runs the child')
  assert.deepEqual(plan.args, [
    'C:/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',
    '--profile',
    'remote-tab',
    '--host',
    '127.0.0.1',
    '--port',
    '0',
    '--no-open',
  ], 'the child selects the remote-tab profile and asks for a loopback ephemeral port; no `web` word')
  assert.ok(!plan.args.includes('web'), '`web` is a profile alias, not a subcommand, so it is never passed')
  assert.equal(plan.cwd, 'C:/children/one/home', 'the child runs in its own home')
  assert.equal(plan.env.DSH_HOME, 'C:/children/one/home', 'DSH_HOME points at the child home')
  assert.deepEqual(JSON.parse(plan.env.DSH_REMOTE_TAB_TARGET), {
    targetDeviceId: 'device-1',
    workspacePath: '/src/app',
    backend: 'harness',
  }, 'the target rides in DSH_REMOTE_TAB_TARGET')
  assert.equal(plan.env.DSH_GUI_ROOT, 'C:/gui', 'DSH_GUI_ROOT is preserved')
  assert.equal(plan.env.DSH_PROFILE, undefined, 'the parent profile selection is scrubbed')
  assert.equal(plan.env.DSH_PROFILE_DIR, undefined, 'the parent profile directory is scrubbed')
  assert.equal(plan.env.DSH_PLUGIN_PROFILE, undefined)
  assert.equal(plan.env.DSH_PLUGIN_DSH_CLI, undefined)
  assert.equal(plan.env.DSH_SESSION_ID, undefined)
  assert.equal(plan.env.DSH_SHELL, undefined)
  assert.equal(plan.env.DSH_WEB_URL, undefined)
  assert.equal(plan.env.ELECTRON_RUN_AS_NODE, undefined, 'a plain Node child does not carry the Electron flag')

  const electron = mod.childSpawnPlan({
    cliPath: 'C:/runtime/loader.js',
    childHome: 'C:/children/two/home',
    target: { targetDeviceId: 'device-2', workspacePath: '/src/app' },
    electron: true,
    execPath: 'C:/app/DeepSeek Harness.exe',
    env: {},
  })
  assert.equal(electron.args[0], '--expose-internals', 'the Electron spawn exposes internals first')
  assert.equal(electron.env.ELECTRON_RUN_AS_NODE, '1', 'the Electron spawn runs the executable in Node mode')
  assert.equal(electron.args[3], 'remote-tab', 'the profile name follows --profile under Electron too')

  assert.ok(mod.isBootReadyLine('[remote-tab-boot] ready dev /src/app'), 'the sentinel line is recognized')
  assert.ok(!mod.isBootReadyLine('other output'), 'ordinary output is not a ready sentinel')
  assert.equal(mod.parseChildLaunchLine(`dsh web: ${CHILD_URL}`), CHILD_URL, 'the launch line yields the tokenized URL')
  assert.equal(mod.parseChildLaunchLine('dsh web: http://127.0.0.1:1/'), undefined, 'a tokenless launch line is not accepted as ready')
  assert.equal(mod.redactLogLine(`failed at ${CHILD_URL}`), 'failed at http://127.0.0.1:34567/?token=***', 'log lines mask the token')
}

// ---------------------------------------------------------------- ready / down
{
  const harness = makeHarness('ready')
  const request = requestFor('remote-ready')
  const { url } = await harness.supervisor.up(request)
  assert.equal(url, CHILD_URL, 'up answers the child URL')
  assert.equal(harness.plans.length, 1, 'one child is spawned')
  assert.deepEqual(harness.plans[0].args.slice(1, 3), ['--profile', 'remote-tab'], 'the child boots the remote-tab profile')
  assert.equal(harness.plans[0].cwd, mod.remoteTabHome(join(root, 'parent-home'), request.id), 'the child home is derived from the connection id')

  const status = harness.supervisor.status()
  assert.equal(status.length, 1)
  assert.equal(status[0].state, 'up')
  assert.equal(status[0].url, CHILD_URL)
  assert.ok(status[0].log.includes('子后端已就绪'), 'the status log reports readiness')

  // A second up reuses the running child.
  const second = await harness.supervisor.up(request)
  assert.equal(second.url, CHILD_URL, 'a second open returns the established URL')
  assert.equal(harness.plans.length, 1, 'a second open does not spawn another child')

  await harness.supervisor.down(request.id)
  assert.deepEqual(harness.supervisor.status(), [], 'down clears the tab status')
  assert.ok(existsSync(join(root, 'parent-home', 'gui', 'remote-tabs')), 'down keeps the child home directory')
  await until(() => harness.children[0].exitCode !== null, 'the child exits after down')
  assert.equal(harness.children[0].signalCode, null)
}

// ---------------------------------------------------------------- unexpected exit after up
{
  const harness = makeHarness('ready')
  const request = requestFor('remote-crash')
  await harness.supervisor.up(request)
  harness.children[0].exit(1)
  await tick()
  const status = harness.supervisor.status()
  assert.equal(status[0].state, 'error', 'a child that dies after readiness is reported as an error')
  assert.match(status[0].error ?? '', /子后端已退出/u)
  assert.equal(status[0].url, undefined, 'a dead child no longer advertises a URL')
}

// ---------------------------------------------------------------- timeout
{
  const harness = makeHarness('no-boot', { readyTimeoutMs: 150 })
  const request = requestFor('remote-timeout')
  await assert.rejects(() => harness.supervisor.up(request), /等待子后端就绪超时/u, 'a child without the ready sentinel times out')
  const status = harness.supervisor.status()
  assert.equal(status[0].state, 'error', 'a timed-out tab is in error')
  assert.match(status[0].error ?? '', /超时/u)
  assert.ok(status[0].log.some((line) => line.includes('dsh web:')), 'the status log keeps the child output')
  await harness.supervisor.down(request.id)
  await until(() => harness.children[0].exitCode !== null, 'the timed-out child is stopped')
}

// ---------------------------------------------------------------- early exit
{
  const harness = makeHarness('exit1')
  await assert.rejects(() => harness.supervisor.up(requestFor('remote-exit')), /子后端在就绪前退出/u, 'an early exit is reported')
  const status = harness.supervisor.status()
  assert.equal(status[0].state, 'error')
  assert.ok((status[0].log ?? []).some((line) => line.includes('boom')), 'the failure keeps the child error output')
}

// ---------------------------------------------------------------- token redaction
{
  const harness = makeHarness('token-error')
  await assert.rejects(() => harness.supervisor.up(requestFor('remote-token-error')), (error: Error) => {
    assert.ok(!error.message.includes('SecretChildToken123'), 'a failure message never carries the launch token')
    assert.ok(error.message.includes('token=***'), 'a failure message masks the token')
    return true
  })
  const status = harness.supervisor.status()
  assert.ok(!JSON.stringify(status[0].log).includes('SecretChildToken123'), 'the status log never carries the launch token')
}

// ---------------------------------------------------------------- forget
{
  const revoked: string[] = []
  const request = requestFor('remote-forget')
  const forgetHarness = makeHarness('ready', {
    revokeIdentity: async ({ childHome }: { childHome: string }) => { revoked.push(childHome) },
  })
  await forgetHarness.supervisor.up(request)
  const childHome = mod.remoteTabHome(join(root, 'parent-home'), request.id)
  assert.ok(existsSync(childHome), 'the child home exists before forget')
  await forgetHarness.supervisor.forget(request.id)
  assert.deepEqual(revoked, [childHome], 'forget revokes the child device')
  assert.ok(!existsSync(childHome), 'forget removes the child home')
  assert.deepEqual(forgetHarness.supervisor.status(), [], 'forget clears the tab status')
  await until(() => forgetHarness.children[0].exitCode !== null, 'forget stops the child')
}

// ---------------------------------------------------------------- dispose
{
  const harness = makeHarness('ready')
  await harness.supervisor.up(requestFor('remote-dispose-1'))
  await harness.supervisor.up(requestFor('remote-dispose-2'))
  assert.equal(harness.children.length, 2, 'two children are running')
  await harness.supervisor.dispose()
  assert.deepEqual(harness.supervisor.status(), [], 'dispose clears every record')
  assert.ok(harness.children.every((child) => child.exitCode !== null), 'dispose stops every child')
}

// ---------------------------------------------------------------- missing boot bundle
{
  const harness = makeHarness('ready', {
    prepareProfile: async ({ childHome }: { childHome: string }) => {
      mkdirSync(childHome, { recursive: true })
      return { cliPath: '/fake/bin.js', bundles: ['@deepseek-ai/dsh-base', 'ds-harness-remote'] }
    },
  })
  await assert.rejects(
    () => harness.supervisor.up(requestFor('remote-no-boot')),
    /dsh-remote-tab-boot/u,
    'a profile without the bootstrap bundle fails fast instead of waiting out the budget',
  )
  assert.equal(harness.plans.length, 0, 'no child is spawned without the bootstrap plugin')
}

// ---------------------------------------------------------------- desktop context
{
  const noProfile = mod.createRemoteTabSupervisor({
    dshHome: join(root, 'parent-home'),
    spawn: () => { throw new Error('must not spawn') },
    resolveIdentity: async () => ({ serverUrl: 'https://dsh.example.test', deviceId: 'device-1' }),
    revokeIdentity: async () => {},
  })
  await assert.rejects(() => noProfile.up(requestFor('remote-nodesktop')), /仅在桌面应用中可用/u, 'outside the desktop the launch explains what is missing')
}

rmSync(root, { recursive: true, force: true })
console.log('remote-tab supervisor tests passed')
