/**
 * `connection.requestRejection` compatibility bridge.
 *
 * dsh 0.2.2-rc.5 provided the method on `@deepseek-ai/dsh-client-connection`;
 * 0.2.3 dropped it and keeps only `admit(request)`, whose result carries
 * `{ peer }` on success and `{ rejection: 401 | 403 }` otherwise. The removed
 * method was a one-line delegation to that result:
 *
 *     requestRejection(request) {
 *       const admission = this.admit(request)
 *       return 'rejection' in admission ? admission.rejection : undefined
 *     }
 *
 * Plugins that fence their own HTTP and WebSocket routes with
 * `ctx.connection.requestRejection(request) === undefined` therefore throw
 * against a 0.2.3 host, and their routes answer 401/503 instead of the caller's
 * payload. This plugin restores exactly that delegation for hosts that no
 * longer publish the method, so the fence keeps its original meaning: the
 * decision still comes from the host's own admission path, including the
 * Host/Origin check and the session credential.
 *
 * `connection.authentication` must be injected alongside `connection`: `admit`
 * reads the authentication provider, and a context that did not inject the
 * sub-service cannot reach it.
 *
 * The bridge is inert where the host still exports `requestRejection`, and
 * where it exports neither that method nor `admit`. Remove the plugin once every
 * installed plugin uses `admit`, or once the host restores the method.
 */

export const name = 'connection-compat'

export const inject = ['connection', 'connection.authentication']

/**
 * Install the bridge when the running host no longer provides the method.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  const connection = ctx.connection
  if (typeof connection.requestRejection === 'function') return
  if (typeof connection.admit !== 'function') return
  ctx.effect(() => {
    connection.requestRejection = (request) => {
      const admission = connection.admit(request)
      return 'rejection' in admission ? admission.rejection : undefined
    }
    return () => {
      delete connection.requestRejection
    }
  }, 'connection-compat: requestRejection bridge')
}
