# plugins/

Local DeepSeek Harness plugin packages, in the same preset-style layout as
`presets/`: every first-level directory is a **plugin wrapper** that owns an
`install.mjs` plus the plugin package/repo checkout (for multi-package
distribution repos such as `deep-whale`, the package path points one level
deeper). `dsh-web-ui` is the exception: it installs the `liangshen` agent
preset, the `dsh-pet` plugin, and the `dsh-web-ui-settings` compatibility
bundle — and nothing else from its distribution repo.

```
plugins/
├─ <id>/
│  ├─ install.mjs        # plugin: builds + installs + mounts; dsh-web-ui: preset + pet + settings bridge
│  └─ <package>/         # the plugin package (in-tree, or a git submodule)
└─ ...
```

The harness installs plugins into a *profile* (for the web surface, the `web`
profile). `npm run install:plugins` (alias `npm run plugins`) runs every
`plugins/*/install.mjs` in directory-name order. Plugin wrappers delegate the
shared pipeline to `scripts/plugin-install.mjs` and only own their id, package
directory, and submodule hint:

1. build the package in place when it declares a `build` script (pinned
   toolchain pnpm + repo-local store),
2. pin the profile's pnpm store,
3. `dsh plugin --profile web add link:<package dir>`,
4. append an idempotent insert to `.dsh/profiles/web/cordis.patch.yml` —
   the wrapper's explicit `mount` entry when given, else derived from the
   manifest.

`DSH_HOME` is pinned to `./.dsh` by the desktop shell and by every install
script, so installed plugins land under `.dsh/` inside this repository —
nothing is written to `~/.dsh` or any global location.

Two package shapes are handled specially:

- **No `build` script** — the package is used as shipped (prebuilt `lib/` or
  config-only): the installer skips `pnpm install` + `pnpm run build` for it.
- **Wrapper `build: false` opt-out** — a prebuilt distribution package that
  still declares a `build` script for upstream development is used as shipped;
  `deep-whale` uses this for its `maid-atelier` skin.
- **`dsh.bundle.patch` declared** — the package carries its own
  `cordis.patch.yml` bundle layer. `dsh plugin add` reconciles it into the
  profile's `dsh.profile.bundles`, and that layer inserts its entry — the
  installer writes no `cordis.patch.yml` insert (a manual one would
  double-mount it).

Plugins without any of these get a derived mount entry (id from
`dsh.gui.mountId`, else the package name without a leading `dsh-`). A wrapper may instead pass an
explicit `mount` entry — usually parsed from the wrapper's own
`cordis.patch.yml` mount recipe, as `review` does — and it overrides the
derived entry.

- **Preset + dsh-pet + settings bridge wrapper** — `dsh-web-ui` first copies
  `dsh-web-ui/packages/dsh-liangshen/presets/liangshen` into
  `.dsh/.agent-presets/liangshen` and applies a dsh-gui-side Windows patch
  (custom-bash for the phase-1 shell). It then builds `dsh-pet` and
  `dsh-web-ui-settings` with one filtered pnpm install and delegates both
  profile installs to the shared pipeline. Both packages declare
  `dsh.bundle.patch`, so each mounts through its own bundle layer (no manual
  cordis inserts), and the wrapper orders the settings bridge before
  `dsh-pet`. See `dsh-web-ui/README.md`.

## Current plugins

- `remote` — in-tree plugin at `remote/dsh-remote`: multi-backend remote mode
  for the web GUI (connection tabs, new-connection page, SSH deploy). See
  `remote/dsh-remote/docs/`.
- `terminal` — git submodule (`ZgblKylin/dsh-terminal`) at
  `terminal/dsh-terminal`: VSCode-style integrated terminal panel. See
  `terminal/dsh-terminal/docs/`.
  ⛔ **Temporarily masked** — superseded by `better-sidebar`'s terminal tabs:
  its `install.mjs` skips the install pipeline (guard `MASKED` at the top
  of the script) and its insert row was removed from
  `.dsh/profiles/web/cordis.patch.yml`.
