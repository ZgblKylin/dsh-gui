// dsh-gui frameless shell: custom title bar, window controls, config menu,
// connection tabs (VSCode-style), the new-connection dialog, and the About
// dialog. Talks to the Rust side through __TAURI__.core.invoke; the remote
// machinery lives in the dsh-remote plugin host and is reached through the
// `remote_call` Rust command (a loopback HTTP proxy to /remote-api).
"use strict";

const $ = (id) => document.getElementById(id);

// In a plain browser preview there is no injected Tauri API; degrade gracefully.
const tauri = window.__TAURI__;
const invoke = (cmd, args) =>
  tauri
    ? tauri.core.invoke(cmd, args)
    : Promise.reject(new Error("__TAURI__ is unavailable (running outside the app?)"));

const harnessFrame = $("harness-frame");
const btnMin = $("btn-min");
const btnMax = $("btn-max");
const btnClose = $("btn-close");
const btnWindowIcon = $("btn-window-icon");
const btnConfig = $("btn-config");
const configWrap = $("config-wrap");
const configMenu = $("config-menu");
const menuAbout = $("menu-about");
const menuExit = $("menu-exit");
const menuUpdate = $("menu-update");
const updateBadge = $("update-badge");
const updateOverlay = $("update-overlay");
const updateBody = $("update-body");
const updateMarkAll = $("update-mark-all");
const updateAiAll = $("update-ai-all");
const updateApply = $("update-apply");
const updateClose = $("update-close");
const updateNote = $("update-note");
const updateProgress = $("update-progress");
const aboutOverlay = $("about-overlay");
const aboutList = $("about-list");
const aboutClose = $("about-close");

