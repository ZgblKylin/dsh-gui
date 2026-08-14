# dsh-gui

A thin desktop shell for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
web UI. It is **not** a repackaged harness — it runs the harness in place from
the `deepseek-harness` git submodule, hosts the web server itself, and shows the
full harness UI in a single webview window. Nothing else is drawn: just the OS
title bar and border.

## What it does

On launch the entry exe:

1. Spawns `node deepseek-harness/apps/cli/lib/bin.js web --port <port>`, with
   `DSH_HOME` pinned to `./.dsh` inside this repository.
2. Waits until the harness answers `GET /` with `200` on `127.0.0.1:<port>`.
3. Opens one **frameless** webview window that renders a custom title bar and
   embeds the harness web UI in an iframe. On exit it tears the harness
   process tree down; the harness runs inside a kill-on-close Windows job
   object, so the kernel enforces that teardown even when dsh-gui itself is
   killed (Task Manager, closing the terminal it was launched from).

The `ui/` page is a thin shell only: a drag-anywhere title bar with
**connection tabs** (VSCode-style, one per connected DSH backend), a **＋**
new-connection button, and on their inner side a hamburger (☰) menu — the
standard minimize / maximize / close controls come after it, and the hamburger
menu carries the tab list plus **新建连接** / **关闭当前连接** and the existing
**关于** / **退出** entries. The new-connection dialog supports a local backend
(probe the port, or start the built-in harness on it) and a remote backend
(VSCode Remote SSH style: load the frontend, or SSH-deploy it to another host,
reaching it over an SSH local port forward). The connection chrome lives in the
native title bar — the embedded harness page renders none of it. The About
dialog shows the version (exact git tag, else the commit short hash), license,
and GitHub link for dsh-gui, the deepseek-harness submodule, the whale-girl
app-icon submodule, and every plugin package under `plugins/`. The harness UI
itself goes on talking to its self-hosted server over plain HTTP exactly like a
browser.

## Requirements

- Windows 10/11 with the **WebView2 Evergreen runtime** (ships with most modern
  Windows / Edge installs).
- **Node.js** `^22.19 || >=24` and **npm** on `PATH` (used by the build tooling
  and by the shell to launch `bin.js`).
- **Rust** toolchain (`rustc`/`cargo`) for the entry exe.

Everything fetched at build time (npm packages, the pnpm store, cargo crates)
lands inside this repository or the standard local caches — no global install of
the harness is ever performed.

The tooling is a single cross-platform Node CLI (`scripts/dsh-gui.mjs`) exposed
through npm scripts, so the same commands work on Windows, macOS, and Linux
(WSL).

## Layout

```
dsh-gui/
├─ deepseek-harness/   # git submodule: the harness checkout (built in place)
├─ package.json        # npm scripts: setup / build / install:plugins / start / ...
├─ dsh-gui.exe         # the Tauri shell entry binary (Windows; `dsh-gui` on
│                      #   Linux/macOS — build scripts copy it here)
├─ src-tauri/          # the Tauri shell (Rust); cargo output at target/<profile>/
│  ├─ ui/              # the frameless shell page: title bar (connection tabs,
│  │                   #   + button, hamburger menu, window controls), the
│  │                   #   new-connection dialog, and the About dialog
│  └─ whale-icon/      # git submodule: the DeepSeek Harness whale-girl icon pack
│                      #   (DeepSeekHarness-WhaleGirl.ico is the app icon)
├─ scripts/
│  └─ dsh-gui.mjs      # the cross-platform CLI behind every npm script
├─ plugins/            # local harness plugin packages: `remote` (in-tree) plus
│                      #   the `dsh-terminal` and `dsh-file-explorer` git
│                      #   submodules (see plugins/README.md)
└─ .dsh/               # (runtime, gitignored) harness home: profiles/plugins/sessions
```

## Build (one shot)

```powershell
npm run setup
```

This is idempotent and fully repo-internal:

- Bootstraps **pnpm 11.7.0** into `.toolchain/` (the exact version the harness
  pins), so a system pnpm is not required.
- Runs `pnpm install --store-dir .pnpm-store --frozen-lockfile` inside
  `deepseek-harness/`, so the package cache lives at `.pnpm-store/` in this
  repository — not in a global store. Both `.toolchain/` and `.pnpm-store/` are
  gitignored.
- Builds the harness (`pnpm run build`: host lib + web `dist/`).
- Compiles the entry exe with `cargo build --release` (**release by default**)
  and copies it to the repository root (`dsh-gui.exe` on Windows, `dsh-gui`
  elsewhere).
