# plugins/

Local DeepSeek Harness plugin packages, in the same preset-style layout as
`presets/`: every first-level directory is a **plugin wrapper** that owns an
`install.mjs` plus the plugin package/repo checkout it installs from, if any.
A wrapper may own several checkouts and install several npm
packages in one script. Two wrappers own no package checkout at all:
`dsh-web-ui` installs four npm bundles of its distribution repo —
`dsh-web-ui-settings`, `dsh-skill-explorer`, `dsh-usage` and
`dsh-model-capabilities` — and `harness` owns the official dsh-family plugins it
installs as one flat group: `browser-use.mjs` installs the Playwright MCP
browser provider (the exclusive `dsh-browser-use` registration service + the
experimental provider — see `harness/README.md`), and `computer-use.mjs`
installs the Cua Driver native desktop provider (the exclusive
`dsh-computer-use` registration service + the native SDK provider). The Agent
Teams and Auto review bundles the plugin page switches on are runtime
dependencies of the dsh installation and are not installed by any wrapper here.

```
plugins/
├─ harness/
│  ├─ install.mjs        # entry: loads each plugins/harness/*.mjs installer in order
│  ├─ browser-use.mjs    # Browser Use: exclus. service + Playwright MCP provider
│  └─ computer-use.mjs   # Computer Use: exclus. service + Cua Driver native provider
├─ <id>/
│  ├─ install.mjs        # plugin: builds + installs + mounts; dsh-web-ui: four npm
│  │                     # bundles
│  └─ <package>/         # the plugin package (in-tree, or a git submodule); absent
│                        # for npm-only wrappers
└─ ...
```

The harness installs plugins into a *profile* (for the web surface, the `web`
profile). `npm run install:plugins` (alias `npm run plugins`) runs every
`plugins/*/install.mjs` in directory-name order. The `harness` wrapper owns no
install of its own: its `install.mjs` only loads the flat sibling installers
(`browser-use.mjs`, `computer-use.mjs`), each of which also
runs standalone, so the group stays one directory with no nesting. Plugin
wrappers delegate the shared pipeline to `scripts/plugin-install.mjs` and
only own their id, package directory, and submodule hint:

1. build the package in place when it declares a `build` script (pinned
   toolchain pnpm + shared store),
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