/* ── Tab state ─────────────────────────────────────────────── */
const LS_TABS = "dsh.remote.tabs.v1";
const LS_ACTIVE = "dsh.remote.active.v1";

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw !== null ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
function uid() {
  return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function normUrl(u) {
  return String(u || "").replace(/\/+$/, "");
}

/* ── Page-driven title bar theme ───────────────────────────────
   The Rust shell injects ui/theme-bridge.js into every child frame; the
   active harness page reports its own global text/background colors here.
   This shell only stores/validates those colors and derives a title-bar-only
   palette from them. It does not know anything about skin plugins. */
const PAGE_THEME_MESSAGE = "dsh-gui:page-theme";
const PAGE_THEME_VERSION = 1;
const DEFAULT_PAGE_THEME = Object.freeze({
  background: Object.freeze({ r: 22, g: 27, b: 34, a: 1 }), // #161b22
  text: Object.freeze({ r: 230, g: 237, b: 243, a: 1 }), // #e6edf3
});

function isThemeColor(color) {
  return (
    color !== null &&
    typeof color === "object" &&
    [color.r, color.g, color.b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255) &&
    typeof color.a === "number" &&
    color.a >= 0 &&
    color.a <= 1
  );
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function cssRgba(color) {
  if (color.a >= 1) return `rgb(${color.r}, ${color.g}, ${color.b})`;
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${Math.round(color.a * 1000) / 1000})`;
}

// Source-over composite of a possibly translucent text color over the page
// background, so the title bar text stays legible on the title bar itself.
function compositeOver(foreground, background) {
  const outA = foreground.a + background.a * (1 - foreground.a);
  if (outA <= 0) return { r: background.r, g: background.g, b: background.b, a: 0 };
  const fw = foreground.a;
  const bw = background.a * (1 - foreground.a);
  return {
    r: Math.round((foreground.r * fw + background.r * bw) / outA),
    g: Math.round((foreground.g * fw + background.g * bw) / outA),
    b: Math.round((foreground.b * fw + background.b * bw) / outA),
    a: clamp01(outA),
  };
}

function blendRgba(base, tint, amount) {
  const t = clamp01(amount);
  return {
    r: Math.round(base.r + (tint.r - base.r) * t),
    g: Math.round(base.g + (tint.g - base.g) * t),
    b: Math.round(base.b + (tint.b - base.b) * t),
    a: clamp01(base.a + (tint.a - base.a) * t),
  };
}

function deriveTitlebarPalette(colors) {
  const background = isThemeColor(colors?.background)
    ? colors.background
    : DEFAULT_PAGE_THEME.background;
  const rawText = isThemeColor(colors?.text) ? colors.text : DEFAULT_PAGE_THEME.text;
  const text = compositeOver(rawText, background);
  return {
    background: cssRgba(background),
    text: cssRgba(text),
    muted: cssRgba(blendRgba(background, text, 0.62)),
    border: cssRgba(blendRgba(background, text, 0.16)),
    hover: cssRgba(blendRgba(background, text, 0.09)),
    softHover: cssRgba(blendRgba(background, text, 0.14)),
    tabBg: cssRgba(blendRgba(background, text, 0.055)),
    tabActiveBorder: cssRgba(blendRgba(background, text, 0.24)),
  };
}

function applyPageTheme(colors) {
  const palette = deriveTitlebarPalette(colors);
  const style = document.documentElement.style;
  style.setProperty("--titlebar-theme-bg", palette.background);
  style.setProperty("--titlebar-theme-text", palette.text);
  style.setProperty("--titlebar-theme-muted", palette.muted);
  style.setProperty("--titlebar-theme-border", palette.border);
  style.setProperty("--titlebar-theme-hover", palette.hover);
  style.setProperty("--titlebar-theme-soft-hover", palette.softHover);
  style.setProperty("--titlebar-theme-tab-bg", palette.tabBg);
  style.setProperty("--titlebar-theme-tab-active-border", palette.tabActiveBorder);
}

function wirePageTheme() {
  window.addEventListener("message", (event) => {
    const tab = activeTab();
    if (!tab || !harnessFrame.contentWindow) return;
    if (event.source !== harnessFrame.contentWindow) return;

    const data = event.data;
    if (
      !data ||
      data.type !== PAGE_THEME_MESSAGE ||
      data.version !== PAGE_THEME_VERSION ||
      !isThemeColor(data.colors?.background) ||
      !isThemeColor(data.colors?.text)
    ) {
      return;
    }

    // Ignore delayed messages from a previous iframe URL (the injected script
    // reports location.href; the shell also cross-checks event.origin).
    if (data.url && normUrl(data.url) !== normUrl(tab.url)) return;
    try {
      if (event.origin !== "null" && event.origin !== new URL(tab.url).origin) return;
    } catch {
      return;
    }

    const idx = tabs.findIndex((t) => t.id === tab.id);
    if (idx >= 0) {
      tabs[idx].theme = data.colors;
      persist();
    }
    applyPageTheme(data.colors);
  });
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function bufferToB64(buf) {
  const u = new Uint8Array(buf);
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < u.length; i += CH) {
    s += String.fromCharCode.apply(null, Array.from(u.subarray(i, i + CH)));
  }
  return btoa(s);
}

let tabs = loadJSON(LS_TABS, []);
let activeId = loadJSON(LS_ACTIVE, null);
let harnessUrl = "http://127.0.0.1:3080";
let defaultPort = 3080;

function persist() {
  saveJSON(LS_TABS, tabs);
  saveJSON(LS_ACTIVE, activeId);
}
function activeTab() {
  if (!Array.isArray(tabs)) return null;
  return tabs.find((t) => t.id === activeId) || tabs[0] || null;
}

/* ── Icons / sync of the embedded frontend ─────────────────── */
async function setIframeSource() {
  harnessUrl = (tauri ? await invoke("harness_url") : "http://127.0.0.1:3080").replace(/\/+$/, "");
  try {
    defaultPort = Number(new URL(harnessUrl).port) || 3080;
  } catch {
    defaultPort = 3080;
  }
}

function syncIframe() {
  const tab = activeTab();
  const placeholder = $("no-tabs");
  if (!tab) {
    placeholder.classList.remove("hidden");
    harnessFrame.classList.add("hidden");
    if (harnessFrame.src !== "") harnessFrame.src = "";
    applyPageTheme(DEFAULT_PAGE_THEME);
    return;
  }
  placeholder.classList.add("hidden");
  harnessFrame.classList.remove("hidden");
  // Restore the last theme reported by this tab while the page reloads;
  // ui/theme-bridge.js will send the fresh computed colors shortly after load.
  applyPageTheme(tab.theme ?? DEFAULT_PAGE_THEME);
  if (normUrl(harnessFrame.src) !== normUrl(tab.url)) harnessFrame.src = tab.url;
}

function switchTab(id) {
  activeId = id;
  persist();
  renderTabs();
  syncIframe();
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const next = tabs.filter((t) => t.id !== id);
  if (next.length === 0) {
    // Every tab closed: auto-open a fresh new-connection flow.
    tabs = [];
    activeId = null;
    persist();
    renderTabs();
    syncIframe();
    openConnection();
    return;
  }
  tabs = next;
  if (activeId === id) activeId = tabs[Math.min(idx, tabs.length - 1)].id;
  persist();
  renderTabs();
  syncIframe();
}

/* ── Render: tab strip + hamburger tab list ────────────────── */
function renderTabs() {
  const strip = $("remote-tabs");
  strip.innerHTML = "";
  for (const t of tabs) {
    const el = document.createElement("div");
    el.className = "remote-tab" + (t.id === activeId ? " active" : "");
    el.dataset.tabId = t.id;
    el.title = t.title || t.url || "";

    const label = document.createElement("span");
    label.className = "remote-tab-label";
    label.textContent = t.title || "连接";

    const x = document.createElement("button");
    x.type = "button";
    x.className = "remote-tab-x";
    x.textContent = "×";
    x.title = "关闭";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(t.id);
    });

    el.addEventListener("click", (e) => {
      if (e.target !== x) switchTab(t.id);
    });
    el.append(label, x);
    strip.appendChild(el);
  }

  const list = $("menu-tabs-list");
  list.innerHTML = "";
  for (const t of tabs) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "menu-item" + (t.id === activeId ? " active" : "");
    item.textContent = t.title || "连接";
    item.addEventListener("click", () => {
      switchTab(t.id);
      closeMenu();
    });
    list.appendChild(item);
  }
  $("menu-tabs-section").classList.toggle("hidden", tabs.length === 0);
  $("menu-closeconn").disabled = tabs.length === 0;
}

function addTab(title, url, meta) {
  const tab = { id: uid(), title, url, ...meta };
  tabs.push(tab);
  activeId = tab.id;
  persist();
  $("conn-overlay").classList.add("hidden");
  renderTabs();
  syncIframe();
}

/* ── RPC to the dsh-remote plugin host (via the Rust proxy) ── */
async function rpc(op, args) {
  const raw = await invoke("remote_call", { op, body: JSON.stringify(args ?? {}) });
  return JSON.parse(raw || "{}");
}

/* ── New-connection dialog ─────────────────────────────────── */
let connType = "local";
let serverKeyPath = null;

function setConnType(type) {
  connType = type;
  for (const card of document.querySelectorAll(".conn-type-card")) {
    card.classList.toggle("sel", card.dataset.type === type);
  }
  const remote = type === "remote";
  $("conn-addr-wrap").classList.toggle("hidden", !remote);
  $("conn-ssh-toggle").classList.toggle("hidden", !remote);
  const sshOn = remote && $("conn-ssh-on").checked;
  $("conn-ssh-auth").classList.toggle("hidden", !sshOn);
  $("conn-ssh-port-wrap").classList.toggle("hidden", !sshOn);
  $("conn-creds").classList.toggle("hidden", !sshOn);
  $("conn-save-wrap").classList.toggle("hidden", !sshOn);
}

function resetConnForm() {
  $("conn-name").value = "";
  $("conn-port").value = String(defaultPort);
  $("conn-addr").value = "";
  $("conn-ssh-on").checked = false;
  $("conn-ssh-host").value = "";
  $("conn-ssh-user").value = "";
  $("conn-ssh-port").value = "";
  $("conn-password").value = "";
  $("conn-keyfile").value = "";
  $("conn-key-path").textContent = "";
  $("conn-save-auth").checked = true;
  $("conn-log").innerHTML = "";
  serverKeyPath = null;
  setConnType("local");
}

function openConnection() {
  resetConnForm();
  $("conn-overlay").classList.remove("hidden");
  $("conn-name").focus();
}

function connLog(step, ok, detail) {
  const el = document.createElement("div");
  el.className = ok === undefined ? "info" : ok ? "ok" : "err";
  el.textContent =
    (ok === undefined ? "· " : ok ? "✓ " : "✗ ") + step + (detail !== undefined ? " — " + detail : "");
  const log = $("conn-log");
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function onPickKey(file) {
  serverKeyPath = null;
  $("conn-key-path").textContent = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      connLog("上传密钥", undefined, file.name);
      const w = await rpc("keyfile.write", {
        name: $("conn-name").value.trim() || "key",
        b64: bufferToB64(reader.result),
      });
      if (w.ok === true) {
        serverKeyPath = w.path;
        $("conn-key-path").textContent = w.path;
        connLog("密钥已保存", true, w.path);
      } else {
        connLog("密钥保存失败", false, w.error ?? "");
      }
    } catch (e) {
      connLog("密钥读取失败", false, String(e && e.message ? e.message : e));
    }
  };
  reader.readAsArrayBuffer(file);
}

async function doConnect() {
  const btn = $("conn-connect");
  btn.disabled = true;
  btn.textContent = "连接中…";
  $("conn-log").innerHTML = "";
  try {
    if (connType === "local") await connectLocal();
    else await connectRemote();
  } catch (e) {
    connLog("连接失败", false, String(e && e.message ? e.message : e));
  } finally {
    btn.disabled = false;
    btn.textContent = "连接";
  }
}

async function connectLocal() {
  const name = $("conn-name").value.trim();
  const p = Number($("conn-port").value);
  if (name === "") {
    connLog("校验", false, "请填写连接名");
    return;
  }
  if (!Number.isInteger(p) || p <= 0 || p > 65535) {
    connLog("校验", false, "端口无效");
    return;
  }
  const url = `http://127.0.0.1:${p}/`;
  connLog("检查端口 " + p, undefined, url);
  const probe = await rpc("probe", { url });
  if (probe.reachable === true && probe.loadable === true) {
    connLog("端口可加载", true, `HTTP ${probe.status}`);
    addTab(name, url, { type: "local", port: p });
    return;
  }
  connLog(
    "端口不可加载，启动内置 dsh",
    undefined,
    probe.error ?? (probe.reachable ? `HTTP ${probe.status} 非 2xx` : "不可达")
  );
  const started = await rpc("local.start", { port: p });
  if (started.ok !== true) {
    connLog("启动失败", false, started.error ?? "");
    return;
  }
  connLog("等待后端就绪", undefined, `pid ${started.pid ?? "?"}`);
  const deadline = Date.now() + 60000;
  let okProbe = null;
  while (Date.now() < deadline) {
    await sleep(1000);
    okProbe = await rpc("probe", { url });
    if (okProbe.reachable === true && okProbe.loadable === true) break;
  }
  if (okProbe !== null && okProbe.reachable === true && okProbe.loadable === true) {
    connLog("后端就绪", true, `HTTP ${okProbe.status}`);
    addTab(name, url, { type: "local", port: p });
  } else {
    connLog("超时", false, "后端未在 60s 内启动");
  }
}

async function connectRemote() {
  const name = $("conn-name").value.trim();
  const p = Number($("conn-port").value);
  const addr = $("conn-addr").value.trim().replace(/^https?:\/\//i, "");
  if (name === "") {
    connLog("校验", false, "请填写连接名");
    return;
  }
  if (addr === "") {
    connLog("校验", false, "请填写地址");
    return;
  }
  if (!Number.isInteger(p) || p <= 0 || p > 65535) {
    connLog("校验", false, "端口无效");
    return;
  }
  const url = `http://${addr}:${p}/`;
  connLog("检查 " + url, undefined);
  const probe = await rpc("probe", { url });
  if (probe.reachable === true && probe.loadable === true) {
    connLog("远端可加载", true, `HTTP ${probe.status}`);
    addTab(name, url, { type: "remote", address: addr, port: p });
    return;
  }
  connLog(
    "远端不可加载，尝试 ssh 部署",
    undefined,
    probe.error ?? (probe.reachable ? `HTTP ${probe.status} 非 2xx` : "不可达")
  );
  if (!$("conn-ssh-on").checked) {
    connLog("需要 ssh", false, "请开启 SSH 部署并配置认证");
    return;
  }

  const sshConn = {
    address: addr,
    port: p,
    sshUser: $("conn-ssh-user").value.trim() || undefined,
    sshHost: $("conn-ssh-host").value.trim() || undefined,
    sshPort: Number($("conn-ssh-port").value) || undefined,
    password: $("conn-password").value || undefined,
    keyFile: serverKeyPath,
  };
  if (!sshConn.password && !sshConn.keyFile) {
    connLog("使用已保存认证", undefined, "读取凭据…");
    const saved = await rpc("creds.read", { name });
    if (saved.exists === true && saved.payload) {
      const pl = saved.payload;
      sshConn.sshUser = sshConn.sshUser || pl.sshUser;
      sshConn.sshHost = sshConn.sshHost || pl.sshHost;
      sshConn.sshPort = sshConn.sshPort || pl.sshPort;
      sshConn.password = pl.password;
      sshConn.keyFile = pl.keyFile;
      connLog("使用已保存认证", true, name);
    } else {
      connLog("无已保存认证", true, "将尝试 ~/.ssh/config");
    }
  }
  if (!sshConn.sshUser && !sshConn.password && !sshConn.keyFile && !sshConn.sshHost) {
    connLog("缺少认证", false, "请填写 SSH 用户名（或 SSH 主机别名）与密码/密钥");
    return;
  }
  connLog("建立 SSH 会话", undefined, sshConn.sshHost || addr);
  const res = await rpc("ssh.connect", { conn: sshConn });
  for (const s of res.log ?? []) {
    connLog(String(s.step ?? "步骤"), s.ok, s.detail);
  }
  if (res.ok === true) {
    if (
      $("conn-save-auth").checked &&
      ($("conn-password").value !== "" || serverKeyPath !== null || $("conn-ssh-host").value.trim() !== "")
    ) {
      await rpc("creds.save", {
        name,
        payload: {
          sshUser: sshConn.sshUser,
          sshHost: sshConn.sshHost,
          password: $("conn-password").value || undefined,
          keyFile: serverKeyPath || undefined,
          sshPort: sshConn.sshPort,
        },
      });
    }
    addTab(name, res.url ?? url, { type: "remote", address: addr, port: p });
  } else if (res.authRequired === true) {
    connLog(
      "回退到连接配置",
      false,
      "该主机需要认证（SSH 别名无法免密）——请填写 SSH 用户名、密码或密钥文件（二选一），或勾选保存认证"
    );
  }
}

/* ── Window controls ───────────────────────────────────────── */
function wireControls() {
  if (!tauri) {
    document.body.classList.add("no-tauri");
    return;
  }
  btnMin.addEventListener("click", () => invoke("minimize_window").catch(() => {}));
  // On Windows 11 the snap-layout plugin covers this button with a native
  // HTMAXBUTTON overlay, so the OS handles click + Snap Layouts flyout there.
  // This click handler remains the fallback for Windows 10 and non-Windows.
  btnMax.addEventListener("click", () => invoke("toggle_maximize_window").then(syncMaximizeIcon).catch(() => {}));
  btnClose.addEventListener("click", () => invoke("close_window").catch(() => {}));

  // Native top-left window icon: left click and right click both open the
  // window-control menu (还原/移动/大小/最小化/最大化/关闭).
  btnWindowIcon.addEventListener("click", () => invoke("show_window_menu").catch(() => {}));
  btnWindowIcon.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    invoke("show_window_menu").catch(() => {});
  });

  // Drag the window from the empty title-bar area; double-click toggles
  // maximize/restore like a native title bar. Tabs/buttons/menu are exempt.
  //
  // start_window_drag() is deliberately not called on mousedown: Win32 enters
  // a modal move loop from the synthetic WM_NCLBUTTONDOWN, which can swallow
  // the second click of a double-click. Start the move after a short hold or
  // as soon as the pointer travels a few pixels instead.
  const titlebar = $("titlebar");
  const interactive = (target) =>
    !!target.closest("button,a,.remote-tab,.config-menu,.titlebar-controls");
  const DRAG_THRESHOLD_PX = 3;
  let drag = null;

  function beginDrag() {
    if (!drag || drag.started) return;
    drag.started = true;
    if (drag.timer) {
      clearTimeout(drag.timer);
      drag.timer = 0;
    }
    invoke("start_window_drag").catch(() => {});
  }

  titlebar.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || interactive(e.target)) return;
    drag = {
      x: e.clientX,
      y: e.clientY,
      started: false,
      timer: setTimeout(beginDrag, 160),
    };
  });

  window.addEventListener("mousemove", (e) => {
    if (!drag || drag.started) return;
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) >= DRAG_THRESHOLD_PX) {
      beginDrag();
    }
  });

  window.addEventListener("mouseup", () => {
    if (drag?.timer) clearTimeout(drag.timer);
    drag = null;
  });

  titlebar.addEventListener("dblclick", (e) => {
    if (interactive(e.target)) return;
    invoke("toggle_maximize_window").then(syncMaximizeIcon).catch(() => {});
  });

  setInterval(syncMaximizeIcon, 800);
}

