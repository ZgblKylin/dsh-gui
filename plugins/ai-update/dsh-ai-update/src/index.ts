/**
 * dsh-ai-update host half — empty by design.
 *
 * Every behavior lives in the browser half (lib/client.js): the embedded
 * dsh web page listens for "dsh-gui:ai-update" window messages from the
 * desktop shell, starts a session from the requested agent preset, and
 * prefills the composer. The host half exists only so the plugin is a real
 * loader entry the client-module scan can pick up.
 */

/** Host plugin body — no host-side behavior for this bridge plugin. */
export function apply(): void {}
