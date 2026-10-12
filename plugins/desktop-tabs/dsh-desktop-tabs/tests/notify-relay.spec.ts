/**
 * Regression test for the remote-notification relay (`src/client/notify-relay.ts`).
 *
 * Runs under plain Node (v24 type stripping) as one in-process script — no test
 * runner and no child processes, so it stays inside sandboxed environments. The
 * guest shim (`NOTIFY_SHIM_SOURCE`) is evaluated against a fake `window`, and the
 * app-document playback (`playRemoteNotification`) is exercised against a fake
 * global `Notification`. Any failed assertion is counted and the process exits
 * non-zero.
 *
 * Run: `node tests/notify-relay.spec.ts`
 */
import {
  NOTIFY_SHIM_SOURCE,
  playRemoteNotification,
  type RemoteNotifyPayload,
} from '../src/client/notify-relay.ts'

/** Remote page coordinates the shim reloads icon URLs against. */
const REMOTE_HREF = 'http://remote.test:1999/?token=secret'

// The shim reads `location` lazily (when a page constructs a notification), so
// this global must stay installed for the whole run, not just during evaluation.
globalThis.location = { href: REMOTE_HREF } as unknown as Location

let failures = 0
/** @returns whether the assertion held; counts a mismatch as a failure. */
function check(condition: unknown, label: string): void {
  if (condition) return
  failures += 1
  console.error(`FAIL: ${label}`)
}

/**
 * @returns a fake guest window with a native-like Notification before the shim runs.
 */
function fakeGuestWindow(): Record<string, unknown> {
  return {
    navigator: {
      permissions: {
        query: (desc: { name?: string }) =>
          Promise.resolve({ state: desc?.name === 'camera' ? 'denied' : 'default' }),
      },
    },
    Notification: {
      permission: 'denied',
      maxActions: 2,
      requestPermission: (): Promise<string> => Promise.resolve('denied'),
    },
  }
}

