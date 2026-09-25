---
name: dsh-gui-update
description: 'Use when updating a dsh-gui module to a newer upstream revision — the deepseek-harness engineering base or a plugin module under plugins/ — and when validating that upgrade before it reaches the working repository. Covers the persistent staging clone (.staging/dsh-gui via scripts/staging.mjs), the staging-first two-phase flow, the phase-one acceptance gate (the staging WebUI must actually load; a harness update additionally gets a computer-use check that the GUI starts and runs) and the user approval required before phase two, the ban on building or installing inside the running checkout (phase two only syncs install scripts and submodule pins, then hands the rebuild back to the user), plugin masking, the post-upgrade install-script audit, the npm publish state of npm-installed wrappers and of the dsh runtime, reporting and commit-message drafting, and the sandbox elevation rule.'
whenToUse: 需要把 deepseek-harness 或某个插件模块升级到更新的上游修订（最新 tag 或最新提交）、需要在实装前先验证、需要在实装阶段避免改动正在运行的 dsh 实例、或更新对话框的「AI 更新」把升级提示词预填到会话后落地该流程时使用。
---

# dsh-gui 模块更新

本 skill 把本仓库依赖的模块升级到更新的上游修订：工程基座 `deepseek-harness`，以及 `plugins/<id>/` 下各插件的上游仓库。升级分两个阶段执行，阶段一在持久化副本中验证，阶段二才在本工程实装。

## 0. 铁律：先验证，后实装

- 阶段一在副本 `.staging/dsh-gui` 中更新、构建、冒烟检查与验收；阶段二在本工程实装。本工程正在服务运行中的 dsh-gui，一次失败的升级会让它无法启动，副本验证正是为了在改动本工程之前暴露这类问题（事故复盘见 [`docs/dsh-gui/2026-08-30-harness-upgrade-v0-1-2-alpha-1-build-failure.md`](../../../docs/dsh-gui/2026-08-30-harness-upgrade-v0-1-2-alpha-1-build-failure.md)）。
- 更新、构建与安装只在副本中进行。副本自带独立的 DSH_HOME（`.staging/dsh-gui/.dsh`），全部产出落在副本内。禁止在本工程执行任何构建或安装动作（`npm run build`、各插件的 `install.mjs`、`dsh plugin add`，以及直接写入本工程 `.dsh/` 的改动）：这些动作会改写正在运行的 dsh 实例的 profile、插件与 preset，使其损坏到无法操作。
- 阶段二因此只写本工程中受版本管理的文件：安装脚本、插件源码适配与子模块指针。本工程的重新构建由用户在停止运行中的实例后自行执行，会话只负责通知，不代跑。
- 阶段一全部通过之前，禁止改动本工程的子模块指针、插件安装与构建产物。
- 阶段一验收全部通过后，先向用户报告验证结论（副本路径、目标修订、验证命令与结果、适配改动清单、屏蔽项与未决风险），取得用户明确审批后才进入阶段二实装；用户未批准前不得改动本工程受版本管理的文件。
- 一次只推进一个明确目标：更新目标是「最新 tag」还是「最新提交」，由用户在更新对话框按行选择，或由用户直接指定。
- `deepseek-harness/` 是 pinned 上游子模块，只用于查证规范：禁止编辑其中任何文件，也禁止从该目录向插件源码复制代码。

## 1. 权威来源

| 来源 | 内容 |
| --- | --- |
| [`src-tauri/ui/app.js`](../../../src-tauri/ui/app.js) | 更新对话框预填的提示词：`AI_UPDATE_SKILL`（手势常量 `/dsh-gui-update`）、`buildHarnessUpdatePrompt`（仅 harness）、`buildHarnessMergedPrompt`（harness 与插件批量）、`buildAiUpdatePrompt`（单模块与插件批量）。提示词只给出模块名、路径、当前版本、更新目标，以及 skill 无法从对话框得知的验收门槛 `AI_UPDATE_GATE_NOTE`（副本 WebUI 必须能正确加载；含 harness 时另用 computer use 验证 GUI；报告并经用户审批后才实装）；分步流程由本 skill 承载 |
| [`docs/dsh-gui/upgrade-staging-workspace.md`](../../../docs/dsh-gui/upgrade-staging-workspace.md) | 副本的位置、维护命令、远端语义、副本内构建与冒烟检查 |
| [`harness.json`](../../../harness.json) 与 [`docs/dsh-gui/harness-runtime.md`](../../../docs/dsh-gui/harness-runtime.md) | dsh 运行时的选择与版本来源；harness 升级后由 build 按子模块 `apps/cli/package.json` 的版本安装 CLI |
| [`docs/dsh-gui/update-check.md`](../../../docs/dsh-gui/update-check.md) | 更新检查的判定规则与 npm 发布状态 |
| [`AGENTS.md`](../../../AGENTS.md) | 开发约定、插件开发规范、插件市场约束、bundle 加载注意事项、提交规范 |
| [`plugins/README.md`](../../../plugins/README.md) | 各 wrapper 的安装方式标注与来源形态 |

