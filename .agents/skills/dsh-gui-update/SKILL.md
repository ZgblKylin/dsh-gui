---
name: dsh-gui-update
description: 'Use when updating a dsh-gui module to a newer upstream revision — the deepseek-harness engineering base or a plugin module under plugins/ — and when validating that upgrade before it reaches the working repository. Covers the persistent staging clone (.staging/dsh-gui via scripts/staging.mjs), the staging-first two-phase flow, plugin masking, the post-upgrade install-script audit, the npm publish state of npm-installed wrappers, reporting and commit-message drafting, and the sandbox elevation rule.'
whenToUse: 需要把 deepseek-harness 或某个插件模块升级到更新的上游修订（最新 tag 或最新提交）、需要在实装前先验证、或更新对话框的「AI 更新」把升级提示词预填到会话后落地该流程时使用。
---

# dsh-gui 模块更新

本 skill 把本仓库依赖的模块升级到更新的上游修订：工程基座 `deepseek-harness`，以及 `plugins/<id>/` 下各插件的上游仓库。升级分两个阶段执行，阶段一在持久化副本中验证，阶段二才在本工程实装。

## 0. 铁律：先验证，后实装

- 阶段一在副本 `.staging/dsh-gui` 中更新、构建与冒烟检查；阶段二在本工程实装。本工程正在服务运行中的 dsh-gui，一次失败的升级会让它无法启动，副本验证正是为了在改动本工程之前暴露这类问题（事故复盘见 [`docs/dsh-gui/2026-08-30-harness-upgrade-v0-1-2-alpha-1-build-failure.md`](../../../docs/dsh-gui/2026-08-30-harness-upgrade-v0-1-2-alpha-1-build-failure.md)）。
- 阶段一全部通过之前，禁止改动本工程的子模块指针、插件安装与构建产物。
- 一次只推进一个明确目标：更新目标是「最新 tag」还是「最新提交」，由用户在更新对话框按行选择，或由用户直接指定。
- `deepseek-harness/` 是 pinned 上游子模块，只用于查证规范：禁止编辑其中任何文件，也禁止从该目录向插件源码复制代码。

## 1. 权威来源

| 来源 | 内容 |
| --- | --- |
| [`src-tauri/ui/app.js`](../../../src-tauri/ui/app.js) | 产品内 AI 更新提示词：`buildHarnessUpdatePrompt`（仅 harness）、`buildHarnessMergedPrompt`（harness 与插件批量）、`buildAiUpdatePrompt`（插件单模块与批量）、`buildHarnessValidationSteps`（两阶段步骤骨架）、`buildHarnessAuditStep`（安装脚本速查）、`buildCommitMessageStep`（提交信息草稿） |
| [`docs/dsh-gui/upgrade-staging-workspace.md`](../../../docs/dsh-gui/upgrade-staging-workspace.md) | 副本的位置、维护命令、远端语义、副本内构建与冒烟检查 |
| [`docs/dsh-gui/update-check.md`](../../../docs/dsh-gui/update-check.md) | 更新检查的判定规则与 npm 发布状态 |
| [`AGENTS.md`](../../../AGENTS.md) | 开发约定、插件开发规范、插件市场约束、bundle 加载注意事项、提交规范 |
| [`plugins/README.md`](../../../plugins/README.md) | 各 wrapper 的安装方式标注与来源形态 |

产品内提示词要求 agent 在系统临时目录建立一次性副本再验证；本 skill 改用持久化副本 `.staging/dsh-gui`，步骤与判定标准与提示词一致。

## 2. 更新目标与跳过规则

- **tag 目标**：`git -C <path> fetch --prune origin`，再用 `git -C <path> describe --tags --abbrev=0 origin/<默认分支>` 取得远端默认分支可达的最新 tag，然后检出该 tag。
- **提交目标**：远端默认分支的最新提交，子模块用 `git -C .staging/dsh-gui submodule update --remote <path>`，或在该模块目录内 `fetch origin` 后检出 `origin/<默认分支>`。
- **跳过**：模块当前正好检出于某个 tag，而远端只有更新的提交、没有更新的 tag 时，保持其 tag 版本，不要把它更新到非 tag 提交，并在报告中说明原因。产品内该状态对应 `announce === false`（[`src-tauri/src/update.rs`](../../../src-tauri/src/update.rs) 的 `check_project`）。
- **顶层仓库本体**不进入本流程：更新对话框对顶层行直接执行 git 层更新（顶层快进加子模块递归同步），随后由 `npm run build` 重建。

