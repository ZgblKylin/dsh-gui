/**
 * dsh-auto-update browser half — the caption-band update entry.
 *
 * It does nothing unless the document is the desktop application's renderer:
 * the shell publishes `window.dshDesktop` (protocol version 1) only in its own
 * primary frame, so an ordinary `dsh web` page, an iframe, or any other host
 * leaves this half completely inert — no element, no `<style>`, no request.
 *
 * When it does mount, this module owns the three surfaces and their lifecycle:
 *
 *   - `./button.ts`         the 「更新」 entry in the caption band, plus the toast
 *   - `./dialog.ts`         the 自动更新 dialog (rows, targets, streamed log)
 *   - `./changelog-view.ts` the 更新日志 dialog behind each row
 *
 * A mount that outlived its fiber would otherwise leave a second set of
 * surfaces behind, so every marked element is removed before mounting, and the
 * effect disposer removes everything this half created — including the owned
 * `<style>` tag.
 *
 * One background pass runs at mount to fill the entry badge from the host's
 * `notifyCount` — `?mode=cached` first, a real `?mode=check` only on a cold
 * start (contract §8.4); there is no polling, and a failure leaves the entry
 * usable (the reason surfaces in the dialog when it is opened).
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

import { fetchCachedStatus, fetchStatus, type UpdateStatus } from './api.ts'
import { desktopCarrier } from './bridge.ts'
import { BUTTON_ATTR, TOAST_ATTR, createUpdateButton, disposeToast } from './button.ts'
import { CHANGELOG_ATTR, createChangelogView } from './changelog-view.ts'
import { OVERLAY_ATTR, createUpdateDialog } from './dialog.ts'
import { installStyles, removeStyles } from './styles.ts'

/** No Cordis service is required: every surface is plain DOM owned by this fiber. */
export const inject = [] as const

/**
 * Mount the update entry when the desktop shell publishes its carrier.
 * @param ctx - Client Cordis context.
 */
export function apply(ctx: ClientContext): void {
  if (desktopCarrier() === undefined) return
  ctx.effect(() => mountAutoUpdate(), 'dsh-auto-update: update entry')
}

/**
 * Build the entry, both dialogs, and their wiring.
 * @returns teardown, registered as the plugin's effect disposer.
 */
function mountAutoUpdate(): () => void {
  installStyles()
  // Single instance: a mount that outlived its fiber must not leave a second
  // entry, dialog, changelog, or toast behind.
  document.querySelectorAll(`[${BUTTON_ATTR}], [${OVERLAY_ATTR}], [${CHANGELOG_ATTR}], [${TOAST_ATTR}]`)
    .forEach((stale) => { stale.remove() })

  let disposed = false
  const changelog = createChangelogView()
  const button = createUpdateButton({
    onClick: () => {
      // One dialog at a time: the entry is disabled until the dialog closes.
      if (dialog.isOpen()) return
      button.setEnabled(false)
      dialog.open()
    },
  })
  const dialog = createUpdateDialog({
    changelog,
    onNotifyCount: (count) => { button.setNotifyCount(count) },
    onClosed: () => { if (!disposed) button.setEnabled(true) },
  })

  button.setNotifyCount(0)
  document.body.append(button.element, dialog.element, changelog.element)

  /**
   * Escape closes the topmost surface: the changelog when it is open, else the
   * update dialog (which refuses while an update is streaming).
   */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    if (changelog.isOpen()) {
      changelog.close()
      return
    }
    if (dialog.isOpen()) dialog.close()
  }
  window.addEventListener('keydown', onKeyDown)

  // Fill the badge once (contract §8.4). The host cache is asked first: when it
  // is warm — a page reload, or a check the shell already ran in this host
  // process — the badge needs no network at all, whereas a cold `mode=check`
  // fetches every submodule and can take minutes. Only a cold start runs the
  // real check. The dialog refreshes the badge after every completed check.
  void (async () => {
    let status: UpdateStatus | undefined
    try {
      status = await fetchCachedStatus()
    } catch {
      // No usable cache route (an older host): fall through to a real check.
    }
    if (disposed) return
    if (status !== undefined) {
      button.setNotifyCount(Number.isFinite(status.notifyCount) ? status.notifyCount : 0)
      return
    }
    try {
      const fresh = await fetchStatus('check')
      if (disposed) return
      button.setNotifyCount(Number.isFinite(fresh.notifyCount) ? fresh.notifyCount : 0)
    } catch {
      // No badge without a successful check; the dialog reports the reason.
    }
  })()

  return () => {
    disposed = true
    window.removeEventListener('keydown', onKeyDown)
    dialog.dispose()
    changelog.dispose()
    button.dispose()
    disposeToast()
    removeStyles()
  }
}
