/**
 * The desktop shell's guest-lease bridge, as the browser half consumes it.
 *
 * The shell exposes `window.dshDesktop` in the application document
 * (protocol version 1). `browser.acquire(workspace)` reserves one guest and
 * returns its single-use lease plus the process-local partition approved for it;
 * a `<webview>` whose `src` is `about:blank#<lease>` and whose `partition` is
 * that value is the only shape the shell attaches. The type is declared here
 * rather than imported from the sidebar-browser package: the shell's contract is
 * the object it publishes, and this plugin requests no other package's code.
 */

/** One approved guest reservation. */
export interface DesktopBrowserReservation {
  /** Single-use identity of this reservation. */
  readonly lease: string
  /** Storage partition approved for this reservation. */
  readonly partition: string
}

/** Lease-scoped guest operations published by the desktop shell. */
export interface DesktopBrowserBridge {
  /**
   * Reserve one guest in the storage account named by `workspace`; the same
   * account keeps the same partition for the process lifetime.
   * @param workspace - opaque storage-account identity, 1..4096 characters.
   * @returns the approved reservation.
   */
  acquire(workspace: string): Promise<DesktopBrowserReservation>
  /**
   * Destroy a reservation's guest and release its lease.
   * @param lease - the caller's lease.
   */
  release(lease: string): Promise<void>
}

/**
 * Read the carrier published by the desktop shell.
 * @returns the guest bridge, or undefined outside the desktop application.
 */
export function desktopBrowser(): DesktopBrowserBridge | undefined {
  const carrier = (globalThis as typeof globalThis & {
    dshDesktop?: { readonly protocolVersion?: number; readonly browser?: DesktopBrowserBridge }
  }).dshDesktop
  if (carrier?.protocolVersion !== 1) return undefined
  return carrier.browser
}
