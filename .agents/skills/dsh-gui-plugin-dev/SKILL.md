---
name: dsh-gui-plugin-dev
description: 'Use when adding, migrating, building, debugging, or reviewing a plugin under the dsh-gui `plugins/` tree, when writing or changing a `plugins/<id>/install.mjs` wrapper (an npm-pinned wrapper or an in-tree source plugin), and when deciding whether a feature must depend on dsh-gui. Covers the current plugin directory layout and install-script pattern, then routes plugin-authoring questions to the deepseek-harness submodule docs and reference examples.'
whenToUse: 在 dsh-gui 仓库 `plugins/` 下新增、迁移、构建、调试、审查插件，写或改 `plugins/<id>/install.mjs`，决定插件以 npm 发布包还是内嵌源码形态接入，或判断某功能是否必须依赖 dsh-gui 时使用。插件本体编写问题交给 deepseek-harness 子模块文档与示例工程。
---

# dsh-gui 插件开发

本 skill 只负责 dsh-gui 这一层：插件如何放进 `plugins/`、如何以 npm 精确 pin 的发布包或内嵌源码接入、如何写
`install.mjs`、如何挂载到 web profile。插件本体怎么写，以 `deepseek-harness/`
子模块中的官方文档与示例工程为准（见下方「阅读地图」）。

## 0. 首要设计规则：优先做纯净 harness 插件

> **除非必须与其他插件协作，或必须与 dsh-gui 对接才能实现功能，否则优先设计为
> 脱离 dsh-gui、基于原生 deepseek-harness 纯净版的插件。**

落实为以下硬性约束：

- 新功能默认做成一个普通 deepseek-harness 插件/bundle：只用 Cordis 的 `apply(ctx)`、
  `inject`、`ctx.*` 服务、`cordis.patch.yml` 和标准 `dsh.client`/`dsh.bundle` 声明。
- 插件代码不得 import dsh-gui 仓库里的任何模块，不得假设进程由 `dsh-gui.exe` 启动、
  不得假设 `DSH_HOME` 是仓库根下的 `.dsh`（它属于运行时根）、不得依赖 `src-tauri/` 或 `plugins/` 目录结构。
- dsh-gui 只负责「构建 + 安装 + 挂载」，是分发层，不是插件运行时的前置条件。
- 只有当功能确实依赖其他插件协作，或必须接入 dsh-gui 原生壳（例如 Tauri 标题栏、
  `remote_call`、本地 backend 启动这类 GUI 对接）时，才允许写 dsh-gui 耦合。
  这种例外必须在插件 README/docs 中写明原因，并尽量把耦合隔离在 client/宿主对接薄层，
  其余逻辑仍按纯净 harness 插件设计。
- 验收问题：**“这个插件能否在不装 dsh-gui、只 clone deepseek-harness 的环境里，通过
  `dsh plugin add` 或 `--patch` 加载运行？”** 答案应是能；只有明确豁免项才允许回答不能。

## 1. dsh-gui 的插件目录结构与来源形态

真源（先读，不要重复抄写）：

