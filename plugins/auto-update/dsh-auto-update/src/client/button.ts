/**
 * The always-mounted caption-band chrome: the 「更新」 entry button and the
 * transient toast that failures report through.
 *
 * The button is the plugin's only permanent element. It sits at the band's
 * right edge, just before the three native window controls
 * (`--dsh-auto-update-controls-width`, 138px measured on Windows), is
 * `-webkit-app-region: no-drag`, and keeps its `title`/`aria-label` fixed at
 * 「检查更新」; the pending-update state is one dot badge, exposed to assistive
 * tech through `aria-label` on the badge itself rather than by rewriting the
 * button's label.
 */

/** Marks the entry button. */
export const BUTTON_ATTR = 'data-dsh-auto-update-button'

/** Marks the dot badge inside the entry button. */
export const BADGE_ATTR = 'data-dsh-auto-update-badge'

/** Marks the toast element. */
export const TOAST_ATTR = 'data-dsh-auto-update-toast'

/** How long a toast stays on screen. */
const TOAST_MS = 4200

/** The entry button and its observable state. */
export interface UpdateButton {
  /** The `<button>` element; the caller appends it. */
  readonly element: HTMLButtonElement
  /** Show or hide the dot badge for this many pending updates. */
  setNotifyCount(count: number): void
  /** Disable the button (used while a dialog is already open). */
  setEnabled(enabled: boolean): void
  /** Remove the element and its listeners. */
  dispose(): void
}

/**
 * Create the entry button.
 * @param options - `onClick` runs on activation.
 * @returns the button handle.
 */
export function createUpdateButton(options: { onClick: () => void }): UpdateButton {
  const element = document.createElement('button')
  element.type = 'button'
  element.setAttribute(BUTTON_ATTR, '')
  element.title = '检查更新'
  element.setAttribute('aria-label', '检查更新')
  element.textContent = '更新'

  const badge = document.createElement('span')
  badge.setAttribute(BADGE_ATTR, '')
  badge.hidden = true
  badge.setAttribute('aria-hidden', 'true')
  element.append(badge)

  const onClick = (): void => { options.onClick() }
  element.addEventListener('click', onClick)

  return {
    element,
    setNotifyCount(count: number): void {
      const pending = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
      element.setAttribute('data-notify-count', String(pending))
      badge.hidden = pending === 0
      if (pending > 0) element.setAttribute('data-notify', 'pending')
      else element.removeAttribute('data-notify')
    },
    setEnabled(enabled: boolean): void {
      element.disabled = !enabled
    },
    dispose(): void {
      element.removeEventListener('click', onClick)
      element.remove()
    },
  }
}

/** The shared toast element, created on first use. */
let toastElement: HTMLDivElement | undefined
let toastTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Show one transient message under the caption band.
 *
 * Used for outcomes that do not belong in the dialog body (an AI-update
 * receipt, a timeout, a refusal while an update is running).
 *
 * @param message - readable Chinese text.
 */
export function showToast(message: string): void {
  if (toastElement === undefined) {
    toastElement = document.createElement('div')
    toastElement.setAttribute(TOAST_ATTR, '')
    toastElement.setAttribute('role', 'status')
    document.body.append(toastElement)
  }
  toastElement.textContent = message
  toastElement.hidden = false
  if (toastTimer !== undefined) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastTimer = undefined
    if (toastElement !== undefined) toastElement.hidden = true
  }, TOAST_MS)
}

/** Remove the toast element and cancel its timer (plugin teardown). */
export function disposeToast(): void {
  if (toastTimer !== undefined) {
    clearTimeout(toastTimer)
    toastTimer = undefined
  }
  toastElement?.remove()
  toastElement = undefined
}