更新对话框的「AI 更新」预填的草稿以 `/dsh-gui-update` 开头：host 侧的 `dsh-tool-skill` 会把本 skill 的内容注入会话，因此本 skill 就是升级流程的权威步骤。手势名称取自 `src-tauri/ui/app.js` 的 `AI_UPDATE_SKILL` 常量；重命名本 skill 时必须在同一改动中同步该常量。

## 2. 更新目标与跳过规则

- **tag 目标**：`git -C <path> fetch --prune origin`，再用 `git -C <path> describe --tags --abbrev=0 origin/<默认分支>` 取得远端默认分支可达的最新 tag，然后检出该 tag。
- **提交目标**：远端默认分支的最新提交，子模块用 `git -C .staging/dsh-gui submodule update --remote <path>`，或在该模块目录内 `fetch origin` 后检出 `origin/<默认分支>`。
- **跳过**：模块当前正好检出于某个 tag，而远端只有更新的提交、没有更新的 tag 时，保持其 tag 版本，不要把它更新到非 tag 提交，并在报告中说明原因。产品内该状态对应 `announce === false`（[`src-tauri/src/update.rs`](../../../src-tauri/src/update.rs) 的 `check_project`）。
- **顶层仓库本体**不进入本流程：更新对话框对顶层行直接执行 git 层更新（顶层快进加子模块递归同步），随后由用户执行 `npm run build` 重建。

## 3. 阶段一：副本内验证（不碰本工程）

1. 同步副本：`npm run staging -- sync`（副本尚不存在时先运行 `npm run staging -- ensure`）。副本工作区必须干净；本工程的未提交改动不会进入副本，需要一并验证时先在副本中重做同样的编辑，或导出为 patch 应用。
   - **动手前先把副本重置到与本工程一致的版本状态**：`git -C .staging/dsh-gui status` 必须干净，且 `git -C .staging/dsh-gui submodule status` 的每个指针与 `git -C . submodule status` 对应项相同。上一次验证可能把副本留在别的修订，或留下未跟踪残留（临时脚本、被删插件的目录），那样这次验证的基线就不是"将要实装的状态"。`sync` 只快进顶层，不清理这些；用 `git -C .staging/dsh-gui reset --hard` 加 `git -C .staging/dsh-gui submodule update --init --recursive` 拉回，再删除未跟踪残留，然后才动手。
   - **副本内的每一条 `node` / `dsh` / `install.mjs` 调用都必须显式设置 `DSH_HOME`**：见第 9 节的同名条目。
2. 在副本中把目标模块更新到目标修订，操作同第 2 节的两种目标。
3. 分析该版本的影响：新增、变更或移除的功能、配置与依赖，以及本仓库插件需要跟进适配的点（组合方式、插件 API、bundle 契约）。以 `AGENTS.md` 与 [`docs/official/`](../../../docs/official) 为依据。
4. 在副本中完成适配修改并验证：改动本仓库侧的插件源码、适配代码与安装脚本（不涉及 `deepseek-harness/` 内文件），然后运行副本内的 `npm run build -- --skip-exe`，必须全绿；本次更新包含 `deepseek-harness` 时必须去掉该标记跑 `npm run build`，因为它要一并构建第 7 步验证的入口 exe。
   - `harness.json` 的 `runtime` 为 `npm`（仓库当前取值）时，本步按子模块 `apps/cli/package.json` 的版本从 registry 安装 dsh CLI，不编译子模块；子模块快进后必须重跑 build 才会换到新版本。
5. 组合冒烟检查：用副本的 dsh CLI 以 `--profile web --dump-config` 渲染配置树（命令见副本说明文档），确认没有 `duplicate loader entry id`、缺失插件或 patch 报错。这一步只是验收的前置条件，通过它不等于验证通过。
6. **WebUI 加载验收（必做，阶段一的通过基准）**：「验证通过」指副本的 WebUI 能正确加载出来——构建全绿与配置 dump 无报错都不算。以副本自身的 DSH_HOME 在**空闲端口**启动副本的 web 后端，再确认界面真的渲染出来：

   ```powershell
   cd .staging\dsh-gui
   $env:DSH_GUI_PORT = "3090"   # 空闲端口：正在运行的 dsh-gui 占着 3080
   npm run harness              # scripts/harness.mjs：副本 .dsh 为 DSH_HOME，副本 .dsh\.agents 为 DSH_AGENTS_HOME
   ```

   在 `http://127.0.0.1:3090`（或所选空闲端口）确认会话界面正常渲染、能新建或载入会话、插件与组合没有加载失败提示或错误覆盖层；在 agent 会话中以后台任务启动它，确认手段不限（浏览器或 computer use），但必须以真实渲染结果为准，不能只看进程起来了。确认后结束该实例，不要把端口或 profile 留给后续步骤复用。
