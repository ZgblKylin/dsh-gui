/**
 * The remote-view layer: one retained leased `<webview>` per open remote tab.
 *
 * Every remote tab owns a surface in this layer. Showing a tab reveals its
 * surface while the guests of the other tabs stay attached and keep running,
 * hidden with their surfaces, so switching preserves document state, scroll
 * position, connections, and in-page work. A guest is unloaded only when its
 * tab is closed or refreshed, or when the layer is disposed.
 *
 * Re-acquiring a lease for the same storage account maps back to the partition
 * the shell already holds, so one unload keeps the tab's cookie jar for the
 * lifetime of the application process (the partitions are not `persist:` — they
 * do not survive a restart).
 *
 * Concurrency: each surface carries a generation number that every transition
 * replacing or unloading its guest increments. A mount still awaiting
 * `acquire()` for a superseded surface is released instead of attaching a guest
 * nobody shows.
 */

import type { DesktopBrowserBridge, DesktopBrowserReservation } from './bridge.ts'
import { installClipboardShim } from './clipboard-relay.ts'
import {
  drainRemoteNotifications,
  installNotifyShim,
  playRemoteNotification,
  REMOTE_NOTIFY_POLL_MS,
} from './notify-relay.ts'

/** The Electron tag API this layer calls. */
interface WebviewElement extends HTMLElement {
  loadURL(url: string): Promise<void>
  isLoading(): boolean
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
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
  /** Reveal a tab's surface (its guest or placeholder); no surface yet shows an empty layer. */
  activate(id: string): void
  /** @returns whether the tab currently has a live guest. */
  hasGuest(id: string): boolean
  /** Show a tab's connecting placeholder, unloading its guest. */
  open(id: string, title: string): void
  /** Show a tab's failure placeholder, unloading its guest; the log stays visible. */
  fail(id: string, text: string): void
  /** @param lines - one tab's connection progress log, oldest first; scrolls to the newest line. */
  setLog(id: string, lines: readonly string[]): void
  /** Load a tab's address in a fresh guest, replacing any guest it already had. */
  show(id: string, target: RemoteTarget): void
  /** Unload one tab's guest and drop its surface (the tab is being closed or refreshed). */
  unload(id: string): void
  /** Reveal the native UI; every tab's guest stays alive. */
  hide(): void
  /** Unload every guest and detach the layer. */
  dispose(): void
}

/** Marks the view layer. */
export const VIEW_ATTR = 'data-dsh-desktop-tabs-view'
/** Marks the `<html>` element while the layer covers the application. */
export const COVER_ATTR = 'data-dsh-desktop-tabs-cover'
/** Marks one tab's surface inside the layer. */
const SURFACE_ATTR = 'data-dsh-desktop-tabs-surface'
/** Marks a surface's status line, shown while loading or after a failure. */
const STATUS_ATTR = 'data-dsh-desktop-tabs-status'
/** Marks a surface's connection progress log. */
const LOG_ATTR = 'data-dsh-desktop-tabs-log'

/** `ERR_ABORTED`: emitted for the superseded bootstrap navigation, not a failure. */
const ERR_ABORTED = -3

/** One tab's part of the layer: its own status, log, guest, and lease. */
interface Surface {
  /** Tab id this surface belongs to. */
  readonly id: string
  /** The surface element; hidden while another tab is shown. */
  readonly root: HTMLElement
  readonly status: HTMLElement
  readonly log: HTMLElement
  /** The tab's retained guest, absent while connecting or after a failure. */
  guest?: WebviewElement
  /** Lease owned by {@link guest}. */
  lease?: string
  /** Invalidates mounts and listeners of a replaced or unloaded guest. */
  generation: number
  /** Drains this guest's relayed notifications; cleared with the guest. */
  timer?: number
}

/**
 * Create the remote-view layer.
 * @param bridge - guest lease operations from the desktop shell.
 * @returns the layer and its transitions.
 */
