// dsh-gui page-theme bridge.
//
// The Rust shell injects this script into every frame
// (`initialization_script_for_all_frames`). In child frames (the harness web
// UI is embedded as a cross-origin iframe) it samples the document's own
// global CSS — the computed `color` and `background-color` of html/body/#root
// (plus the common `#app`/`main` mounts as fallback) — and posts the resulting
// rgba values to the top frame. The shell title bar listens for these
// messages and derives its colors from them.
//
// This is deliberately generic: it reads computed global styles, not any
// specific skin/plugin class or CSS variable.
(() => {
  "use strict";

  // Only frames below the shell need to report. The shell itself owns the
  // title bar and is the message receiver.
  if (window === window.top) return;

  const TYPE = "dsh-gui:page-theme";
  const VERSION = 1;

  let lastSignature = "";
  let debounceTimer = 0;
  let pollTimer = 0;

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

  function signature(colors) {
    return JSON.stringify(colors);
  }

  function emit() {
    let colors;
    try {
      colors = readGlobalColors();
    } catch {
      return;
    }
    if (!colors) return;

    const nextSignature = signature(colors);
    if (nextSignature === lastSignature) return;
    lastSignature = nextSignature;

    try {
      window.top.postMessage(
        {
          type: TYPE,
          version: VERSION,
          url: window.location.href,
          colors,
        },
        "*"
      );
    } catch {
      /* top frame gone or unavailable */
    }
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
  document.addEventListener("DOMContentLoaded", () => {
    installObservers();
    debouncedEmit();
  }, { once: true });
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