async function syncMaximizeIcon() {
  if (!tauri) return;
  let maximized = false;
  try {
    maximized = await invoke("is_window_maximized");
  } catch (_) {
    /* ignore: window already closed */
  }
  btnMax.classList.toggle("maximized", maximized);
  btnMax.title = maximized ? "还原" : "最大化";
  btnMax.setAttribute("aria-label", btnMax.title);
}

/* ── Update checking ───────────────────────────────────────── */
// Startup check fires shortly after boot; then a long-interval background
// poll keeps the badge and menu text in sync while the app stays open.
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
let updateStatus = null;
let updateChecking = false;
let updateSelection = new Set();

function applyUpdateIndicator(status) {
  const has = !!(status && status.hasUpdates);
  updateBadge.classList.toggle("hidden", !has);
  menuUpdate.textContent = has ? "更新软件" : "检查更新";
  menuUpdate.classList.toggle("update-available", has);
}

function resetUpdateSelection() {
  updateSelection.clear();
  updateApply.disabled = true;
  updateApply.textContent = "重启并更新";
}

/* ── In-dialog top-level update (仓库本体：git 层 + 实时进度) ─── */
// The top-level dsh-gui row has no AI update: its 「更新」 button runs the
// live in-dialog update — root fast-forward plus recursive submodule sync
// (streamed as update-root-log events) — and then reminds the user to run
// `npm run build` for the full rebuild.
const ROOT_PROJECT_ID = "dsh-gui";
const UPDATE_ROOT_LOG_EVENT = "update-root-log";
let rootUpdateBusy = false;

