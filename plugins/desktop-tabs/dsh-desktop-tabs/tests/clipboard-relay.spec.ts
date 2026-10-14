/**
 * Regression test for the remote-clipboard write fallback
 * (`src/client/clipboard-relay.ts`).
 *
 * Runs under plain Node (v24 type stripping) as one in-process script — no test
 * runner and no child processes, so it stays inside sandboxed environments. The
 * shim (`CLIPBOARD_SHIM_SOURCE`) is evaluated against a fake guest `window` whose
 * async Clipboard API rejects (the deny-all guest session), and its execCommand
 * fallback path is exercised against a fake `document`. Any failed assertion is
 * counted and the process exits non-zero.
 *
 * Run: `node tests/clipboard-relay.spec.ts`
 */
import { CLIPBOARD_SHIM_SOURCE } from '../src/client/clipboard-relay.ts'

let failures = 0
/** @returns whether the assertion held; counts a mismatch as a failure. */
function check(condition: unknown, label: string): void {
  if (condition) return
  failures += 1
  console.error(`FAIL: ${label}`)
}

/**
 * @param nativeRejects - whether the guest's async write rejects (denied session).
 * @returns a fake `window`/`document` pair plus the execCommand spy record.
 */
function fakeGuest(nativeRejects: boolean): {
  win: Record<string, unknown>
  doc: Record<string, unknown>
  execCalls: string[]
} {
  const execCalls: string[] = []
  const ta = {
    value: '',
    setAttribute(): void {},
    select(): void {},
    setSelectionRange(start: number, end: number): void { this.value = this.value.slice(0, start) + this.value.slice(start, end) },
    style: {},
    remove(): void {},
  }
  const doc: Record<string, unknown> = {
    body: { appendChild(): void {} },
    createElement: (tag: string): typeof ta => {
      if (tag !== 'textarea') throw new Error(`unexpected createElement(${tag})`)
      return ta
    },
    execCommand: (command: string): boolean => {
      if (command !== 'copy') throw new Error(`unexpected execCommand(${command})`)
      execCalls.push(ta.value)
      return true
    },
  }
  const win: Record<string, unknown> = {
    navigator: {
      clipboard: {
        writeText: (text: string): Promise<void> => nativeRejects ? Promise.reject(new Error('denied')) : Promise.resolve(),
      },
    },
  }
  // The shim reads the Document interface through its free `document` binding.
  return { win, doc, execCalls }
}

/**
 * Evaluate the shim against a fake guest window.
 * `document` is read lazily by the shim at write time (not at evaluation), so the
 * per-case fake stays installed for the whole run — each case awaits its write
 * before the next case swaps in its own fake.
 */
function runShim(win: Record<string, unknown>, doc: Record<string, unknown>): void {
  const priorWindow = globalThis.window
  globalThis.window = win
  globalThis.document = doc as unknown as Document
  try {
    ;(0, eval)(CLIPBOARD_SHIM_SOURCE)
  } finally {
    if (priorWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
    else globalThis.window = priorWindow
  }
}

;(async () => {
  // 1. On a denied native write, the shim falls back to execCommand and resolves.
  {
    const { win, doc, execCalls } = fakeGuest(true)
    runShim(win, doc)
    const writeText = (win.navigator as { clipboard: { writeText(t: string): Promise<void> } }).clipboard.writeText
    await writeText('const x = 1')
    check(execCalls.length === 1 && execCalls[0] === 'const x = 1', 'denied async write falls back to execCommand with the same text')
  }
  // 2. On a succeeding native write, execCommand is not reached.
  {
    const { win, doc, execCalls } = fakeGuest(false)
    runShim(win, doc)
    const writeText = (win.navigator as { clipboard: { writeText(t: string): Promise<void> } }).clipboard.writeText
    await writeText('native ok')
    check(execCalls.length === 0, 'succeeding async write does not touch execCommand')
  }
  // 3. The shim is idempotent across repeated injection and keeps the patched surface.
  {
    const { win, doc, execCalls } = fakeGuest(true)
    runShim(win, doc)
    runShim(win, doc)
    const writeText = (win.navigator as { clipboard: { writeText(t: string): Promise<void> } }).clipboard.writeText
    await writeText('again')
    check(execCalls.length === 1, 're-injection does not double-wrap the write surface')
  }
})()

/* flush the async blocks, then report */
setTimeout(() => {
  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`)
    process.exit(1)
  }
  console.log('\nclipboard-relay: all assertions passed')
}, 0)