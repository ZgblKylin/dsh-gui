/**
 * Regression test for the window-title layer (`src/client/window-title.ts`).
 *
 * The desktop window title follows the main document's title, and the harness
 * keeps owning that document value for its own UI. This layer takes the title
 * over while a remote page is shown: it samples the native title once, writes
 * the remote title, records (and immediately rewrites) any native title the
 * harness sets during the takeover, and restores the newest native title when
 * the native UI is shown again.
 *
 * Runs under plain Node (type stripping) as one in-process script — no test
 * runner and no child processes. The surface is an injected fake, so the test
 * plays the document and the harness's title writes directly.
 *
 * Run: `node tests/window-title.spec.ts`
 */

import { createWindowTitle, type TitleSurface } from '../src/client/window-title.ts'

let failures = 0
/** @returns whether the assertion held; counts a mismatch as a failure. */
function check(condition: unknown, label: string): void {
  if (condition) return
  failures += 1
  console.error(`FAIL: ${label}`)
}

/** A title surface backed by one string; the test plays the document. */
class FakeSurface implements TitleSurface {
  title: string
  /** Reads through {@link read}, counting native-title samples. */
  reads = 0
  /** Every value written through the layer, in order. */
  readonly writes: string[] = []
  /** Observers currently installed; a takeover installs exactly one. */
  activeObservers = 0
  private readonly listeners = new Set<() => void>()

  constructor(initial: string) {
    this.title = initial
  }

  read(): string {
    this.reads += 1
    return this.title
  }

  write(title: string): void {
    this.writes.push(title)
    this.title = title
  }

  observe(listener: () => void): () => void {
    this.activeObservers += 1
    this.listeners.add(listener)
    let stopped = false
    return (): void => {
      if (stopped) return
      stopped = true
      this.activeObservers -= 1
      this.listeners.delete(listener)
    }
  }

  /** Mimic the harness rewriting `document.title` while the layer observes it. */
  externalWrite(title: string): void {
    this.title = title
    for (const listener of [...this.listeners]) listener()
  }
}

/** The first takeover samples the native title, observes once, and writes the remote title. */
function firstTakeover(): void {
  const surface = new FakeSurface('本机标题')
  const windowTitle = createWindowTitle(surface)
  windowTitle.showRemote('会话 A — DeepSeek Harness')
  check(surface.title === '会话 A — DeepSeek Harness', 'first takeover: remote title written')
  check(surface.activeObservers === 1, 'first takeover: document observed once')
  check(surface.reads === 1, 'first takeover: native title sampled once')
  check(surface.writes.length === 1, 'first takeover: exactly one write')
}

/** A harness write during the takeover becomes the newest native title and is rewritten. */
function externalRewrite(): void {
  const surface = new FakeSurface('本机标题')
  const windowTitle = createWindowTitle(surface)
  windowTitle.showRemote('远程标题')
  surface.externalWrite('会话 B — DeepSeek Harness')
  check(surface.title === '远程标题', 'external write: remote title put back')
  check(surface.writes.length === 2, 'external write: the rewrite is the second write')
  windowTitle.showNative()
  check(surface.title === '会话 B — DeepSeek Harness', 'external write: recorded as the newest native title')
  check(surface.activeObservers === 0, 'external write: showNative stops observing')
}

/** A remote-to-remote switch keeps the native title sampled by the first takeover. */
function remoteSwitch(): void {
  const surface = new FakeSurface('本机标题')
  const windowTitle = createWindowTitle(surface)
  windowTitle.showRemote('远程 A')
  windowTitle.showRemote('远程 B')
  check(surface.title === '远程 B', 'remote switch: the new remote title is shown')
  check(surface.activeObservers === 1, 'remote switch: the single observation is kept')
  check(surface.reads === 1, 'remote switch: native title is not sampled again')
  windowTitle.showNative()
  check(surface.title === '本机标题', 'remote switch: restores the pre-takeover native title')
}