Since harness dsh-v0.2.0-rc.2 the app-boot admission gate compares every
`@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer with the running dsh version: a
package whose range predates it is refused by `dsh plugin add` and its bundle
layer is skipped at boot. `installNpmPlugin`'s `exempt` option
is the only way to keep such a version mounted: the wrapper passes a reason, and
before the install the pipeline grants the profile an exact-version exemption
with `dsh plugin allow-version <spec> --dsh-version <runtime> --accept-risk`,
which writes the accepted risk into the profile's `compatibility.json`. The
exemption is keyed by exact package version and exact runtime version, so the
next harness change invalidates it instead of carrying the accepted risk
forward. No wrapper currently grants one: a package whose
installed version already admits the 0.2 line does not — the deep-whale skins
needed one at `v0.1.6` and their `v0.1.7` peers admit 0.2.1-alpha.1, so that
wrapper no longer grants it, and `dsh-pet`'s `v0.3.6` peers admit 0.2.1-alpha.1, so
its wrapper no longer does either.

Both paths fast-path an already-satisfied profile. `installNpmPlugin` skips the
`dsh plugin add` entirely when the package is pinned to an exact version, the
profile's dependency and `node_modules` copy are at that version, no foreign
nested `node_modules` is left in the package, and the mount state is intact (the
bundle is listed in `dsh.profile.bundles`, or the wrapper's insert row is in
`cordis.patch.yml`). `installPlugin` (a `link:` install) always builds the
package — its sources, not a spec, decide what is current — and skips only the
dependency write when the profile already links this exact directory and the
mount state is intact. Use `npm run rebuild` (or `DSH_PLUGIN_REBUILD=1`) to
install everything again even when the profile is already current; the per-plugin
mask switches stay separate (`DSH_PLUGIN_SKIP`, `DSH_PLUGIN_FORCE_INSTALL`).

`DSH_HOME` is pinned to the runtime root's `.dsh` by the desktop shell and by
every install script, so installed plugins land under that directory — the
checkout's parent in the nested layout — and nothing is written to `~/.dsh` or
any global location.

Two package shapes are handled specially:

- **No `build` script** — the package is used as shipped (prebuilt `lib/` or
  config-only): the installer skips `pnpm install` + `pnpm run build` for it.
- **`dsh.bundle.patch` declared** — the package carries its own
  `cordis.patch.yml` bundle layer. `dsh plugin add` reconciles it into the
  profile's `dsh.profile.bundles`, and that layer inserts its entry — the
  installer writes no `cordis.patch.yml` insert (a manual one would
  double-mount it).

Plugins without any of these get a derived mount entry (id from
`dsh.gui.mountId`, else the package name without a leading `dsh-`). A wrapper
may instead pass an explicit `mount` entry that overrides the derived entry,
and the `mount` may also carry a `config` object that the shared pipeline
renders as the row's `config:` block (needed when a plain package's entry
must carry settings). `harness`'s `browser-use` and `computer-use` are the
only wrappers that mount plain packages by hand: their four
packages (`@deepseek-ai/dsh-browser-use`,
`@deepseek-ai/dsh-experimental-browser-use-playwright-mcp`,
`@deepseek-ai/dsh-computer-use`,
`@deepseek-ai/dsh-experimental-computer-use-cua-driver-native`) declare no
`dsh.bundle.patch`, so the wrapper mounts them two at a time as
service + provider insert rows — only the Browser Use provider row carries a
`config` (`mode: launch` / `headless: true` / `executablePath`); the Cua
Driver native provider takes no configuration, so its row is bare.
Every in-tree plugin (`remote`, `ai-update`) still declares
`dsh.bundle.patch` and mounts through its own bundle layer. A manual profile
insert for a bundle-declared plugin would double-mount it and fail the plugin
tree with `duplicate loader entry id`.

- **Multiple npm bundles wrapper** — `dsh-web-ui` installs four plugin
  packages of its distribution repo, pinned to exact versions matching the
  git tag (`0.4.5`; exact pins bypass pnpm 11's 24h `minimumReleaseAge`
  gate, which would otherwise silently fall back to an older version for
  `@latest`): `@linxin666/dsh-client-ui-web-ui-settings`,
  `@linxin666/dsh-client-ui-skill-explorer`, `@linxin666/dsh-usage` and
  `@linxin666/dsh-client-ui-model-capabilities` (the settings bridge is
  ordered first; per the 安装方式 section below: not marked as source
  installs). All four declare `dsh.bundle.patch`, so each mounts through its
  own bundle layer (no manual cordis inserts). The plugin-manager tab
  (`@linxin666/dsh-client-ui-plugin-manager`) is not installed: the official
  `@deepseek-ai/dsh-web-app` bundle of the pinned harness (dsh-v0.2.1-alpha.1)
  inserts its own `ui-plugin-manager` loader entry with the same id. A duplicate
  id across bundle layers is not a boot failure — the loader reuses one Entry per
  id and the last row wins — but the surviving row would be the upstream
  package's, and shadowing the official row removes the Plugins page seat that
  the upstream package's own `plugins.detail.section` block extends. It does not
  install agent presets or any other dsh-web-ui package. See
  `dsh-web-ui/README.md`.

## 安装方式

未标注源码安装的，均使用`dsh plugin --profile <profile> add <package>`安装npm包，package参数见列表。
标注源码安装的，基于源码编译后，基于link模式引入源码安装。

- [dshmarket](https://github.com/dsh-market/dsh-market) npm包（pin 子模块 tag `1.66.9`；1.66.4 起把 `@deepseek-ai/dsh-settings` peer 纳入 0.2 线，属硬下限：1.65.3 的 peer 范围被 0.2.1-alpha.1 的准入闸门拒绝，安装前置检查直接失败）
- [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) npm包（**0.24.1** 的 14 条 `@deepseek-ai/dsh-*` peerDeps 全指 `^0.2.0-rc.1`，与本工程 pinned 的 `dsh-v0.2.1-alpha.1` 匹配；0.21.1 的 `^0.1.7-rc.1` 上界不含 0.2.0，会被 0.2.0 的准入闸门整包拒绝），右列交由 DSH 原生右侧栏承载、插件把各 tab 类型注册为原生 tab 并只保留底部工作台与 `ctx.betterSidebar` 服务。wrapper 固定 `0.24.1` 而非 `@latest`，因为 pinned pnpm 11.7 默认 supply-chain minimumReleaseAge 会把过新的版本挡在 `@latest` 之外、静默回退到更旧版本；v0.16.1 起已含 z-index 图层修复 [#330](https://github.com/omdsh-dev/DSH-better-sidebar/pull/330) 与市场受管安装兼容 [#338](https://github.com/omdsh-dev/DSH-better-sidebar/pull/338)，原 TEMP fork-source 源码安装已还原为 npm；子模块 checkout 仅作源码参考），install.mjs 先装本插件再装下方的 dsh-sidebar-qa
  - [dsh-sidebar-qa](https://github.com/chenruot/dsh-sidebar-qa) npm包（pin `1.1.0`；1.1.0 是纯元数据修复版，peer 由 `^0.1.0-rc.8` 改为纯下限 `>=0.1.0-rc.8`，caret 上界 `<0.2.0-0` 过不了 0.2.0 的准入闸门；v1.0.0 起收敛为原生单后端，并在 manifest 层移除了 `dsh-better-sidebar` peer；按 DSH 0.1.7 重命名后的图标集按名解析宿主图标）
- [dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale) npm包（pin 子模块 tag `v0.1.7`，分包 pin：maid-atelier 与 orca-link 各 `0.1.7`、skin-manager `0.1.6`（上游该 tag 的发布提交即「0.1.7 皮肤 + 0.1.6 管理包」）；`@smalltailqwq/dsh-client-ui-skin-*` 三包按上游 INSTALL.md 顺序安装，两块皮肤在此 tag 把 `@deepseek-ai/dsh` peer 放宽到 `>=0.1.7-rc.1 <0.3.0-0`、`skin.json` 记 `dshCompatibility: 0.2.0rc2`，0.2.1-alpha.1 的准入闸门不再拒绝，v0.1.6 用的精确版本例外随之撤销；manager 的 peer `>=0.1.7-rc.1` 无需例外；并清理旧 `@dsh-external/*` 占位 scope 的残留键）
- [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) 安装部分内容，见下方列表
  - [@linxin666/dsh-client-ui-web-ui-settings@0.4.5](dsh-web-ui/packages/dsh-web-settings/README.zh.md) npm包
  - [@linxin666/dsh-client-ui-skill-explorer@0.4.5](dsh-web-ui/packages/dsh-skill-explorer/README.zh.md) npm包
  - [@linxin666/dsh-usage@0.4.5](dsh-web-ui/packages/dsh-usage/README.zh.md) npm包
  - [@linxin666/dsh-client-ui-model-capabilities@0.4.5](dsh-web-ui/packages/dsh-model-capabilities/README.zh.md) npm包
    （插件管理器 Tab `@linxin666/dsh-client-ui-plugin-manager`、会话归档管理
    `@linxin666/dsh-session-archive` 与任务板
    `@linxin666/dsh-client-ui-task-board` 已从本工程移除，不再安装；见
    `dsh-web-ui/README.md`「已移除插件」一节）
- harness（dsh 工程官方插件组，平铺脚本见 [harness/README.md](harness/README.md)）：
  - Agent Teams（无本地包，官方可选 bundle）：`@deepseek-ai/dsh-experimental-agent-team-profile` 随 dsh 安装提供并列入 harness 的 `OPTIONAL_BUNDLES`，由插件页「智能体团队」开关写入 `dsh.profile.bundles`，本 wrapper 既不安装它也不派生 preset。
  - Auto review（无本地包，官方可选 bundle）：`@deepseek-ai/dsh-experimental-auto-review` 随 dsh 安装提供并列入 harness 的 `OPTIONAL_BUNDLES`，由插件页「自动授权审查」开关写入 `dsh.profile.bundles`，本 wrapper 不安装它
  - Browser Use / Playwright MCP（无本地包）npm包 ×2：`@deepseek-ai/dsh-browser-use@0.2.1-alpha.1`（独占浏览器提供方注册服务）与 `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp@0.2.1-alpha.1`（逐 Session Chromium 工具）；两包均不声明 `dsh.bundle.patch`，按普通依赖安装并由 wrapper 显式挂载两行 insert（提供方行带 `config: mode launch/headless`，Chromium 路径安装时探测）。默认安装：`mode: launch` 下每个存活 Session 各持一份浏览器客户端
  - Computer Use / Cua Driver native（无本地包）npm包 ×2：`@deepseek-ai/dsh-computer-use@0.2.1-alpha.1`（独占桌面提供方注册服务）与 `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native@0.2.1-alpha.1`（进程内 Cua Driver 原生桌面工具，工具名 `cua_driver_native__*`）；两包均不声明 `dsh.bundle.patch`，按普通依赖安装并由 wrapper 显式挂载两行 insert（原生提供方无配置，行不带 `config`；此提供方仅限 native 路线，同族的已安装 MCP 提供方不装、与 native 抢占唯一注册位）
- [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) npm包（v0.3.6；子模块
  checkout 仅作源码参考；9 条 `@deepseek-ai/dsh*` peer 均为 `^0.2.0-rc.1`，
  覆盖 0.2.1-alpha.1 的准入闸门，无需精确版本例外），默认安装：host 半 inject 为
  `webServer / agentDefaultModel / credentials / llm / commands`，
  `agentDefaultModel` 由 base bundle 提供；client 半的本地 inject
  （`src/client/app.ts`）为 `slots / locale / connection / remote /
  remote.commands / commandUi`，其中 `commandUi`（官方 dsh-client-ui-commands
  的「/」命令服务，随 web-app bundle 挂载）就绪后 `/pet` 选择框才注册；声明层
  `dsh.client.inject` 只列 `@deepseek-ai/dsh-client-connection`（随 web-app
  bundle 挂载）；系统通知走 host 转发通道（host 半监听 `session/event` /
  `agent/error`，把帧落在 `/dsh-pet-7340/notify`，浏览器半每秒轮询该路由）。
  用户层配置为 `$DSH_HOME/dsh-pet/main-config.jsonc`，安装后自动注入
  `display:"web"` 屏蔽桌面 Electron 模式（见
  [dsh-pet/README.md](dsh-pet/README.md)）

## Current plugins

- `remote` — in-tree plugin at `remote/dsh-remote`: multi-backend remote mode
  for the web GUI (connection tabs, new-connection page, SSH deploy, Docker
  exec connect). It
  declares `dsh.bundle.patch` and mounts through its own bundle layer (no
  manual cordis insert). See `remote/dsh-remote/docs/`.
- `better-sidebar` — two git submodules at `better-sidebar/DSH-better-sidebar`
  (`omdsh-dev/DSH-better-sidebar`) and `better-sidebar/dsh-sidebar-qa`
  (`ChenRuoT/dsh-sidebar-qa`); its `install.mjs` installs the two packages
  in order — `dsh-better-sidebar@0.24.1` FIRST (0.24.1 is the DSH
  0.2.0-rc.1 适配版, peerDeps 全指 `^0.2.0-rc.1`；0.21.1 的 `^0.1.7-rc.1` 上界
  不含 0.2.0，会被 0.2.0 的准入闸门整包拒绝。固定精确版本而非 `@latest`，
  因为 pinned pnpm 11.7 默认 supply-chain minimumReleaseAge 会把过新的版本挡在
  `@latest` 之外、静默回退到更旧版本；子模块 checkout 在 pinned tag 处保留作
  源码参考),
  then `dsh-sidebar-qa@1.1.0`
  (the same order ends up in `dsh.profile.bundles`; both are pinned to exact
  versions matching their submodule tags. `dsh-sidebar-qa` dropped the
  better-sidebar peer in v1.0.0, so its position only preserves the existing
  layout).
  - `DSH-better-sidebar` — service-first sidebar workbench (tab types on DSH's
    native right sidebar + its own bottom panel) with per-session explorer,
    CodeMirror editor and
    file-viewer registry (image/PDF/Markdown/HTML/code/binary), real
    terminal (xterm.js + node-pty, reconnect replay, optional `terminal_*`
    model tools — **off by default**), Git panel, embedded browser,
    background-job page, and the `ctx.betterSidebar` extension API. It
    declares `dsh.bundle.patch`, so `dsh plugin add` mounts it through its
    own bundle layer (no manual cordis insert). It is the successor to the
    former `terminal` / `file-explorer` wrappers, now removed from this
    repository. See its `README.md` and `docs/`.
  - `dsh-sidebar-qa` — select conversation text → right-panel follow-up
    question → a dedicated same-workspace session (`❓追问·<主题>`) that never
    interrupts the main conversation. Since v1.0.0 it is a native-only sidebar
    port that no longer declares `dsh-better-sidebar` as a peer (it resolves the
    host icon set by name after DSH 0.1.7 renamed it) and declares
    `dsh.bundle.patch`, so it mounts through its own bundle layer. See its
    `README.md`.
- `plugin-market` — git submodule (`dsh-market/dsh-market`) at
  `plugin-market/dsh-market`: visual plugin market (browse/search/one-click
  install community plugins). It is installed from npm as `dshmarket@1.66.9`
  (pinned to the submodule tag; per the 安装方式 section; the version is a hard
  floor, because 1.66.4 admitted the 0.2 line and 1.65.3's
  `@deepseek-ai/dsh-settings` peer range is rejected by 0.2.1-alpha.1's admission
  gate, which fails the install preflight; the submodule
  checkout is kept as a source
  reference only), declares `dsh.bundle.patch`, so `dsh plugin add` mounts it
  through its own bundle layer. See its `README.md`.
- `ai-update` — in-tree plugin at `ai-update/dsh-ai-update`: browser-half
  bridge behind the update dialog's AI update buttons. The desktop shell
  posts a `dsh-gui:ai-update` message into the embedded page, and the plugin
  returns to the new-session home, selects the dsh-gui workspace there, and
  prefills the update prompt (it never creates a session directly and never
  picks a preset). It declares `dsh.bundle.patch` and mounts through its own
  bundle layer (no manual cordis insert). See
  `ai-update/dsh-ai-update/docs/`.
- `deep-whale` — git submodule (`Small-tailqwq/dsh-deep-whale`) at
  `deep-whale/dsh-deep-whale`, kept as the version source and a source
  reference only. The wrapper installs the published trio from npm in upstream
  order (per the upstream INSTALL.md, which makes the npm packages the regular
  install path and scopes the bundled `dsh-skin-install` skill to legacy
  migration, local development builds, specified-commit testing and diagnosis):
  the persistent skin manager
  `@smalltailqwq/dsh-client-ui-skin-deep-whale-manager` plus the two
  mutually exclusive skins `maid-atelier` and `orca-link`
  (`@smalltailqwq/dsh-client-ui-skin-maid-atelier` /
  `@smalltailqwq/dsh-client-ui-skin-orca-link`, each MIT for its code and
  CC BY-NC-SA 4.0 for its artwork), pinned per package to the exact version each
  carries in the pinned `v0.1.7` tag — both skins at `0.1.7` and the manager one
  release behind at `0.1.6` (upstream's release commit prepares "0.1.7 skins and
  0.1.6 skin manager"). At this tag both skins widened their
  `@deepseek-ai/dsh` peer to `>=0.1.7-rc.1 <0.3.0-0` and record
  `dshCompatibility: 0.2.0rc2` in `skin.json`, so they admit 0.2.1-alpha.1 and no
  longer need the exact-version exemption the v0.1.6 skins required (whose
  `>=0.1.7-rc.1 <0.1.8-0` upper bound the 0.2.0-rc.2 admission gate rejected);
  the manager's `>=0.1.7-rc.1` peer is satisfied, so it needs none. Every tarball
  ships its prebuilt `lib/` and its own `cordis.patch.yml`, so nothing is
  compiled or linked locally and each mounts through its own bundle layer (entry
  ids `ui-skin-deep-whale-manager`, `ui-skin-maid-atelier`, `ui-skin-orca-link`).
  Skin mutual exclusion is the manager's own job: on the first restart it detects
  "two skins enabled at once" and falls back to the official default, after which
  a skin is chosen in `设置 → 皮肤管理`; the wrapper pre-stages nothing. The
  wrapper also migrates installs made from GitHub before upstream 0.1.3, whose
  `@dsh-external/*` placeholder keys would otherwise leave two identities for the
  same skins. Current upstream tracks the native conversation geometry itself
  (`--maid-conversation-*`), so the palace backdrop and whale-girl art shrink
  out of any right/bottom panels generically. See
  `deep-whale/dsh-deep-whale/README.md` and the per-skin `README.md` files.
- `dsh-web-ui` — git submodule (`zhu1090093659/dsh-web-ui`) at
  `dsh-web-ui/dsh-web-ui`. Installs four plugin packages of the distribution
  repo pinned to exact versions matching the git tag (`0.4.5`) (per the
  安装方式 section above): the `dsh-web-ui-settings` compatibility bundle
  (`@linxin666/dsh-client-ui-web-ui-settings`, ordered first),
  `dsh-skill-explorer` (`@linxin666/dsh-client-ui-skill-explorer`),
  `dsh-usage` (`@linxin666/dsh-usage`) and `dsh-model-capabilities`
  (`@linxin666/dsh-client-ui-model-capabilities`) — each mounts through its
  own `dsh.bundle.patch` layer; the plugin-manager tab
  (`@linxin666/dsh-client-ui-plugin-manager`), the task board
  (`@linxin666/dsh-client-ui-task-board`) and the session-archive manager
  (`@linxin666/dsh-session-archive`) are no longer installed. It does not
  install agent presets or any other dsh-web-ui package. See
  `dsh-web-ui/README.md`.
- `dsh-pet` — git submodule (`PC2005-cloud/dsh-pet`, pin latest tag v0.3.6)
  at `dsh-pet/dsh-pet`: a floating desktop pet whose host half runs inside
  DSH and whose optional desktop mode spawns per-pet transparent Electron
  windows. The wrapper installs the package from npm as `dsh-pet@0.3.6` (its
  nine `@deepseek-ai/dsh*` peers are `^0.2.0-rc.1`, so 0.2.1-alpha.1's admission
  gate admits it and no exact-version exemption is granted), then
  injects a user-layer default pet with `display:"web"` into
  `$DSH_HOME/dsh-pet/main-config.jsonc` (or the legacy `main-config.json` when
  that is the file on disk, unless a `display` is already
  configured) — so no pet resolves to `desktop`/`both` and no Electron helper
  process is launched or downloaded. It installs by default: the host half's
  injection is `webServer / agentDefaultModel / credentials / llm / commands`
  (`agentDefaultModel` comes from the base bundle), the client half's own
  inject adds `commandUi` — the `/` command service `dsh-client-ui-commands`
  mounts with the web-app bundle, so the `/pet` selector registers — and
  system notifications are relayed through the host
  (`session/event` / `agent/error` consumed by the host half, polled by the
  browser half over `/dsh-pet-7340/notify`). See `dsh-pet/README.md`.
- `harness` — a single flat wrapper at `harness/` that owns the official
  dsh-family plugins it installs: `install.mjs` only loads the sibling installers
  `browser-use.mjs` and `computer-use.mjs`, so the group stays
  one directory with no nesting. Agent Teams and Auto review are not installed
  here: `@deepseek-ai/dsh-experimental-agent-team-profile` and
  `@deepseek-ai/dsh-experimental-auto-review` are dsh runtime dependencies
  listed in the harness's `OPTIONAL_BUNDLES`, and the plugin page (插件 →
  智能体团队 / 自动授权审查) switches them into `dsh.profile.bundles`; the
  wrapper derives no preset declaration from them.
  See `harness/README.md`.
  - `browser-use` — `harness/browser-use.mjs` installs the Playwright MCP
    browser provider from npm as two plain (non-bundle) packages:
    `@deepseek-ai/dsh-browser-use@0.2.1-alpha.1` (the exclusive browser-use
    provider registration service, `ctx.browserUse`) and
    `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp@0.2.1-alpha.1`
    (per-Session Chromium tools via `@playwright/mcp`, surfaced as
    `mcp__playwright-mcp__<tool>`). Neither declares `dsh.bundle.patch`, so the
    wrapper mounts both plain packages by hand: two
    `cordis.patch.yml` insert rows (id `browser-use` /
    `browser-use-playwright-mcp`), the provider row carrying a `config:` block
    (`mode: launch`, `headless: true`, and a system Chromium `executablePath`
    resolved at install time — override with `DSH_BROWSER_EXECUTABLE`).
    Installed by default: `mode: launch` gives every live
    Session its own browser client, and the profile resolves a single
    `@deepseek-ai/dsh-scope` instance (the duplicate-instance failure upstream
    issue #4573 describes). See `harness/README.md`.
  - `computer-use` — `harness/computer-use.mjs` installs the Cua Driver
    native desktop provider from npm as two plain (non-bundle) packages:
    `@deepseek-ai/dsh-computer-use@0.2.1-alpha.1` (the exclusive computer-use
    provider registration service, `ctx.computerUse`) and
    `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native@0.2.1-alpha.1`
    (in-process desktop tools via the Cua Driver native npm SDK
    `@trycua/cua-driver@0.28.0`, surfaced as `cua_driver_native__<tool>`).
    Neither declares `dsh.bundle.patch`, so the wrapper mounts both plain
    packages by hand: two `cordis.patch.yml` insert rows (id `computer-use` /
    `computer-use-cua-driver-native`), neither carrying `config` because the
    native provider takes no configuration. Only the native route is
    installed; the sibling installed-MCP computer-use provider is not, since
    both contend for the single `ctx.computerUse` registration slot.
    See `harness/README.md`.