function appendUpdateProgress(text) {
  updateProgress.classList.remove("hidden");
  const line = document.createElement("div");
  line.textContent = text;
  updateProgress.appendChild(line);
  updateProgress.scrollTop = updateProgress.scrollHeight;
}

function clearUpdateProgress() {
  updateProgress.textContent = "";
  updateProgress.classList.add("hidden");
}

function setRootUpdateControls(disabled) {
  updateMarkAll.disabled = disabled;
  updateAiAll.disabled = disabled;
  updateApply.disabled = disabled;
  updateClose.disabled = disabled;
  for (const select of updateBody.querySelectorAll(".update-mode")) select.disabled = disabled;
  for (const button of updateBody.querySelectorAll(".update-run, .update-ai")) {
    button.disabled = disabled || button.classList.contains("pending");
  }
}

async function runRootUpdate(project) {
  if (rootUpdateBusy) return;
  rootUpdateBusy = true;
  clearUpdateProgress();
  appendUpdateProgress("开始更新顶层工程 dsh-gui（git 层：顶层快进 + 子模块递归同步）…");
  appendUpdateProgress("提示：本更新仅完成 git 层；更新完成后需要重新执行 npm run build 做全量构建，再重启 dsh-gui 生效。");
  setRootUpdateControls(true);
  let unlisten = null;
  if (tauri && tauri.event) {
    try {
      unlisten = await tauri.event.listen(UPDATE_ROOT_LOG_EVENT, (event) => {
        if (typeof event.payload === "string" && event.payload) appendUpdateProgress(event.payload);
      });
    } catch (_) {
      unlisten = null;
    }
  }
  try {
    await invoke("update_root", { mode: updateModeOf(project.id) });
    appendUpdateProgress("");
    appendUpdateProgress("✅ 顶层工程与子模块更新完成（git 层）。");
    appendUpdateProgress(
      "请重新执行 npm run build 做全量构建（node scripts/dsh-gui.mjs build：harness 安装与构建 → 入口 exe → 插件安装 → agent preset 安装），构建完成后重启 dsh-gui 生效。"
    );
    // Refetch the rows behind this update so the stale "behind" state resets.
    void checkForUpdates(false);
  } catch (error) {
    appendUpdateProgress("❌ 更新失败：" + String((error && error.message) || error));
    appendUpdateProgress("可关闭弹窗重试；git 层未完成时也可改用子模块的「重启并更新」流程。");
  } finally {
    if (unlisten) {
      try {
        unlisten();
      } catch (_) {
        /* ignore */
      }
    }
    setRootUpdateControls(false);
    rootUpdateBusy = false;
  }
}

function updateError(message) {
  updateBody.innerHTML = "";
  const error = document.createElement("div");
  error.className = "update-loading update-error";
  error.textContent = message;
  updateBody.appendChild(error);
  updateMarkAll.classList.add("hidden");
  updateAiAll.classList.add("hidden");
  updateApply.classList.add("hidden");
}

function updateRow(project) {
  const row = document.createElement("div");
  row.className = "update-item";

  const info = document.createElement("div");
  info.className = "update-item-info";
  const name = document.createElement("div");
  name.className = "update-item-name";
  name.textContent = project.name || project.id || "工程";
  const versions = document.createElement("div");
  versions.className = "update-item-versions";
  const latest = document.createElement("code");
  latest.className = project.checking ? "update-checking" : "";
  latest.textContent = project.checking ? project.latest || "检查中…" : project.latest || "—";
  versions.append(
    "当前 ",
    Object.assign(document.createElement("code"), { textContent: project.current || "unknown" }),
    " → ",
    "最新 ",
    latest
  );
  info.append(name, versions);
  if (project.error) {
    const error = document.createElement("div");
    error.className = "update-item-error";
    error.textContent = project.error;
    info.appendChild(error);
  }

  const action = document.createElement("div");
  action.className = "update-item-action";
  if (project.checking) {
    const checking = document.createElement("span");
    checking.className = "update-item-checking";
    checking.textContent = "检测中…";
    action.appendChild(checking);
  } else if (project.error) {
    const unavailable = document.createElement("span");
    unavailable.className = "update-item-unavailable";
    unavailable.textContent = "不可检查";
    action.appendChild(unavailable);
  } else if (project.behind) {
    const isRoot = project.id === ROOT_PROJECT_ID;
    const mode = document.createElement("select");
    mode.className = "update-mode";
    mode.dataset.updateId = project.id;
    mode.title = "更新目标";
    const staleTag = project.latestTagStale === true;
    const tagOption = new Option(
      !project.latestTag
        ? "最新tag（无）"
        : staleTag
          ? `最新tag（${project.latestTag} 早于当前）`
          : `最新tag（${project.latestTag}）`,
      "tag"
    );
    if (!project.latestTag || staleTag) tagOption.disabled = true;
    // 新 tag 排在最上面并作为默认目标；tag 早于当前提交时不可用，自动回落到最新提交。
    mode.append(tagOption, new Option("最新提交", "commit"));
    mode.value = project.latestTag && !staleTag ? "tag" : "commit";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary update-run";
    button.dataset.updateId = project.id;
    button.textContent = "更新";
    if (isRoot) {
      button.title =
        "在弹窗内直接更新顶层工程（快进到更新目标并把子模块递归同步到顶层修订记录的提交）；完成后按提示手动执行 npm run build 做全量构建";
      action.append(mode, button);
    } else {
      const ai = document.createElement("button");
      ai.type = "button";
      ai.className = "primary update-ai";
      ai.dataset.updateId = project.id;
      ai.textContent = "AI 更新";
      ai.title = "回到项目首页选中 dsh-gui 目录并预填提示词，预设由你自选";
      action.append(mode, button, ai);
    }
  } else {
    const ok = document.createElement("span");
    ok.className = "update-item-ok";
    ok.textContent = "已是最新";
    action.appendChild(ok);
  }

  row.append(info, action);
  return row;
}

function markProjectUpdate(id) {
  if (!id || updateSelection.has(id)) return;
  updateSelection.add(id);
  for (const button of updateBody.querySelectorAll(".update-run")) {
    if (button.dataset.updateId === id) {
      button.disabled = true;
      button.textContent = "待重启";
      button.classList.add("pending");
    }
  }
  updateApply.disabled = false;
  updateApply.textContent = `重启并更新（${updateSelection.size}）`;
}

function renderUpdateDialog(status) {
  updateBody.innerHTML = "";
  resetUpdateSelection();
  const projects = Array.isArray(status && status.projects) ? status.projects : [];
  const behind = projects.filter((project) => project && project.behind && !project.error);
  const checking = projects.filter((project) => project && project.checking).length;
  const summary = document.createElement("div");
  summary.className = "update-summary";
  summary.textContent =
    checking > 0
      ? `${projects.length} 个工程，正在检测更新…`
      : behind.length > 0
        ? `${behind.length} 个工程有可用更新。每行默认以最新 tag 为更新目标（tag 早于当前提交时该项不可用，自动改以最新提交为目标）。顶层 dsh-gui 行：点「更新」直接在弹窗内执行 git 层更新（顶层快进 + 子模块递归同步），完成后需按提示重新执行 npm run build 做全量构建；子模块行：可点「AI 更新」（回项目首页选中 dsh-gui 目录并预填提示词，agent 预设由你自选），或点「更新」确认后再点「重启并更新」——dsh-gui 会退出，更新在弹出窗口中完成并自动重启。`
        : "所有工程均为最新版本。";
  updateBody.appendChild(summary);
  for (const project of projects) updateBody.appendChild(updateRow(project));
  // The bottom batch actions cover submodule rows only: the top-level row has
  // its own live in-dialog update and never enters these flows.
  const submoduleBehind = behind.filter((project) => project.id !== ROOT_PROJECT_ID).length;
  updateMarkAll.classList.toggle("hidden", submoduleBehind === 0);
  updateAiAll.classList.toggle("hidden", submoduleBehind === 0);
  updateApply.classList.toggle("hidden", submoduleBehind === 0);
}

