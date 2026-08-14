# plugins/

Local DeepSeek Harness plugin packages, in the same preset-style layout as
`presets/`: every first-level directory is a **plugin wrapper** that owns an
`install.mjs` plus the plugin package/repo in a second-level directory.

```
plugins/
├─ <id>/
│  ├─ install.mjs        # builds, installs, and mounts this one plugin
│  └─ <package>/         # the plugin package (in-tree, or a git submodule)
└─ ...
```

The harness installs plugins into a *profile* (for the web surface, the `web`
profile). `npm run install:plugins` (alias `npm run plugins`) runs every
`plugins/*/install.mjs` in directory-name order. Each script delegates the
shared pipeline to `scripts/plugin-install.mjs` and only owns its own id,
package directory, and submodule hint:

1. build the package in place when it declares a `build` script (pinned
   toolchain pnpm + repo-local store),
2. pin the profile's pnpm store,
3. `dsh plugin --profile web add link:<package dir>`,
4. append an idempotent insert to `.dsh/profiles/web/cordis.patch.yml`.

`DSH_HOME` is pinned to `./.dsh` by the desktop shell and by every install
script, so installed plugins land under `.dsh/` inside this repository —
nothing is written to `~/.dsh` or any global location.

Two package shapes are handled specially:

- **No `build` script** — the package is used as shipped (prebuilt `lib/` or
  config-only): the installer skips `pnpm install` + `pnpm run build` for it.
- **`dsh.bundle.patch` declared** — the package carries its own
  `cordis.patch.yml` bundle layer. `dsh plugin add` reconciles it into the
  profile's `dsh.profile.bundles`, and that layer inserts its entry — the
  installer writes no `cordis.patch.yml` insert (a manual one would
  double-mount it).

Plugins without either get a derived mount entry (id from `dsh.gui.mountId`,
else the package name without a leading `dsh-`).

## Current plugins

- `remote` — in-tree plugin at `remote/dsh-remote`: multi-backend remote mode
  for the web GUI (connection tabs, new-connection page, SSH deploy). See
  `remote/dsh-remote/docs/`.
- `terminal` — git submodule (`ZgblKylin/dsh-terminal`) at
  `terminal/dsh-terminal`: VSCode-style integrated terminal panel. See
  `terminal/dsh-terminal/docs/`.
- `file-explorer` — git submodule (`joejojoking-cloud/dsh-file-explorer`) at
  `file-explorer/dsh-file-explorer`: right-side resizable file tree with
  search, syntax-highlighted preview, in-panel editing, and VS Code open. It
  ships prebuilt and mounts through its own `dsh.bundle.patch` layer. See
  `docs/plugins/dsh-file-explorer.md` in the repository root for integration
  notes, and its own `README.md` for the feature set.

## One-shot layout migration

This checkout migrated from the old flat layout (`plugins/<package>` directly)
to the wrapper layout. `remote` and `terminal` are already moved; the
`dsh-file-explorer` submodule move must run while dsh-gui is closed, because
the app holds files under that checkout open:

```powershell
# 1. close dsh-gui (it tears its harness children down on exit)
node scripts/migrate-plugin-layout.mjs   # or: npm run migrate:plugins
```

The script moves the submodule with `git mv`, then re-runs every plugin
install script so the web profile links all packages at their new paths. It is
idempotent and can be re-run safely.
