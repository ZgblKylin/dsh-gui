# plugins/

Local DeepSeek Harness plugin wrappers, in the same preset-style layout as
`presets/`: every first-level directory is a **plugin wrapper** that owns an
`install.mjs`. A wrapper installs either published npm packages, pinned to
exact versions in its own script, or an in-tree package directory it also owns.
A wrapper may install several npm packages in one script (`better-sidebar` two,
`deep-whale` three, `dsh-web-ui` three). The `harness` wrapper owns the official
dsh-family plugins it installs as one flat group: `browser-use.mjs` installs the
Playwright MCP browser provider (the exclusive `dsh-browser-use` registration
service + the experimental provider — see `harness/README.md`), and
`computer-use.mjs` installs the Cua Driver native desktop provider (the
exclusive `dsh-computer-use` registration service + the native SDK provider).
The Agent Teams and Auto review bundles the plugin page switches on are runtime
dependencies of the dsh installation and are not installed by any wrapper here.

```
plugins/
├─ harness/
│  ├─ install.mjs        # entry: loads each plugins/harness/*.mjs installer in order
│  ├─ browser-use.mjs    # Browser Use: exclus. service + Playwright MCP provider
│  └─ computer-use.mjs   # Computer Use: exclus. service + Cua Driver native provider
├─ <id>/
│  ├─ install.mjs        # npm wrapper: installs the exact-pinned npm package(s)
│  │                     # in-tree wrapper: builds, links and mounts its package
│  ├─ <package>/         # in-tree package: manifest, sources, docs; absent for npm
│  │                     # wrappers
│  └─ ...                # wrapper-owned extras, e.g. README.md or helper scripts
└─ ...
```

The harness installs plugins into a *profile* (for the web surface, the `web`
profile). `npm run install:plugins` (alias `npm run plugins`) runs every
`plugins/*/install.mjs` in directory-name order. The `harness` wrapper owns no
install of its own: its `install.mjs` only loads the flat sibling installers
(`browser-use.mjs`, `computer-use.mjs`), each of which also
runs standalone, so the group stays one directory with no nesting. Plugin
wrappers delegate the shared pipeline to `scripts/plugin-install.mjs` and
only own their id, package directory, and optional mount entry:

Before any wrapper runs, the build asks the running dsh installation's own
compatibility evaluator which installed direct dependencies the admission gate
rejects and removes them with one `dsh plugin remove`. A harness upgrade leaves
the previous build's plugin family in the profile; without that scan the first
`dsh plugin add` is refused before any wrapper can install its pinned version.
The desktop build runs the same scan for the desktop profile before its plugin
step, using the freshly built source tree as the evaluator. Every removal is
logged with the rejected requirement; a package no wrapper pins stays removed.

1. build the package in place when it declares a `build` script (pinned
   toolchain pnpm + shared store),
2. pin the profile's pnpm store,
3. `dsh plugin --profile web add link:<package dir>`,
4. append an idempotent insert to `.dsh/profiles/web/cordis.patch.yml` —
   the wrapper's explicit `mount` entry when given, else derived from the
   manifest.

npm wrappers (the external plugins in the 安装方式 section below) skip the
local build/link pipeline and call the shared `installNpmPlugin` instead, which
runs `dsh plugin --profile web add <package>` (npm registry) and lets the
package's own `dsh.bundle.patch` reconcile it into `dsh.profile.bundles` — no
manual cordis insert. Such a wrapper keeps no package checkout in this
repository: its script is the authoritative install target for the current
profile and for a fresh deployment, so upgrading the plugin means raising the
`packageSpec` pin and re-running the wrapper (`node plugins/<id>/install.mjs`).

