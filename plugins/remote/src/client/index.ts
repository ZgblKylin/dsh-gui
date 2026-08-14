/**
 * dsh-remote browser half: mounts the connection tab bar chrome in the
 * frame-wide `shell.overlay` seat. It renders in the embedded web view (the
 * dsh-gui desktop shell wraps this UI in an iframe, so `window.top` is NOT the
 * app window) and skips only when the page is itself one of our remote-connection
 * iframes — those are created with `name="dsh-remote-connection"`, which
 * survives navigation, so a child backend that also runs this plugin never
 * re-renders the chrome recursively.
 *
 * All host work goes through same-origin HTTP to `/remote-api/<op>`; the
 * connection records and tab list are persisted in localStorage (dsh-gui owns
 * the connection config, the remote owns its own backend config).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { RemoteApp } from './RemoteApp.tsx'
import { installStyles, removeStyles } from './styles.ts'

/** Required services for slot registration. */
export const inject = ['slots']

/** Mounts the browser half.
 * @param ctx - Client Cordis context.
 */
export function apply(ctx: ClientContext): void {
  if (typeof window === 'undefined') return
  // Inside the dsh-gui shell iframe, `self !== top` is expected; only a
  // nested remote-connection iframe must stay inert.
  if (window.name === 'dsh-remote-connection') return

  ctx.effect(() => {
    installStyles()
    return () => { removeStyles() }
  }, 'dsh-remote: styles')

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'remote.chrome',
    order: 1000,
  }, RemoteApp))
}
