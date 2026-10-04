/**
 * The remote-view layer: one leased `<webview>` for the active remote tab.
 *
 * Every transition is an unload. `show()` destroys the current guest and creates
 * a fresh one, `hide()` destroys it and reveals the native UI; there is no
 * retained hidden guest. Revisiting a tab acquires a new lease for the same
 * storage account, which the shell maps back to the partition it already holds,
 * so the tab's cookie jar survives the unload for the lifetime of the
 * application process (the partitions are not `persist:` — they do not survive a
 * restart).
 *
 * Concurrency: a monotonically increasing run number invalidates any mount that
 * is still awaiting `acquire()` when a newer transition starts, so a stale
 * reservation is released instead of attaching a guest for a tab the user has
 * already left.
 */

import type { DesktopBrowserBridge, DesktopBrowserReservation } from './bridge.ts'

/** The Electron tag API this layer calls. */
interface WebviewElement extends HTMLElement {
  loadURL(url: string): Promise<void>
  isLoading(): boolean
}

/** A main-frame navigation failure event. */
interface LoadFailureEvent extends Event {
  readonly isMainFrame: boolean
  readonly errorCode: number
  readonly errorDescription: string
}

/** One remote destination to present. */
export interface RemoteTarget {
  /** Storage account; the same value keeps the same cookie jar across unloads. */
  readonly account: string
  /** Absolute http/https URL to load. */
  readonly url: string
  /** Tab title, used for the accessible label and status text. */
  readonly title: string
}

/** The layer's element plus its transitions. */
export interface RemoteView {
  /** The layer to append to the document. */
  readonly element: HTMLElement
  /** Show the layer for a tab whose address is still being resolved; no guest is created yet. */
  open(title: string): void
  /** Show the layer carrying a failure message; no guest is created, and the log stays visible. */
  fail(text: string): void
  /** @param lines - the connection progress log, oldest first; scrolls to the newest line. */
  setLog(lines: readonly string[]): void
  /** @param target - destination to load, replacing the current guest. */
  show(target: RemoteTarget): void
  /** Destroy the current guest and reveal the native UI. */
  hide(): void
  /** Destroy the current guest and detach the layer. */
  dispose(): void
}

/** Marks the view layer. */
export const VIEW_ATTR = 'data-dsh-desktop-tabs-view'
/** Marks the `<html>` element while the layer covers the application. */
export const COVER_ATTR = 'data-dsh-desktop-tabs-cover'
/** Marks the status line shown while loading or after a failure. */
const STATUS_ATTR = 'data-dsh-desktop-tabs-status'
/** Marks the connection progress log. */
const LOG_ATTR = 'data-dsh-desktop-tabs-log'

/** `ERR_ABORTED`: emitted for the superseded bootstrap navigation, not a failure. */
const ERR_ABORTED = -3

/**
 * Create the remote-view layer.
 * @param bridge - guest lease operations from the desktop shell.
 * @returns the layer and its transitions.
 */