export function createRemoteView(bridge: DesktopBrowserBridge): RemoteView {
  const element = document.createElement('div')
  element.setAttribute(VIEW_ATTR, '')
  element.hidden = true
  /** One surface per remote tab that has been activated in this mount. */
  const surfaces = new Map<string, Surface>()
  /** The tab whose surface is currently visible; undefined reveals the native UI. */
  let activeId: string | undefined

  const setCover = (covered: boolean): void => {
    if (covered) document.documentElement.setAttribute(COVER_ATTR, '')
    else document.documentElement.removeAttribute(COVER_ATTR)
  }

  const setStatus = (surface: Surface, text: string | undefined): void => {
    surface.status.textContent = text === undefined ? '' : redact(text)
    surface.status.hidden = text === undefined
  }

  const setLog = (surface: Surface, lines: readonly string[]): void => {
    surface.log.textContent = lines.map(redact).join('\n')
    surface.log.hidden = lines.length === 0
    // Keep the newest line in view; the log is the only progress feedback until
    // the guest exists.
    surface.log.scrollTop = surface.log.scrollHeight
  }

  const release = (lease: string): void => {
    void bridge.release(lease).catch((error: unknown) => {
      console.warn('[dsh-desktop-tabs] guest release failed:', error)
    })
  }

  /**
   * Mark the document while the layer covers the application, so the plugin's
   * stylesheet hides the application root (`visibility`, keeping its layout and
   * React state). Any skin or onboarding surface drawn inside that root goes
   * with it; what the root does not own is covered by the opaque layer itself.
   */
  const showActive = (id: string | undefined): void => {
    activeId = id
    for (const [key, surface] of surfaces) surface.root.hidden = key !== id
    if (id === undefined) {
      element.hidden = true
      setCover(false)
      return
    }
    element.hidden = false
    setCover(true)
    surfaces.get(id)?.guest?.focus()
  }

  /** The tab's surface, created on first use. */
  const surfaceOf = (id: string): Surface => {
    const existing = surfaces.get(id)
    if (existing !== undefined) return existing
    const root = document.createElement('div')
    root.setAttribute(SURFACE_ATTR, id)
    root.hidden = true
    const status = document.createElement('p')
    status.setAttribute(STATUS_ATTR, '')
    status.hidden = true
    const log = document.createElement('pre')
    log.setAttribute(LOG_ATTR, '')
    log.hidden = true
    root.append(status, log)
    const surface: Surface = { id, root, status, log, generation: 0 }
    surfaces.set(id, surface)
    element.append(root)
    return surface
  }

  /** Stop draining a guest's relayed notifications. */
  const stopNotifyPoll = (surface: Surface): void => {
    if (surface.timer === undefined) return
    window.clearInterval(surface.timer)
    surface.timer = undefined
  }

  /** Replay a guest's relayed notifications on the app document while it lives. */
  const startNotifyPoll = (surface: Surface, generation: number): void => {
    stopNotifyPoll(surface)
    surface.timer = window.setInterval(() => {
      const guest = surface.guest
      if (generation !== surface.generation || guest === undefined) {
        stopNotifyPoll(surface)
        return
      }
      void drainRemoteNotifications(guest)
        .then((items) => {
          if (generation !== surface.generation) return
          for (const item of items) playRemoteNotification(item)
        })
        .catch(() => { /* a destroyed guest just stops relaying */ })
    }, REMOTE_NOTIFY_POLL_MS)
  }

  /** Remove a surface's guest, release its lease, and stop relaying its notifications. */
  const destroyGuest = (surface: Surface): void => {
    stopNotifyPoll(surface)
    const guest = surface.guest
    const lease = surface.lease
    surface.guest = undefined
    surface.lease = undefined
    guest?.remove()
    // Nothing but this surface's own guest may ever sit in it.
    for (const stray of surface.root.querySelectorAll('webview')) stray.remove()
    if (lease !== undefined) release(lease)
  }

  /**
   * Start a transition on one tab's surface: drop its guest and clear its
   * picture, then reveal the surface when it is the active tab.
   * @param keepLog - keep the surface's connection log (a failure keeps it).
   */
  const beginTransition = (id: string, status: string, keepLog = false): Surface => {
    const surface = surfaceOf(id)
    surface.generation += 1
    destroyGuest(surface)
    setStatus(surface, status)
    if (!keepLog) setLog(surface, [])
    if (activeId === id) showActive(id)
    return surface
  }

  /** Acquire a lease for the target and attach its guest to the surface. */
  const mount = async (surface: Surface, target: RemoteTarget, generation: number): Promise<void> => {
    let reservation: DesktopBrowserReservation
    try {
      reservation = await bridge.acquire(target.account)
    } catch (error: unknown) {
      if (generation === surface.generation) setStatus(surface, `${target.title} 连接失败：${message(error)}`)
      return
    }
    if (generation !== surface.generation) {
      release(reservation.lease)
      return
    }
    surface.lease = reservation.lease
    const webview = document.createElement('webview') as WebviewElement
    // The shell attaches a guest only for this exact src + partition pair, once
    // per lease: `about:blank#<lease>` is the approved bootstrap document.
    webview.setAttribute('name', reservation.lease)
    webview.setAttribute('partition', reservation.partition)
    webview.setAttribute('src', `about:blank#${reservation.lease}`)
    webview.setAttribute('aria-label', target.title)
    webview.addEventListener('dom-ready', () => {
      if (generation !== surface.generation) return
      void webview.loadURL(target.url).catch((error: unknown) => {
        if (generation === surface.generation) setStatus(surface, `${target.title} 加载失败：${message(error)}`)
      })
    }, { once: true })
    // The guest cannot carry a preload (the shell strips webview preferences), so
    // the notification and clipboard shims are installed from here at every ready
    // document — the guest session denies their permissions, and the page-level
    // relays are the remaining ways to surface them (see notify-relay/clipboard-relay)
    // with the clipboard async write falling back to execCommand('copy').
    webview.addEventListener('dom-ready', () => {
      if (generation !== surface.generation) return
      void installNotifyShim(webview).catch(() => { /* the relay is best-effort */ })
      void installClipboardShim(webview).catch(() => { /* the relay is best-effort */ })
    })
    webview.addEventListener('did-start-loading', () => {
      if (generation === surface.generation) setStatus(surface, `正在连接 ${target.title}…`)
    })
    // A stop event for the bootstrap document arrives while the target is still
    // loading; only a genuinely idle guest clears the status.
    webview.addEventListener('did-stop-loading', () => {
      if (generation === surface.generation && !webview.isLoading()) setStatus(surface, undefined)
    })
    webview.addEventListener('did-fail-load', (event) => {
      const failure = event as LoadFailureEvent
      if (generation === surface.generation && failure.isMainFrame && failure.errorCode !== ERR_ABORTED) {
        setStatus(surface, `${target.title} 加载失败：${failure.errorDescription || String(failure.errorCode)}`)
      }
    })
    surface.guest = webview
    surface.root.append(webview)
    // Hand keyboard focus to the shown guest (the same cause class the parity
    // doc lists for the remote copy/notification defects); a click inside the
    // page re-focuses it anyway, this covers the pre-interaction state. A guest
    // mounted while its tab is in the background keeps the current focus.
    if (surface.id === activeId) webview.focus()
    startNotifyPoll(surface, generation)
  }

  return {
    element,
    activate(id: string): void {
      showActive(id)
    },
    hasGuest: (id: string): boolean => surfaces.get(id)?.guest !== undefined,
    open(id: string, title: string): void {
      beginTransition(id, `正在连接 ${title}…`)
    },
    fail(id: string, text: string): void {
      beginTransition(id, text, true)
    },
    setLog: (id: string, lines: readonly string[]): void => {
      setLog(surfaceOf(id), lines)
    },
    show(id: string, target: RemoteTarget): void {
      const surface = beginTransition(id, `正在连接 ${target.title}…`)
      void mount(surface, target, surface.generation)
    },
    unload(id: string): void {
      const surface = surfaces.get(id)
      if (surface === undefined) return
      surface.generation += 1
      destroyGuest(surface)
      surface.root.remove()
      surfaces.delete(id)
      if (activeId === id) showActive(undefined)
    },
    hide(): void {
      showActive(undefined)
    },
    dispose(): void {
      for (const surface of surfaces.values()) {
        surface.generation += 1
        destroyGuest(surface)
        surface.root.remove()
      }
      surfaces.clear()
      activeId = undefined
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
