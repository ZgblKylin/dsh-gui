// dsh-gui view bridge.
//
// The Rust shell injects this script at document-start into every
// connection-tab child webview (src-tauri/src/views.rs). Those webviews load
// the harness page as the top-level document — not as an iframe — so:
//
//   * the page-theme sampler reports colors over Tauri IPC instead of
//     window.postMessage (there is no parent frame to talk to);
//   * the dsh-ai-update plugin's reply ("dsh-gui:ai-update-result" posted to
//     window.parent) lands on this very window (at top level window.parent ===
//     window) and is forwarded over IPC so the shell update dialog can
//     resolve its promise.
//
// Runs in the main frame only. (On Windows wry injects main-frame scripts
// into subframes as well, hence the explicit top-frame guard.)
//
// Deliberately generic: it reads computed global styles, not any specific
// skin/plugin class or CSS variable.
(() => {
  "use strict";

  if (window !== window.top) return;

  const internals = window.__TAURI_INTERNALS__;
  if (!internals) return; // plain-browser preview: nothing to bridge

  const invoke = (cmd, args) => {
    try {
      internals.invoke(cmd, args);
    } catch {
      /* ignore */
    }
  };

  /* ── WebView2 notification-permission consent ─────────────────── */
  // The Rust side (src-tauri/src/views.rs) registers a permission handler on
  // this webview. For the notifications permission it defers the WebView2
  // request, then evals this function to render an inline consent dialog. The
  // user's choice is sent back over IPC (view_answer_permission), which lets
  // WebView2 resolve the deferred request (allow / deny).
  window.__dshPermissionPrompt = (payload) => {
    try {
      if (!payload || !document.body) return;
      if (document.getElementById("dsh-permission-overlay")) return;
      const root = document.createElement("div");
      root.id = "dsh-permission-overlay";
      root.style.cssText =
        "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;" +
        "justify-content:center;background:rgba(0,0,0,.45);" +
        "font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;";
      const box = document.createElement("div");
      box.style.cssText =
        "background:#1f1f1f;color:#eee;border-radius:12px;padding:20px 22px;max-width:360px;" +
        "box-shadow:0 10px 40px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.08);";
      box.innerHTML =
        "<div style='font-size:15px;font-weight:600;margin-bottom:8px;'>🔔 通知权限</div>" +
        "<p style='margin:0 0 16px;font-size:13px;line-height:1.55;color:#bbb;'>是否允许此页面显示系统通知？" +
        "<br>（对话完成 / 生成失败 / 权限申请等会弹通知）</p>";
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:10px;justify-content:flex-end;";
      const deny = document.createElement("button");
      deny.textContent = "拒绝";
      deny.style.cssText =
        "padding:7px 14px;border:1px solid rgba(255,255,255,.18);border-radius:8px;" +
        "background:transparent;color:#ccc;cursor:pointer;font-size:13px;";
      const allow = document.createElement("button");
      allow.textContent = "允许";
      allow.style.cssText =
        "padding:7px 18px;border:none;border-radius:8px;background:#2f6fed;color:#fff;" +
        "cursor:pointer;font-size:13px;";
      const answer = (ok) => {
        try {
          invoke("view_answer_permission", { requestId: payload.requestId, allow: ok });
        } catch {
          /* ignore */
        }
        root.remove();
      };
      deny.onclick = () => answer(false);
      allow.onclick = () => answer(true);
      row.append(deny, allow);
      box.append(row);
      root.append(box);
      document.body.appendChild(root);
    } catch {
      /* ignore */
    }
  };

  /* ── AI-update result forwarding ─────────────────────────── */
  // The dsh-ai-update browser plugin answers to `window.parent`, which for a
  // top-level webview is this window itself; the message event's source is
  // this window, and the shell gets notified through the Rust side.
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.type !== "dsh-gui:ai-update-result") return;
    if (event.source !== window) return;
    invoke("ai_update_result", {
      requestId: typeof data.requestId === "string" ? data.requestId : "",
      ok: data.ok === true,
      error: typeof data.error === "string" ? data.error : null,
    });
  });

  /* ── Page theme sampling ─────────────────────────────────── */
  // Convert any computed CSS color into plain rgba components by painting a
  // 1x1 canvas pixel. This also handles `transparent`/`color(srgb ...)`
  // computed values without hand-parsing CSS color syntax.
  function readPixel(color) {
    if (!color || color === "transparent") return null;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const data = ctx.getImageData(0, 0, 1, 1).data;
      return { r: data[0], g: data[1], b: data[2], a: data[3] / 255 };
    } catch {
      return null;
    }
  }

  // Standard source-over compositing for stacking semi-transparent global
  // background layers (e.g. body over html).
  function composite(top, bottom) {
    if (!top) return bottom;
    if (!bottom) return top;
    if (top.a >= 1) return { r: top.r, g: top.g, b: top.b, a: 1 };
    const outA = top.a + bottom.a * (1 - top.a);
    if (outA <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    const topW = top.a;
    const bottomW = bottom.a * (1 - top.a);
    return {
      r: Math.round((top.r * topW + bottom.r * bottomW) / outA),
      g: Math.round((top.g * topW + bottom.g * bottomW) / outA),
      b: Math.round((top.b * topW + bottom.b * bottomW) / outA),
      a: outA,
    };
  }

  function readGlobalColors() {
    const root = document.documentElement;
    const body = document.body;
    if (!root || !body) return null;

    const rootStyle = getComputedStyle(root);
    const bodyStyle = getComputedStyle(body);

    // Background: root -> body -> common app mount, composited front-to-back.
    let background = readPixel(rootStyle.backgroundColor);
    const bodyBackground = readPixel(bodyStyle.backgroundColor);
    if (bodyBackground) background = composite(bodyBackground, background);

    try {
      const app = document.querySelector("#root, #app, main, [data-app-root]");
      if (app && app !== body) {
        const appBackground = readPixel(getComputedStyle(app).backgroundColor);
        if (appBackground) background = composite(appBackground, background);
      }
    } catch {
      /* selector is invalid only in exotic documents; ignore */
    }

    if (!background || background.a === 0) {
      background = { r: 255, g: 255, b: 255, a: 1 };
    }
    if (background.a < 1) {
      // Flatten a remaining translucent background over white so the shell
      // always receives an opaque, visually-equivalent base color.
      background = composite(background, { r: 255, g: 255, b: 255, a: 1 });
    }

    // Text: the document-global color (body first, html as fallback).
    let text = readPixel(bodyStyle.color) || readPixel(rootStyle.color);
    if (!text || text.a === 0) text = { r: 0, g: 0, b: 0, a: 1 };

    return { background, text };
  }

  let lastSignature = "";
  let debounceTimer = 0;
  let pollTimer = 0;

  function emit() {
    let colors;
    try {
      colors = readGlobalColors();
    } catch {
      return;
    }
    if (!colors) return;

    const signature = JSON.stringify(colors);
    if (signature === lastSignature) return;
    lastSignature = signature;

    invoke("page_theme", { background: colors.background, text: colors.text });
  }

  function debouncedEmit() {
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(emit, 60);
  }

  // CSS/theme application is rarely synchronous with document parsing, so the
  // bridge resamples at increasing delays and then keeps a low-rate fallback
  // poll. Messages are deduplicated, so the poll is nearly free when idle.
  function scheduleDelayedSamples() {
    [0, 80, 250, 700, 1500, 3000].forEach((delay) => {
      window.setTimeout(emit, delay);
    });
  }

  // Follow global style/theme changes without depending on any particular
  // theme attribute name: attribute changes on html/body and stylesheet/link
  // additions in head all trigger a (debounced) resample. At document-start
  // `head`/`body` may not exist yet, so installation is retried once parsing
  // has progressed; the interval fallback covers any remaining case.
  function installObservers() {
    try {
      const observer = new MutationObserver(debouncedEmit);
      observer.observe(document.documentElement, { attributes: true });
      if (document.head) observer.observe(document.head, { childList: true, subtree: true });
      if (document.body) observer.observe(document.body, { attributes: true });
    } catch {
      /* observation is best-effort; the interval fallback remains */
    }
  }

  installObservers();
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      installObservers();
      debouncedEmit();
    },
    { once: true }
  );
  window.addEventListener("load", debouncedEmit, { once: true });
  scheduleDelayedSamples();

  pollTimer = window.setInterval(emit, 1200);

  try {
    const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
    if (darkQuery && typeof darkQuery.addEventListener === "function") {
      darkQuery.addEventListener("change", debouncedEmit);
    }
  } catch {
    /* ignore */
  }

  // Keep the interval from holding a closing page alive longer than needed.
  window.addEventListener(
    "pagehide",
    () => {
      window.clearTimeout(debounceTimer);
      window.clearInterval(pollTimer);
    },
    { once: true }
  );
})();
