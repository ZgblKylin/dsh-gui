/**
 * Tests of the generic remote-tab child supervisor, run against the built
 * package (`../lib/index.js`).
 *
 * The child processes are emulated by an in-process fake: the injected spawner
 * records the spawn plan the production code would run and returns a
 * `FakeChild` whose stdout/stderr are real streams and whose exit and SIGTERM
 * behaviour are driven by timers. That keeps the readiness handshake, timeout,
 * early exit, redaction, down, forget, and dispose paths real without starting a
 * second `dsh` — the test sandbox refuses a nested child with piped stdio, and a
 * real child is not needed to exercise the supervisor's own logic. The plan of a
 * real child (Node choice, loader flag, scrubbed environment) is asserted
 * directly as a pure function, and one default-path case drives the real
 * runtime/Node selection and profile generation inside a fixture.
 *
 * Usage (from the package directory): node tests/remote-tab-supervisor.spec.ts
 */

import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

import { cleanup, fakeProvider, makeFixture } from './remote-tab-fixtures.ts'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)

const root = mkdtempSync(join(tmpdir(), 'dsh-remote-tab-supervisor-'))
const CHILD_URL = 'http://127.0.0.1:34567/?token=SecretChildToken123'
const loaderPath = join(root, 'generated-loader.mjs')
writeFileSync(loaderPath, '// generated loader\n')

/** One spawn plan as captured by the injected spawner. */
interface CapturedPlan {
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv
  readonly cwd: string
  readonly command: string
  readonly electron: boolean
}

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
  readonly plans: CapturedPlan[]
  readonly children: FakeChild[]
  readonly providerCalls: ReturnType<typeof fakeProvider>['calls']
}

/** The fake Node used by the seam-based tests. */
const FAKE_NODE = { command: '/fake/node', electron: false, kind: 'host-node' } as const