export function createRemoteView(bridge: DesktopBrowserBridge): RemoteView {
  const element = document.createElement('div')
  element.setAttribute(VIEW_ATTR, '')
  element.hidden = true
  const status = document.createElement('p')
  status.setAttribute(STATUS_ATTR, '')
  status.hidden = true
  const log = document.createElement('pre')
  log.setAttribute(LOG_ATTR, '')
  log.hidden = true
  element.append(status, log)

  let lease: string | undefined
  let guest: WebviewElement | undefined
  let run = 0

  const setStatus = (text: string | undefined): void => {
    status.textContent = text === undefined ? '' : redact(text)
    status.hidden = text === undefined
  }

  /**
   * Mark the document while the layer covers the application, so the plugin's
   * stylesheet hides the application root (`visibility`, keeping its layout and
   * React state). Any skin or onboarding surface drawn inside that root goes
   * with it; what the root does not own is covered by the opaque layer itself.
   */
  const setCover = (covered: boolean): void => {
    if (covered) document.documentElement.setAttribute(COVER_ATTR, '')
    else document.documentElement.removeAttribute(COVER_ATTR)
  }

  const setLog = (lines: readonly string[]): void => {
    log.textContent = lines.map(redact).join('\n')
    log.hidden = lines.length === 0
    // Keep the newest line in view; the log is the only progress feedback until
    // the guest exists.
    log.scrollTop = log.scrollHeight
  }

  const release = (id: string): void => {
    void bridge.release(id).catch((error: unknown) => {
      console.warn('[dsh-desktop-tabs] guest release failed:', error)
    })
  }

  /** Remove the guest element and release its lease (the guest dies with the DOM). */
  const destroyGuest = (): void => {
    const current = guest
    const currentLease = lease
    guest = undefined
    lease = undefined
    current?.remove()
    // Nothing but the owned guest may ever sit in the layer: a stale element
    // would keep showing the previous session under the placeholder.
    for (const stray of element.querySelectorAll('webview')) stray.remove()
    if (currentLease !== undefined) release(currentLease)
  }

  const mount = async (target: RemoteTarget, current: number): Promise<void> => {
    let reservation: DesktopBrowserReservation
    try {
      reservation = await bridge.acquire(target.account)
    } catch (error: unknown) {
      if (current === run) setStatus(`${target.title} 连接失败：${message(error)}`)
      return
    }
    if (current !== run) {
      release(reservation.lease)
      return
    }
    lease = reservation.lease
    const webview = document.createElement('webview') as WebviewElement
    // The shell attaches a guest only for this exact src + partition pair, once
    // per lease: `about:blank#<lease>` is the approved bootstrap document.
    webview.setAttribute('name', reservation.lease)
    webview.setAttribute('partition', reservation.partition)
    webview.setAttribute('src', `about:blank#${reservation.lease}`)
    webview.setAttribute('aria-label', target.title)
    webview.addEventListener('dom-ready', () => {
      if (current !== run) return
      void webview.loadURL(target.url).catch((error: unknown) => {
        if (current === run) setStatus(`${target.title} 加载失败：${message(error)}`)
      })
    }, { once: true })
    webview.addEventListener('did-start-loading', () => {
      if (current === run) setStatus(`正在连接 ${target.title}…`)
    })
    // A stop event for the bootstrap document arrives while the target is still
    // loading; only a genuinely idle guest clears the status.
    webview.addEventListener('did-stop-loading', () => {
      if (current === run && !webview.isLoading()) setStatus(undefined)
    })
    webview.addEventListener('did-fail-load', (event) => {
      const failure = event as LoadFailureEvent
      if (current === run && failure.isMainFrame && failure.errorCode !== ERR_ABORTED) {
        setStatus(`${target.title} 加载失败：${failure.errorDescription || String(failure.errorCode)}`)
      }
    })
    guest = webview
    element.append(webview)
  }

  return {
    element,
    open(title: string): void {
      run += 1
      destroyGuest()
      element.hidden = false
      setStatus(`正在连接 ${title}…`)
      setLog([])
      setCover(true)
    },
    fail(text: string): void {
      run += 1
      destroyGuest()
      element.hidden = false
      setStatus(text)
      setCover(true)
    },
    setLog,
    show(target: RemoteTarget): void {
      run += 1
      const current = run
      destroyGuest()
      element.hidden = false
      setStatus(`正在连接 ${target.title}…`)
      setLog([])
      setCover(true)
      void mount(target, current)
    },
    hide(): void {
      run += 1
      destroyGuest()
      element.hidden = true
      setStatus(undefined)
      setLog([])
      setCover(false)
    },
    dispose(): void {
      run += 1
      destroyGuest()
      element.remove()
      setCover(false)
    },
  }
}

/** @returns an error's message, or its string form. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Strip a launch token from anything rendered.
 *
 * The remote half documents that its launch token never enters the connection
 * log, but its ready line and its launch-URL failures can carry the full
 * `?token=...` URL. The panel is a rendering surface, so it never shows the
 * secret even while that source is being fixed.
 * @param value - one status or log line.
 * @returns the line with every `token=` value masked.
 */
function redact(value: string): string {
  return value.replace(/([?&]token=)[^\s&"']+/gi, '$1***')
}
