/**
 * dsh-desktop-tabs browser half — mounts the caption-band host tab strip.
 *
 * It does nothing unless the document is the desktop application's renderer:
 * the shell publishes `window.dshDesktop.browser` (protocol version 1) only in
 * its own primary frame, so an ordinary `dsh web` page, an iframe, or any other
 * host leaves this half inert and never touches the existing UI.
 *
 * The strip itself is `./tabs.ts`; everything it owns (the `<style>` tag, the
 * strip, the remote-view layer, the guest lease) is released by the effect
 * disposer returned here.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

import { desktopBrowser } from './bridge.ts'
import { createDesktopTabs } from './tabs.ts'

/** No Cordis service is required: the strip is plain DOM owned by this fiber. */
export const inject = [] as const

/**
 * Mount the strip when the desktop shell publishes its guest bridge.
 * @param ctx - Client Cordis context.
 */
export function apply(ctx: ClientContext): void {
  const bridge = desktopBrowser()
  if (bridge === undefined) return
  ctx.effect(() => createDesktopTabs(bridge), 'dsh-desktop-tabs: tab strip')
}
