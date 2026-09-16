# dsh 运行时（harness runtime）

## 用途

`harness.json` 决定本仓库运行的 dsh CLI 来自哪里：`npm` 用 registry 安装的 `@deepseek-ai/dsh`，`source` 编译 `deepseek-harness` 子模块。外壳、构建 CLI、插件安装器与 `npm run harness` 共用同一份解析契约：JS 侧实现在 `scripts/harness-runtime.mjs`，Rust 侧实现在 `src-tauri/src/harness.rs`，两侧在清单文件、环境变量名与解析路径上保持一致。

## 清单

`harness.json` 位于仓库根并受版本管理：

```json
{
  "runtime": "npm",
  "version": null
}
```

`runtime` 取 `npm` 或 `source`，默认为 `source`；文件缺失时同样按 `source` 处理，使早于该清单的检出继续本地编译。

`version` 是精确的 npm 版本，或 `null`；为 `null` 时从 `deepseek-harness/apps/cli/package.json` 的 `version` 推导。发布契约让仓库根清单、`apps/cli` 与 dsh family 的每个已发布包共用同一版本，子模块则钉在对应的发布 tag 上；读清单同时避免启动子进程，这类子进程在 dsh 文件沙箱下会因管道 stdio 被拒绝。

清单不是合法 JSON、`runtime` 取值未知、或 npm 模式下无法推导版本时，解析报错并中止。

## 两种运行时

### npm

CLI 安装在 `<repo>/.harness/`，入口是 `.harness/node_modules/@deepseek-ai/dsh/lib/bin.js`，工作目录是 `.harness/`。

`deepseek-harness/` 下的内容不参与编译，子模块只提供版本与规范。

### source

入口是 `deepseek-harness/apps/cli/lib/bin.js`，工作目录是 `deepseek-harness/`。

`version` 在该模式下不参与路径解析，只记录清单或环境变量给出的值。

## 环境变量覆盖

| 变量 | 作用 |
| --- | --- |
| `DSH_HARNESS_RUNTIME` | 覆盖 `runtime`，取 `npm` 或 `source`，其他值报错 |
| `DSH_HARNESS_VERSION` | 覆盖 `version`，指定精确版本 |
| `DSH_HARNESS_INSTALL_DIR` | npm 安装目录，相对仓库根或绝对路径，默认 `.harness` |
| `DSH_HARNESS_BIN` | 覆盖 CLI 入口路径，优先级最高；工作目录仍由运行时决定 |
| `DSH_HARNESS_REBUILD` | 取值为 `1` 时强制重建或重装运行时，等同 `--force-harness` |
| `DSH_HARNESS_ALLOW_BUILDS` | 逗号分隔的包名，把 `.harness/pnpm-workspace.yaml` 中对应的 `allowBuilds` 决策改为 `true` |

表内前四项由 JS 与 Rust 两侧读取，最后两项只在构建 CLI 中生效。空白值按未设置处理。

## 构建行为

`npm run build` 与 `npm run setup` 先解析运行时，再按运行时分支：

- `npm`：不编译 harness。`pnpm add @deepseek-ai/dsh@<version>` 装入 `.harness/`，已装同版本时跳过安装，也跳过其后的清理与记录。实际发生（重）安装时，清理 `<DSH_HOME>/profiles/web/.dsh-module-fallback/node_modules` 下指向 `deepseek-harness/` 源码树的链接，并把 `@deepseek-ai/dsh` 记入 `<DSH_HOME>/gui/npm-installs.json`，供更新检查识别这个 npm 安装。
- `source`：在子模块内执行 `pnpm install --store-dir <repo>/.pnpm-store`（`setup` 额外带 `--frozen-lockfile`）、`pnpm run clean` 与 `pnpm run build`；完成后把子模块 revision 记入 `<DSH_HOME>/gui/harness-build.json`，内容为 `runtime`、`revision`、`version` 与 `builtAt`。

source 模式以 revision 为增量判据：`harness-build.json` 记录的 revision 与当前子模块一致、且 `apps/cli/lib/bin.js` 存在时，跳过 `pnpm install`、`pnpm run clean` 与 `pnpm run build`。revision 从子模块 `.git` gitfile 指向的 gitdir 的 `HEAD` 读取；检出停留在分支而非游离 HEAD 时读不到 revision，该构建按过期处理并重建。

