/**
 * Remote-guest notification relay.
 *
 * The desktop shell's guest sessions (`deepseek-harness/apps/desktop/src/browser-guests.ts`)
 * deny every permission, so a remote session's `Notification.requestPermission()`
 * resolves `'denied'` and its `new Notification(...)` never surfaces. The desktop-tabs
 * plugin owns the remote `<webview>` in the application renderer and cannot reach the
 * guest's session (a main-process concept), so this module relays at the page level:
 *
 *  1. `installNotifyShim` runs a self-contained script in the guest that fakes a
 *     granted notification permission and intercepts `new Notification(...)`,
 *     queueing each payload instead of creating a denied browser notification.
 *  2. `drainRemoteNotifications` reads and clears that queue through
 *     `webview.executeJavaScript` (the only stable embedder→guest channel on a
 *     sandboxed, context-isolated guest; the `<webview>` tag exposes neither
 *     `contentWindow` nor `postMessage` on this Electron line).
 *  3. `playRemoteNotification` replays each payload with the application document's
 *     own `Notification`, which the app session grants — a real system notification.
 *
 * The icon URL is absolutized inside the guest so the app document can load it.
 */
import type { RemoteWebview } from './webview-host.ts'

/** One relayed notification, in the shape the app document replays. */
export interface RemoteNotifyPayload {
  readonly kind: 'notify'
  readonly title: string
  readonly body?: string
  readonly icon?: string
  readonly tag?: string
  readonly requireInteraction?: boolean
  readonly silent?: boolean
  readonly data?: unknown
}

/** How often the embedder asks a shown guest for queued notifications. */
export const REMOTE_NOTIFY_POLL_MS = 1000

/**
 * Script injected into a remote guest at document-ready. It installs a marker
 * (`window.__dshNotifyRelay`) and rewrites the page's notification surface:
 * `Notification.permission` reports `'granted'`, `requestPermission()` resolves
 * `'granted'`, `navigator.permissions.query({ name: 'notifications' })` reports
 * `'granted'`, and constructing a notification enqueues its payload for the
 * embedder instead of creating a denied browser notification. The remaining
 * `permissions.query` calls and anything else on the page are untouched.
 *
 * Written as ES2017 with string concatenation only (no template literals), so the
 * source string stays independent of any bundler transformation.
 */
export const NOTIFY_SHIM_SOURCE = `(function initNotifyRelay() {
  if (window.__dshNotifyRelay) return;
  var queue = [];
  var relay = {
    enqueue: function (item) { queue.push(item); },
    drain: function () { var out = queue.slice(); queue.length = 0; return out; },
    test: function (title) {
      relay.enqueue({ kind: 'notify', title: String(title || '【dsh-desktop-tabs】通知转接已就绪'), body: '远端页面的 Notification API 已转发到本机。' });
    }
  };
  window.__dshNotifyRelay = relay;

  function absIcon(icon) {
    if (typeof icon !== 'string' || icon === '') return icon;
    try { return new URL(icon, location.href).href; } catch (e) { return icon; }
  }

  var NativeNotification = window.Notification;
  function RemoteNotify(title, options) {
    var opts = options || {};
    var item = { kind: 'notify', title: String(title == null ? '' : title) };
    if (typeof opts.body === 'string' && opts.body !== '') item.body = opts.body;
    var icon = absIcon(opts.icon);
    if (icon !== undefined && icon !== '') item.icon = icon;
    if (typeof opts.tag === 'string' && opts.tag !== '') item.tag = opts.tag;
    if (opts.requireInteraction === true) item.requireInteraction = true;
    if (opts.silent === true) item.silent = true;
    if (opts.data !== undefined) {
      try { item.data = JSON.parse(JSON.stringify(opts.data)); } catch (e) { item.data = undefined; }
    }
    relay.enqueue(item);
    var onclick = null;
    var onclose = null;
    return {
      close: function () { onclick = null; onclose = null; },
      get onclick() { return onclick; },
      set onclick(fn) { onclick = fn; },
      get onclose() { return onclose; },
      set onclose(fn) { onclose = fn; },
      title: item.title,
      tag: item.tag || '',
      body: item.body || '',
      icon: item.icon || '',
      silent: item.silent === true,
      requireInteraction: item.requireInteraction === true,
      data: item.data
    };
  }
  Object.defineProperty(RemoteNotify, 'permission', { get: function () { return 'granted'; } });
  RemoteNotify.requestPermission = function (cb) {
    var p = Promise.resolve('granted');
    if (typeof cb === 'function') p.then(cb);
    return p;
  };
  RemoteNotify.maxActions = (NativeNotification && typeof NativeNotification.maxActions === 'number') ? NativeNotification.maxActions : 0;
  try { window.Notification = RemoteNotify; } catch (e) {}
  if (window.Notification !== RemoteNotify) {
    try { Object.defineProperty(window, 'Notification', { value: RemoteNotify, configurable: true, writable: true }); } catch (e2) {}
  }
  try {
    var nav = window.navigator;
    if (nav.permissions && typeof nav.permissions.query === 'function') {
      var nativeQuery = nav.permissions.query.bind(nav.permissions);
      nav.permissions.query = function (desc) {
        try {
          if (desc && desc.name === 'notifications') {
            return Promise.resolve({ state: 'granted', onchange: null });
          }
        } catch (e) {}
        return nativeQuery(desc);
      };
    }
  } catch (e) {}
}())`

/** Install the notification relay shim into a shown guest. */
export function installNotifyShim(webview: RemoteWebview): Promise<void> {
  return webview.executeJavaScript(NOTIFY_SHIM_SOURCE, false).then(() => undefined)
}

/** Read and clear the guest's queued notifications; an unavailable guest yields nothing. */
export async function drainRemoteNotifications(webview: RemoteWebview): Promise<RemoteNotifyPayload[]> {
  try {
    const value = await webview.executeJavaScript(
      'window.__dshNotifyRelay ? window.__dshNotifyRelay.drain() : []',
      false,
    )
    if (!Array.isArray(value)) return []
    return value.filter((item): item is RemoteNotifyPayload => isNotifyPayload(item))
  } catch {
    // A destroyed or re-navigating guest simply stops relaying.
    return []
  }
}

/** Replay one relayed notification through the application document's own Notification. */
export function playRemoteNotification(payload: RemoteNotifyPayload): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  try {
    const options: NotificationOptions = {}
    if (payload.body !== undefined) options.body = payload.body
    if (payload.icon !== undefined) options.icon = payload.icon
    if (payload.tag !== undefined) options.tag = payload.tag
    if (payload.requireInteraction === true) options.requireInteraction = true
    if (payload.silent === true) options.silent = true
    const notice = new Notification(payload.title, options)
    notice.onclick = () => {
      window.focus()
      notice.close()
    }
  } catch {
    // A refused notification must not break the relay or the conversation.
  }
}

/** Queue a relay test notification inside the guest, for verifying the pipeline. */
export function testRemoteNotification(webview: RemoteWebview, title?: string): Promise<void> {
  const js = `window.__dshNotifyRelay && window.__dshNotifyRelay.test(${JSON.stringify(title ?? '')})`
  return webview.executeJavaScript(js, false).then(() => undefined).catch(() => undefined)
}

/** @returns whether the drained value is a payload this relay understands. */
function isNotifyPayload(value: unknown): value is RemoteNotifyPayload {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return item.kind === 'notify' && typeof item.title === 'string'
}