- 根目录 [`plugins/README.md`](../../../plugins/README.md) —— wrapper 布局与当前插件清单。
- 根目录 [`README.md`](../../../README.md#adding-plugins-at-runtime) —— 安装流水线说明。
- [`scripts/plugin-install.mjs`](../../../scripts/plugin-install.mjs) —— 共享安装流水线的唯一实现。
- [`scripts/dsh-gui.mjs`](../../../scripts/dsh-gui.mjs) —— build/setup 如何发现并执行各 `install.mjs`。
- [`.gitmodules`](../../../.gitmodules) —— 当前子模块的真实记录（`deepseek-harness` 与 `src-tauri/whale-icon`，两者都不是插件）。

### 1.1 wrapper 布局

每个一级目录是一个插件 wrapper，目录名即 `install.mjs` 里的 `id`：

```text
plugins/
├─ README.md
├─ <id>/
│  ├─ install.mjs                 # 只描述“这个插件怎么落地”，不含插件业务代码
│  └─ <package>/                  # 仅 in-tree 源码插件有：package.json、源码、docs
└─ harness/                       # 官方插件组：install.mjs 按序加载平铺的 *.mjs
```

npm 型 wrapper 只有 `install.mjs`：包从 registry 安装，仓库内不保留源码 checkout。

当前实例对照：

| wrapper | 来源形态 | 特殊处理 |
|---|---|---|
| `remote`、`ai-update`、`opencode-session` | in-tree 源码（`<id>/<package>`） | 有 `build` 脚本；`dsh.bundle.patch` 自挂载（patch 行 id 与 `dsh.gui.mountId` 一致） |
| `mcp-on-demand` | in-tree 源码 | 无 `build` 脚本，包按发布形态直接 `link:`；`dsh.bundle.patch` 自挂载 |
| `auto-update`、`desktop-tabs` | in-tree 源码 | 只装 desktop profile：`DSH_PLUGIN_PROFILE` 不是 `desktop` 时跳过 |
| `better-sidebar`、`deep-whale`、`dsh-web-ui` | npm 发布包（一个 wrapper 多个包） | 每包一个精确 pin；`dsh.bundle.patch` 自挂载 |
| `plugin-market`、`dsh-pet`、`skill-mcp-center` | npm 发布包（单包） | `dsh.bundle.patch` 自挂载；`dsh-pet` 装后另注入用户配置 |
| `commandcode-provider` | npm 发布包（单包） | pin 的 dsh 依赖区间不接纳当前 runtime，wrapper 用 `exempt` 授予精确版本例外 |
| `harness` | 官方 `@deepseek-ai/dsh-*` npm 包组 | 平铺的 `browser-use.mjs` 与 `computer-use.mjs` 各装两个包；包不声明 bundle patch，由显式 `mount` 写 insert 行 |

靠提示词与现有工具完成的用户级指令（例如 `/review`）做成 skill，不要建 wrapper：
源文件放 `global_template.agents/skills/<name>/SKILL.md`，构建安装到
`$DSH_HOME/skills/`（运行时根的 `.dsh/skills/`）；只有需要注册 service、工具或命令的能力才写成插件。

### 1.2 两种来源

**npm 发布包（本仓库当前多数插件）**：插件在独立仓库维护并发布到 npm，wrapper 只写
`install.mjs`，用 `installNpmPlugin` 安装精确 pin 的版本；仓库内不保留源码 checkout。
升级时改 `packageSpec` 并重跑 wrapper（见 skill `dsh-gui-update`）。

**内嵌（in-tree）**：插件源码直接随 dsh-gui 仓库提交，适合 dsh-gui 自有插件；wrapper
用 `installPlugin` 构建并以 `link:` 安装。

可选能力：第三方源码也可以用 git submodule 引入，再以 `installPlugin` 指向该 checkout，
多包仓库把 `packageDir` 指向更深一层的包目录。这条路径需要同时维护 [`.gitmodules`](../../../.gitmodules)
与子模块指针，本仓库当前没有这种 wrapper。

## 2. install.mjs 模式

共享流水线在 [`scripts/plugin-install.mjs`](../../../scripts/plugin-install.mjs)；
每个 wrapper 只声明自己的 id、安装目标（npm spec 或本地包路径）和少量例外。

### 2.1 最小模板

npm 型：

```js
import { installNpmPlugin } from '../../scripts/plugin-install.mjs'

installNpmPlugin({
  id: 'my-plugin',                       // = plugins/<id> 目录名
  packageSpec: 'dsh-my-plugin@1.2.3',    // 精确 pin；更新面板按该字面量检测与改写
})
```

in-tree 型：

```js
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPlugin } from '../../scripts/plugin-install.mjs'

const here = dirname(fileURLToPath(import.meta.url))

installPlugin({
  id: 'my-plugin',                       // = plugins/<id> 目录名
  packageDir: join(here, 'dsh-my-plugin'),
})
```

`installNpmPlugin` 的选项：

| 选项 | 含义 |
|---|---|
| `id` | wrapper 目录名，也是安装日志与定位 id |
| `packageSpec` | `<包名>@<精确版本>` 的 npm spec，必须以字符串字面量出现在脚本里 |
| `mount` | 显式 mount 行；仅用于不声明 `dsh.bundle.patch` 的包（当前 `harness` 官方插件组用它写带 `config` 的 insert 行） |
| `skip` | wrapper 声明的默认跳过：`true` 或原因字符串；`DSH_PLUGIN_FORCE_INSTALL=1` 强制安装，`DSH_PLUGIN_SKIP` 追加跳过 |
| `exempt` | 精确版本兼容例外的原因；pin 声明的 dsh 依赖区间不接纳当前 runtime 时使用 |

`installPlugin` 的选项：

| 选项 | 含义 |
|---|---|
| `id` | wrapper 目录名，也是安装日志与定位 id |
| `packageDir` | 插件包的绝对路径；不存在时报错 |
| `sourceHint` | `packageDir` 缺失时在报错中给出的恢复提示；只用于 wrapper 带本地 checkout 但缺文件的场景，本仓库当前没有这种 wrapper |
| `mount` | 显式 mount 行 `{ id, name }`；覆盖从 manifest 派生的值 |
| `build` | 默认 `true`。设为 `false` 表示“包声明了 build，但本仓库应使用其预构建产物” |

> 自带 `dsh.bundle.patch` 的包不要用显式 `mount` / wrapper 级 `cordis.patch.yml`：让包作为
> bundle 层自己挂载（`dsh plugin add` 自动 reconcile 进 `dsh.profile.bundles`）。wrapper 级
> `cordis.patch.yml` 手工 insert 会与 bundle 层撞出 `duplicate loader entry id`。

### 2.2 共享安装流水线做什么

`npm run install:plugins`（别名 `npm run plugins`）按目录名字典序执行所有
`plugins/*/install.mjs`；`npm run build` / `npm run setup` 也会在构建后执行同一批脚本。
目标 profile 由 `DSH_PLUGIN_PROFILE` 选择（默认 `web`），desktop 构建传 `desktop`。
每个脚本最终走共享流水线：

1. **自托管工具链**：先 bootstrap 仓库固定的 pnpm（`.toolchain/`，store 固定为
   `.pnpm-store/`）。
2. **固定 profile store**：写 profile 的 `pnpm-workspace.yaml` 的 `storeDir`，避免普通终端
   与桌面壳环境因 home 变量不同而 `ERR_PNPM_UNEXPECTED_STORE`。
3. **in-tree 包**：包有 `build` 脚本且未 `build: false` 时，在包目录内执行
   `pnpm install --store-dir <runtime-root>/.pnpm-store` + `pnpm run build`；没有 `build`
   脚本的包按已发布形态直接使用（预构建 `lib/` 或纯配置包）。随后执行
   `dsh plugin --profile <profile> add link:<packageDir>`；`link:` 使下一次启动直接看到
   包目录里的改动。
4. **npm 包**：执行 `dsh plugin --profile <profile> add <packageSpec>` 从 registry 安装，
   并把包名记录到 `.dsh/gui/npm-installs.json`。精确 pin 已安装且挂载状态完好时跳过整次
   安装；`npm run rebuild`（`DSH_PLUGIN_REBUILD=1`）强制重装。
5. **挂载 entry**：
   - 若包 `package.json` 的 `dsh.bundle.patch` 有值：`dsh plugin add` 会把它 reconcile 进
     `dsh.profile.bundles`，其 bundle 层自己插入 entry，安装脚本**不写**
     `cordis.patch.yml`，否则会双挂载。
   - 否则向 profile 的 `cordis.patch.yml` 幂等追加一个 `- insert:` 行；mount 值取显式
     `mount`，否则 `id` 取 `package.json` 的 `dsh.gui.mountId ?? packageName.replace(/^dsh-/, '')`，
     `name` 取包名。

命令里的 `dsh` 是按 [`harness.json`](../../../harness.json) 解析出的 CLI：`npm` 运行时在
运行时根的 `.harness/`，`source` 运行时用子模块的 `apps/cli/lib/bin.js`（见
[`docs/dsh-gui/harness-runtime.md`](../../../docs/dsh-gui/harness-runtime.md)）。

约束：

- 安装脚本必须幂等，重复执行结果一致（共享流水线按 entry id 去重）。
- 只写 `DSH_HOME`（缺省 `<runtime-root>/.dsh`），不写系统全局位置。
- npm 型 wrapper 的 `packageSpec` 必须是 `<包名>@<精确版本>` 字符串字面量：desktop
  更新面板按字面量生成插件行并就地改写版本，从文件读取或用拼接构造的 spec 不会被检测
  与更新（见 `plugins/README.md` 的安装方式约定）。
- 准入闸门读取包声明的 dsh 版本要求（`engines.dsh`，没有时比对 `@deepseek-ai/dsh*`
  peer 区间）：区间不接纳当前 runtime 时 `dsh plugin add` 拒绝安装，只有
  `installNpmPlugin` 的 `exempt` 能授予精确版本例外，例外按包版本与 runtime 版本精确
  绑定。
- 安装产物都在 gitignored 的 `.dsh/` 里；源码侧不要手改
  `.dsh/profiles/web/cordis.patch.yml` 后把运行时状态当源提交。
- 插件集合变更通常要重启 dsh-gui（或 harness）后生效。

### 2.3 package.json 的 dsh-gui 相关约定

```jsonc
{
  "name": "dsh-my-plugin",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",            // host 半
    "./client": "./lib/client.js",    // browser 半（有 UI 时必需）
    "./package.json": "./package.json"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "*"        // 以及所需 harness 服务、react 等
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" }, // 可选：bundle 自挂载
    "client": { "platform": "web", "inject": ["..."] }, // 可选：web client 半
    "gui": { "mountId": "my-plugin" }  // dsh-gui 本地约定：entry id；可省略
  }
}
```

注意区分三层：

- `dsh.bundle.patch` 与 `dsh.client` 是 harness 的公开 manifest 约定。
- `dsh.gui.mountId` 是 dsh-gui 共享安装器读取的本地约定，只影响
  `.dsh/profiles/web/cordis.patch.yml` 里的 entry id，不是 harness 概念。
- bundle patch 的 mount 行才是“插件在 Loader 里成为 entry”的正式机制；
  dsh-gui 对无 bundle patch 的普通包补写等价的用户 patch 行。

## 3. 插件本体开发技术要点

先查 harness 官方文档再写代码。不要凭 Cordis API 记忆，也不要把 dsh-gui 的本地
wrapper 约定误当成 harness 插件模型。

### 3.1 基础：Cordis 插件模型

- 插件 = `export function apply(ctx)` 模块（可带 `inject`、`Config` schema）。
- `inject` 声明服务依赖，框架按依赖就绪顺序加载；加载失败走 Fiber FAILED。
- 所有注册（工具、路由、事件监听、效果）都必须可撤销：优先 `ctx.effect(() => disposer)`。
- 与其它插件通信用 typed events：`emit` / `waterfall` / `parallel` / `serial`。

### 3.2 选对扩展点，再写代码

| 要做的事 | 正确入口 | 参考 |
|---|---|---|
| 给模型加一个工具 | `inject: ['tools']`，`ctx.tools.register(...)` | [`basic/tool.md`](../../../deepseek-harness/docs/user/develop/basic/tool.md) |
| 给 web GUI 加 host HTTP/WS 路由 | `inject: ['webServer']`，`ctx.webServer.register/registerUpgrade` | [`host/webserver`](../../../deepseek-harness/packages/host/webserver/README.md) |
| 给 web GUI 加界面 | 声明 `dsh.client` + 导出 `./client`，用 `ctx.slots` 注册 slot | [`subsystems/client-modules.md`](../../../deepseek-harness/docs/subsystems/client-modules.md)、[`client/README.md`](../../../deepseek-harness/packages/client/README.md) |
| 拦截请求/工具/回合 | 监听 `agent/*`、`tools/*` 事件，waterfall 必须调用 `next()` | [`architecture.md`](../../../deepseek-harness/docs/architecture.md) |
| 可替换能力 | Service Definition / Provider / Consumer 三角色 seam | [`capability-seams.md`](../../../deepseek-harness/docs/capability-seams.md) |
| 新的事件/持久状态 | 先读 producer/consumer 契约，新增 durable session event 必须可回放 | [`event-producer-consumer.md`](../../../deepseek-harness/docs/event-producer-consumer.md) |
| 配置 | `Config` 类型 + Schemastery schema，默认值放 schema | [`basic/config.md`](../../../deepseek-harness/docs/user/develop/basic/config.md) |
| 打包分发 | `dsh.bundle.patch` + `dsh plugin add`，git 安装的 `prepare`/`allowBuilds` 问题 | [`basic/publish.md`](../../../deepseek-harness/docs/user/develop/basic/publish.md) |
| 加 harness 内部包 | 遵循 packages 分组与 README/JSDoc 规则 | [`packages/README.md`](../../../deepseek-harness/packages/README.md)、[`cookbook/adding-a-package.md`](../../../deepseek-harness/docs/cookbook/adding-a-package.md) |

### 3.3 阅读地图（deepseek-harness 子工程）

**入门路径（按顺序）**

1. [`docs/user/develop/basic/index.md`](../../../deepseek-harness/docs/user/develop/basic/index.md) —— 第一个 Harness 插件。
2. [`docs/user/develop/basic/config.md`](../../../deepseek-harness/docs/user/develop/basic/config.md) —— 插件配置。
3. [`docs/user/develop/basic/tool.md`](../../../deepseek-harness/docs/user/develop/basic/tool.md) —— 注册模型工具。
4. [`docs/user/develop/basic/publish.md`](../../../deepseek-harness/docs/user/develop/basic/publish.md) —— bundle 打包、profile 安装、层顺序。

**框架与生命周期**

- [`docs/cordis-primer.md`](../../../deepseek-harness/docs/cordis-primer.md) —— Cordis 五概念、四种 dispatch、waterfall。
- [`docs/cordis-tutorial/index.md`](../../../deepseek-harness/docs/cordis-tutorial/index.md) —— 可运行的分章教程（第 7 章接入真实 harness 服务）。
- [`docs/user/develop/framework/index.md`](../../../deepseek-harness/docs/user/develop/framework/index.md) —— Fiber 生命周期。
- [`docs/user/develop/framework/service.md`](../../../deepseek-harness/docs/user/develop/framework/service.md) —— 服务与 `inject`。
- [`docs/user/develop/framework/events.md`](../../../deepseek-harness/docs/user/develop/framework/events.md) —— 事件系统。

**架构与扩展点**

- [`docs/architecture.md`](../../../deepseek-harness/docs/architecture.md) —— profile/bundle、核心服务、turn flow、扩展点速查表。
- [`docs/capability-seams.md`](../../../deepseek-harness/docs/capability-seams.md) —— `ctx.*` 服务图。
- [`docs/event-producer-consumer.md`](../../../deepseek-harness/docs/event-producer-consumer.md) —— 事件生产/消费全景。
- [`docs/tool-execution-pipeline.md`](../../../deepseek-harness/docs/tool-execution-pipeline.md) —— 工具执行管线。
- [`packages/README.md`](../../../deepseek-harness/packages/README.md) —— 包分组、命名、依赖规则。
- [`AGENTS.md`](../../../deepseek-harness/AGENTS.md) —— 子工程开发约定与检查命令。

**Web/Client 插件**

- [`docs/subsystems/client-modules.md`](../../../deepseek-harness/docs/subsystems/client-modules.md) —— `dsh.client` 声明如何变成 `/plugins/<id>/client.js` 与 `window.__DSH_BOOT__`。
- [`packages/client/README.md`](../../../deepseek-harness/packages/client/README.md) —— browser 半包族与 ui-slots 入口。
- [`packages/client/ui-slots/README.md`](../../../deepseek-harness/packages/client/ui-slots/README.md) —— slot 注册契约。
- [`packages/host/webserver/README.md`](../../../deepseek-harness/packages/host/webserver/README.md) —— host HTTP/upgrade 路由。
- [`docs/api-gateway.md`](../../../deepseek-harness/docs/api-gateway.md) —— host 服务暴露给 browser 半的机制（需要时）。

**参考工程与示例（抄模式前先读）**

- [`packages/experimental/webhook-github/examples/github-review/cordis.yml`](../../../deepseek-harness/packages/experimental/webhook-github/examples/github-review/cordis.yml) —— 可选 overlay 接入 GitHub webhook 评审，配套指南 [`docs/user/guide/github-review.md`](../../../deepseek-harness/docs/user/guide/github-review.md)。
- [`apps/cli/config/examples/mcp-memory/`](../../../deepseek-harness/apps/cli/config/examples/mcp-memory) —— 三份默认关闭的第三方记忆 MCP 参考配置，配套指南 [`docs/user/guide/mcp-memory.md`](../../../deepseek-harness/docs/user/guide/mcp-memory.md)。
- [`docs/user/develop/practice/dynamic-cordis.md`](../../../deepseek-harness/docs/user/develop/practice/dynamic-cordis.md) —— 用提示词把持久化组合包写进当前 profile，运行时检查与挂载的自指示例。
- [`docs/user/guide/schedule.md`](../../../deepseek-harness/docs/user/guide/schedule.md) —— Schedule 提醒的创建、修改与投递语义。
- [`apps/cli/README.md`](../../../deepseek-harness/apps/cli/README.md) 的「入口模式」与「可选覆盖层」两节 —— `dsh` 各启动形态与 overlay 的权威清单；无 GUI 形态用 `dsh --profile headless` 验证。
- 各 profile 的组合测试与 patch fixture 在 [`apps/cli/tests/profiles/`](../../../deepseek-harness/apps/cli/tests/profiles/)；这些 `cordis.yml`/`*.patch.yml` 与包内 `tests/fixtures/` 是比指南更直接的复制起点。

### 3.4 开发与验证顺序

1. **先在纯净 harness 里做出来并验证**：按上面入门路径写包，用 `dsh plugin add` 或
   `--patch` 在临时 profile 里加载；需要 GUI 时用 harness 自己的 `dsh web`。
2. **再决定是否需要 dsh-gui 例外**：不需要就到此为止，后续只加 wrapper 分发；
   需要就在文档里写明理由并控制耦合面。
3. **加 dsh-gui wrapper**：按第 1、2 节创建 `plugins/<id>/install.mjs`——npm 型只写精确
   pin，in-tree 型再建包目录并交给 `installPlugin`；不要为安装而改 harness 本体。
4. **构建验证**：先保证 harness 已构建（首次 `npm run setup`），再跑
   `npm run install:plugins`；之后查看每个 wrapper 输出的
   `installed plugin '<id>'`，并核对 profile 的 `cordis.patch.yml`
   或 `dsh.profile.bundles` 中的挂载结果。也可用 harness 的
   `--dump-config` 检查最终组合。
5. **重启生效**：重启 dsh-gui/harness，确认插件出现且无 FAILED fiber。

## 4. 文档与提交

- in-tree 插件同步维护 `plugins/<id>/<package>/docs/`；npm 型 wrapper 在
  `plugins/<id>/README.md` 说明来源包、pin 版本与升级方式，上游文档以发布包内的
  `README.md` 与 `docs/` 为准。
- wrapper 的 `install.mjs` 顶部注释应说明：包来源（npm 包名 / in-tree）、pin 版本与升级
  方式、是否预构建、mount 来源（bundle patch 自挂载 / 显式 `mount` / manifest 派生）、
  `DSH_HOME` 约束。
- 提交遵循 Conventional Commits；安装脚本与 pin 变更一起提交，不提交 `.dsh/`、
  `.toolchain/`、`.pnpm-store/` 等运行期/缓存目录。
