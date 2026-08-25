/**
 * dsh-remote browser half — INERT as of the desktop-shell redesign.
 *
 * The connection chrome (tabs, new-connection page, hamburger entries) moved
 * out of the embedded web view into the native Tauri title bar
 * (`src-tauri/ui`). The embedded page must therefore render NO extra chrome of
 * its own. The mount expects a client module, so this half loads but applies
 * nothing.
 *
 * All the real machinery stays in the host half: `/remote-api/*` (probe, local
 * backend spawn, SSH start + tunnel, credentials, tunnels) is reached by the Tauri
 * shell through the `remote_call` Rust command. This keeps every capability in
 * one place while leaving the embedded UI untouched.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

/** Required services for slot registration (unused while inert). */
export const inject = ['slots']

/** Mounts (or rather, intentionally does not mount) the browser half.
 * @param ctx - Client Cordis context.
 */
export function apply(ctx: ClientContext): void {
  void ctx
}