- Builds, installs, and mounts every plugin package under `plugins/` into the
  web profile (see [Adding plugins](#adding-plugins-at-runtime)).

The result is the entry binary at the repository root (cargo keeps its own
output at `src-tauri\target\release\` or `target\debug\`).

Flags (pass after `--`): `--debug` for a `cargo build` debug build,
`--skip-harness` to skip the harness install+build, `--skip-exe` to skip cargo
entirely (harness/plugins only — useful on Linux without Tauri system deps).
Example: `npm run build -- --debug`.

> Packaging/installer generation is intentionally disabled (`bundle.active:
> false` in `src-tauri/tauri.conf.json`). The app always runs from this checkout,
> which is what lets you `git pull` the submodule or add plugins and pick them up
> on the next launch.

## Run

```powershell
npm start
# or double-click the entry binary at the repository root
```

`npm start` launches the entry exe detached: the terminal returns immediately
and closing it never kills dsh-gui (or its harness child).

Override the port with `$env:DSH_GUI_PORT` (default `3080`). Harness output is
logged to `.dsh\gui\harness.log`; dsh-gui's own status lines go to
`.dsh\gui\gui.log`, and startup failures also pop a message box (a GUI app has
no console to print to).

## System shortcut (Windows)

```powershell
npm run shortcut                          # desktop shortcut
npm run shortcut -- "D:\x.lnk"            # arbitrary location
```

## App icon

The app icon comes from the `src-tauri/whale-icon` submodule
([fornarwhal/deepseek-whale-girl-icon](https://github.com/fornarwhal/deepseek-whale-girl-icon),
CC BY-NC-SA 4.0): `DeepSeekHarness-WhaleGirl.ico` (16–256 px, transparent).
`src-tauri/tauri.conf.json` points `bundle.icon` at it, so it is embedded as the
Windows exe resource and used as the window/taskbar icon. The shell UI itself
keeps no icon copy — swap the submodule to change the icon, then rebuild:

```powershell
git submodule update --remote src-tauri/whale-icon
npm run build
```

## Updating the harness submodule

```powershell
git submodule update --remote deepseek-harness
npm run build             # reinstall + rebuild harness, then rebuild exe + plugins
```

## Adding plugins at runtime

Plugins are installed into the `web` profile under the repo-local `DSH_HOME`
(`.dsh/`). Drop a package (a directory with its own `package.json`) into
`plugins/` — after the next `npm run build` (or `npm run setup`) it is
automatically:

1. built (`pnpm install` + `pnpm run build` with the pinned toolchain pnpm) —
   a package without a `build` script is used as shipped (prebuilt `lib/`),
2. installed into the web profile as a `link:` dependency, and
3. mounted into the web composition: the CLI appends an `insert` entry to
   `.dsh\profiles\web\cordis.patch.yml` (the harness only loads entries from
   the composition — a dependency alone stays inert). The entry id comes from
   the plugin's `dsh.gui.mountId` declaration in its `package.json`, defaulting
   to the package name without a leading `dsh-`.

A plugin that declares `dsh.bundle.patch` (its own `cordis.patch.yml` bundle
layer, e.g. `dsh-file-explorer`) mounts itself: `dsh plugin add` reconciles it
into the profile's `dsh.profile.bundles` list and its patch inserts the entry
as a bundle layer — no `cordis.patch.yml` insert is written for it.

Standalone, the same step is:

```powershell
npm run install:plugins
```

Restart `dsh-gui` (or the harness) afterwards — plugin-set changes take effect
on boot. Any other `dsh plugin` / `--patch` workflow also works — nothing
escapes this repository.

## Linux / WSL

The tooling is pure Node and runs on Linux (e.g. inside WSL): `npm run setup`,
`npm run build`, and `npm run install:plugins` behave identically there. The
harness, the plugins, and the `dsh web` server are all cross-platform. Building
the Tauri shell on Linux additionally needs the Tauri system libraries
(`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, ...)
and a display to run; without them, use `npm run build -- --skip-exe` to build
and install just the harness + plugins.

## Troubleshooting

- **"harness is not built"** — run `npm run setup`.
- **`ERR_PNPM_UNEXPECTED_STORE` when installing plugins** — the profile's
  pnpm store was not pinned (an install ran from a context whose home
  variables resolve a different default store than the one used before). Run
  `npm run install:plugins` once — it writes `storeDir` into
  `.dsh\profiles\web\pnpm-workspace.yaml` and re-syncs every plugin.
- **"failed to spawn harness (is `node` on PATH?)"** — install Node 22+.
- **Blank window / connection refused** — read `.dsh\gui\harness.log`; the
  harness failed to start (e.g. port already in use — set `DSH_GUI_PORT`).
- **Nothing happens on launch** — a message box reports startup errors;
  `.dsh\gui\gui.log` keeps the history, and a panic writes
  `dsh-gui-crash.log` next to the exe.
- **A leftover `node` process after an old version crashed** — current builds
  kill the harness via a Windows job object; kill strays once with
  `taskkill /IM node.exe /F` (check nothing else needs them first).
- **WebView2 error** — install the WebView2 Evergreen runtime.

## License

This project (the dsh-gui shell) is released into the public domain under
[The Unlicense](LICENSE). The `deepseek-harness` submodule retains its own
license.