/** Evaluate the shim against one fake guest window (idempotent by design). */
function evaluateShim(win: Record<string, unknown>): void {
  const priorWindow = globalThis.window
  globalThis.window = win
  try {
    // Indirect eval: the shim's free `window`/`location` resolve to the globals above.
    ;(0, eval)(NOTIFY_SHIM_SOURCE)
  } finally {
    if (priorWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
    else globalThis.window = priorWindow
  }
}

/** @returns a fresh guest window with the shim installed. */
function runShim(): {
  win: Record<string, unknown>
  relay: { drain(): RemoteNotifyPayload[]; enqueue(item: RemoteNotifyPayload): void }
} {
  const win = fakeGuestWindow()
  evaluateShim(win)
  const relay = win.__dshNotifyRelay as {
    drain(): RemoteNotifyPayload[]
    enqueue(item: RemoteNotifyPayload): void
  }
  return { win, relay }
}

/* ── shim: permission surface ───────────────────────────────── */

;(async () => {
  const { win } = runShim()
  const NotificationCtor = win.Notification as unknown as {
    permission: string
    requestPermission(cb?: (v: string) => void): Promise<string>
  }
  check(NotificationCtor.permission === 'granted', 'permission reports granted')
  const granted = await NotificationCtor.requestPermission()
  check(granted === 'granted', 'requestPermission resolves granted')
  const viaCallback = await new Promise<string>((resolve) => {
    void NotificationCtor.requestPermission((value: string) => resolve(value))
  })
  check(viaCallback === 'granted', 'requestPermission honors the callback form')
})()

/* ── shim: queued notification + icon absolutization ────────── */

;(async () => {
  const { win, relay } = runShim()
  const NotificationCtor = win.Notification as unknown as new (
    title: string,
    options: Record<string, unknown>,
  ) => { onclick: (() => void) | null; close(): void }
  const stub = new NotificationCtor('任务完成', {
    body: '远程输出',
    icon: '/dsh-pet-7340/pic/done.png',
    tag: 'conv-1',
    requireInteraction: true,
  })
  stub.onclick = () => {}
  stub.close()
  const items = relay.drain()
  check(items.length === 1, 'construction enqueues exactly one notification')
  const item = items[0]
  check(item.kind === 'notify', 'payload kind is notify')
  check(item.title === '任务完成', 'title forwarded')
  check(item.body === '远程输出', 'body forwarded')
  check(item.icon === 'http://remote.test:1999/dsh-pet-7340/pic/done.png', 'icon absolutized against the guest origin')
  check(item.tag === 'conv-1', 'tag forwarded')
  check(item.requireInteraction === true, 'requireInteraction forwarded')
  check(relay.drain().length === 0, 'drain clears the queue')
})()

/* ── shim: absent fields + passthrough of other permissions ─── */

;(async () => {
  const { win, relay } = runShim()
  const NotificationCtor = win.Notification as unknown as new (title: string) => unknown
  void new NotificationCtor('仅标题')
  const item = relay.drain()[0]
  check(item.body === undefined, 'absent body stays absent')
  check(item.icon === undefined, 'absent icon stays absent')
  const notifyState = await (
    win.navigator as { permissions: { query(d: { name: string }): Promise<{ state: string }> } }
  ).permissions.query({ name: 'notifications' })
  check(notifyState.state === 'granted', 'notifications permission query resolves granted')
  const cameraState = await (
    win.navigator as { permissions: { query(d: { name: string }): Promise<{ state: string }> } }
  ).permissions.query({ name: 'camera' })
  check(cameraState.state === 'denied', 'other permission queries pass through untouched')
})()

/* ── shim: idempotent re-injection on the same window ───────── */

;(async () => {
  const win = fakeGuestWindow()
  evaluateShim(win)
  const firstRelay = win.__dshNotifyRelay
  ;(firstRelay as { enqueue(item: RemoteNotifyPayload): void }).enqueue({ kind: 'notify', title: 'held' })
  // A later dom-ready re-injects; the guard must keep the same handle and queue.
  evaluateShim(win)
  check(win.__dshNotifyRelay === firstRelay, 're-injection keeps the installed handle')
  const items = (win.__dshNotifyRelay as { drain(): RemoteNotifyPayload[] }).drain()
  check(items.length === 1 && items[0].title === 'held', 're-injection keeps the queued notification')
})()

/* ── app-side playback ──────────────────────────────────────── */

;(async () => {
  type FakeNote = { title: string; options: NotificationOptions }
  const shown: FakeNote[] = []
  const priorNotification = globalThis.Notification
  const priorWindowObject = globalThis.window
  let focused = false
  class FakeNotification {
    static permission = 'granted'
    onclick: (() => void) | null = null
    title: string
    options: NotificationOptions
    constructor(title: string, options: NotificationOptions) {
      this.title = title
      this.options = options
      shown.push({ title, options })
    }
    close(): void {}
  }
  globalThis.Notification = FakeNotification as unknown as typeof Notification
  globalThis.window = { focus: () => { focused = true } } as unknown as Window & typeof globalThis
  try {
    playRemoteNotification({
      kind: 'notify',
      title: '任务完成',
      body: 'B',
      icon: 'http://remote.test:1999/i.png',
      tag: 'g',
      silent: true,
    })
    check(shown.length === 1, 'one app-document notification is created')
    const note = shown[0]
    check(note.title === '任务完成', 'played title matches')
    check(note.options.body === 'B', 'played body matches')
    check(note.options.icon === 'http://remote.test:1999/i.png', 'played icon matches')
    check(note.options.tag === 'g', 'played tag matches')
    const before = shown.length
    const FakeDenied = class extends FakeNotification {
      static permission = 'denied'
    } as unknown as typeof Notification
    globalThis.Notification = FakeDenied
    playRemoteNotification({ kind: 'notify', title: 'x' })
    check(shown.length === before, 'denied app permission skips playback')
    check(focused === false, 'skipped playback does not focus')
  } finally {
    if (priorNotification === undefined) Reflect.deleteProperty(globalThis, 'Notification')
    else globalThis.Notification = priorNotification
    if (priorWindowObject === undefined) Reflect.deleteProperty(globalThis, 'window')
    else globalThis.window = priorWindowObject
  }
})()

/* flush the async blocks, then report */
setTimeout(() => {
  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`)
    process.exit(1)
  }
  console.log('\nnotify-relay: all assertions passed')
}, 0)