/** Build a supervisor whose "children" are `FakeChild` instances in `mode`. */
function makeHarness(mode: FakeMode, overrides: Record<string, unknown> = {}): Harness {
  const plans: CapturedPlan[] = []
  const children: FakeChild[] = []
  const { provider, calls } = fakeProvider()
  const spawn = (plan: CapturedPlan) => {
    plans.push(plan)
    const child = new FakeChild(mode)
    children.push(child)
    return child
  }
  const supervisor = mod.createRemoteTabSupervisor({
    dshHome: join(root, 'parent-home'),
    provider,
    parentProfileDir: join(root, 'parent-profile'),
    parentRuntimeDir: join(root, 'runtime'),
    hostExecPath: '/fake/node',
    hostElectron: false,
    childNode: FAKE_NODE,
    spawn,
    readyTimeoutMs: 2_000,
    terminateTimeoutMs: 500,
    prepareProfile: async ({ childHome }: { childHome: string }) => {
      mkdirSync(childHome, { recursive: true })
      writeFileSync(join(childHome, 'marker.txt'), 'child home\n')
      return { cliPath: '/fake/bin.js', loaderPath, bundles: [provider.readyBundle] }
    },
    ...overrides,
  })
  return { supervisor, plans, children, providerCalls: calls }
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
    node: { command: 'C:/node/node.exe', electron: false, kind: 'path-node' },
    loaderPath: 'C:/children/one/home/remote-tab-loader.mjs',
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
  assert.equal(plan.command, 'C:/node/node.exe', 'the selected real Node runs the child')
  assert.equal(plan.electron, false, 'the plan records that no Electron Node mode is needed')
  assert.equal(plan.args[0], '--experimental-loader', 'the loader flag comes first')
  assert.equal(plan.args[1], pathToFileURL('C:/children/one/home/remote-tab-loader.mjs').href, 'the loader is passed as a file URL')
  assert.deepEqual(plan.args.slice(2), [
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
  assert.equal(plan.env.ELECTRON_RUN_AS_NODE, undefined, 'a real Node child does not carry the Electron flag')

  const electron = mod.childSpawnPlan({
    cliPath: 'C:/runtime/loader.js',
    childHome: 'C:/children/two/home',
    target: { targetDeviceId: 'device-2', workspacePath: '/src/app' },
    node: { command: 'C:/app/DeepSeek Harness.exe', electron: true, kind: 'electron-fallback' },
    loaderPath: 'C:/children/two/home/loader.mjs',
    env: {},
  })
  assert.equal(electron.args[0], '--expose-internals', 'the Electron spawn exposes internals first')
  assert.equal(electron.args[1], '--experimental-loader', 'the Electron spawn still loads the child loader')
  assert.equal(electron.env.ELECTRON_RUN_AS_NODE, '1', 'the Electron spawn runs the executable in Node mode')
  assert.equal(electron.args[4], '--profile', 'the profile flag follows the CLI entry')
  assert.equal(electron.electron, true)

  const withoutLoader = mod.childSpawnPlan({
    cliPath: 'C:/runtime/loader.js',
    childHome: 'C:/children/three/home',
    target: { targetDeviceId: 'device-3', workspacePath: '/w' },
    node: { command: 'C:/node/node.exe', electron: false, kind: 'path-node' },
    env: {},
  })
  assert.ok(!withoutLoader.args.includes('--experimental-loader'), 'a plan without a loader omits the flag')

  const oldNode = mod.childSpawnPlan({
    cliPath: 'C:/runtime/loader.js',
    childHome: 'C:/children/four/home',
    target: { targetDeviceId: 'device-4', workspacePath: '/w' },
    node: { command: 'C:/node/node.exe', electron: false, kind: 'path-node' },
    loaderPath: 'C:/children/four/home/loader.mjs',
    supportsLoader: false,
    env: {},
  })
  assert.ok(!oldNode.args.includes('--experimental-loader'), 'a Node without loader support omits the flag')

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
  assert.deepEqual(harness.plans[0].args.slice(3, 5), ['--profile', 'remote-tab'], 'the child boots the remote-tab profile')
  assert.equal(harness.plans[0].args[1], pathToFileURL(loaderPath).href, 'the child is spawned with the generated loader')
  assert.equal(harness.plans[0].command, FAKE_NODE.command, 'the spawner receives the selected Node')
  assert.equal(harness.plans[0].cwd, mod.remoteTabHome(join(root, 'parent-home'), request.id), 'the child home is derived from the connection id')
  assert.deepEqual(harness.providerCalls.identityArgs, [{
    childHome: mod.remoteTabHome(join(root, 'parent-home'), request.id),
    deviceName: 'Desktop-ZgblKylin · archlinux · 远程标签',
  }], 'the provider mints the child identity for this connection')

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

// ---------------------------------------------------------------- default selection path
{
  // No profile seam: the supervisor selects `<runtimeRoot>/.harness` and a real
  // Node, generates the child profile, and spawns with the generated loader.
  const fixture = makeFixture({ harnessRuntime: true })
  const { provider } = fakeProvider()
  const plans: CapturedPlan[] = []
  const children: FakeChild[] = []
  const supervisor = mod.createRemoteTabSupervisor({
    dshHome: fixture.parentHome,
    provider,
    parentProfileDir: fixture.parentProfile,
    hostExecPath: '/fake/node',
    hostElectron: false,
    env: {},
    spawn: (plan: CapturedPlan) => {
      plans.push(plan)
      const child = new FakeChild('ready')
      children.push(child)
      return child
    },
    readyTimeoutMs: 2_000,
    terminateTimeoutMs: 500,
  })
  const request = requestFor('remote-selected')
  const { url } = await supervisor.up(request)
  assert.equal(url, CHILD_URL, 'the default path reaches readiness')
  const plan = plans[0]
  const harnessCli = join(fixture.runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  assert.equal(plan.command, '/fake/node', 'a real (non-Electron) Node is selected')
  assert.equal(plan.electron, false)
  assert.ok(plan.args.includes('--experimental-loader'), 'the generated loader is passed')
  assert.ok(plan.args.includes(harnessCli), 'the child CLI comes from the selected .harness runtime')
  const childHome = mod.remoteTabHome(fixture.parentHome, request.id)
  const loaderFile = join(childHome, 'remote-tab-loader.mjs')
  assert.ok(existsSync(loaderFile), 'the loader is generated in the child home')
  assert.ok(readFileSync(loaderFile, 'utf8').includes(JSON.stringify(join(fixture.runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))), 'the loader anchors at the selected runtime')
  const profile = JSON.parse(readFileSync(join(childHome, 'profiles', 'remote-tab', 'package.json'), 'utf8'))
  assert.ok(profile.dsh.profile.bundles.includes('dsh-remote-tab-boot'), 'the provider bootstrap bundle is listed')
  await supervisor.dispose()
  await until(() => children[0].exitCode !== null, 'the selected child is stopped')
  cleanup(fixture)
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
  const request = requestFor('remote-forget')
  const forgetHarness = makeHarness('ready')
  await forgetHarness.supervisor.up(request)
  const childHome = mod.remoteTabHome(join(root, 'parent-home'), request.id)
  assert.ok(existsSync(childHome), 'the child home exists before forget')
  await forgetHarness.supervisor.forget(request.id)
  assert.deepEqual(forgetHarness.providerCalls.revoked, [childHome], 'forget revokes the child device through the provider')
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

// ---------------------------------------------------------------- selection failures
{
  const harness = makeHarness('ready', { prepareProfile: undefined, provider: undefined })
  await assert.rejects(() => harness.supervisor.up(requestFor('remote-no-provider')), /未配置远程后端 provider/u, 'a supervisor without a provider reports the feature unavailable')
}
{
  const harness = makeHarness('ready', { prepareProfile: undefined, parentProfileDir: undefined })
  await assert.rejects(() => harness.supervisor.up(requestFor('remote-no-profile')), /父 profile/u, 'a missing parent profile is reported')
}
{
  // No real runtime anywhere and no hosting runtime: actionable error.
  const harness = makeHarness('ready', {
    prepareProfile: undefined,
    parentRuntimeDir: undefined,
    env: {},
    childNode: undefined,
  })
  await assert.rejects(
    () => harness.supervisor.up(requestFor('remote-no-runtime')),
    /未找到可用于子后端的真实 dsh 运行时/u,
    'a missing runtime is reported before any network work',
  )
}
{
  // Electron-only fallback with an asar runtime cannot work: fail with the
  // actionable Node error instead of hanging in the loader.
  const harness = makeHarness('ready', {
    prepareProfile: undefined,
    childRuntime: {
      runtimeDir: 'C:/app/resources/app.asar/dsh',
      cliPath: 'C:/app/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
      anchor: 'C:/app/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/package.json',
      kind: 'parent-asar',
    },
    childNode: { command: 'C:/app/DeepSeek Harness.exe', electron: true, kind: 'electron-fallback' },
  })
  await assert.rejects(
    () => harness.supervisor.up(requestFor('remote-asar-electron')),
    /找不到真实 Node/u,
    'the Electron + asar combination is refused with the real cause',
  )
}
{
  // A ready bundle missing from the generated profile fails fast instead of
  // waiting out the readiness budget.
  const harness = makeHarness('ready', {
    prepareProfile: async ({ childHome }: { childHome: string }) => {
      mkdirSync(childHome, { recursive: true })
      return { cliPath: '/fake/bin.js', loaderPath, bundles: ['@deepseek-ai/dsh-base'] }
    },
  })
  await assert.rejects(
    () => harness.supervisor.up(requestFor('remote-no-boot')),
    /dsh-remote-tab-boot/u,
    'a profile without the provider bootstrap bundle fails fast',
  )
  assert.equal(harness.plans.length, 0, 'no child is spawned without the bootstrap plugin')
}

rmSync(root, { recursive: true, force: true })
console.log('remote-tab supervisor tests passed')
