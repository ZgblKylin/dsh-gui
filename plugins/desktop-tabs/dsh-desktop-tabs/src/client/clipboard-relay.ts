/**
 * Remote-guest clipboard write fallback.
 *
 * The desktop shell's guest sessions deny every permission, so a remote session's
 * `navigator.clipboard.writeText()` is rejected (`clipboard-sanitized-write` is
 * checked against the deny-all session handler in
 * `deepseek-harness/apps/desktop/src/browser-guests.ts`). The harness copy controls
 * route through ui-primitives' writeClipboard, which treats a rejection as a failed
 * copy and only falls back to `document.execCommand('copy')` when the async API is
 * absent — the common denial therefore never reaches that fallback.
 *
 * The plugin cannot reach the guest's session (a main-process concept), so — like
 * the notification relay (notify-relay.ts) — it patches at the page level: a shim
 * injected into the guest wraps `navigator.clipboard.writeText` so a denied async
 * write falls back to `document.execCommand('copy')` (a user-gesture selection copy
 * that the session permission handler does not gate). The promise contract is kept:
 * it resolves when either path succeeds and rejects when both fail.
 */
import type { RemoteWebview } from './webview-host.ts'

/**
 * Script injected into a remote guest at document-ready. Installs a marker
 * (`window.__dshClipboardWriteRelay`) and wraps `navigator.clipboard.writeText`:
 * the native write is attempted first, and a rejection falls back to
 * `document.execCommand('copy')` over a hidden textarea holding the same text.
 * Nothing else on the page is touched, including `readText`. Re-injection on a
 * later navigation is a no-op.
 */
export const CLIPBOARD_SHIM_SOURCE = `(function initClipboardWriteRelay() {
  if (window.__dshClipboardWriteRelay) return;
  var nav = window.navigator;
  if (!nav || !nav.clipboard) return;
  var nativeWriteText = typeof nav.clipboard.writeText === 'function' ? nav.clipboard.writeText.bind(nav.clipboard) : null;
  if (!nativeWriteText) return;
  window.__dshClipboardWriteRelay = true;

  function copyViaExec(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  var shim = function (text) {
    return Promise.resolve()
      .then(function () { return nativeWriteText(text); })
      .catch(function () {
        if (!copyViaExec(text)) throw new Error('clipboard write failed');
      });
  };
  try { nav.clipboard.writeText = shim; } catch (e) {}
}())`

/** Install the clipboard write fallback into a shown guest. */
export function installClipboardShim(webview: RemoteWebview): Promise<void> {
  return webview.executeJavaScript(CLIPBOARD_SHIM_SOURCE, false).then(() => undefined)
}