7. **GUI 启动运行验收（仅当本次更新包含 `deepseek-harness`）**：harness 换代可能让桌面外壳起不来，因此还要用 computer use 验证 GUI 能正常启动和运行。副本内 `npm run build`（不带 `--skip-exe`）已产出副本根目录的入口 exe，用空闲端口启动副本自己的 exe，再用 computer use 观察真实窗口：

   ```powershell
   cd .staging\dsh-gui
   $env:DSH_GUI_PORT = "3090"
   npm start                    # 副本的 scripts/dsh-gui.mjs run：启动副本根目录的入口 exe
   ```

   确认窗口出现、加载页过渡到标签页、harness 就绪、能正常交互（打开设置或新建会话即可），随后关闭该实例。副本 exe 从自身路径解析仓库根与 `.dsh`（[`src-tauri/src/main.rs`](../../../src-tauri/src/main.rs) 的 `repo_root`），与正在运行的实例互不干扰；唯一会冲突的是端口（`ensure_loopback_port_available`），因此必须换端口。
8. 屏蔽确认与新版不兼容且本次无法修复的插件，并从 profile 的挂载与依赖条目中移除，使其不参与本次验证的安装：
   - npm 安装型 wrapper：以 `DSH_PLUGIN_SKIP=<wrapper id>` 跳过本次安装，或把 wrapper 的 `skip` 声明改为默认跳过；[`scripts/plugin-install.mjs`](../../../scripts/plugin-install.mjs) 的 `skipInstall` 是唯一判定处，`DSH_PLUGIN_FORCE_INSTALL=1` 强制安装。
   - 源码构建与 link 安装型 wrapper：在其 `plugins/<id>/install.mjs` 顶部加 MASKED 守卫。
   - 逐条记录屏蔽原因与恢复条件（例如等上游适配）。
9. 记录修复清单：每一项适配改动对应的文件、结论与验证命令及结果，供阶段二逐文件同步。

## 4. 阶段二：在本工程实装（阶段一验收通过并经用户审批后）

本阶段只改本工程中受版本管理的文件，不执行构建或安装，也不改动本工程 `.dsh/` 中的已安装状态（见第 0 节）。

0. 先确认两件事都已发生：阶段一验收全部通过，且用户已明确审批本次实装。把验证结论、改动清单与风险报告给用户后等待其答复；用户未批准（或尚未答复）时停在这里，不要改动本工程。
1. 把本工程的目标模块更新到阶段一确认的修订。
2. 逐文件同步副本中验证过的适配改动：核对差异后复制或应用，禁止整目录覆盖，避免带入 `.dsh/`、`.toolchain/`、`.pnpm-store/`、`node_modules/` 等 gitignore 产物。
3. 执行第 5 节的安装脚本速查。
4. 汇报并通知用户重新构建，列出：
   - 本次同步的文件与子模块指针；
   - 被屏蔽插件在本工程的卸载动作：移除 profile 的挂载与依赖条目并删除对应 node_modules 链接，避免后续 Loader 组合重新加载它（卸载流程见 skill `dsh-plugin-uninstall`）；
   - 重新构建命令 `npm run build`：入口 exe 被运行中的 dsh-gui 占用时可以加 `--skip-exe`，但构建与卸载都由用户在停止运行中的实例后执行。
5. 在末尾给出 commit message 草稿：为本次更新的每个模块各准备一条外层仓库的 submodule bump 提交信息，主题行遵循 `AGENTS.md` 的 Conventional Commits 约定，模板为 `feat(submodule): bump <模块名> from <旧版本/旧提交> to <新版本/新提交>`，需要时在其下方空一行写正文。只生成消息文本，禁止替用户执行 `git commit`。

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

- 副本内 `npm run build` 全绿，含 dsh 运行时的安装或构建与各插件安装脚本；
- 副本的 `--profile web --dump-config` 能渲染组合；
- **副本的 WebUI 已实际加载验收通过**：在空闲端口启动副本 web 后端后，会话界面正常渲染、无插件或组合的加载报错；
- **本次更新包含 `deepseek-harness` 时，副本的入口 exe 已用 computer use 验证能正常启动和运行**；
- **用户已明确审批阶段二实装**；
- 不兼容插件已屏蔽，原因与恢复条件已记录；
- npm 安装型 wrapper 与 dsh 运行时的 npm 发布状态已核对（判据见 `docs/dsh-gui/update-check.md`）；
- 本工程已更新到阶段一确认的修订，验证过的安装脚本与适配改动已逐文件同步；
- 已通知用户重新构建，构建结果与重建后各插件、agent preset 的安装由用户确认。

