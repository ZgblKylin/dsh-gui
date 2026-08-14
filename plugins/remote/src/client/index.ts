/**
 * dsh-remote browser half: mounts the connection tab bar chrome in the
 * frame-wide `shell.overlay` seat. It only takes over at the top level of the
 * page (never inside a connection iframe), so loading another backend's
 * frontend never re-renders the chrome recursively.
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
  if (typeof window === 'undefined' || window.self !== window.top) return

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