- `file-explorer` — git submodule (`joejojoking-cloud/dsh-file-explorer`) at
  `file-explorer/dsh-file-explorer`: right-side resizable file tree with
  search, syntax-highlighted preview, in-panel editing, and VS Code open. It
  ships prebuilt and mounts through its own `dsh.bundle.patch` layer. See
  `docs/plugins/dsh-file-explorer.md` in the repository root for integration
  notes, and its own `README.md` for the feature set.
  ⛔ **Temporarily masked** — superseded by `better-sidebar`'s explorer/viewers:
  its `install.mjs` skips the install pipeline (guard `MASKED` at the top
  of the script) and its dependency + bundle entry were removed from
  `.dsh/profiles/web/package.json`.
- `better-sidebar` — git submodule (`omdsh-dev/DSH-better-sidebar`) at
  `better-sidebar/DSH-better-sidebar`: service-first sidebar workbench
  (right sidebar + bottom panel) with per-session explorer, CodeMirror editor
  and file-viewer registry (image/PDF/Markdown/HTML/code/binary), real
  terminal (xterm.js + node-pty, reconnect replay, optional `terminal_*`
  model tools — **off by default**), Git panel, embedded browser,
  background-job page, and the `ctx.betterSidebar` extension API. It
  declares `dsh.bundle.patch`, so `dsh plugin add` mounts it through its
  own bundle layer (no manual cordis insert). Currently supersedes the
  `terminal` and `file-explorer` wrappers. See its `README.md` and
  `docs/`.
- `sidebar-qa` — git submodule (`ChenRuoT/dsh-sidebar-qa`) at
  `sidebar-qa/dsh-sidebar-qa`: select conversation text → right-panel
  follow-up question → a dedicated same-workspace session (`❓追问·<主题>`)
  that never interrupts the main conversation. Thin consumer of
  `dsh-better-sidebar` (hard peer dependency; stays inactive without it),
  registers two better-sidebar tabs via `ctx.betterSidebar` and declares
  `dsh.bundle.patch`, so it mounts through its own bundle layer. See its
  `README.md`.
- `review` — in-tree plugin at `review/dsh-review`: the built-in `/review`
  slash command. It injects the review instructions adapted from opencode's
  review-mode prompt and submits the user's request (defaulting to all
  uncommitted changes) to the current agent. Ships prebuilt with no harness
  runtime imports; its mount row lives in the wrapper's
  `review/cordis.patch.yml`. See `review/dsh-review/README.md`.
- `ai-update` — in-tree plugin at `ai-update/dsh-ai-update`: browser-half
  bridge behind the update dialog's AI update buttons. The desktop shell
  posts a `dsh-gui:ai-update` message into the embedded page, and the plugin
  returns to the new-session home, selects the dsh-gui workspace there, and
  prefills the update prompt (it never creates a session directly and never
  picks a preset). See `ai-update/dsh-ai-update/docs/`.
- `deep-whale` — git submodule (`Small-tailqwq/dsh-deep-whale`) at
  `deep-whale/dsh-deep-whale`: the whale-girl skin series. The current
  package is `maid-atelier` (`@dsh-external/dsh-client-ui-skin-maid-atelier`,
  CC BY-NC-SA 4.0), a hot-pluggable deep-sea maid atelier skin. It ships
  prebuilt `lib/` (wrapper passes `build: false`) and mounts through its own
  `dsh.bundle.patch` layer. The wrapper keeps the submodule pristine: it copies
  the package to `.dsh/plugins/deep-whale/maid-atelier` and applies
  `deep-whale/patch-sidebar-qa.mjs` to the copy so the palace backdrop and
  whale-girl art shrink out of `dsh-better-sidebar`/`dsh-sidebar-qa` right and
  bottom panels. See `deep-whale/dsh-deep-whale/README.md` and its
  `maid-atelier/README.md`.
- `dsh-web-ui` — git submodule (`zhu1090093659/dsh-web-ui`) at
  `dsh-web-ui/dsh-web-ui`. Installs the `liangshen` preset (梁神模式) to
  `.dsh/.agent-presets/liangshen`, plus the `dsh-pet` plugin
  (`@linxin666/dsh-pet`) and the `dsh-web-ui-settings` compatibility bundle
  (`@linxin666/dsh-client-ui-web-ui-settings`) into the web profile, with the
  settings bridge ordered before dsh-pet; it intentionally does not install
  or mount any other dsh-web-ui package. See `dsh-web-ui/README.md`.

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