function openUpdateDialog() {
  updateOverlay.classList.remove("hidden");
  updateNote.classList.add("hidden");
  updateNote.textContent = "";
  clearUpdateProgress();
  updateBody.innerHTML = "";
  resetUpdateSelection();
  const loading = document.createElement("div");
  loading.className = "update-loading";
  loading.textContent = "正在检查更新…";
  updateBody.appendChild(loading);
  updateMarkAll.classList.add("hidden");
  updateAiAll.classList.add("hidden");
  updateApply.classList.add("hidden");
}

function closeUpdateDialog() {
  updateOverlay.classList.add("hidden");
}

function hasCachedUpdateStatus() {
  return (
    updateStatus &&
    Array.isArray(updateStatus.projects) &&
    updateStatus.projects.length > 0
  );
}

// Menu entry: when the badge is on (a background check found updates), the
// dialog reuses that result and must not fetch again. When nothing is cached,
// show the local preview first; when a stale no-update cache exists, show it
// immediately but still refresh it in the background.
async function openUpdateDialogWithBestState() {
  openUpdateDialog();
  const hadCache = hasCachedUpdateStatus();
  if (hadCache) {
    renderUpdateDialog(updateStatus);
    if (updateStatus.hasUpdates) return;
  } else if (await previewUpdateProjects()) {
    // A background check finished while the local preview was loading: show
    // the fresh result and do not start another fetch.
    renderUpdateDialog(updateStatus);
    return;
  }
  void checkForUpdates(false);
}

// Cold-start preview: list every project and its local current version
// immediately, with 检查中… placeholders on the latest-version column while
// the slow check runs in the background. Returns true when a background check
// completed and cached a result while the preview was loading.
async function previewUpdateProjects() {
  if (!tauri) {
    updateError("当前不在 dsh-gui 应用中，无法检查更新。");
    return false;
  }
  try {
    const projects = await invoke("local_update_projects");
    if (hasCachedUpdateStatus()) {
      renderUpdateDialog(updateStatus);
      return true;
    }
    if (Array.isArray(projects) && projects.length > 0) {
      renderUpdateDialog({
        projects,
        hasUpdates: false,
        updateCount: 0,
        allChecked: false,
      });
    }
  } catch (_) {
    // Keep the generic loading row; checkForUpdates will still render.
    if (hasCachedUpdateStatus()) {
      renderUpdateDialog(updateStatus);
      return true;
    }
  }
  return false;
}

async function checkForUpdates(showDialog) {
  if (showDialog) openUpdateDialog();
  if (updateChecking) return updateStatus;
  if (!tauri) {
    if (showDialog) updateError("当前不在 dsh-gui 应用中，无法检查更新。");
    return null;
  }
  updateChecking = true;
  try {
    const status = await invoke("check_updates");
    updateStatus = status;
    // A partially failed check must not clear an existing badge; a successful
    // one (or one that found updates) is authoritative.
    if (status && (status.hasUpdates || status.allChecked)) {
      applyUpdateIndicator(status);
    }
    if (showDialog || !updateOverlay.classList.contains("hidden")) {
      renderUpdateDialog(status);
    }
    return status;
  } catch (error) {
    const message = String((error && error.message) || error);
    if (showDialog || !updateOverlay.classList.contains("hidden")) {
      updateError(`检查更新失败：${message}`);
    }
    toast(`检查更新失败：${message}`);
    return null;
  } finally {
    updateChecking = false;
  }
}

async function startUpdates(ids) {
  const usable = (ids ?? []).filter((id) => id);
  if (usable.length === 0) return;
  const modes = {};
  for (const id of usable) modes[id] = updateModeOf(id);
  const label = usable.length === 1 ? "所选工程" : `${usable.length} 个工程`;
  updateNote.textContent =
    `已确认更新${label}。dsh-gui 即将退出，更新过程会显示在控制台窗口中（非 Windows 平台写入 .dsh/gui/update.log），完成后自动重启。`;
  updateNote.classList.remove("hidden");
  updateMarkAll.disabled = true;
  updateAiAll.disabled = true;
  updateApply.disabled = true;
  updateClose.disabled = true;
  for (const button of updateBody.querySelectorAll(".update-run")) button.disabled = true;
  for (const select of updateBody.querySelectorAll(".update-mode")) select.disabled = true;
  try {
    await invoke("start_update", { ids: usable, modes });
  } catch (error) {
    updateNote.textContent = `启动更新失败：${String((error && error.message) || error)}`;
    updateMarkAll.disabled = false;
    updateAiAll.disabled = false;
    updateApply.disabled = false;
    updateClose.disabled = false;
    for (const select of updateBody.querySelectorAll(".update-mode")) select.disabled = false;
    for (const button of updateBody.querySelectorAll(".update-run")) {
      if (updateSelection.has(button.dataset.updateId)) continue;
      button.disabled = false;
    }
  }
}

function updateModeOf(projectId) {
  const select = updateBody.querySelector('.update-mode[data-update-id="' + projectId + '"]');
  return select && select.value === "tag" ? "tag" : "commit";
}

/* ── AI update (项目首页选中 dsh-gui + 预填充提示词) ─────── */
// The shell only builds the message; the dsh-ai-update browser plugin inside
// the harness page returns the page to the new-session home, selects the
// dsh-gui workspace there, and prefills the composer draft (the agent preset
// choice stays with the user). It replies with a result message.
const AI_UPDATE_MESSAGE = "dsh-gui:ai-update";
const AI_UPDATE_RESULT = "dsh-gui:ai-update-result";
const AI_UPDATE_VERSION = 1;
const AI_UPDATE_TIMEOUT_MS = 10000;
let aiUpdateSeq = 0;

function updatableProjects(projects) {
  return (projects ?? []).filter((project) => project && project.behind && !project.error);
}

function aiModuleLabel(project) {
  const kind = project.id === "dsh-gui" ? "仓库本体" : "submodule " + project.id;
  const path = project.path ? "，路径：" + project.path : "";
  return project.name + "（" + kind + path + "）";
}

function aiUpdateTargetText(project) {
  const current = project.current || "unknown";
  if (updateModeOf(project.id) === "tag") {
    const tag = project.latestTag
      ? "最新 tag「" + project.latestTag + "」"
      : "最新 tag（用 git describe --tags --abbrev=0 origin/<默认分支> 确定）";
    return "更新目标：" + tag + "（当前 " + current + "）";
  }
  return "更新目标：最新提交（远端默认分支 HEAD；当前 " + current + "，最新 " + (project.latest || "?") + "）";
}

// Deepseek-harness is the engineering base every plugin is built on: it lives
// at the repo root (NOT under plugins/), has no plugins/<id>/install.mjs
// wrapper, and its update re-pins the official spec — so its prompt is built
// separately and is followed by a quick audit of every unmasked plugin
// install script against that new spec.
const HARNESS_PROJECT_ID = "deepseek-harness";

