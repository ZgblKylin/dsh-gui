/**
 * Regression test for the remote-tab child bootstrap (`src/index.ts`).
 *
 * Runs under plain Node (type stripping) as one in-process script. The plugin
 * is driven through a recording fake Cordis context and a fake
 * `dshRemoteClient` service, so no harness profile, no remote Host and no child
 * process is involved.
 *
 * Run: `node tests/boot.spec.ts`
 */

import { apply, openWorkspace, TARGET_ENV } from '../src/index.ts'
import type { RemoteTabClient, RemoteTabTarget } from '../src/index.ts'
import type { Context } from '@deepseek-ai/cordis'

let failures = 0

/** Count a failed assertion; writes through `process.stderr` so console capture cannot hide it. */
function check(condition: unknown, label: string): void {
  if (condition) return
  failures += 1
  process.stderr.write(`FAIL: ${label}\n`)
}

/** The rejection reason of a promise, or `undefined` when it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return undefined
  } catch (error) {
    return error
  }
}

/** Capture `console.log` / `console.error` lines for the duration of one step. */
function captureConsole(): { readonly logs: string[]; readonly errors: string[]; restore(): void } {
  const logs: string[] = []
  const errors: string[] = []
  const originalLog = console.log
  const originalError = console.error
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')) }
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')) }
  return {
    logs,
    errors,
    restore(): void {
      console.log = originalLog
      console.error = originalError
    },
  }
}

type InjectCallback = (ctx: Context, config?: void) => unknown

interface Injection {
  readonly deps: readonly string[]
  readonly callback: InjectCallback
}

/** Fake Cordis context: records `ctx.inject` calls instead of starting a fiber. */
class RecordingContext {
  readonly injections: Injection[] = []
  inject(deps: string[], callback: InjectCallback): void {
    this.injections.push({ deps, callback })
  }
}

/** Fake injected context: exposes only the service the callback asks for. */
class FakeClientContext {
  private readonly client: unknown
  constructor(client: unknown) {
    this.client = client
  }
  get(name: string): unknown {
    return name === 'dshRemoteClient' ? this.client : undefined
  }
}

const TARGET: RemoteTabTarget = {
  targetDeviceId: 'device-1',
  workspacePath: 'E:/work/project',
  backend: 'harness',
}

const SENTINEL = '[remote-tab-boot] ready device-1 E:/work/project'

