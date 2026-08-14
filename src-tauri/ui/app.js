// dsh-gui frameless shell: custom title bar, window controls, config menu, and
// the About dialog. Talks to the Rust side through __TAURI__.core.invoke.
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

async function setIframeSource() {
  const url = tauri ? await invoke("harness_url") : "http://127.0.0.1:3080";
  harnessFrame.src = url;
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

/* ── Window controls ───────────────────────────────────────── */
function wireControls() {
  if (!tauri) {
    document.body.classList.add("no-tauri");
    return;
  }
  btnMin.addEventListener("click", () => invoke("minimize_window").catch(() => {}));
  btnMax.addEventListener("click", () => invoke("toggle_maximize_window").then(syncMaximizeIcon).catch(() => {}));
  btnClose.addEventListener("click", () => invoke("close_window").catch(() => {}));

  // Drag the window via the empty part of the title bar; double-click toggles
  // maximize/restore like a native title bar.
  const dragBar = $("titlebar-drag");
  dragBar.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest("button,a")) return;
    invoke("start_window_drag").catch(() => {});
  });
  dragBar.addEventListener("dblclick", () => invoke("toggle_maximize_window").then(syncMaximizeIcon).catch(() => {}));

  // Keep the restore/maximize icon honest even after OS-level resize (snap,
  // drag-to-top), which bypasses our button handler.
  setInterval(syncMaximizeIcon, 800);
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
    if (!aboutOverlay.classList.contains("hidden")) closeAbout();
    else closeMenu();
  }
});

/* ── Boot ──────────────────────────────────────────────────── */
setIframeSource().catch(() => {});
syncMaximizeIcon();
wireControls();