// Quick-audit step shared by the harness prompts (single and batch): every
// unmasked plugins/<id>/install.mjs must match the official spec the updated
// harness just pinned.
function buildHarnessAuditStep(number) {
  return (
    number +
    ". 速查：盘点 plugins/ 下所有未被 mask 的插件（跳过 install.mjs 顶部带 MASKED 守卫的条目，如 terminal、file-explorer），逐一检查其安装脚本（plugins/<id>/install.mjs）是否与最新的官方规范一致——对照仓库根 AGENTS.md（开发约定/插件开发规范/插件市场约束/bundle 加载注意事项）、docs/official/（deepseek-harness 官方文档：develop-basic/publish.md 的 bundle 打包教程、packages-bundle/ 官方 bundle 实例、cli-reference.md 的 dsh plugin 行为）与 dsh 插件安装教程（先加载 skill dsh-plugin-install，内容见 .dsh/skills/dsh-plugin-install/SKILL.md）。核对要点：安装方式与 plugins/README.md「安装方式」标注一致——「源码构建（pnpm install + pnpm run build）+ dsh plugin --profile web add link: 安装」或「dsh plugin --profile web add <npm 包>」；声明 dsh.bundle.patch 的包应通过自己的 bundle 层挂载，不手动插入 cordis.patch.yml（避免双重挂载）；Market 约束（精确稳定 SemVer、无 preinstall/install/postinstall/prepare lifecycle script、engines.node 接受 Node LTS、files 白名单只含必要构建产物，README 不暗示被收录/审核/推荐）；无异常步骤（越出仓库、绕过 scripts/plugin-install.mjs 共享流水线、修改依赖或配置文件之外的东西等）。发现不一致的插件先停下来向用户报告，不要擅自修改；"
  );
}

// Dedicated prompt for deepseek-harness: the engineering base, not a plugin —
// never reference the plugins/ layout or the plugin install pipeline for it.
function buildHarnessUpdatePrompt(project) {
  const lines = [];
  lines.push("请更新当前 dsh-gui 仓库中的「deepseek-harness」模块：");
  lines.push("");
  lines.push("- 模块：deepseek-harness（工程基座——DSH 框架本体，路径：deepseek-harness）；");
  lines.push("- " + aiUpdateTargetText(project));
  lines.push("");
  lines.push("说明：deepseek-harness 是本工程的基座，不是插件——plugins/ 下的所有插件都基于它工作；它位于仓库根目录的 deepseek-harness/（不在 plugins/ 下），没有 plugins/<id>/install.mjs 安装脚本，其文档在 deepseek-harness/docs/ 与仓库根 AGENTS.md（docs/official/ 是官方文档与源码的符号链接汇总），不要套用插件文档路径（plugins/<id>/<package>/README.md）。按仓库约定，deepseek-harness/ 是 pinned 上游子模块，只用于查证规范：不要编辑其中的任何文件，也不要从该目录向插件源码复制代码。");
  lines.push("");
  lines.push("步骤：");
  if (updateModeOf(project.id) === "tag") {
    lines.push("1. 先 fetch origin（git -C deepseek-harness fetch --prune origin），再用 git -C deepseek-harness describe --tags --abbrev=0 origin/<默认分支> 找到远端默认分支可达的最新 tag，然后 checkout/reset 到该 tag；");
  } else {
    lines.push("1. 将该模块快进到远端默认分支的最新提交（submodule 用 git submodule update --remote deepseek-harness，或在 deepseek-harness/ 目录里 fetch origin 后检出 origin/<默认分支>）；");
  }
  lines.push("2. 先检查 harness 本次更新对当前 dsh-gui 项目所使用功能的影响（新增、变更或移除的功能/配置/依赖，以及插件需要跟进适配的点——组合方式、插件 API、bundle 契约等），结合 AGENTS.md 与 docs/official/ 汇报；需要修改本仓库对应插件或安装脚本时，先征询用户确认；");
  lines.push("3. 确认影响后再重建 harness（必须）：运行仓库构建脚本 npm run build（node scripts/dsh-gui.mjs build——用 .toolchain/ 的 pinned pnpm 与仓库本地 .pnpm-store 执行 harness 的 pnpm install + pnpm run build（CI=true，跳过 lefthook）→ cargo 编译入口 exe → 执行各插件安装脚本 → 安装 agent preset）。dsh-gui 运行时入口 exe 被占用，可先加 --skip-exe（npm run build -- --skip-exe）；但 harness 构建与插件安装脚本必须执行，确保各插件基于新 harness 重新构建/安装；");
  lines.push(buildHarnessAuditStep("4"));
  lines.push("5. 完成后汇报：改动了哪些文件、执行了哪些安装/构建命令及结果，并给出速查结论（哪些插件安装脚本与官方规范一致、哪些需要调整）。");
  return lines;
}