/** showNative restores the newest native title, stops observing, and is idle afterwards. */
function nativeRestore(): void {
  const surface = new FakeSurface('本机标题')
  const windowTitle = createWindowTitle(surface)
  windowTitle.showRemote('远程标题')
  surface.externalWrite('最新本机标题')
  windowTitle.showNative()
  check(surface.title === '最新本机标题', 'showNative: the newest native title is restored')
  check(surface.activeObservers === 0, 'showNative: observation stopped')
  const writes = surface.writes.length
  windowTitle.showNative()
  check(surface.writes.length === writes, 'showNative: an idle call writes nothing')
}

/** An empty title means the native UI, both before and during a takeover. */
function emptyTitle(): void {
  const idle = new FakeSurface('本机标题')
  const idleTitle = createWindowTitle(idle)
  idleTitle.showRemote('   ')
  check(idle.title === '本机标题', 'empty title: idle call leaves the native title untouched')
  check(idle.writes.length === 0, 'empty title: idle call writes nothing')
  check(idle.activeObservers === 0, 'empty title: idle call installs no observation')

  const surface = new FakeSurface('本机标题')
  const windowTitle = createWindowTitle(surface)
  windowTitle.showRemote('远程标题')
  windowTitle.showRemote('')
  check(surface.title === '本机标题', 'empty title: takeover returns the native title')
  check(surface.activeObservers === 0, 'empty title: takeover observation stopped')
}

/** dispose behaves like showNative and leaves nothing watching the document. */
function disposeRestores(): void {
  const surface = new FakeSurface('本机标题')
  const windowTitle = createWindowTitle(surface)
  windowTitle.showRemote('远程标题')
  windowTitle.dispose()
  check(surface.title === '本机标题', 'dispose: native title restored')
  check(surface.activeObservers === 0, 'dispose: observation stopped')
  surface.externalWrite('dispose 之后的改写')
  check(surface.title === 'dispose 之后的改写', 'dispose: external writes are no longer rewritten')

  const idle = new FakeSurface('本机标题')
  createWindowTitle(idle).dispose()
  check(idle.writes.length === 0, 'dispose: idle dispose writes nothing')
}

/** The mutation options `domTitleSurface` is expected to observe with. */
interface ObserveOptions {
  childList?: boolean
  subtree?: boolean
  characterData?: boolean
}

/** The default surface drives `document.title` and watches the document element. */
function documentSurface(): void {
  const documentElement = { tag: 'html' }
  const document = { title: '本机标题', documentElement }
  let observer: RecordingObserver | undefined
  let options: ObserveOptions | undefined

  class RecordingObserver {
    readonly listener: () => void
    constructor(listener: () => void) {
      this.listener = listener
      observer = this
    }
    observe(target: unknown, init: unknown): void {
      check(target === documentElement, 'document surface: watches the document element')
      options = init as ObserveOptions
    }
    disconnect(): void {
      observer = undefined
    }
  }

  const globals = globalThis as unknown as { document?: unknown; MutationObserver?: unknown }
  const previousDocument = globals.document
  const previousObserver = globals.MutationObserver
  globals.document = document
  globals.MutationObserver = RecordingObserver
  try {
    const windowTitle = createWindowTitle()
    windowTitle.showRemote('远程标题')
    check(document.title === '远程标题', 'document surface: remote title written to document.title')
    check(options?.childList === true && options.subtree === true && options.characterData === true,
      'document surface: watches childList/subtree/characterData')
    // The harness rewrites the title; the observer callback puts the remote one back.
    document.title = '会话 B — DeepSeek Harness'
    observer?.listener()
    check(document.title === '远程标题', 'document surface: external write rewritten')
    windowTitle.showNative()
    check(document.title === '会话 B — DeepSeek Harness', 'document surface: newest native title restored')
    check(observer === undefined, 'document surface: showNative disconnects the observer')
  } finally {
    globals.document = previousDocument
    globals.MutationObserver = previousObserver
  }
}

firstTakeover()
externalRewrite()
remoteSwitch()
nativeRestore()
emptyTitle()
disposeRestores()
documentSurface()

if (failures > 0) {
  console.error(`window-title: ${failures} assertion(s) failed`)
  process.exitCode = 1
} else {
  console.log('window-title: all assertions passed')
}