delete process.env[TARGET_ENV]
try {
  // 1. No target: the plugin must stay inert (the parent-profile boot).
  {
    const ctx = new RecordingContext()
    const capture = captureConsole()
    try {
      apply(ctx as unknown as Context)
    } finally {
      capture.restore()
    }
    check(ctx.injections.length === 0, 'absent target: no dshRemoteClient injection')
    check(capture.logs.length === 0 && capture.errors.length === 0, 'absent target: no console noise')
  }

  // 2. Blank target: same no-op.
  {
    process.env[TARGET_ENV] = '   '
    const ctx = new RecordingContext()
    apply(ctx as unknown as Context)
    check(ctx.injections.length === 0, 'blank target: no dshRemoteClient injection')
  }

  // 3. Target present: wait for the service, open the workspace, print the sentinel.
  {
    process.env[TARGET_ENV] = JSON.stringify({ ...TARGET, title: 'host · workspace' })
    const calls: { targetDeviceId: string; path: string; signal?: AbortSignal }[] = []
    const client: RemoteTabClient = {
      openRemoteWorkspace: (targetDeviceId, path, signal) => {
        calls.push({ targetDeviceId, path, signal })
        return Promise.resolve({})
      },
    }
    const ctx = new RecordingContext()
    apply(ctx as unknown as Context)
    check(ctx.injections.length === 1, 'target: injects exactly one dependency')
    const injection = ctx.injections[0]
    check(JSON.stringify(injection.deps) === JSON.stringify(['dshRemoteClient']), 'target: injects dshRemoteClient')
    const capture = captureConsole()
    try {
      await injection.callback(new FakeClientContext(client) as unknown as Context)
    } finally {
      capture.restore()
    }
    check(calls.length === 1, 'target: calls openRemoteWorkspace once')
    check(calls[0].targetDeviceId === 'device-1', 'target: passes the Host device id')
    check(calls[0].path === 'E:/work/project', 'target: passes the workspace path')
    check(calls[0].signal instanceof AbortSignal, 'target: passes a timeout signal')
    check(calls[0].signal.aborted === false, 'target: the timeout signal is not aborted yet')
    check(capture.logs.includes(SENTINEL), `target: prints the sentinel line (${SENTINEL})`)
    check(capture.errors.length === 0, 'target: no console errors')
  }

  // 4. Unsupported backend: console.error + synchronous throw, before any injection.
  {
    process.env[TARGET_ENV] = JSON.stringify({ ...TARGET, backend: 'codex' })
    const ctx = new RecordingContext()
    let thrown: unknown
    const capture = captureConsole()
    try {
      apply(ctx as unknown as Context)
    } catch (error) {
      thrown = error
    } finally {
      capture.restore()
    }
    check(thrown instanceof Error && thrown.message.includes("backend 'codex' is not supported"), 'backend: throws for unsupported backends')
    check(capture.errors.some((line) => line.includes("backend 'codex' is not supported")), 'backend: logs the unsupported backend')
    check(ctx.injections.length === 0, 'backend: does not inject')
  }

  // 5. Malformed payload: console.error + throw.
  {
    process.env[TARGET_ENV] = '{not json'
    const ctx = new RecordingContext()
    let thrown: unknown
    const capture = captureConsole()
    try {
      apply(ctx as unknown as Context)
    } catch (error) {
      thrown = error
    } finally {
      capture.restore()
    }
    check(thrown instanceof Error && thrown.message.includes('is not valid JSON'), 'malformed: throws for invalid JSON')
    check(capture.errors.some((line) => line.includes('is not valid JSON')), 'malformed: logs the parse failure')
    check(ctx.injections.length === 0, 'malformed: does not inject')
  }

  // 6. Missing required field: console.error + throw.
  {
    process.env[TARGET_ENV] = JSON.stringify({ targetDeviceId: 'device-1' })
    const ctx = new RecordingContext()
    let thrown: unknown
    const capture = captureConsole()
    try {
      apply(ctx as unknown as Context)
    } catch (error) {
      thrown = error
    } finally {
      capture.restore()
    }
    check(thrown instanceof Error && thrown.message.includes('workspacePath must be a non-empty string'), 'missing field: throws for a missing workspace path')
    check(capture.errors.length === 1, 'missing field: logs exactly one error')
    check(ctx.injections.length === 0, 'missing field: does not inject')
  }

  // 7. Client method absent: a clear error instead of a TypeError.
  {
    process.env[TARGET_ENV] = JSON.stringify(TARGET)
    const ctx = new RecordingContext()
    apply(ctx as unknown as Context)
    const capture = captureConsole()
    let thrown: unknown
    try {
      thrown = await rejectionOf(ctx.injections[0].callback(new FakeClientContext({}) as unknown as Context))
    } finally {
      capture.restore()
    }
    check(thrown instanceof Error && thrown.message.includes('does not provide dshRemoteClient.openRemoteWorkspace'), 'service: reports the missing method')
    check(capture.errors.some((line) => line.includes('does not provide dshRemoteClient.openRemoteWorkspace')), 'service: logs the missing method')
  }

  // 8. openRemoteWorkspace rejects: console.error + rethrow, no sentinel.
  {
    process.env[TARGET_ENV] = JSON.stringify(TARGET)
    let attempts = 0
    const client: RemoteTabClient = {
      openRemoteWorkspace: () => {
        attempts += 1
        return Promise.reject(new Error('connect failed'))
      },
    }
    const ctx = new RecordingContext()
    apply(ctx as unknown as Context)
    const capture = captureConsole()
    let thrown: unknown
    try {
      thrown = await rejectionOf(ctx.injections[0].callback(new FakeClientContext(client) as unknown as Context))
    } finally {
      capture.restore()
    }
    check(attempts === 1, 'failure: calls openRemoteWorkspace once')
    check(thrown instanceof Error && thrown.message.includes('openRemoteWorkspace failed'), 'failure: rethrows with context')
    check(thrown instanceof Error && thrown.message.includes('connect failed'), 'failure: keeps the original reason')
    check(capture.errors.some((line) => line.includes('openRemoteWorkspace failed')), 'failure: logs the open failure')
    check(!capture.logs.some((line) => line.includes('ready')), 'failure: never prints the sentinel')
  }

  // 9. Deadline: a call that does not settle is reported as a timeout.
  {
    const timeoutClient: RemoteTabClient = {
      openRemoteWorkspace: (_targetDeviceId, _path, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
      }),
    }
    const capture = captureConsole()
    // `AbortSignal.timeout` does not keep the event loop alive; hold it open
    // until the deadline fires so the awaited call settles in this test.
    const keepAlive = setInterval(() => {}, 25)
    let thrown: unknown
    try {
      thrown = await rejectionOf(openWorkspace(timeoutClient, TARGET, 25))
    } finally {
      clearInterval(keepAlive)
      capture.restore()
    }
    check(thrown instanceof Error && thrown.message.includes('timed out after 25ms'), 'timeout: reports the deadline')
    check(capture.errors.some((line) => line.includes('timed out after 25ms')), 'timeout: logs the deadline')
    check(!capture.logs.some((line) => line.includes('ready')), 'timeout: never prints the sentinel')
  }
} finally {
  delete process.env[TARGET_ENV]
}

if (failures > 0) {
  process.stderr.write(`${failures} check(s) failed\n`)
  process.exitCode = 1
} else {
  process.stdout.write('boot.spec: all checks passed\n')
}
