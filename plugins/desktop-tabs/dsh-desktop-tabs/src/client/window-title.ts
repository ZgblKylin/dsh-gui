/**
 * The window-title layer: keeps the desktop window on the active remote page's
 * title while one of its tabs covers the application.
 *
 * The desktop window title follows the main document's `document.title` (the
 * shell leaves Electron's default `page-title-updated` handling in place), and
 * the harness's DocumentTitle component owns that value for the native UI. A
 * remote tab is a `<webview>` guest, so its page title never reaches the main
 * document: this layer takes the document title over for as long as a remote
 * page is shown and restores the native one whenever the native UI (or a tab
 * without a title yet) is shown again.
 *
 * Taking over: the first {@link WindowTitle.showRemote} call samples the current
 * document title as the native title and starts observing the document. The
 * harness keeps rewriting `document.title` on its own renders, so an observed
 * write that does not equal the remote title is recorded as the newest native
 * title and immediately overwritten with the remote one. The native title is
 * sampled once per takeover, never while it is being displaced — sampling again
 * on a remote-to-remote switch would capture the previous remote title as
 * "native".
 */

/** The title surface the state machine reads, writes, and watches. */
export interface TitleSurface {
  /** @returns the current document title. */
  read(): string
  /** Replace the document title. */
  write(title: string): void
  /**
   * Watch for title writes made outside this layer.
   * @param listener - called after every observed title mutation.
   * @returns a stop function; calling it after the observer stopped is harmless.
   */
  observe(listener: () => void): () => void
}

/** One remote title at a time, or the native title. */
export interface WindowTitle {
  /**
   * Take the document title over with a remote page title. An empty (or
   * whitespace-only) title means the native UI is shown, so it restores the
   * native title instead.
   */
  showRemote(title: string): void
  /** Restore the newest native title and stop following external title writes. */
  showNative(): void
  /** Release the layer: restores the native title (same as {@link showNative}). */
  dispose(): void
}

/**
 * Create the window-title layer.
 * @param surface - the title surface to drive; defaults to the document.
 * @returns the layer's transitions.
 */
export function createWindowTitle(surface: TitleSurface = domTitleSurface()): WindowTitle {
  /** The document title sampled when the current takeover started. */
  let native: string | undefined
  /** The remote title the document shows while taken over; undefined while native. */
  let remote: string | undefined
  /** Stops observing the document; present only during a takeover. */
  let stopObserving: (() => void) | undefined

  /**
   * Record a title write from outside this layer, then put the remote title
   * back. Only a takeover installs the observer, but the guard keeps a stale
   * callback harmless.
   */
  const onExternalTitle = (): void => {
    if (remote === undefined) return
    const current = surface.read()
    if (current === remote) return
    native = current
    surface.write(remote)
  }

  /** Restore the newest native title and stop following external writes. */
  const showNative = (): void => {
    if (remote === undefined) return
    const previous = native ?? ''
    remote = undefined
    native = undefined
    const stop = stopObserving
    stopObserving = undefined
    stop?.()
    surface.write(previous)
  }

  return {
    showRemote(title: string): void {
      const next = title.trim()
      if (next === '') {
        showNative()
        return
      }
      if (remote === undefined) {
        native = surface.read()
        stopObserving = surface.observe(onExternalTitle)
      }
      remote = next
      surface.write(next)
    },
    showNative,
    dispose: showNative,
  }
}

/**
 * @returns the document-backed title surface: `document.title` plus a
 * `MutationObserver` on the document element.
 */
export function domTitleSurface(): TitleSurface {
  return {
    read: (): string => document.title,
    write: (title: string): void => {
      document.title = title
    },
    observe(listener: () => void): () => void {
      // The title lives in a `<title>` element, so a write mutates the document
      // element's subtree (its text node, or the element itself on first use). A
      // missing root or an unusable observer only costs external-write tracking:
      // the layer itself keeps working, so the failure is reported and ignored.
      try {
        const observer = new MutationObserver(listener)
        observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true })
        return (): void => { observer.disconnect() }
      } catch (error: unknown) {
        console.warn('[dsh-desktop-tabs] could not observe the document title:', error)
        return (): void => {}
      }
    },
  }
}