## 3. 阶段一：副本内验证（不碰本工程）

1. 同步副本：`npm run staging -- sync`（副本尚不存在时先运行 `npm run staging -- ensure`）。副本工作区必须干净；本工程的未提交改动不会进入副本，需要一并验证时先在副本中重做同样的编辑，或导出为 patch 应用。
2. 在副本中把目标模块更新到目标修订，操作同第 2 节的两种目标。
3. 分析该版本的影响：新增、变更或移除的功能、配置与依赖，以及本仓库插件需要跟进适配的点（组合方式、插件 API、bundle 契约）。以 `AGENTS.md` 与 [`docs/official/`](../../../docs/official) 为依据。
4. 在副本中完成适配修改并验证：改动本仓库侧的插件源码、适配代码与安装脚本（不涉及 `deepseek-harness/` 内文件），然后运行副本内的 `npm run build -- --skip-exe`，必须全绿；需要一并验证入口 exe 时用 `npm run build`。
5. 冒烟检查组合：用副本的 harness CLI 以 `--profile web --dump-config` 渲染配置树（命令见副本说明文档），确认没有 `duplicate loader entry id`、缺失插件或 patch 报错。
6. 屏蔽确认与新版不兼容且本次无法修复的插件，并从 profile 的挂载与依赖条目中移除，使其不参与本次验证的安装：
   - npm 安装型 wrapper：以 `DSH_PLUGIN_SKIP=<wrapper id>` 跳过本次安装，或把 wrapper 的 `skip` 声明改为默认跳过；[`scripts/plugin-install.mjs`](../../../scripts/plugin-install.mjs) 的 `skipInstall` 是唯一判定处，`DSH_PLUGIN_FORCE_INSTALL=1` 强制安装。
   - 源码构建与 link 安装型 wrapper：在其 `plugins/<id>/install.mjs` 顶部加 MASKED 守卫。
   - 逐条记录屏蔽原因与恢复条件（例如等上游适配）。
7. 记录修复清单：每一项适配改动对应的文件、结论与验证命令及结果，供阶段二逐文件同步。

## 4. 阶段二：在本工程实装（阶段一全部通过后进行）

1. 把本工程的目标模块更新到阶段一确认的修订。
2. 逐文件同步副本中验证过的适配改动：核对差异后复制或应用，禁止整目录覆盖，避免带入 `.dsh/`、`.toolchain/`、`.pnpm-store/`、`node_modules/` 等 gitignore 产物。
3. 从本工程的已安装状态中卸载被屏蔽的插件：移除 profile 的挂载与依赖条目并删除对应 node_modules 链接，避免后续 Loader 组合重新加载它。卸载流程见 skill `dsh-plugin-uninstall`。
4. 在本工程重建：`npm run build`。入口 exe 被运行中的 dsh-gui 占用时可以加 `--skip-exe`，但 harness 构建与各插件安装脚本必须执行，使插件基于新的 harness 重新构建与安装。
5. 执行第 5 节的安装脚本速查。
6. 汇报，并在末尾给出 commit message 草稿：为本次更新的每个模块各准备一条外层仓库的 submodule bump 提交信息，主题行遵循 `AGENTS.md` 的 Conventional Commits 约定，模板为 `feat(submodule): bump <模块名> from <旧版本/旧提交> to <新版本/新提交>`，需要时在其下方空一行写正文。只生成消息文本，禁止替用户执行 `git commit`。

## 5. 安装脚本速查

对 `plugins/` 下每个未被 mask 的插件（跳过 `install.mjs` 顶部带 MASKED 守卫、或以 `skip` 声明默认跳过的条目）逐一核对其安装脚本是否与最新官方规范一致。依据：`AGENTS.md`、[`docs/official/`](../../../docs/official)、`plugins/README.md` 的安装方式标注，以及 skill `dsh-plugin-install`。

