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

Wrappers for npm-published plugins (per the 安装方式 section: not marked as
source installs) skip the local build/link pipeline and call the shared
`installNpmPlugin` instead, which runs
`dsh plugin --profile web add <package>` (npm registry) and lets the package's
own `dsh.bundle.patch` reconcile it into `dsh.profile.bundles` — no manual
cordis insert.

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
  (custom-bash for the phase-1 shell). It then installs `dsh-pet` and
  `dsh-web-ui-settings` from npm as `@linxin666/dsh-pet@latest` /
  `@linxin666/dsh-client-ui-web-ui-settings@latest` (per the 安装方式 section
  below: not marked as source installs). Both packages declare
  `dsh.bundle.patch`, so each mounts through its own bundle layer (no manual
  cordis inserts), and the wrapper orders the settings bridge before
  `dsh-pet`. See `dsh-web-ui/README.md`.

## 安装方式

未标注源码安装的，均使用`dsh plugin --profile <profile> add <package>`安装npm包，package参数见列表。
标注源码安装的，基于源码编译后，基于link模式引入源码安装。

- [dsh-cache-hit-precision](https://github.com/ZgblKylin/dsh-cache-hit-precision) 源码安装
- [dsh-review](https://github.com/ZgblKylin/dsh-review) 源码安装
- [dshmarket](https://github.com/dsh-market/dsh-market) npm包
- [DSH-better-sidebar@latest](https://github.com/omdsh-dev/DSH-better-sidebar) npm包
  - [dsh-sidebar-qa](https://github.com/chenruot/dsh-sidebar-qa) npm包
- [dsh-deep-whale/maid-atelier](https://github.com/Small-tailqwq/dsh-deep-whale) 源码安装
- [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite) 源码安装
- [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) 安装部分内容，见下方列表
  - [@linxin666/dsh-liangshen@latest](dsh-web-ui/packages/dsh-liangshen/README.zh.md) npm包
  - [@linxin666/dsh-pet@latest](dsh-web-ui/packages/dsh-pet/README.zh.md) npm包

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
  background-job page, and the `ctx.betterSidebar` extension API. It is
  installed from npm as `dsh-better-sidebar@latest` (per the 安装方式 section;
  the submodule checkout is kept as a source reference only), declares
  `dsh.bundle.patch`, so `dsh plugin add` mounts it through its own bundle
  layer (no manual cordis insert). Currently supersedes the `terminal` and
  `file-explorer` wrappers. See its `README.md` and `docs/`.
- `sidebar-qa` — git submodule (`ChenRuoT/dsh-sidebar-qa`) at
  `sidebar-qa/dsh-sidebar-qa`: select conversation text → right-panel
  follow-up question → a dedicated same-workspace session (`❓追问·<主题>`)
  that never interrupts the main conversation. Thin consumer of
  `dsh-better-sidebar` (hard peer dependency; stays inactive without it),
  registers two better-sidebar tabs via `ctx.betterSidebar` and declares
  `dsh.bundle.patch`, so it mounts through its own bundle layer. It is
  installed from npm as `dsh-sidebar-qa` (per the 安装方式 section; the
  submodule checkout is kept as a source reference only). See its `README.md`.
- `plugin-market` — git submodule (`dsh-market/dsh-market`) at
  `plugin-market/dsh-market`: visual plugin market (browse/search/one-click
  install community plugins). It is installed from npm as `dshmarket`
  (per the 安装方式 section; the submodule checkout is kept as a source
  reference only), declares `dsh.bundle.patch`, so `dsh plugin add` mounts it
  through its own bundle layer. See its `README.md`.
- `review` — git submodule (`../dsh-review`, recorded in `.gitmodules`) at
  `review/dsh-review`: the built-in `/review`
  slash command. It injects the review instructions adapted from opencode's
  review-mode prompt and submits the user's request (defaulting to all
  uncommitted changes) to the current agent. Ships prebuilt with no harness
  runtime imports; its mount row lives in the wrapper's
  `review/cordis.patch.yml` (read by `review/install.mjs`). See
  `review/dsh-review/README.md`.
- `ai-update` — in-tree plugin at `ai-update/dsh-ai-update`: browser-half
  bridge behind the update dialog's AI update buttons. The desktop shell
  posts a `dsh-gui:ai-update` message into the embedded page, and the plugin
  returns to the new-session home, selects the dsh-gui workspace there, and
  prefills the update prompt (it never creates a session directly and never
  picks a preset). See `ai-update/dsh-ai-update/docs/`.
- `routing-suite` — git submodule (`yjh051108/dsh-routing-suite`) at
  `routing-suite/dsh-routing-suite`: aggregator suite with two pinned
  component submodules — `injector` (`dsh-super-injector`, copied to
  `.dsh/plugins/` and built against the harness checkout, then mounted through
  its own `dsh.bundle.patch`) and
  `preset` (`router-standard` + `router-spec` agent presets copied whole into
  `.dsh/.agent-presets/`). The former `mode-boost` component was cancelled
  upstream and removed; the wrapper no longer installs it. The nested component
  submodules need a recursive
  init: `git submodule update --init --recursive
  plugins/routing-suite/dsh-routing-suite`. See `routing-suite/README.md`.
- `cache-hit-precision` — git submodule
  (`ZgblKylin/dsh-cache-hit-precision`) at
  `cache-hit-precision/dsh-cache-hit-precision`: browser-half presentation
  tweak that shows the composer stats line's cache-hit percentage with two
  decimals and caps it at 99.99% (never 100%). It reads the same
  `tokenUsage` projection the stock stats line rounds, and rewrites the
  rendered digits under the `conversation.composer.dock` slot anchor; every
  DOM write is restored on disposal. See
  `cache-hit-precision/dsh-cache-hit-precision/README.md`.
- `deep-whale` — git submodule (`Small-tailqwq/dsh-deep-whale`) at
  `deep-whale/dsh-deep-whale`: the whale-girl skin series. The current
  package is `maid-atelier` (`@dsh-external/dsh-client-ui-skin-maid-atelier`,
  CC BY-NC-SA 4.0), a hot-pluggable deep-sea maid atelier skin. It ships
  prebuilt `lib/` (wrapper passes `build: false`) and mounts through its own
  `dsh.bundle.patch` layer. The wrapper keeps the submodule pristine: it copies
  the package to `.dsh/plugins/deep-whale/maid-atelier` and invokes
  `deep-whale/patch-sidebar-qa.mjs` as a fallback. Current upstream tracks the
  native conversation geometry itself (`--maid-conversation-*`), so the palace
  backdrop and whale-girl art shrink out of any right/bottom panels generically;
  the patch no-ops for that bundle. See `deep-whale/dsh-deep-whale/README.md` and its
  `maid-atelier/README.md`.
- `dsh-web-ui` — git submodule (`zhu1090093659/dsh-web-ui`) at
  `dsh-web-ui/dsh-web-ui`. Installs the `liangshen` preset (梁神模式) to
  `.dsh/.agent-presets/liangshen`, plus the `dsh-pet` plugin
  (`@linxin666/dsh-pet`) and the `dsh-web-ui-settings` compatibility bundle
  (`@linxin666/dsh-client-ui-web-ui-settings`) — both installed from npm
  `@latest` per the 安装方式 section above — into the web profile, with the
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