`--force-harness`（`npm run build -- --force-harness`）或 `DSH_HARNESS_REBUILD=1` 强制重建或重装运行时；`--skip-harness` 跳过整个运行时步骤。

`<DSH_HOME>` 默认是仓库的 `.dsh`，可用 `DSH_HOME` 覆盖，上述状态文件随之改址。

## `.harness` 项目布局

`ensureHarnessProject` 每次构建重写 `.harness/pnpm-workspace.yaml`，并在缺失时生成私有的 `.harness/package.json`。工作区文件包含三项关键设置：

- `nodeLinker: hoisted`，与 profile 模板一致，让 CLI 看到单一扁平的 `node_modules`。
- `autoInstallPeers: true`：registry 安装必须物化源码工作区由自身 workspace 包满足的 peer 边，否则 CLI 会因找不到 `@deepseek-ai/cordis-plugin-group` 之类的包而启动失败。
- `allowBuilds` 对七个带 lifecycle script 的包显式写布尔值：`koffi`、`node-pty`、`node-addon-require-builtin`、`sharp`、`@google/genai`、`protobufjs`、`@deepseek-ai/dsh-subprocess-local`，默认全部为 `false`。这些包的编译产物已随包发布，无需执行生命周期脚本；dsh 文件沙箱也拒绝 spawn 构建脚本（`spawn EPERM`）。

`DSH_HARNESS_ALLOW_BUILDS` 可把指定项改为 `true`。工作区文件每次构建都会重写，因此该环境变量才是持久的改动方式；缺少决策时 pnpm 会写入非布尔的占位值，后续安装随之失败。

## 子模块的角色

`deepseek-harness/` 是 pinned 上游子模块，提供版本与规范；npm 模式下只读取 `apps/cli/package.json` 的版本，子模块不编译。禁止编辑其中的任何文件，也禁止向插件源码复制其中的代码。

## 升级流程

harness 升级先由更新对话框把子模块 fast-forward 到新 tag，再运行 `node scripts/dsh-gui.mjs build`；build 按新检出的 `apps/cli/package.json` 版本从 registry 安装对应包。

`npm-installs.json` 记有 `@deepseek-ai/dsh`，更新检查因此把 deepseek-harness 行视为 npm 安装型条目，核对最新 tag 是否已有对应的 npm 发布；该核对只作为对话框附注，不影响行的更新徽标判定。流程见 skill `dsh-gui-update`，验证位置见 [upgrade-staging-workspace.md](upgrade-staging-workspace.md)。

## 限制与风险

- `@deepseek-ai/dsh` 的 `latest` dist-tag 落后于预发布（`0.1.6-alpha.1` 发布在 `alpha`），因此只能按精确版本安装，不能依赖 `latest`。
- 上游只验收 `dsh --version`；端到端启动仍由本仓库 `.staging` 副本的冒烟检查负责（`--profile web --dump-config`）。
- `.harness/` 中带 install 或 postinstall 脚本的包需要 pinned pnpm 的 `allowBuilds` 决策，未决策会让后续安装失败。
- npm 模式失去修改 harness 源码或以源码启动它的能力；按 `AGENTS.md`，子模块本来就不允许修改。

## 相关文件

- `harness.json` —— 运行时清单
- `scripts/harness-runtime.mjs` —— JS 侧的解析契约与 `.harness` 项目生成
- `src-tauri/src/harness.rs` —— Rust 侧的同一契约
- `scripts/dsh-gui.mjs` —— build 与 setup 的运行时分支、`--force-harness`
- `scripts/plugin-install.mjs` —— 插件安装用同一解析结果调用 `dsh plugin add`
- `scripts/harness.mjs` —— `npm run harness` 的前台启动
- `src-tauri/src/main.rs` —— 外壳启动 dsh 与更新日志使用的 CLI 路径
- `src-tauri/src/about.rs` —— 关于对话框的运行时版本行
- `docs/dsh-gui/update-check.md` —— npm 发布状态判定
