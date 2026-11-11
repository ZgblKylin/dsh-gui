/**
 * Local loopback port selection.
 *
 * Two different needs share this module. The SSH path needs a free port for its
 * tunnel, probed and not reserved: the tunnel binds it a moment later, and the
 * bind is the authority (`ssh` runs with `ExitOnForwardFailure=yes`, so a lost
 * race fails the tunnel loudly instead of forwarding requests to whichever local
 * service won the port). The WSL path needs to know whether a chosen backend
 * port is reachable on the Windows loopback, because WSL2's localhost forwarding
 * is what lets the desktop shell open `http://127.0.0.1:<port>/` without a
 * tunnel.
 */

import { createServer } from 'node:net'

/**
 * Find a free loopback TCP port by binding port 0 and releasing it.
 * @returns the port number, free on `127.0.0.1` at the moment of the call.
 */
export async function findFreeLocalPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.once('error', reject)
    probe.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('the loopback port probe returned no TCP address')))
        return
      }
      const port = address.port
      probe.close((error) => {
        if (error === undefined) resolve(port)
        else reject(error)
      })
    })
  })
}

/**
 * Whether a TCP port can be bound on the Windows loopback right now.
 *
 * This is the Windows half of the WSL port scan: a listener already holding
 * `127.0.0.1:<port>` on this machine (another app, or WSL's own localhost
 * forwarding of a port used inside the distro) makes the backend unreachable
 * even when the port is idle inside WSL. Any bind failure counts as "not free"
 * — a permission problem is just as unusable as a collision.
 * @param port - candidate TCP port.
 * @returns true only when a probe bind and release succeeded.
 */
export async function isLoopbackPortFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const probe = createServer()
    probe.unref()
    probe.once('error', () => { resolve(false) })
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      probe.close((error) => { resolve(error === undefined) })
    })
  })
}