阶段一验收未全部通过、或用户尚未审批时，不得进入阶段二。验证失败时先在副本中修正重试，不要带着失败的升级改动回到本工程。本工程需要回滚时，把对应模块检回旧修订，然后同样通知用户重新构建：

```powershell
git -C deepseek-harness checkout <旧修订>
git -C plugins\<id>\<package> checkout <旧修订>
```

顶层仓库自身的回滚用 `git reset --hard <旧提交>`，随后同样通知用户重新构建。

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

- **`source` 运行时下 harness 子模块的残留构建产物**：升级后旧的 `lib/` 与 `node_modules/` 会被 tsdown 的 workspace glob 当成构建目标，报 `MISSING_EXPORT` 并中止构建。副本从干净检出安装，能提前暴露该问题；本工程的修复见事故复盘。
- **子模块指针漂移**：本工程记录的修订与子模块工作区 HEAD 不一致时，`git status` 显示 ` M <path>`；实装要让两者一致，否则本工程处于半升级状态。
- **移动了 checkout 却没有重跑安装**：`link:` 安装指向包目录，包需要重新构建才会生效，因此本工程检出阶段一确认的修订后，必须由用户重新构建才会生效。
- **npm 安装型 wrapper 的发布滞后**：仓库 tag 可能早于 npm 发布，只移动 submodule checkout 不会更新已安装的插件本体。
- **npm 运行时换代后实装仓库的 `.harness` 可能残留混合版本树**：副本是全新安装、必然一致，冒烟验不出；本工程是就地升级，`pnpm add` 调和既有 lockfile 时可能把顶层 `@deepseek-ai/dsh` 升到新版本、兄弟包（`dsh-sandbox`、`dsh-attachment` 等）留在旧版本。症状是启动时 `harness.log` 报 `does not provide an export named '...'`。build 的 npm 运行时分支现已自动兜底：家族不一致触发干净重装（删 `.harness/node_modules` + `pnpm-lock.yaml` 后 `pnpm add`），重装后仍不一致则构建报错；`--force-harness` 也是干净重装。手动恢复：`Remove-Item .harness\node_modules, .harness\pnpm-lock.yaml -Recurse -Force` 后重跑 build。详见 `docs/dsh-gui/harness-runtime.md` 的「故障排查」。
- **副本不含未提交改动**：本工程有待提交的改动时，副本验证的不是将要实装的状态。
- **`DSH_HOME` 会从会话环境继承，指向正在运行的实例**：dsh 会话自身导出了 `DSH_HOME=<本工程>/.dsh`，副本里跑的每条 `node` / `dsh` / `install.mjs` 命令都会继承它，于是"副本内验证"实际写进了本工程的 profile。典型症状是 pnpm 报 `ERR_PNPM_UNEXPECTED_STORE`（副本的 store 与本工程 profile 记录的 store 不同），或本工程 `.dsh/` 冒出新的文件。副本内的每条命令都显式带上 `$env:DSH_HOME="<副本>/.dsh"`。若已经写进去，按本工程 `.dsh` 的改动清单逐项复原，至少核对 `profiles/web/pnpm-workspace.yaml` 的 `storeDir`、`gui/npm-installs.json` 与 `profiles/web/package.json` 的依赖与 `dsh.profile.bundles`。
- **强杀副本构建会遗留陈旧的 atomic-write 锁**：在 `dsh plugin add` 写 `package.json` 期间用 `Stop-Process -Force` 终止副本构建，会留下陈旧的 `.dsh/profiles/web/package.json.lock`（内容是刚被杀进程的 PID）。之后每次 `dsh plugin add` 都等待该锁直到超时，报 `atomic-write: timed out waiting for the writer lock at ...package.json.lock`，整体表现为构建长时间静默挂起。清理：删除该锁文件后重跑 build。
- **验收副本的 WebUI / GUI 与运行中的实例争用端口**：副本的 web 后端与入口 exe 都默认用 3080，而正在运行的 dsh-gui 正占着它，直接启动会报 `127.0.0.1:3080 is already in use`（[`src-tauri/src/main.rs`](../../../src-tauri/src/main.rs) 的 `ensure_loopback_port_available`）。验收一律显式把 `DSH_GUI_PORT` 设到空闲端口；验收结束后关闭该实例，避免残留进程占住端口，或被后续步骤误当成"副本实例还在跑"。
- **把端口起来当成验证通过**：WebUI 验收看的是真实渲染结果（会话界面出来、无插件或组合的加载报错），不是进程存活、也不是 `dump-config` 无报错；harness 更新的 GUI 验收同样要用 computer use 看到窗口真正走到就绪。