The app-boot admission gate reads a package's declared dsh requirements against
the running version — its `engines.dsh` range when present, else its
`@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer ranges: a package whose declared
range excludes the running version is refused by `dsh plugin add` and its bundle
layer is skipped at boot. `installNpmPlugin`'s `exempt` option
is the only way to keep such a version mounted: the wrapper passes a reason, and
before the install the pipeline grants the profile an exact-version exemption
with `dsh plugin allow-version <spec> --dsh-version <runtime> --accept-risk`,
which writes the accepted risk into the profile's `compatibility.json`. The
exemption is keyed by exact package version and exact runtime version, so the
next harness change invalidates it instead of carrying the accepted risk
forward. On the pinned `dsh-v0.2.2-rc.1` runtime no wrapper needs one any more. The last
holder was the commandcode provider: pins through `0.15.5` declared
`engines.dsh` as `>=0.2.1-rc.2 <0.2.2-0`, whose upper bound excludes the whole
0.2.2 prerelease line (`0.2.2-rc.1` sorts above `0.2.2-0`), so its `install.mjs`
granted the exact-version exemption. `0.17.3` widens the declaration to
`>=0.2.1-rc.2 <0.2.2-0 || >=0.2.2-alpha.2 <0.2.3-0` — the same disjunction is
carried by its `@deepseek-ai/dsh-*` peers — which contains 0.2.2-rc.1, and it
records `0.2.2-rc.1` as compatible in `dsh.compatibility.dshReleases`, so the
exemption is dropped instead of carried forward (it is keyed to an exact package
version and runtime version, so it could not have covered `0.17.3` anyway).
Every other pinned version admits 0.2.2-rc.1 through its own declared range —
the `^0.2.2-rc.1` / `^0.2.0-rc.1` / `^0.2.0-rc.2` peers, the `>=0.2.2-rc.1` /
`>=0.2.1-rc.2` floors and `engines.dsh >=0.1.7-alpha.1` all still contain it.

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
Every in-tree wrapper's package declares
`dsh.bundle.patch` and mounts through its own bundle layer. A manual profile
insert for a bundle-declared plugin would double-mount it and fail the plugin
tree with `duplicate loader entry id`.

- **Multiple npm bundles wrapper** — `dsh-web-ui` installs three plugin
  packages of its distribution repo, pinned to the exact versions of its
  `0.4.16` release (exact pins bypass pnpm 11's 24h `minimumReleaseAge`
  gate, which would otherwise silently fall back to an older version for
  `@latest`): `@linxin666/dsh-client-ui-web-ui-settings`,
  `@linxin666/dsh-client-ui-skill-explorer` and `@linxin666/dsh-usage`
  (the settings bridge is ordered first; per the 安装方式 section below: not
  marked as source installs). All three declare `dsh.bundle.patch`, so each
  mounts through its own bundle layer (no manual cordis inserts). The
  `dsh-model-capabilities` package (`@linxin666/dsh-client-ui-model-capabilities`)
  is not installed any more: model input types are declared on the official
  Models page, and its provider-disable archive is an extra layer this wrapper
  no longer carries (see `dsh-web-ui/README.md`). The
  plugin-manager tab (`@linxin666/dsh-client-ui-plugin-manager`) is also not
  installed: the official `@deepseek-ai/dsh-web-app` bundle of the pinned
  harness (dsh-v0.2.2-rc.1) inserts its own `ui-plugin-manager` loader entry
  with the same id. A duplicate id across bundle layers is not a boot failure —
  the loader reuses one Entry per id and the last row wins — but the surviving
  row would be the upstream package's, and shadowing the official row removes
  the Plugins page seat that the upstream package's own
  `plugins.detail.section` block extends. It does not install agent presets or
  any other dsh-web-ui package. See `dsh-web-ui/README.md`.

## 安装方式

未标注源码安装的，均使用 `dsh plugin --profile <profile> add <package>` 安装 npm 包，package 参数见列表；标注源码安装的，基于源码编译后以 link 模式引入。
npm 型 wrapper 不在仓库内保留插件源码检出，安装脚本就是当前 profile 与全新部署共同的权威安装目标：升级时把 `packageSpec` 改成上游新版本并重跑该 wrapper。
npm 型 wrapper 的安装目标必须以精确 spec 字面量写在安装脚本里，形如 `<包名>@<版本>`（例如 `const PACKAGE_SPEC = 'dsh-pet@0.4.6'`，或直接 `packageSpec: '@max-null/dsh-skill-mcp-center@0.7.0'`）。
本仓库的更新面板（外壳与 desktop 插件两个入口）按这些字面量生成插件行，并把新版本就地写回脚本后重跑该 wrapper；脚本必须能在改写后的 pin 下原样重跑（幂等，不缓存旧版本）。
从其他文件读取版本、用拼接构造 spec、或在注释与 README 里维护第二份版本号的写法，更新面板检测不到或会被误导。

- [dshmarket](https://github.com/dsh-market/dsh-market) npm包（pin `1.73.15`；1.66.4 起把 `@deepseek-ai/dsh-settings` peer 纳入 0.2 线，属硬下限：1.65.3 的 peer 范围被 0.2.2-rc.1 的准入闸门拒绝，安装前置检查直接失败；1.70.0 起 peer 检查按 `includePrerelease` 接纳 prerelease 宿主线，1.73.x 沿用同一区间（`^0.2.1-alpha.3 || ^0.2.1-rc.1`），1.70.2 含 carrier 型 bundle 开关的缺陷修复，1.73.15 另含市场更新链路、Agent 空闲期延迟插件变更（#411）与 Windows 控制台输出解码（#1122）的修复）
- [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) npm包（**0.30.1** 的 14 条 `@deepseek-ai/dsh-*` peerDeps 全指 `^0.2.2-rc.1`，与本工程 pinned 的 `dsh-v0.2.2-rc.1` 匹配（较 0.28.2 新增的 `dsh-client-ui-input-trigger` 随 0.2.2-rc.1 的 web-app bundle 的 `ui-input-trigger` 行提供）；host inject 仍为 `webServer / sessions / connection / tools`，未再引用 rc.2 起已删除的 `webRuntime`，因此本 pin 必须与 harness 同批更换），右列交由 DSH 原生右侧栏承载、插件把各 tab 类型注册为原生 tab 并只保留底部工作台与 `ctx.betterSidebar` 服务。wrapper 固定 `0.30.1` 而非 `@latest`，因为 pinned pnpm 11.7 默认 supply-chain minimumReleaseAge 会把过新的版本挡在 `@latest` 之外、静默回退到更旧版本；0.30.0 起侧聊模型切换改走 `agent.model.select()`，旧「`installModelSelection` 两参调用未适配 0.2.2」的限制已解除；v0.16.1 起还含 z-index 图层修复 [#330](https://github.com/omdsh-dev/DSH-better-sidebar/pull/330) 与市场受管安装兼容 [#338](https://github.com/omdsh-dev/DSH-better-sidebar/pull/338)），install.mjs 先装本插件再装下方的 dsh-sidebar-qa
  - [dsh-sidebar-qa](https://github.com/chenruot/dsh-sidebar-qa) npm包（pin `1.2.2`；1.2.0 的 host 半改为 Config + volatile、按 profile 条目 id 寻址，设置项因此可持久化；1.2.1 把信任围栏从已删除的 `webRuntime` 迁到 `webStartup`，修掉 LAN/`--trusted-host` 访问 `/sidebarqa/api` 恒 403 的缺陷，client 半恢复流式并显示失败原因；manifest 的 `engines.dsh >=0.1.7-alpha.1` 覆盖 0.2.2-rc.1；自 v1.0.0 起收敛为原生单后端，并在 manifest 层移除了 `dsh-better-sidebar` peer；按 DSH 0.1.7 重命名后的图标集按名解析宿主图标）
- [dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale) npm包（按各包最新发布 pin：orca-link `0.1.10`、skin-manager `0.1.9`、maid-atelier 保持 `0.1.9`（本次不升）；`@smalltailqwq/dsh-client-ui-skin-*` 三包按上游 INSTALL.md 顺序安装。orca-link 0.1.10 的 peer 收窄为 `@deepseek-ai/dsh >=0.2.2-0 <0.2.3-0`（`0.2.2-rc.1` 落在该区间内、满足准入闸门），其 `skin.json` 记 `dshCompatibility: 0.2.2rc1`（仅「验证于」展示，不参与准入判定）；maid-atelier 0.1.9 仍是 `>=0.2.0-rc.2 <0.3.0-0`，manager 的 `>=0.1.7-rc.1` 同样满足，0.2.2-rc.1 的准入闸门全部放行、无需例外；并清理旧 `@dsh-external/*` 占位 scope 的残留键）
- [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) 安装部分内容，见下方列表
  - [@linxin666/dsh-client-ui-web-ui-settings@0.4.16](https://www.npmjs.com/package/@linxin666/dsh-client-ui-web-ui-settings) npm包
  - [@linxin666/dsh-client-ui-skill-explorer@0.4.16](https://www.npmjs.com/package/@linxin666/dsh-client-ui-skill-explorer) npm包
  - [@linxin666/dsh-usage@0.4.16](https://www.npmjs.com/package/@linxin666/dsh-usage) npm包
    （模型能力 `@linxin666/dsh-client-ui-model-capabilities`、插件管理器 Tab
    `@linxin666/dsh-client-ui-plugin-manager`、会话归档管理
    `@linxin666/dsh-session-archive` 与任务板
    `@linxin666/dsh-client-ui-task-board` 本工程不安装；见
    `dsh-web-ui/README.md`）
- harness（dsh 工程官方插件组，平铺脚本见 [harness/README.md](harness/README.md)）：
  - Agent Teams（无本地包，官方可选 bundle）：`@deepseek-ai/dsh-experimental-agent-team-profile` 随 dsh 安装提供并列入 harness 的 `OPTIONAL_BUNDLES`，由插件页「智能体团队」开关写入 `dsh.profile.bundles`，本 wrapper 既不安装它也不派生 preset。
  - Auto review（无本地包，官方可选 bundle）：`@deepseek-ai/dsh-experimental-auto-review` 随 dsh 安装提供并列入 harness 的 `OPTIONAL_BUNDLES`，由插件页「自动授权审查」开关写入 `dsh.profile.bundles`，本 wrapper 不安装它
  - Browser Use / Playwright MCP（无本地包）npm包 ×2：`@deepseek-ai/dsh-browser-use@0.2.2-rc.1`（独占浏览器提供方注册服务）与 `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp@0.2.2-rc.1`（逐 Session Chromium 工具）；两包均不声明 `dsh.bundle.patch`，按普通依赖安装并由 wrapper 显式挂载两行 insert（提供方行带 `config: mode launch/headless`，Chromium 路径安装时探测）。默认安装：`mode: launch` 下每个存活 Session 各持一份浏览器客户端
  - Computer Use / Cua Driver native（无本地包）npm包 ×2：`@deepseek-ai/dsh-computer-use@0.2.2-rc.1`（独占桌面提供方注册服务）与 `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native@0.2.2-rc.1`（进程内 Cua Driver 原生桌面工具，工具名 `cua_driver_native__*`）；两包均不声明 `dsh.bundle.patch`，按普通依赖安装并由 wrapper 显式挂载两行 insert（原生提供方无配置，行不带 `config`；此提供方仅限 native 路线，同族的已安装 MCP 提供方不装、与 native 抢占唯一注册位）
- [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) npm包（v0.4.6；9 条 `@deepseek-ai/dsh*` peer 仍为 `^0.2.0-rc.1`，覆盖 0.2.2-rc.1 的准入闸门，无需精确版本例外；包内 `dsh.compatibility.dshReleases` 已把 `0.2.2-rc.1` 记为 compatible），默认安装：host 半 inject 为 `webServer / agentDefaultModel / credentials / llm / commands / connection`，`agentDefaultModel` 由 base bundle 提供，`connection` 供桌面模式的「打开 AI 设置」使用；client 半的本地 inject（`src/client/app.ts`）为 `slots / locale / connection / remote / remote.commands / commandUi`，其中 `commandUi`（官方 dsh-client-ui-commands 的「/」命令服务，随 web-app bundle 挂载）就绪后 `/pet` 选择框才注册；声明层 `dsh.client.inject` 只列 `@deepseek-ai/dsh-client-connection`（随 web-app bundle 挂载）；系统通知走 host 转发通道（host 半监听 `session/event` / `agent/error`，把帧落在 `/dsh-pet-7340/notify`，浏览器半每秒轮询该路由）。0.4.x 新增语音播报（`@andresaya/edge-tts`）、睡觉/说梦话、待办提醒、点击音效与系统托盘等，默认配置键由包内 `assets/config.jsonc` 提供；用户层配置为 `$DSH_HOME/dsh-pet/main-config.jsonc`（旧 `main-config.json` 仍被读取并迁移），安装后自动注入 `display:"web"` 屏蔽桌面 Electron 模式（见 [dsh-pet/README.md](dsh-pet/README.md)）
- [dsh-commandcode-provider](https://github.com/Mars-Sea/dsh-commandcode-provider) npm包（pin `0.17.3`，packageSpec `@mars-sea/dsh-commandcode-provider@0.17.3`；`engines.dsh` 改为析取区间 `>=0.2.1-rc.2 <0.2.2-0 || >=0.2.2-alpha.2 <0.2.3-0`，`0.2.2-rc.1` 落在第二段（`0.2.2-alpha.2 <= 0.2.2-rc.1 < 0.2.3-0`），其 `@deepseek-ai/dsh-*` peer 与 `dsh.compatibility.dshReleases`（已记 `0.2.2-rc.1` 为 compatible）同样放行，因此准入闸门自行接纳、不再需要精确版本例外（0.15.5 时代的例外已随 pin 撤销）；注意 0.16.0 起 `engines.node` 抬到 `>=24.9`，与本工程 harness 的 Node 下限一致；其 bundle 层插入 entry id `llm-commandcode`）
- [dsh-pause](https://github.com/better-er/dsh-pause) npm包（pin `0.1.8`；「DSH·暂停」：host 半在 `agent/pre-step` waterfall 上卡出暂停点（每个 turn 的首次请求不停、不打断在途调用），browser 半经 `conversation.input.right` slot 在 composer 工具行渲染开关与放行控件，会话开关默认关闭（Config `defaultEnabled`）；0.1.8 新增键盘 Pause 键切换，以及模型空闲且输入为空时连按两次回车的「强制继续」（经 `agent.followup` 送一条内容为空的唤醒消息，不产生用户消息）；RPC 走插件向 webServer 自注册的 `/dsh-pause` 前缀路由。manifest 无 `engines.dsh`，六条 `@deepseek-ai/dsh*` peer 均为 `^0.2.0-rc.2`，覆盖 0.2.2-rc.1 的准入闸门、无需例外（另有非 dsh 的 `@deepseek-ai/schemastery >=3.18.0` peer，不进准入闸门）；`engines.node` 声明 `>=26.3.1` 高于 harness 的 `>=24.9.0`，profile 未开 `engine-strict` 故只告警。包声明 `dsh.bundle.patch`，由 `dsh plugin add` reconcile 进 `dsh.profile.bundles` 并自挂载 entry `dsh-pause`）
- [dsh-skill-mcp-center](https://github.com/Max-Null/dsh-skill-mcp-center) npm包（pin `@max-null/dsh-skill-mcp-center@0.7.0`；仓库侧只有 wrapper 的 `install.mjs`，包以发布形态提供预构建 `dist/` 与 `client.js`，无构建步骤。host 半 inject 为 `loader` / `tools` 并从 `ctx.skills` 读取技能目录；client 半在设置页新增「Skill & MCP」分区，`dsh-better-sidebar` 存在时另在右侧栏提供 MCP 实时状态面板（可选 peer，本工程已安装）。manifest 无 `engines.dsh`，准入闸门按 `@deepseek-ai/dsh*` peer（`>=0.1.1-rc.1 <0.3.0`）放行 0.2.2-rc.1；声明 `dsh.bundle.patch`，entry id `skill-mcp-center`）
- [ds-harness-remote](https://github.com/liguobao/ds-harness-remote) npm包（pin `0.6.3`；DSH Remote：低延迟 P2P 端到端加密的远程访问插件，PC / 移动端 / Remote Web 可远程继续本机 Harness 会话与工作区，不开放公网监听端口、无需路由端口转发；host 半向官方 `tools` service 注册 `remote_*` 工具组（列出在线机器与工作区、读写 / 创建会话、收发消息、上下传文件），client 半在设置页提供 Remote 面板。开发基线为 `dsh-v0.2.2-rc.1`；manifest 无 `engines.dsh`，`@deepseek-ai/dsh*` peer 均为 `>=0.2.2-0 <0.2.3-0` 等多段区间，按 `includePrerelease` 覆盖 pinned 的 0.2.2-rc.1、无需精确版本例外；声明 `dsh.bundle.patch`，由 `dsh plugin add` reconcile 进 `dsh.profile.bundles` 并自挂载 entry `ds-harness-remote`：0.6.3 起只插这一行，上一版的 `ds-harness-remote-tui` 条件行与 dsh-tui 判定已移除（上游注明「dsh-TUI 集成推迟到后续版本」，本版本只出 Desktop / Web Host 面），不写手工 insert；`@roamhq/wrtc` 是可选原生 WebRTC 依赖（安装失败按 optional 跳过）。与内建 `dsh-remote` 的多后端 / SSH 隧道方案相互独立，可同时安装）

## Current plugins

- `remote` — in-tree plugin at `remote/dsh-remote`: multi-backend remote mode
  for the web GUI (connection tabs, new-connection page, SSH deploy, Docker
  exec connect). It
  declares `dsh.bundle.patch` and mounts through its own bundle layer (no
  manual cordis insert). See `remote/dsh-remote/docs/`.
- `better-sidebar` — npm wrapper whose `install.mjs` installs two upstream
  packages (`omdsh-dev/DSH-better-sidebar` and `ChenRuoT/dsh-sidebar-qa`) in
  order — `dsh-better-sidebar@0.30.1` FIRST (the 0.2.2 线适配版, 14 条
  peerDeps 全指 `^0.2.2-rc.1`；较 0.28.2 新增的 `dsh-client-ui-input-trigger`
  随 0.2.2-rc.1 的 web-app bundle 的 `ui-input-trigger` 行提供；host inject
  仍为 `webServer / sessions / connection / tools`，未再引用 rc.2 起已删除的
  `webRuntime`。固定精确版本而非 `@latest`，
  因为 pinned pnpm 11.7 默认 supply-chain minimumReleaseAge 会把过新的版本挡在
  `@latest` 之外、静默回退到更旧版本。0.30.0 起侧聊模型切换改走
  `agent.model.select()`，旧「`installModelSelection` 两参调用未适配 0.2.2」
  的记录已随之解除),
  then `dsh-sidebar-qa@1.2.2`
  (the same order ends up in `dsh.profile.bundles`; both are pinned to exact
  versions. `dsh-sidebar-qa` dropped the
  better-sidebar peer in v1.0.0, so its position only preserves the existing
  layout. **1.2.2 仍未适配**：`session.follow` 没传 `activate: true`，0.2.2 起
  跟随冷会话不再自动激活 agent，见 `install.mjs` 头部注释).
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
    repository. See the upstream repository.
  - `dsh-sidebar-qa` — select conversation text → right-panel follow-up
    question → a dedicated same-workspace session (`❓追问·<主题>`) that never
    interrupts the main conversation. Since v1.0.0 it is a native-only sidebar
    port that no longer declares `dsh-better-sidebar` as a peer (it resolves the
    host icon set by name after DSH 0.1.7 renamed it) and declares
    `dsh.bundle.patch`, so it mounts through its own bundle layer. 1.2.0 makes
    its settings persist (Config + volatile, addressed by the profile entry
    id); 1.2.1 moves the trust fence from the removed `webRuntime` to
    `webStartup`, fixing the LAN/`--trusted-host` 403 on `/sidebarqa/api`. See
    the upstream repository.
- `plugin-market` — npm wrapper for the visual plugin market (browse/search and
  one-click install of community plugins), installing `dshmarket@1.73.15`
  (exact pin; per the 安装方式 section; the version is a hard
  floor, because 1.66.4 admitted the 0.2 line and 1.65.3's
  `@deepseek-ai/dsh-settings` peer range is rejected by 0.2.2-rc.1's admission
  gate, which fails the install preflight; 1.70.0 made the market's own peer
  check admit prerelease host lines, 1.70.2 fixes the carrier-bundle toggle
  that could leave a half-written layer, and 1.73.x keeps the same peer
  disjunction while fixing update/repair paths and the catalog tarball watchdog;
  1.73.15 adds the Agent-safe deferred plugin mutation drain (#411) and Windows
  console text decoding (#1122)).
  `install.mjs` is the wrapper's only file. The package
  declares `dsh.bundle.patch`, so `dsh plugin add` mounts it
  through its own bundle layer. See the upstream repository.
- `commandcode-provider` — npm wrapper installing
  `@mars-sea/dsh-commandcode-provider@0.17.3` (exact pin). Its `engines.dsh` is
  now the disjunction `>=0.2.1-rc.2 <0.2.2-0 || >=0.2.2-alpha.2 <0.2.3-0`, so
  the pinned 0.2.2-rc.1 runtime lands in the second branch, its
  `@deepseek-ai/dsh-*` peers carry the same disjunction, and its
  `dsh.compatibility.dshReleases` records `0.2.2-rc.1` as compatible; the
  admission gate therefore admits the package and the exact-version exemption
  the 0.15.5 pin needed is gone (see the exception section above). Its
  `engines.node` is `>=24.9` since 0.16.0, matching the harness floor. The package
  declares `dsh.bundle.patch`, so it mounts through its own bundle layer
  (entry id `llm-commandcode`). See its `README.md`.
- `ai-update` — in-tree plugin at `ai-update/dsh-ai-update`: browser-half
  bridge behind the update dialog's AI update buttons. The desktop shell
  posts a `dsh-gui:ai-update` message into the embedded page, and the plugin
  returns to the new-session home, selects the dsh-gui workspace there, and
  prefills the update prompt (it never creates a session directly and never
  picks a preset). It declares `dsh.bundle.patch` and mounts through its own
  bundle layer (no manual cordis insert). See
  `ai-update/dsh-ai-update/docs/`.
- `opencode-session` — in-tree plugin at
  `opencode-session/dsh-opencode-session`: host-only plugin that injects the
  OpenCode per-conversation `x-opencode-session` header on LLM requests the
  loop does not stamp (auto-review and other hand-built auxiliary calls),
  clearing the opencode-go `400 MissingSessionID` rejection. The injected id is
  the initiating DSH session id — the same value the loop stamps — per the
  OpenCode "stable id per conversation" routing/prompt-cache contract. It
  declares `dsh.bundle.patch` and mounts through its own bundle layer (no
  manual cordis insert). Config: `providers`, `sessionIdMode`, and
  `fallbackSessionId`. See
  `opencode-session/dsh-opencode-session/README.md`.
- `deep-whale` — npm wrapper installing the published trio in upstream
  order (per the upstream INSTALL.md, which makes the npm packages the regular
  install path and scopes the bundled `dsh-skin-install` skill to legacy
  migration, local development builds, specified-commit testing and diagnosis):
  the persistent skin manager
  `@smalltailqwq/dsh-client-ui-skin-deep-whale-manager` plus the two
  mutually exclusive skins `maid-atelier` and `orca-link`
  (`@smalltailqwq/dsh-client-ui-skin-maid-atelier` /
  `@smalltailqwq/dsh-client-ui-skin-orca-link`, each MIT for its code and
  CC BY-NC-SA 4.0 for its artwork), pinned per package to each package's latest
  release: `orca-link` at `0.1.10`, the manager at `0.1.9`, and `maid-atelier`
  kept at `0.1.9` (not bumped this round). `orca-link` 0.1.10 narrows its peer to
  `@deepseek-ai/dsh >=0.2.2-0 <0.2.3-0` (the pinned `0.2.2-rc.1` satisfies that
  range) and records `dshCompatibility: 0.2.2rc1` in `skin.json` (a display-only
  "validated against" label the manager UI shows; the admission gate reads the
  package peers); `maid-atelier` 0.1.9 keeps `>=0.2.0-rc.2 <0.3.0-0`, and the
  manager's `>=0.1.7-rc.1` peer is satisfied, so no package needs an
  exact-version exemption. Every tarball ships its prebuilt `lib/` and its own
  `cordis.patch.yml`, so nothing is compiled or linked locally and each mounts
  through its own bundle layer (entry ids `ui-skin-deep-whale-manager`,
  `ui-skin-maid-atelier`, `ui-skin-orca-link`).
  Skin mutual exclusion is the manager's own job: on the first restart it detects
  "two skins enabled at once" and falls back to the official default, after which
  a skin is chosen in `设置 → 皮肤管理`; the wrapper pre-stages nothing. The
  wrapper also migrates installs made from GitHub before upstream 0.1.3, whose
  `@dsh-external/*` placeholder keys would otherwise leave two identities for the
  same skins. Current upstream tracks the native conversation geometry itself
  (`--maid-conversation-*`), so the palace backdrop and whale-girl art shrink
  out of any right/bottom panels generically. `install.mjs` is the wrapper's only
  file. See the upstream repository and the per-skin package READMEs.
- `dsh-web-ui` — npm wrapper installing three plugin packages of the
  distribution repo pinned to the exact versions of the upstream `0.4.16`
  release (per the
  安装方式 section above): the `dsh-web-ui-settings` compatibility bundle
  (`@linxin666/dsh-client-ui-web-ui-settings`, ordered first),
  `dsh-skill-explorer` (`@linxin666/dsh-client-ui-skill-explorer`) and
  `dsh-usage` (`@linxin666/dsh-usage`) — each mounts through its own
  `dsh.bundle.patch` layer. Model capabilities
  (`@linxin666/dsh-client-ui-model-capabilities`), the plugin-manager tab
  (`@linxin666/dsh-client-ui-plugin-manager`), the task board
  (`@linxin666/dsh-client-ui-task-board`) and the session-archive manager
  (`@linxin666/dsh-session-archive`) are not installed. It does not
  install agent presets or any other dsh-web-ui package. See
  `dsh-web-ui/README.md`.
- `dsh-pet` — npm wrapper installing `dsh-pet@0.4.6` from npm: a floating
  desktop pet whose host half runs inside
  DSH and whose optional desktop mode spawns per-pet transparent Electron
  windows. Its nine `@deepseek-ai/dsh*` peers are `^0.2.0-rc.1`, so
  0.2.2-rc.1's admission
  gate admits it and no exact-version exemption is granted (its
  `dsh.compatibility.dshReleases` now records `0.2.2-rc.1` as compatible); the
  wrapper then
  injects a user-layer default pet with `display:"web"` into
  `$DSH_HOME/dsh-pet/main-config.jsonc` (or the legacy `main-config.json` when
  that is the file on disk, unless a `display` is already
  configured) — so no pet resolves to `desktop`/`both` and no Electron helper
  process is launched or downloaded. It installs by default: the host half's
  injection is `webServer / agentDefaultModel / credentials / llm / commands /
  connection` (`agentDefaultModel` comes from the base bundle; `connection`
  backs the desktop-mode "open AI settings" action), the client half's own
  inject adds `commandUi` — the `/` command service `dsh-client-ui-commands`
  mounts with the web-app bundle, so the `/pet` selector registers — and
  system notifications are relayed through the host
  (`session/event` / `agent/error` consumed by the host half, polled by the
  browser half over `/dsh-pet-7340/notify`). 0.4.x adds voice playback
  (`@andresaya/edge-tts`), sleep / dream talk, todo reminders, a click sound and
  a tray option, whose default keys ship in the package's
  `assets/config.jsonc`. See `dsh-pet/README.md`.
- `skill-mcp-center` — npm-only wrapper installing
  `@max-null/dsh-skill-mcp-center@0.7.0` (exact pin; `install.mjs` is the
  wrapper's only file). The
  plugin adds a "Skill & MCP" settings section for browsing, enabling and
  deleting skills and for adding, editing, enabling and removing `mcp-client`
  servers (hot-applied through `ctx.loader`), plus an MCP live-status sidebar
  tab when `dsh-better-sidebar` is installed (optional peer, mounted here). Its
  host half injects `loader` and `tools` and reads the skill catalog from
  `ctx.skills`. The package declares `dsh.bundle.patch`, so `dsh plugin add`
  reconciles it into `dsh.profile.bundles` and it mounts through its own bundle
  layer (entry id `skill-mcp-center`). No `engines.dsh` is declared; the
  admission gate evaluates its `@deepseek-ai/dsh*` peers
  (`>=0.1.1-rc.1 <0.3.0`), which admit the pinned 0.2.2-rc.1 runtime without
  an exemption. See the upstream `README.md`.
- `dsh-pause` — npm-only wrapper installing `dsh-pause@0.1.8` (exact pin;
  `install.mjs` is the wrapper's only script). The plugin gates the agent
  right before the next model request of a tool round (the host half waits on
  the `agent/pre-step` waterfall; a turn's first request, step 1, is never
  paused and no in-flight call is interrupted) so the composer stays usable; a
  bare Enter in the main input or the pause control releases it, and a
  non-empty draft is carried along as a steering message. 0.1.8 adds the
  keyboard Pause-key toggle and a "force continue" gesture — with the agent
  idle and the input empty, pressing Enter twice sends an empty
  `runtime-context` wake-up message through `agent.followup` without recording
  a user message. The browser half
  renders the switch and control through the `conversation.input.right` slot,
  and the host half registers its `/dsh-pause` route on `webServer` (reusing
  the `connection` trust check) rather than the removed
  `connection.rpc.handle` API. Per-session switches default off (Config
  `defaultEnabled: false`). Its six `@deepseek-ai/dsh*` peers are
  `^0.2.0-rc.2`, which admit 0.2.2-rc.1 without an exact-version exemption
  (0.1.8 also adds a non-dsh `@deepseek-ai/schemastery >=3.18.0` peer, which
  the admission gate does not evaluate).
  `engines.node` is declared `>=26.3.1` (above the harness's `>=24.9.0`), but
  the profile runs pnpm without `engine-strict` and the prebuilt `lib/` uses
  no Node-26-only API. `dsh.client.inject` still names
  `@deepseek-ai/dsh-client-runtime`, which 0.2.2-rc.1 no longer ships —
  those are informational package edges (preflight/HMR), skipped when absent,
  so activation is unaffected. The package declares `dsh.bundle.patch`, so
  `dsh plugin add` reconciles it into `dsh.profile.bundles` and it mounts
  through its own bundle layer (entry id `dsh-pause`). See
  `dsh-pause/README.md`.
- `ds-harness-remote` — npm-only wrapper installing `ds-harness-remote@0.6.3`
  (exact pin; `install.mjs` is the wrapper's only file). DSH Remote continues
  the running Harness from another device over a low-latency, end-to-end
  encrypted P2P connection: the settings page hosts the Remote panel, and the
  host half registers the `remote_*` tool group (list online hosts and their
  workspaces, read/create/message sessions, upload/download files) when the
  official `tools` service is present. No public listener is opened and no
  router port forwarding is needed. Its development baseline is
  `dsh-v0.2.2-rc.1`. The package declares `dsh.bundle.patch`,
  so `dsh plugin add` reconciles it into `dsh.profile.bundles` and it mounts
  through its own bundle layer: entry `ds-harness-remote` only — 0.6.3 drops the
  previous `ds-harness-remote-tui` conditional row and its dsh-tui test
  (upstream defers dsh-TUI integration to a later release; this version ships
  the Desktop / Web Host surface only).
  No `engines.dsh` is declared; its `@deepseek-ai/dsh*` peers
  (`>=0.2.2-0 <0.2.3-0`) admit the pinned 0.2.2-rc.1 runtime under
  `includePrerelease` without an exemption. `@roamhq/wrtc` is an optional
  native WebRTC dependency (pnpm skips it when unavailable). Independent of
  the in-repo `dsh-remote` multi-backend/SSH-tunnel mode; both can be
  installed. See the upstream repository and https://dsh.r2049.cn/app.
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
    `@deepseek-ai/dsh-browser-use@0.2.2-rc.1` (the exclusive browser-use
    provider registration service, `ctx.browserUse`) and
    `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp@0.2.2-rc.1`
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
    `@deepseek-ai/dsh-computer-use@0.2.2-rc.1` (the exclusive computer-use
    provider registration service, `ctx.computerUse`) and
    `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native@0.2.2-rc.1`
    (in-process desktop tools via the Cua Driver native npm SDK
    `@trycua/cua-driver@0.28.0`, surfaced as `cua_driver_native__<tool>`).
    Neither declares `dsh.bundle.patch`, so the wrapper mounts both plain
    packages by hand: two `cordis.patch.yml` insert rows (id `computer-use` /
    `computer-use-cua-driver-native`), neither carrying `config` because the
    native provider takes no configuration. Only the native route is
    installed; the sibling installed-MCP computer-use provider is not, since
    both contend for the single `ctx.computerUse` registration slot.
    See `harness/README.md`.
