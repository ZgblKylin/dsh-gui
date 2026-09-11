# Harness 升级记录：dsh-v0.1.2-rc.1 → dsh-v0.1.5-rc.2

## 背景

`deepseek-harness` 子模块由 `dsh-v0.1.2-rc.1`（`a66e4702`）升级到 `dsh-v0.1.5-rc.2`（`fb2c4b9e`）。该跨度为两个产品系列（`0.1.3`、`0.1.5`），上游在 `0.1.5-rc.1` 的发布说明中把 `v0.1.2-rc.1` 以来的全部用户与开发者变更汇总为一篇，因此本次升级的兼容面比常规补丁升级更大。

按 skill `dsh-gui-update` 的两阶段约定，升级先在 `.staging/dsh-gui` 副本中完成并验证，通过后才实装到本工程。副本验证位置与命令见 [upgrade-staging-workspace.md](upgrade-staging-workspace.md)。

## 需要的适配

`presets/review/agent.cordis.yml` 的 persona 行配置键由 `text` 改为 `prefix`。

`@deepseek-ai/dsh-persona` 的配置在 `0.1.5` 系列拆分为前缀与后缀两个 prompt 区段（`deployment:persona-prefix`、`deployment:persona-suffix`），`prefix` 为必填，`suffix` 默认空串。旧键 `text` 既不再是识别字段，也使必填的 `prefix` 缺失，该 preset 组合无法加载。新 `prefix` 区段的排序值与原 `deployment:persona` 区段同为 `0`，因此把整段审阅提示词放入 `prefix` 与升级前的呈现位置一致，无需拆分为 `suffix`。

`presets/review/agent.cordis.yml` 是 `standard` preset 的定制副本。除 persona 外，它与 `dsh-v0.1.5-rc.2` 的 `standard` 还相差 `command-goal` 与 `present` 两行：前者在升级前就已省略，后者是本次上游新增的 `@deepseek-ai/dsh-tool-present` 行。两者都不影响该 preset 的加载，本次未改动。

### 验证

- `.staging/dsh-gui` 内 `npm run build -- --skip-exe` 退出码为 `0`，harness 构建、8 个插件安装脚本与 preset 安装全部完成。
- `node .staging/dsh-gui/deepseek-harness/apps/cli/lib/bin.js --profile web --dump-config` 渲染出 167 条 loader row，无 `duplicate loader entry id`、无缺失插件、无 patch 报错；15 个插件包全部出现在组合中。
- persona 配置键 `prefix` 通过 `@deepseek-ai/dsh-persona` 的新 Config 校验，旧键 `text` 被拒绝并报 `$.prefix missing required value`；`review` preset 的 29 条 row 全部解析到 `dsh-v0.1.5-rc.2` 的 workspace 包。

## 对本仓库的影响

### desktop 外壳（`src-tauri`）

外壳与 harness 的运行时契约未变，`src-tauri` 无需改动：启动参数 `node <bin> web --port <port> --no-open`、stdout 的 `dsh web: http://127.0.0.1:<port>/?token=<43 字符 base64url>` 行、401／303／200 的浏览器认证序列、`$DSH_HOME/profiles/<profile>` 布局、`dsh plugin --profile <p> add/remove` 与 `update.rs` 对 `package.json` 与 `packages/**` 的扫描均照旧。`packages/client/connection/src/browser-auth.ts` 在两个 tag 之间逐字节相同。

`DshBundleManifest` 已从 `packages/boot/app-boot/src/profile.ts` 迁至 `packages/util/package-manifest/src/types.ts`，`app-boot` 不再导出该类型。`AGENTS.md` 的官方依据条目与 `docs/official` 的符号链接清单已按新位置更新，并新增 `docs/official/package-manifest-types.ts`。

### 插件

`agent` 是本次唯一被移除的 Cordis 服务（对应上游「移除 `ctx.agent`」）。本仓库的插件与已安装的第三方插件都没有引用它；其余 104 个服务全部保留，另有 7 个新增（`documentPreviews`、`fileUpload`、`fileUploads`、`resources`、`sessionFeedback`、`sidebarRight`、`sidebarRightTabs`、`workspaceFiles`）。

Web 端 slot 树在 `0.1.5` 系列重组：根级 `conversation` 变为 `main.conversation`，根级 `details` 被移除并代之以新的 `rightbar` 子树。本仓库在用的 slot——`settings.section`、`settings.plugin.item`、`shell.overlay`、`conversation.chat.turnTail`——在新树中全部保留，没有任何插件注册到被移除的键上。

浏览器端的模块基线只在 `PLATFORM_MODULES` 中新增了 `@deepseek-ai/dsh-client-ui-dockkit`。对全部已安装插件包的产物做外部依赖扫描后，实际请求的裸模块只有 `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-client-ui-primitives`，全部命中新基线；没有任何产物在运行期请求已被移除的 `@deepseek-ai/dsh-client-runtime`。

