# plugins/

Drop your local DeepSeek Harness plugin packages here.

The harness installs plugins into a *profile* (for the web surface, the `web`
profile). During a run you can add a plugin by pointing `dsh plugin` at a
package that lives in this directory:

```powershell
# from the repository root
dsh plugin --profile web add link:./plugins/my-plugin
```

`DSH_HOME` is pinned to `./.dsh` by the desktop shell (and by the `npm run
setup` / `npm run install:plugins` tooling), so installed plugins and agent
presets land under `.dsh/` inside this repository — nothing is written to
`~/.dsh` or any global location.

`npm run install:plugins` builds, installs, and mounts every plugin directory
here. Two package shapes are handled specially:

- **No `build` script** — the package is used as shipped (prebuilt `lib/` or
  config-only): the installer skips `pnpm install` + `pnpm run build` for it.
- **`dsh.bundle.patch` declared** — the package carries its own
  `cordis.patch.yml` bundle layer. `dsh plugin add` reconciles it into the
  profile's `dsh.profile.bundles`, and that layer inserts its entry — the
  installer writes no `cordis.patch.yml` insert (a manual one would
  double-mount it).

Plugins without either get a derived mount entry appended to
`.dsh/profiles/web/cordis.patch.yml` (id from `dsh.gui.mountId`, else the
package name without a leading `dsh-`).

## Current plugins

- `remote` — in-tree plugin: multi-backend remote mode for the web GUI
  (connection tabs, new-connection page, SSH deploy). See `remote/docs/`.
- `terminal` — git submodule (`ZgblKylin/dsh-terminal`): VSCode-style
  integrated terminal panel. See `terminal/docs/`.
- `dsh-file-explorer` — git submodule
  (`joejojoking-cloud/dsh-file-explorer`): right-side resizable file tree with
  search, syntax-highlighted preview, in-panel editing, and VS Code open. It
  ships prebuilt and mounts through its own `dsh.bundle.patch` layer. See
  `docs/plugins/dsh-file-explorer.md` in the repository root for integration
  notes, and its own `README.md` for the feature set.