function buildAiUpdatePrompt(projects) {
  const list = updatableProjects(projects);
  const lines = [];
  if (list.length === 1) {
    const project = list[0];
    if (project.id === HARNESS_PROJECT_ID) {
      lines.push(...buildHarnessUpdatePrompt(project));
    } else {
      lines.push("请更新当前 dsh-gui 仓库中的「" + project.name + "」模块：");
      lines.push("");
      lines.push("- 模块：" + aiModuleLabel(project));
      lines.push("- " + aiUpdateTargetText(project));
      lines.push("");
      lines.push("步骤：");
      if (updateModeOf(project.id) === "tag") {
        lines.push("1. 先 fetch origin（git -C <path> fetch --prune origin），再用 git -C <path> describe --tags --abbrev=0 origin/<默认分支> 找到远端默认分支可达的最新 tag，然后 checkout/reset 到该 tag；");
      } else {
        lines.push("1. 将该模块快进到远端默认分支的最新提交（submodule 用 git submodule update --remote <path>，或在模块目录里 fetch origin 后检出 origin/<默认分支>；仓库本体则 pull/reset 到 origin 默认分支）；");
      }
      lines.push("2. 运行安装脚本前先交叉检查其正确性：对照仓库根 AGENTS.md（开发约定/安装规范）、该模块文档（plugins/<id>/<package>/README.md 与 docs/）以及 dsh 插件安装教程（先加载 skill dsh-plugin-install，内容见 .dsh/skills/dsh-plugin-install/SKILL.md），确认 install.mjs 的安装方式与上述约定一致。各插件安装脚本通常都很简单——「源码构建（pnpm install + pnpm run build）+ dsh plugin --profile web add link: 安装」或「直接 npm 安装」——并无复杂操作；仅当发现异常步骤（越出仓库、绕过 scripts/plugin-install.mjs 共享流水线、修改依赖或配置文件之外的东西等）时，先停下来向用户报告，不要执行；");
      lines.push("3. 确认安装脚本无误后运行：插件模块运行其 plugins/<id>/install.mjs（或仓库根目录的 npm run install:plugins）；");
      lines.push("4. 若改动涉及 harness 或需要重建，按需执行仓库构建脚本；");
      lines.push("5. 完成后汇报改动了哪些文件、执行了哪些安装/构建命令及结果；");
      lines.push("6. 基于该模块的安装脚本（plugins/<id>/install.mjs，或仓库内相关 install.mjs / 构建配置）检查本次更新引入的功能，汇报该目标仓库本次更新对当前 dsh-gui 项目所使用功能的改变（新增、变更或移除的功能/配置/依赖，以及 dsh-gui 侧需要跟进适配的点）。");
    }
  } else {
    lines.push("请批量更新当前 dsh-gui 仓库中以下可更新的模块：");
    lines.push("");
    for (const project of list) {
      const path = project.path ? "路径 " + project.path + "，" : "";
      const target = updateModeOf(project.id) === "tag"
        ? "更新到最新 tag" + (project.latestTag ? "「" + project.latestTag + "」" : "")
        : "更新到最新提交（最新 " + (project.latest || "?") + "）";
      lines.push("- " + project.name + "（" + path + "当前 " + (project.current || "unknown") + "，" + target + "）");
    }
    lines.push("");
    const hasHarness = list.some((project) => project.id === HARNESS_PROJECT_ID);
    if (hasHarness) {
      lines.push("其中 deepseek-harness 是工程基座（DSH 框架本体，不在 plugins/ 下，其他插件都基于它），不是插件——按步骤 3 单独处理，不要套用插件流程（plugins/<id>/install.mjs、plugins/<id>/<package>/README.md）；");
      lines.push("");
    }
    lines.push("对每个模块按其标注的更新目标处理：");
    lines.push("1. 最新提交：快进到远端默认分支的最新提交（submodule 用 git submodule update --remote <path>；仓库本体用 git pull）；");
    lines.push("2. 最新 tag：先 fetch origin，再用 git -C <path> describe --tags --abbrev=0 origin/<默认分支> 找到最新 tag，然后 checkout/reset 到该 tag；");
    const steps = [];
    if (hasHarness) {
      steps.push("3. deepseek-harness（如在本批中）：更新后先检查本次更新对当前 dsh-gui 项目所使用功能的影响（新增、变更或移除的功能/配置/依赖，以及插件需要跟进适配的点——组合方式、插件 API、bundle 契约等），需要修改本仓库对应插件或安装脚本时先征询用户确认；再重建——运行仓库构建脚本 npm run build（node scripts/dsh-gui.mjs build：pinned pnpm（.toolchain/）+ 仓库本地 .pnpm-store 构建 harness（CI=true）→ cargo 编译入口 exe → 执行各插件安装脚本 → 安装 agent preset；dsh-gui 运行时 exe 被占用可加 --skip-exe，但 harness 构建与插件重装必须完成）。它没有 install.mjs 且不在 plugins/ 下，文档在 deepseek-harness/docs/ 与 AGENTS.md（docs/official/ 为官方文档汇总），也不要编辑 deepseek-harness/ 下任何文件；");
      steps.push("4. 对每个插件模块：更新后、运行安装脚本前先交叉检查其正确性：对照仓库根 AGENTS.md（开发约定/安装规范）、各模块文档（plugins/<id>/<package>/README.md 与 docs/）以及 dsh 插件安装教程（先加载 skill dsh-plugin-install，见 .dsh/skills/dsh-plugin-install/SKILL.md），确认 install.mjs 的安装方式与约定一致——各插件通常只是「源码构建（pnpm install + pnpm run build）+ dsh plugin --profile web add link: 安装」或「直接 npm 安装」，无复杂操作；某模块安装脚本有异常步骤（越出仓库、绕过 scripts/plugin-install.mjs 共享流水线、修改依赖或配置文件之外的东西等）时，先停下报告该模块，不要执行；");
      steps.push("5. 确认无误后运行对应安装脚本（plugins/<id>/install.mjs，或仓库根目录 npm run install:plugins）；");
      steps.push("6. 必要时重建；");
      steps.push("7. 全部完成后汇报每个模块的改动与安装结果；");
      steps.push(buildHarnessAuditStep("8"));
      steps.push("9. 基于各模块的安装脚本（plugins/<id>/install.mjs，或仓库内相关 install.mjs / 构建配置）检查本次更新引入的功能，并逐模块汇报该目标仓库本次更新对当前 dsh-gui 项目所使用功能的改变（新增、变更或移除的功能/配置/依赖，以及 dsh-gui 侧需要跟进适配的点）。");
    } else {
      steps.push("3. 更新后、运行安装脚本前先交叉检查其正确性：对照仓库根 AGENTS.md（开发约定/安装规范）、各模块文档（plugins/<id>/<package>/README.md 与 docs/）以及 dsh 插件安装教程（先加载 skill dsh-plugin-install，见 .dsh/skills/dsh-plugin-install/SKILL.md），确认 install.mjs 的安装方式与约定一致——各插件通常只是「源码构建（pnpm install + pnpm run build）+ dsh plugin --profile web add link: 安装」或「直接 npm 安装」，无复杂操作；某模块安装脚本有异常步骤（越出仓库、绕过 scripts/plugin-install.mjs 共享流水线、修改依赖或配置文件之外的东西等）时，先停下报告该模块，不要执行；");
      steps.push("4. 确认无误后运行对应安装脚本（plugins/<id>/install.mjs，或仓库根目录 npm run install:plugins）；");
      steps.push("5. 必要时重建；");
      steps.push("6. 全部完成后汇报每个模块的改动与安装结果；");
      steps.push("7. 基于各模块的安装脚本（plugins/<id>/install.mjs，或仓库内相关 install.mjs / 构建配置）检查本次更新引入的功能，并逐模块汇报该目标仓库本次更新对当前 dsh-gui 项目所使用功能的改变（新增、变更或移除的功能/配置/依赖，以及 dsh-gui 侧需要跟进适配的点）。");
    }
    for (const step of steps) lines.push(step);
  }
  lines.push("");
  lines.push("注意：以上路径均相对于 dsh-gui 仓库根目录；请确认会话工作区就是该仓库（包含 plugins/、presets/、deepseek-harness/ 等目录的目录）。");
  return lines.join("\n");
}

// Post one request to the embedded harness page and wait for the plugin's
// result message. Resolves true when the plugin confirmed the session, false
// when it reported an error or never answered.
function postAiUpdateRequest(prompt) {
  return new Promise((resolve) => {
    const tab = activeTab();
    const win = harnessFrame.contentWindow;
    if (!tab || !win) {
      toast("当前没有打开的连接，无法启动 AI 更新");
      resolve(false);
      return;
    }
    const requestId = "ai-update-" + (++aiUpdateSeq);
    let settled = false;
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener("message", onResult);
      if (ok) toast("已在项目首页选中 dsh-gui 目录并预填充提示词，请选择预设后发送");
      else toast("AI 更新启动失败：" + (error || "未知错误"));
      resolve(ok);
    };
    const onResult = (event) => {
      if (event.source !== win) return;
      const data = event.data;
      if (!data || data.type !== AI_UPDATE_RESULT || data.requestId !== requestId) return;
      finish(data.ok === true, data.ok === true ? "" : data.error);
    };
    const timer = setTimeout(() => finish(false, "内嵌前端无响应（确认 dsh-ai-update 插件已安装并重启）"), AI_UPDATE_TIMEOUT_MS);
    window.addEventListener("message", onResult);
    try {
      win.postMessage(
        {
          type: AI_UPDATE_MESSAGE,
          version: AI_UPDATE_VERSION,
          requestId,
          prompt,
        },
        tab.url
      );
    } catch (error) {
      finish(false, String((error && error.message) || error));
    }
  });
}

async function startAiUpdate(projects) {
  // The top-level project never goes through the AI update flow.
  const list = updatableProjects(projects).filter((project) => project.id !== ROOT_PROJECT_ID);
  if (list.length === 0) {
    toast("没有可用的更新工程");
    return;
  }
  updateNote.textContent = "正在启动 AI 更新会话…";
  updateNote.classList.remove("hidden");
  const ok = await postAiUpdateRequest(buildAiUpdatePrompt(list));
  if (ok) {
    updateNote.textContent = "";
    updateNote.classList.add("hidden");
    closeUpdateDialog();
  } else {
    updateNote.textContent = "AI 更新会话未启动；可检查内嵌页面或重试。";
  }
}

/* ── Config menu ───────────────────────────────────────────── */
function openMenu() {
  configMenu.classList.remove("hidden");
}
function closeMenu() {
  configMenu.classList.add("hidden");
}

btnConfig.addEventListener("click", (e) => {
  e.stopPropagation();
  configMenu.classList.contains("hidden") ? openMenu() : closeMenu();
});