| 核对要点 | 期望状态 |
| --- | --- |
| 安装方式 | 与 `plugins/README.md` 的安装方式标注一致：源码安装为「源码构建（`pnpm install` 加 `pnpm run build`）后以 `link:` 引入」，其余为 `dsh plugin --profile web add <npm 包>` |
| 挂载方式 | 声明 `dsh.bundle.patch` 的包经自身 bundle 层挂载，不手工插入 `cordis.patch.yml` |
| 市场约束 | 精确稳定的 SemVer 版本；无 `preinstall`、`install`、`postinstall`、`prepare` 生命周期脚本；`engines.node` 接受 Node LTS；`files` 白名单只含必要产物 |
| 流水线 | 经 `scripts/plugin-install.mjs` 共享流水线安装，无越出仓库、绕过流水线或改动无关配置的步骤 |

发现不一致时先停下向用户报告，不要擅自修改。

## 6. 通过标准、失败与回滚

全部满足才算完成：

- 副本内 `npm run build` 全绿，含 harness 构建与各插件安装脚本；
- 副本的 `--profile web --dump-config` 能渲染组合；
- 不兼容插件已屏蔽，原因与恢复条件已记录；
- npm 安装型 wrapper 的 npm 发布状态已核对（判据见 `docs/dsh-gui/update-check.md`）；
- 本工程重建后各插件与 agent preset 安装无异常。

验证失败时先在副本中修正重试，不要带着失败的升级改动回到本工程。本工程需要回滚时，把对应模块检回旧修订后重建：

```powershell
git -C deepseek-harness checkout <旧修订>
git -C plugins\<id>\<package> checkout <旧修订>
npm run build
```

顶层仓库自身的回滚用 `git reset --hard <旧提交>`，随后同样执行 `npm run build`。

## 7. 沙箱与提权

- 在 dsh 沙箱会话中，副本的 `ensure`、`sync` 以及副本内的子模块操作会被拦截（Windows 上 `git submodule` 与本地传输依赖 Cygwin `sh.exe`）。按 `AGENTS.md` 的提权规则，通过工具以最窄的足够宽模式申请一次放行；普通终端不需要提权。
- 副本内的构建同样会被拦截：pnpm 执行依赖的生命周期脚本时 `spawn EPERM`。处理方式相同——申请提权，禁止用非标手段绕过。
- 会话工作区必须是本仓库（含 `plugins/`、`presets/`、`deepseek-harness/` 的目录）；副本位于 `.staging/` 下，会话仍以本工程为工作区。

## 8. 相关 skill

| 场景 | skill |
| --- | --- |
| 把插件安装进 profile、源码编译安装 | `dsh-plugin-install` |
| 卸载插件、清理 profile 与 submodule 残留 | `dsh-plugin-uninstall` |
| 插件 wrapper、子模块接线、安装脚本改动 | `dsh-gui-plugin-dev` |
| agent preset 的改动与安装 | `dsh-gui-preset-dev` |
| Cordis 组合与 preset 组合的编写与校验 | `editing-cordis-compositions` |

## 9. 常见坑

- **harness 子模块的残留构建产物**：升级后旧的 `lib/` 与 `node_modules/` 会被 tsdown 的 workspace glob 当成构建目标，报 `MISSING_EXPORT` 并中止构建。副本从干净检出安装，能提前暴露该问题；本工程的修复见事故复盘。
- **子模块指针漂移**：本工程记录的修订与子模块工作区 HEAD 不一致时，`git status` 显示 ` M <path>`；实装要让两者一致，否则本工程处于半升级状态。
- **移动了 checkout 却没有重跑安装**：`link:` 安装指向包目录，包需要重新构建才会生效，因此实装阶段必须执行 `npm run build`。
- **npm 安装型 wrapper 的发布滞后**：仓库 tag 可能早于 npm 发布，只移动 submodule checkout 不会更新已安装的插件本体。
- **副本不含未提交改动**：本工程有待提交的改动时，副本验证的不是将要实装的状态。
