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
const btnConfig = $("btn-config");
const configWrap = $("config-wrap");
const configMenu = $("config-menu");
const menuAbout = $("menu-about");
const menuExit = $("menu-exit");
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
    return;
  }
  placeholder.classList.add("hidden");
  harnessFrame.classList.remove("hidden");
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
  btnMax.addEventListener("click", () => invoke("toggle_maximize_window").then(syncMaximizeIcon).catch(() => {}));
  btnClose.addEventListener("click", () => invoke("close_window").catch(() => {}));

  // Drag the window from the empty title-bar area; double-click toggles
  // maximize/restore like a native title bar. Tabs/buttons/menu are exempt.
  const titlebar = $("titlebar");
  titlebar.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest("button,a,.remote-tab,.config-menu,.titlebar-controls")) return;
    invoke("start_window_drag").catch(() => {});
  });
  titlebar.addEventListener("dblclick", (e) => {
    if (e.target.closest("button,a,.remote-tab,.config-menu,.titlebar-controls")) return;
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

function closeAbout() {
  aboutOverlay.classList.add("hidden");
}

async function showAbout() {
  let info;
  try {
    info = await invoke("about_info");
  } catch (e) {
    toast(`无法读取版本信息：${e}`);
    return;
  }
  aboutList.innerHTML = "";
  const sections = [
    { label: "deepseek-harness", item: info.harness },
    { label: "dsh-gui", item: info.shell },
  ];
  for (const plugin of info.plugins || []) {
    sections.push({ label: plugin.name, item: plugin });
  }
  for (const section of sections) {
    aboutList.appendChild(aboutRow(section.label, section.item));
  }
  aboutOverlay.classList.remove("hidden");
}

menuAbout.addEventListener("click", async () => {
  closeMenu();
  await showAbout();
});
menuExit.addEventListener("click", () => invoke("close_window").catch(() => {}));
aboutClose.addEventListener("click", closeAbout);
aboutOverlay.addEventListener("click", (e) => {
  if (e.target === aboutOverlay) closeAbout();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("conn-overlay").classList.contains("hidden")) $("conn-overlay").classList.add("hidden");
    else if (!aboutOverlay.classList.contains("hidden")) closeAbout();
    else closeMenu();
  }
});

/* ── Boot ──────────────────────────────────────────────────── */
async function boot() {
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
}

boot();
