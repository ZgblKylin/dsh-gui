/**
 * Local loopback port selection for the SSH tunnel.
 *
 * The port is probed, not reserved: the tunnel binds it a moment later, and the
 * bind is the authority. `ssh` runs with `ExitOnForwardFailure=yes`, so a lost
 * race fails the tunnel loudly instead of forwarding requests to whichever local
 * service won the port.
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