逐个插件的结论：

| 插件 | 结论 | 依据 |
| --- | --- | --- |
| `ai-update`（`dsh-ai-update`） | 兼容 | 宿主的 `llm.stream`、`GenerateOptions`、`StreamChunk`（含 `finish.reason.kind` 的 `error`／`aborted`）、`webServer.register`、`agentDefaultModel.currentSelection`、`loader.entries` 均未变；浏览器半的 `sessions`、`workspaces`、`uiWorkspace.connectWorkspace`、`conversation.input.for().setDraft`、`ctx.remote.agentPresets.select` 均未变 |
| `remote`（`dsh-remote`） | 兼容 | 仅依赖 `webServer`（`{kind, path, handler}` 与 disposer 未变）与浏览器半的 `slots`；不触达 `agent`、Inbox、`agentLoop`、Session 持久化。SSH／Docker 的就绪探测已按 401／303 语义判定，与新 harness 一致 |
| `review`（`dsh-review`） | 兼容 | 使用 `ctx.commands.register`（`input.hint`、`recordInput`、`CommandResult` 未变）与 handler 显式收到的 `agent.inject`／`agent.steer`；消息 `source.form: 'instructions'` 仍是合法取值。产物不 import 任何 `@deepseek-ai/*` 运行期模块 |
| `better-sidebar` 三包 | 兼容 | 注册 `settings.section` 与 `conversation.chat.turnTail`，注入 `['webServer', 'sessions', 'webRuntime', 'tools']`，四者均在新 harness 中提供 |
| `plugin-market`（`dshmarket`） | 兼容 | 注册 `settings.section`、`settings.plugin.item`、`shell.overlay`，注入 `['slots', 'locale', 'theme']` |
| `dsh-pet` | 兼容 | 注册 `shell.overlay` 与 `settings.section`，注入 `['webServer', 'agentDefaultModel', 'credentials', 'llm', 'commands']`；产物在运行期只额外请求 `electron`（可选桌面模式） |
| `dsh-web-ui` 四包 | 兼容 | 只请求基线条目 `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-client-ui-primitives` |
| `deep-whale` 三皮肤 | 兼容 | 只请求 `react` 与 `react/jsx-runtime` |

因此本次升级不需要屏蔽任何插件，`scripts/plugin-install.mjs` 与各 wrapper 的跳过声明均未改动。

## 运行期注意事项

**会话数据格式为单向升级。** `dsh-v0.1.2-rc.1` 写入的 `SESSION_FORMAT_VERSION` 为 `0`，`dsh-v0.1.5-rc.2` 为 `3`。首次以新 harness 打开旧会话时，harness 通过 `session-format-v0-to-v1`、`v1-to-v2`、`v2-to-v3` 逐级迁移，生成新版日志并保留原文件；新版日志不支持降级读取。回滚到 `dsh-v0.1.2-rc.1` 后，升级期间新写入的会话将无法读取，回滚前请先备份 `.dsh/sessions/`。

**Node 版本下限提高到 24.2。** `apps/cli/src/bin.ts` 现以 `if (import.meta.main) await runCli()` 作为入口守卫，而 `import.meta.main` 由 Node 22.18.0 与 24.2.0 起提供。在 Node 24.0 或 24.1 上，`bin.js` 会静默退出且退出码为 `0`，外壳随即报告 `harness exited before becoming ready (status exit status: 0)`。harness 自身的 `engines` 仍写作 `^22.19.0 || >=24.0.0`，比其实际要求更宽；本仓库 `README.md` 的环境要求已按 `^22.19 || >=24.2` 记录。

**Linux 与 macOS 构建新增 C 编译器前置。** harness 的 `scripts/build.ts` 在构建 lib 与 web 之前先执行 `build:native-system`。该步骤在 Windows 上以 `--host-addon-only` 直接返回，在 Linux 与 macOS 上则编译 `flock`，需要 `cc`（musl 环境需要 `musl-gcc`）。

**新会话的默认模型。** `0.1.5` 系列把 base bundle 的默认模型改为 `deepseek-flash`（DeepSeek-V41-Flash）。本机 `.dsh/settings.yaml` 的 `agent-default-model` 显式指定 `deepseek-official` / `deepseek-v4-flash-vision-exp`，配置值优先，该默认不会生效。

## 相关文件

- `presets/review/agent.cordis.yml` —— persona 配置键的适配
- `AGENTS.md`、`docs/official/package-manifest-types.ts` —— `DshBundleManifest` 的新位置
- `README.md` —— Node 版本下限
- `.agents/skills/dsh-gui-update/SKILL.md` —— 两阶段升级流程
- `docs/dsh-gui/upgrade-staging-workspace.md` —— 副本的位置、维护与冒烟检查
- `docs/dsh-gui/2026-08-30-harness-upgrade-v0-1-2-alpha-1-build-failure.md` —— 上一次 harness 升级的事故复盘