document.addEventListener("click", (e) => {
  if (!configWrap.contains(e.target)) closeMenu();
});
window.addEventListener("blur", closeMenu);

$("btn-newconn").addEventListener("click", (e) => {
  e.stopPropagation();
  openConnection();
});
$("menu-newconn").addEventListener("click", () => {
  closeMenu();
  openConnection();
});
$("menu-closeconn").addEventListener("click", () => {
  closeMenu();
  if (activeId) closeTab(activeId);
});
$("menu-update").addEventListener("click", () => {
  closeMenu();
  void openUpdateDialogWithBestState();
});
updateClose.addEventListener("click", closeUpdateDialog);
updateOverlay.addEventListener("click", (e) => {
  if (e.target === updateOverlay) closeUpdateDialog();
});
updateMarkAll.addEventListener("click", () => {
  const ids = (updateStatus?.projects ?? [])
    .filter((project) => project.behind && !project.error && project.id !== ROOT_PROJECT_ID)
    .map((project) => project.id);
  for (const id of ids) markProjectUpdate(id);
});
updateApply.addEventListener("click", () => {
  void startUpdates([...updateSelection]);
});
updateAiAll.addEventListener("click", () => {
  void startAiUpdate(updateStatus?.projects);
});
updateBody.addEventListener("click", (e) => {
  const ai = e.target.closest(".update-ai");
  if (ai && ai.dataset.updateId && !ai.disabled) {
    const project = (updateStatus?.projects ?? []).find((p) => p.id === ai.dataset.updateId);
    void startAiUpdate(project ? [project] : []);
    return;
  }
  const button = e.target.closest(".update-run");
  if (!button || !button.dataset.updateId || button.disabled) return;
  const project = (updateStatus?.projects ?? []).find((p) => p.id === button.dataset.updateId);
  if (project && project.id === ROOT_PROJECT_ID) {
    void runRootUpdate(project);
    return;
  }
  markProjectUpdate(button.dataset.updateId);
});

/* ── New-connection dialog wiring ──────────────────────────── */
for (const card of document.querySelectorAll(".conn-type-card")) {
  card.addEventListener("click", () => setConnType(card.dataset.type));
}
$("conn-ssh-on").addEventListener("change", () => setConnType(connType));
$("conn-cancel").addEventListener("click", () => $("conn-overlay").classList.add("hidden"));
$("conn-connect").addEventListener("click", () => void doConnect());
$("conn-keyfile").addEventListener("change", (e) => onPickKey(e.target.files?.[0] ?? null));
$("conn-overlay").addEventListener("click", (e) => {
  if (e.target === $("conn-overlay")) $("conn-overlay").classList.add("hidden");
});

/* ── About dialog ──────────────────────────────────────────── */
function aboutRow(label, item) {
  const row = document.createElement("div");
  row.className = "about-item";

  const head = document.createElement("div");
  head.className = "about-item-head";
  const name = document.createElement("span");
  name.className = "about-item-name";
  name.textContent = label;
  const version = document.createElement("span");
  version.className = "about-item-version";
  version.textContent = item.version || "unknown";
  head.append(name, version);

  row.appendChild(head);

  const licenseRow = document.createElement("div");
  licenseRow.className = "about-item-row";
  const ll = document.createElement("span");
  ll.className = "label";
  ll.textContent = "License";
  const lv = document.createElement("span");
  lv.textContent = item.license || "—";
  licenseRow.append(ll, lv);

  const repoRow = document.createElement("div");
  repoRow.className = "about-item-row";
  const rl = document.createElement("span");
  rl.className = "label";
  rl.textContent = "GitHub";
  if (item.repo) {
    const link = document.createElement("button");
    link.className = "about-item-repo";
    link.type = "button";
    link.title = "点击复制链接";
    link.textContent = item.repo;
    link.addEventListener("click", () => copyText(item.repo));
    repoRow.append(rl, link);
  } else {
    const rv = document.createElement("span");
    rv.className = "about-item-repo";
    rv.textContent = "—";
    repoRow.append(rl, rv);
  }

  row.append(licenseRow, repoRow);
  return row;
}

function copyText(text) {
  const done = () => toast("已复制到剪贴板");
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done, () => legacyCopy(text, done));
  } else {
    legacyCopy(text, done);
  }
}

function legacyCopy(text, done) {
  const input = document.createElement("input");
  input.value = text;
  document.body.appendChild(input);
  input.select();
  try {
    document.execCommand("copy");
    done();
  } catch (_) {
    /* clipboard unavailable */
  }
  document.body.removeChild(input);
}

let toastTimer;
function toast(message) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 1600);
}

let aboutRequestId = 0;

function closeAbout() {
  aboutOverlay.classList.add("hidden");
}

function renderAboutInfo(info) {
  aboutList.innerHTML = "";
  const sections = [
    { label: "deepseek-harness", item: info.harness },
    { label: "dsh-gui", item: info.shell },
    { label: "whale-girl-icon", item: info.icon },
  ];
  for (const plugin of info.plugins || []) {
    sections.push({ label: plugin.name, item: plugin });
  }
  for (const section of sections) {
    aboutList.appendChild(aboutRow(section.label, section.item));
  }
}

function renderAboutMessage(text, isError) {
  aboutList.innerHTML = "";
  const message = document.createElement("div");
  message.className = isError ? "about-loading about-error" : "about-loading";
  message.textContent = text;
  aboutList.appendChild(message);
}

function openAboutDialog() {
  aboutOverlay.classList.remove("hidden");
  renderAboutMessage("正在读取各模块信息…", false);
}

async function showAbout() {
  const requestId = ++aboutRequestId;
  openAboutDialog();
  try {
    const info = await invoke("about_info");
    if (requestId !== aboutRequestId || aboutOverlay.classList.contains("hidden")) return;
    renderAboutInfo(info);
  } catch (e) {
    if (requestId !== aboutRequestId) return;
    const message = `无法读取版本信息：${e}`;
    if (!aboutOverlay.classList.contains("hidden")) renderAboutMessage(message, true);
    toast(message);
  }
}

menuAbout.addEventListener("click", () => {
  closeMenu();
  void showAbout();
});
menuExit.addEventListener("click", () => invoke("close_window").catch(() => {}));
aboutClose.addEventListener("click", closeAbout);
aboutOverlay.addEventListener("click", (e) => {
  if (e.target === aboutOverlay) closeAbout();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("conn-overlay").classList.contains("hidden")) $("conn-overlay").classList.add("hidden");
    else if (!updateOverlay.classList.contains("hidden")) closeUpdateDialog();
    else if (!aboutOverlay.classList.contains("hidden")) closeAbout();
    else closeMenu();
  }
});

/* ── Boot ──────────────────────────────────────────────────── */
async function boot() {
  wirePageTheme();
  await setIframeSource().catch(() => {});
  // Sanitize persisted tabs; guarantee the local (本机) tab always exists.
  if (!Array.isArray(tabs)) tabs = [];
  tabs = tabs.filter((t) => t && typeof t === "object" && typeof t.url === "string");
  if (tabs.length === 0) {
    tabs = [{ id: "current", title: "本机", url: harnessUrl, type: "local", port: defaultPort }];
  }
  if (!activeId || !tabs.some((t) => t.id === activeId)) activeId = tabs[0].id;
  persist();
  renderTabs();
  syncIframe();
  syncMaximizeIcon();
  wireControls();
  // Update monitoring: one check shortly after startup, then a long-interval
  // background poll. Results drive the badge + menu text; the Rust side keeps
  // the detached update launcher in sync with what was found.
  setTimeout(() => void checkForUpdates(false), 3000);
  setInterval(() => void checkForUpdates(false), UPDATE_CHECK_INTERVAL_MS);
}

boot();
