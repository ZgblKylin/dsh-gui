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
3. Opens one webview window at `http://127.0.0.1:<port>` (title bar + border
   only). On exit it tears the harness process tree down; the harness runs
   inside a kill-on-close Windows job object, so the kernel enforces that
   teardown even when dsh-gui itself is killed (Task Manager, closing the
   terminal it was launched from).

There is no frontend, plugin, or IPC layer of its own: the webview talks to the
harness over plain HTTP exactly like a browser.

## Requirements

- Windows 10/11 with the **WebView2 Evergreen runtime** (ships with most modern
  Windows / Edge installs).
- **Node.js** `^22.19 || >=24` and **npm** on `PATH` (used only by the build and
  by the shell to launch `bin.js`).
- **Rust** toolchain (`rustc`/`cargo`) for the entry exe.

Everything fetched at build time (npm packages, the pnpm store, cargo crates)
lands inside this repository or the standard local caches — no global install of
the harness is ever performed.

## Layout

```
dsh-gui/
├─ deepseek-harness/   # git submodule: the harness checkout (built in place)
├─ dsh-gui.exe         # the Tauri shell entry exe (build scripts copy it here)
├─ src-tauri/          # the Tauri shell (Rust); cargo output at target/debug/
│  └─ ui/              # placeholder page (never shown — webview loads the harness URL)
├─ scripts/
│  ├─ setup.ps1        # one-shot: bootstrap pnpm → install → build harness → build exe
│  ├─ build.ps1        # rebuild harness and/or exe after edits
│  ├─ make-shortcut.ps1# create a desktop shortcut to the entry exe
│  └─ run.ps1          # run the built entry exe (returns immediately)
├─ plugins/            # drop your local harness plugin packages here
└─ .dsh/               # (runtime, gitignored) harness home: profiles/plugins/sessions
```

## Build (one shot)

```powershell
.\scripts\setup.ps1
```

This is idempotent and fully repo-internal:

- Bootstraps **pnpm 11.7.0** into `.toolchain/` (the exact version the harness
  pins), so a system pnpm is not required.
- Runs `pnpm install --store-dir .pnpm-store --frozen-lockfile` inside
  `deepseek-harness/`, so the package cache lives at `.pnpm-store/` in this
  repository — not in a global store. Both `.toolchain/` and `.pnpm-store/` are
  gitignored.
- Builds the harness (`pnpm run build`: host lib + web `dist/`).
- Compiles the entry exe with `cargo build` and copies it to the repository
  root.

The result is `dsh-gui.exe` at the repository root (cargo keeps its own
output at `src-tauri\target\debug\`).

> Packaging/installer generation is intentionally disabled (`bundle.active:
> false` in `src-tauri/tauri.conf.json`). The app always runs from this checkout,
> which is what lets you `git pull` the submodule or add plugins and pick them up
> on the next launch.

## Run

```powershell
.\scripts\run.ps1
# or double-click:
dsh-gui.exe
```

dsh-gui is a plain Win32 GUI app: the launching terminal returns immediately
(`run.ps1` uses `Start-Process`, and even a direct `.\dsh-gui.exe` from cmd or
PowerShell does not block). Closing the terminal afterwards does not kill it.

Override the port with `$env:DSH_GUI_PORT` (default `3080`). Harness output is
logged to `.dsh\gui\harness.log`; dsh-gui's own status lines go to
`.dsh\gui\gui.log`, and startup failures also pop a message box (a GUI app has
no console to print to).

## System shortcut

```powershell
.\scripts\make-shortcut.ps1                        # desktop shortcut
.\scripts\make-shortcut.ps1 -OutputPath "D:\x.lnk" # arbitrary location
```

## Updating the harness submodule

```powershell
git submodule update --remote deepseek-harness
.\scripts\build.ps1          # reinstall + rebuild harness, then rebuild exe
```

## Adding plugins at runtime

Plugins are installed into the `web` profile under the repo-local `DSH_HOME`
(`.dsh/`). Put a package in `plugins/`, then from the repository root:

```powershell
dsh plugin --profile web add link:./plugins/my-plugin
```

or manage the running profile with any `dsh plugin` / `--patch` workflow you
normally use — nothing escapes this repository.

## Troubleshooting

- **"harness is not built"** — run `.\scripts\setup.ps1`.
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
