---
name: dsh-gui-update
description: 'Use when updating a dsh-gui module to a newer upstream revision — the deepseek-harness engineering base, the src-tauri/whale-icon submodule, or an npm-pinned plugin under plugins/ — and when validating that upgrade before it reaches the working repository. Covers the in-repo validation worktree (.staging/dsh-gui, a git worktree on branch staging/verify maintained by scripts/staging.mjs, with .staging/ as its runtime root), the staging-first two-phase flow, the phase-one acceptance gate (the worktree WebUI must actually load; a harness update additionally gets a computer-use check that the GUI starts and runs), adaptation commits on the work branch that need no user approval, the user approval still required to merge the work branch back into the main branch, git submodule pin updates for deepseek-harness and src-tauri/whale-icon, npm plugin pin updates in plugins/<id>/install.mjs followed by a wrapper reinstall, the ban on building or installing inside the running checkout, plugin masking, the post-upgrade install-script audit, the npm publish state of the dsh runtime, reporting and commit-message drafting, and the sandbox rule (workspace writes and work-branch commits need no elevation; builds, cargo and sh.exe-backed git operations do; DSH_HOME must be pinned to .staging/.dsh).'
whenToUse: 需要把 deepseek-harness、src-tauri/whale-icon 或某个 npm pin 插件升级到更新的上游修订（最新 tag / 最新提交 / registry 最新版本）、需要在实装前先验证、需要在验证 worktree 的工作分支上直接提交适配改动、需要在实装阶段避免改动正在运行的 dsh 实例、或更新对话框的「AI 更新」把升级提示词预填到会话后落地该流程时使用。
---

# dsh-gui 模块更新

本 skill 把本仓库依赖的模块升级到更新的上游修订：工程基座 `deepseek-harness`、`src-tauri/whale-icon` 两个 git 子模块，以及 `plugins/<id>/` 下以 npm 精确 pin 安装的插件。两类模块的推进方式不同：子模块移动指针，npm 插件改写安装脚本里的 `packageSpec` 并重跑 wrapper。升级分两个阶段执行：阶段一在仓库内的验证 worktree 中验证，阶段二把验证通过的工作分支合并回主分支实装。

## 0. 铁律：先验证，后实装

- 阶段一在验证 worktree `.staging/dsh-gui` 中更新、构建、冒烟检查与验收；阶段二把工作分支合并回主分支。主分支正在服务运行中的 dsh-gui，一次失败的升级会让它无法启动，worktree 验证正是为了在改动主分支之前暴露这类问题（事故复盘见 [`docs/dsh-gui/2026-08-30-harness-upgrade-v0-1-2-alpha-1-build-failure.md`](../../../docs/dsh-gui/2026-08-30-harness-upgrade-v0-1-2-alpha-1-build-failure.md)）。
- 验证 worktree 是本仓库的 git worktree，位于 `<仓库根>/.staging/dsh-gui`，检出工作分支 `staging/verify`，由 [`scripts/staging.mjs`](../../../scripts/staging.mjs) 维护。它的运行时根是 `<仓库根>/.staging`，`.dsh`、`.harness`、`.toolchain`、`.pnpm-store` 与入口 exe 都在那里；整个 worktree 位于会话工作区内。
- 更新、构建与安装只在验证 worktree 中进行。worktree 使用自己的 DSH_HOME（`.staging/.dsh`）与运行时目录，全部产出落在 `.staging/` 下。禁止在主仓库执行任何构建或安装动作（`npm run build`、各插件的 `install.mjs`、`dsh plugin add`，以及直接写入主仓库 `.dsh/` 的改动）：这些动作会改写正在运行的 dsh 实例的 profile、插件与 preset，使其损坏到无法操作。
- 工作分支 `staging/verify` 上的提交不需要用户审批：它不改变主分支，也不影响正在运行的实例。验证适配改动直接在 worktree 内 `git add` 与 `git commit`，提交信息遵循 `AGENTS.md` 的 Conventional Commits 约定。仓库配置了 `commit.gpgsign=true`，而沙箱内无法引用用户的 GPG 签名，因此提交时显式关闭签名：`git -c commit.gpgsign=false commit ...`。该分支是临时验证分支，合并回主分支的 merge commit 由用户签名。
- 把工作分支合并回主分支是实装动作，必须经用户明确审批；未获审批前禁止合并，也禁止改动主分支。
- 阶段一验收全部通过后，先向用户报告验证结论（worktree 路径、工作分支与提交、目标修订、验证命令与结果、适配改动清单、屏蔽项与未决风险），取得明确审批后才进入阶段二。
- 一次只推进一个明确目标：更新目标是「最新 tag」「最新提交」还是「registry 最新版本」，由用户在更新对话框按行选择，或由用户直接指定。
- `deepseek-harness/` 是 pinned 上游子模块，只用于查证规范：禁止编辑其中任何文件，也禁止从该目录向插件源码复制代码。

## 1. 权威来源

| 来源 | 内容 |
| --- | --- |
| [`src-tauri/ui/app.js`](../../../src-tauri/ui/app.js) | 外壳更新对话框预填的提示词：`AI_UPDATE_SKILL`（手势常量 `/dsh-gui-update`）、`buildHarnessUpdatePrompt`（仅 harness）、`buildHarnessMergedPrompt`（harness 与插件批量）、`buildAiUpdatePrompt`（单模块与插件批量）。提示词只给出模块名、路径、当前版本、更新目标，以及 skill 无法从对话框得知的验收门槛 `AI_UPDATE_GATE_NOTE`（worktree 的 WebUI 必须能正确加载；含 harness 时另用 computer use 验证 GUI；适配改动提交到工作分支；报告并经用户审批后才合并回主分支）；分步流程由本 skill 承载 |
| [`plugins/auto-update/dsh-auto-update/src/client/ai-prompt.ts`](../../../plugins/auto-update/dsh-auto-update/src/client/ai-prompt.ts) | desktop 应用内更新对话框的提示词：git 行沿用外壳文案；npm 插件行给出包名、安装脚本、当前 pin 与 registry 目标版本，并要求改安装脚本里的 `packageSpec` 精确版本；构建入口统一写成 `npm run build:desktop` |
| [`docs/dsh-gui/desktop-auto-update.md`](../../../docs/dsh-gui/desktop-auto-update.md) | desktop 更新插件与外壳更新对话框并存时的边界、git 行与 npm 插件行的检测与更新执行 |
| [`docs/dsh-gui/upgrade-staging-workspace.md`](../../../docs/dsh-gui/upgrade-staging-workspace.md) | 验证 worktree 的路径与运行时根、维护命令、工作分支与合并政策、构建与验收命令 |
| [`scripts/staging.mjs`](../../../scripts/staging.mjs) | `ensure`、`sync`、`status`、`clean` 的实现与帮助文本；`npm run staging -- help` 是选项的权威列表 |
| [`harness.json`](../../../harness.json) 与 [`docs/dsh-gui/harness-runtime.md`](../../../docs/dsh-gui/harness-runtime.md) | dsh 运行时的选择与版本来源；harness 升级后由 build 按子模块 `apps/cli/package.json` 的版本安装 CLI |
| [`docs/dsh-gui/update-check.md`](../../../docs/dsh-gui/update-check.md) | 外壳侧更新检查的判定规则、npm 发布状态与提示词接线 |
| [`AGENTS.md`](../../../AGENTS.md) | 开发约定、插件开发规范、插件市场约束、bundle 加载注意事项、提交规范 |
| [`plugins/README.md`](../../../plugins/README.md) | 各 wrapper 的安装方式与 npm pin 标注 |

更新对话框的「AI 更新」预填的草稿以 `/dsh-gui-update` 开头：host 侧的 `dsh-tool-skill` 会把本 skill 的内容注入会话，因此本 skill 就是升级流程的权威步骤。手势名称定义在两个常量中：外壳的 `src-tauri/ui/app.js` 与 desktop 更新插件的 `plugins/auto-update/dsh-auto-update/src/client/ai-prompt.ts` 各有一个 `AI_UPDATE_SKILL`；重命名本 skill 时必须在同一改动中同步这两个常量。

## 2. 更新目标与跳过规则

模块按行类型推进：

- **git 子模块行**（`deepseek-harness` 与 `src-tauri/whale-icon`）：
  - **tag 目标**：在模块目录内 `git fetch --prune origin`，再用 `git describe --tags --abbrev=0 origin/<默认分支>` 取得远端默认分支可达的最新 tag，然后检出该 tag。模块目录位于 worktree 内：`.staging/dsh-gui/deepseek-harness` 或 `.staging/dsh-gui/src-tauri/whale-icon`。以 harness 为例（把 `main` 换成该模块的默认分支）：

    ```powershell
    git -C .staging\dsh-gui\deepseek-harness fetch --prune origin
    git -C .staging\dsh-gui\deepseek-harness describe --tags --abbrev=0 origin/main
    git -C .staging\dsh-gui\deepseek-harness checkout <tag>
    ```

  - **提交目标**：远端默认分支的最新提交。子模块用 `git -C .staging\dsh-gui submodule update --remote <path>`，或在该模块目录内 `fetch origin` 后检出 `origin/<默认分支>`。
  - **跳过**：模块当前正好检出于某个 tag，而远端只有更新的提交、没有更新的 tag 时，保持其 tag 版本，不要把它更新到非 tag 提交，并在报告中说明原因。产品内该状态对应 `announce === false`（[`src-tauri/src/update.rs`](../../../src-tauri/src/update.rs) 的 `check_project`）。
- **npm 插件行**（`plugins/<id>/install.mjs` 里 `installNpmPlugin` 的精确 pin）：更新目标是 registry 最新版本，对话框行给出 `latest`；行内没有该值（例如提示词只给了包名）时用 `npm view <包名> version` 确认。在 worktree 中把该脚本的 `packageSpec` 改成 `<包名>@<新版本>`（保留完整的三段 semver，带 prerelease 时写全），再重跑该 wrapper 完成安装。一个 wrapper 安装多个包时逐行处理，只改目标包。
- **顶层仓库本体**不进入本流程：更新对话框对顶层行直接执行 git 层更新（顶层快进加子模块递归同步），随后由用户执行 `npm run build` 重建。worktree 与主仓库共享 object 库与 refs，顶层不需要 fetch，`sync` 会把工作分支对齐到本仓库当前 HEAD。

## 3. 阶段一：worktree 内验证（不碰主分支）

1. 准备 worktree 并确认基线：

   ```powershell
   npm run staging -- ensure          # worktree 尚不存在时创建；已存在时提示并退出，加 --recreate 替换
   npm run staging -- sync            # 把工作分支对齐到本仓库当前 HEAD，并重新钉住子模块
   npm run staging -- status          # 汇报两侧修订、未合并提交数、子模块漂移与运行时根的构建阶段
   ```

   - `sync` 要求 worktree 工作区干净（`git status --porcelain` 为空）：工作分支的提交已全部包含在本仓库 HEAD 中时执行 `git reset --hard <本仓库 HEAD>`；存在未合并提交时拒绝，并说明未合并提交数与两种处理方式：先合并回主分支，或加 `--rebase` 把这些提交重放到 HEAD（rebase 失败时脚本先 `git rebase --abort` 再报错）。`sync` 不 fetch 顶层仓库：worktree 与主仓库共享 object 库与 refs，本仓库当前 HEAD 就是权威基线；子模块仍可能因新指针需要 fetch。
   - 动手前确认基线一致：`git -C .staging/dsh-gui rev-parse HEAD` 与本仓库 `git rev-parse HEAD` 相同，`git -C .staging/dsh-gui status --porcelain` 为空。`sync` 只重置顶层工作分支并重新钉住子模块，不清理未跟踪文件与子模块工作区里的改动：有未跟踪残留时用 `git -C .staging/dsh-gui clean -fd` 删除，子模块工作区有改动时用 `git -C .staging/dsh-gui submodule update --init --recursive --force` 拉回。
   - 在仓库根执行这些命令：脚本检测到当前路径位于 `.staging` 内时会拒绝运行，防止嵌套创建。
   - worktree 内的每条 `node` / `dsh` / `install.mjs` 调用前都显式设置 `DSH_HOME`，原因与取值见第 7 节。
2. 在 worktree 中把目标模块推进到目标状态：git 子模块按第 2 节检出 tag 或提交；npm 插件行改 `plugins/<id>/install.mjs` 的 `packageSpec` 后由第 4 步的构建重跑该 wrapper 完成安装。需要单独执行 wrapper 时用 `node plugins/<id>/install.mjs`，`DSH_HOME` 按第 7 节钉到 worktree 的运行时根，目标 profile 用 `DSH_PLUGIN_PROFILE` 指定（desktop 更新对话框的流程用 `desktop`，外壳与普通构建用默认的 `web`）。
3. 分析该版本的影响：新增、变更或移除的功能、配置与依赖，以及本仓库插件需要跟进适配的点（组合方式、插件 API、bundle 契约）。以 `AGENTS.md` 与 [`docs/official/`](../../../docs/official) 为依据。
   - **npm 插件行**还要读该版本的 Release 与包内 README，核对声明的 dsh 依赖要求（`engines.dsh`，没有时看 `@deepseek-ai/dsh*` peer 区间）是否接纳本仓库 pinned 的 harness。接纳时只改 pin；不接纳时停止本次更新并向用户报告，可选做法是由 wrapper 的 `exempt` 授予精确版本例外并记录接受的风险，或把该插件屏蔽出本次验证。
   - **核对 `docs/official` 的每条链接仍可穿透**：目录链接要能列出子项，文件链接要能读到内容。子模块换代会让官方目录树移动或撤除（顶层 `examples/` 已被撤除，内容分散到 `apps/cli/config/examples/`、`docs/user/` 与各包 `tests/fixtures/`），悬空链接要改指当前修订的等价位置，没有等价位置的删除；`AGENTS.md` 的 `docs/official` 条目与目录内容逐项对齐。
   - 失效并不总是「目标不存在」：目标是目录却被写成**文件型重解析点**时，`Test-Path` 仍返回真，但 shell 报 `Not a directory`、目录列举为空、子路径全部读不到。用 `(Get-Item <链接>).PSIsContainer` 判定：目标为目录却得到 `False` 的就是这种链接。
   - 重建用 `New-Item -ItemType SymbolicLink -Path <链接> -Target <相对目标>`，目标按仓库约定写成正斜杠相对路径。不要用 .NET 的 `Directory.CreateSymbolicLink`：它对本仓库的相对目标写出的重解析点在 Windows 上不解析，子项无法访问。
   - 重建只改文件系统：目标字符串不变时 git blob 不变，`git status` 不显示这些路径被修改，因此这一步不产生提交内容，只需在报告中记录链接清单。
4. 在 worktree 中完成适配修改，并把改动提交到工作分支（不需要用户审批）：

   ```powershell
   cd .staging\dsh-gui
   git status --porcelain          # 确认改动范围，排除构建产物与临时文件
   git add -A
   # 沙箱内无法引用用户的 GPG 签名，本次提交显式关闭签名
   git -c commit.gpgsign=false commit -m "chore: adapt <module> to <revision>"
   ```

   - 适配改动在本仓库顶层提交（安装脚本与 npm pin、`docs/official` 链接、配置与文档）；`deepseek-harness/` 与 `src-tauri/whale-icon` 是 pinned 子模块，禁止编辑其中文件。
   - 提交后构建验证。先跑 `--skip-exe` 全绿；本次更新包含 `deepseek-harness` 时再跑不带该标记的那条，一并构建第 7 步验证的入口 exe：

     ```powershell
     cd .staging\dsh-gui
     $env:DSH_HOME = 'E:\Git\dsh-gui-home\dsh-gui\.staging\.dsh'
     npm run build -- --skip-exe     # dsh 运行时 + 插件 + preset
     npm run build                   # 含入口 exe
     ```

   - 从 desktop 更新对话框进入时，提示词把构建入口统一写成 `npm run build:desktop`（构建 desktop 产物并安装 desktop profile），按提示词给出的构建入口执行；外壳对话框的验收用上面的 `npm run build`。
   - `harness.json` 的 `runtime` 为 `npm`（仓库当前取值）时，build 按子模块 `apps/cli/package.json` 的版本从 registry 安装 dsh CLI，不编译子模块；子模块快进后必须重跑 build 才会换到新版本。
5. 组合冒烟检查：用 worktree 的 dsh CLI 以 `--profile web --dump-config` 渲染配置树，确认没有 `duplicate loader entry id`、缺失插件或 patch 报错。在仓库根执行：

   ```powershell
   $env:DSH_HOME = 'E:\Git\dsh-gui-home\dsh-gui\.staging\.dsh'
   node .staging\.harness\node_modules\@deepseek-ai\dsh\lib\bin.js --profile web --dump-config
   ```

   `harness.json` 的 `runtime` 为 `source` 时把 CLI 入口换成 `.staging\dsh-gui\deepseek-harness\apps\cli\lib\bin.js`。这一步只是验收的前置条件，通过它不等于验证通过。desktop 更新对话框的流程没有普通 dsh CLI 可用的 desktop profile（只能由 Desktop 自带的 CLI 管理），组合验收以第 6 步的 desktop 应用加载为准。
6. **WebUI 加载验收（必做，阶段一的通过基准）**：「验证通过」指 worktree 的 WebUI 能正确加载出来：构建全绿与配置 dump 无报错都不算。以 worktree 自身的 DSH_HOME 在**空闲端口**启动它的 web 后端，再确认界面真的渲染出来：

   ```powershell
   cd .staging\dsh-gui
   $env:DSH_GUI_PORT = "3090"   # 空闲端口：正在运行的 dsh-gui 占着 3080
   npm run harness              # scripts/harness.mjs：把 DSH_HOME 钉到 worktree 运行时根的 .dsh；不设 DSH_AGENTS_HOME
   ```

   在 `http://127.0.0.1:3090`（或所选空闲端口）确认会话界面正常渲染、能新建或载入会话、插件与组合没有加载失败提示或错误覆盖层；在 agent 会话中以后台任务启动它，确认手段不限（浏览器或 computer use），但必须以真实渲染结果为准，不能只看进程起来了。确认后结束该实例，不要把端口或 profile 留给后续步骤复用。从 desktop 更新对话框进入时，验收对象是 worktree 的 desktop 应用：按提示词的构建入口构建并启动它，用空闲端口避开正在运行的实例，判据同样是界面真正可用。
7. **GUI 启动运行验收（仅当本次更新包含 `deepseek-harness`）**：harness 换代可能让桌面外壳起不来，因此还要用 computer use 验证 GUI 能正常启动和运行。worktree 内不带 `--skip-exe` 的 `npm run build` 已产出 `<仓库根>/.staging/dsh-gui.exe`，用空闲端口启动它，再用 computer use 观察真实窗口：

   ```powershell
   cd .staging\dsh-gui
   $env:DSH_GUI_PORT = "3090"
   npm start                    # 启动 .staging\dsh-gui.exe
   ```

   确认窗口出现、加载页过渡到标签页、harness 就绪、能正常交互（打开设置或新建会话即可），随后关闭该实例。入口 exe 从自身路径解析两个根（[`src-tauri/src/roots.rs`](../../../src-tauri/src/roots.rs) 的 `repo_root` 与 `runtime_root`），与正在运行的实例互不干扰；唯一会冲突的是端口（`ensure_loopback_port_available`），因此必须换端口。
8. 屏蔽确认与新版不兼容且本次无法修复的插件，并从 profile 的挂载与依赖条目中移除，使其不参与本次验证的安装：
   - npm 型 wrapper：以 `DSH_PLUGIN_SKIP=<wrapper id>` 跳过本次安装，或临时把 wrapper 的 `installNpmPlugin` 改成带 `skip` 默认跳过；[`scripts/plugin-install.mjs`](../../../scripts/plugin-install.mjs) 的 `skipInstall` 是唯一判定处，`DSH_PLUGIN_FORCE_INSTALL=1` 强制安装。
   - in-tree 型 wrapper：在其 `plugins/<id>/install.mjs` 顶部加提前返回的守卫，跳过本次安装。
   - 逐条记录屏蔽原因与恢复条件（例如等上游适配）。
9. 记录修复清单：每一项适配改动对应的文件、结论与验证命令及结果，供阶段二报告与合并引用。确认工作分支没有未提交改动（`git -C .staging/dsh-gui status --porcelain` 为空），并把工作分支上的提交清单整理进验证结论。

## 4. 阶段二：合并工作分支实装（阶段一验收通过并经用户审批后）

本阶段把工作分支合并回主分支。合并带入顶层树（安装脚本与 npm pin、适配代码，以及 `deepseek-harness` / `src-tauri/whale-icon` 的子模块指针）；本流程不在子模块内产生本地提交。本阶段不执行构建或安装，重新构建由用户完成。

0. 先确认两件事都已发生：阶段一验收全部通过，且用户已明确审批本次实装。把验证结论、改动清单与风险报告给用户后等待其答复；用户未批准（或尚未答复）时停在这里，不要合并。
1. 主分支在验证期间前进过时，先在工作分支上同步到本仓库当前 HEAD，解决冲突后重跑受影响的验收步骤：

   ```powershell
   npm run staging -- sync --rebase
   ```

   它把工作分支上的提交 rebase 到本仓库当前 HEAD，并重新钉住子模块；也可以改在 worktree 中把主分支 merge 进工作分支。
2. 由用户在主仓库当前分支执行合并（合并提交进入主分支，需要用户的签名与提交钩子）：

   ```powershell
   cd E:\Git\dsh-gui-home\dsh-gui
   git status --porcelain                         # 期望为空
   git merge --no-ff staging/verify -m "feat: bump <module> to <revision>"
   ```

   合并提交信息遵循 Conventional Commits；把 `<module>` 与 `<revision>` 换成本次实际更新内容。
3. 更新主工程子模块指针：若本次更新包含 `deepseek-harness` 或 `src-tauri/whale-icon`，合并把 worktree 记录的子模块 gitlink 带进主分支，主工程需要把子模块检出到新指针（可能需要网络 fetch）：

   ```powershell
   git submodule update --init --recursive
   ```

   主工程与 worktree 的子模块是相互独立的 git 仓库，但本流程只在其中 checkout 上游修订、不产生本地提交，因此不需要搬运提交。

4. 汇报并通知用户重新构建，列出：
   - 本次合并的提交、涉及的模块与 npm pin 变更、子模块指针；
   - 被屏蔽插件在主工程的卸载动作：移除 profile 的挂载与依赖条目并删除对应 node_modules 链接，避免后续 Loader 组合重新加载它（卸载流程见 skill `dsh-plugin-uninstall`）；
   - 重新构建命令 `npm run build`（desktop 更新对话框的流程为 `npm run build:desktop`）：入口 exe 被运行中的 dsh-gui 占用时可以加 `--skip-exe`，但构建与卸载都由用户在停止运行中的实例后执行。

## 5. 安装脚本速查

对 `plugins/` 下每个未被 mask 的插件（跳过以 `skip` 声明默认跳过、或本次以 `DSH_PLUGIN_SKIP` 跳过的条目）逐一核对其安装脚本是否与最新官方规范一致。依据：`AGENTS.md`、[`docs/official/`](../../../docs/official)、`plugins/README.md` 的安装方式标注，以及 skill `dsh-plugin-install`。

| 核对要点 | 期望状态 |
| --- | --- |
| 安装方式 | 与 `plugins/README.md` 的安装方式标注一致：in-tree 源码插件经 `installPlugin` 构建后以 `link:` 引入，npm 插件经 `installNpmPlugin` 以精确 spec 安装 |
| 版本 pin | npm 型 wrapper 的 `packageSpec` 是 `<包名>@<精确版本>` 字符串字面量，版本与上游 npm 最新发布及登记的兼容区间一致 |
| 挂载方式 | 声明 `dsh.bundle.patch` 的包经自身 bundle 层挂载，不手工插入 `cordis.patch.yml` |
| 市场约束 | 精确稳定的 SemVer 版本；无 `preinstall`、`install`、`postinstall`、`prepare` 生命周期脚本；`engines.node` 接受 Node LTS；`files` 白名单只含必要产物 |
| 流水线 | 经 `scripts/plugin-install.mjs` 共享流水线安装，无越出仓库、绕过流水线或改动无关配置的步骤 |

发现不一致时先停下向用户报告，不要擅自修改。

## 6. 通过标准、失败与回滚

全部满足才算完成：

- 验证 worktree 内 `npm run build` 全绿（desktop 更新对话框的流程用 `npm run build:desktop`），含 dsh 运行时的安装或构建与各插件安装脚本；
- 验证 worktree 的 `--profile web --dump-config` 能渲染组合；
- **`docs/official` 的链接全部可穿透**：目录链接能列出子项、文件链接能读到内容，悬空项已改指当前修订的等价位置或被删除；
- **验证 worktree 的 WebUI 已实际加载验收通过**：在空闲端口启动它的 web 后端后，会话界面正常渲染、无插件或组合的加载报错；
- **本次更新包含 `deepseek-harness` 时，验证 worktree 的入口 exe 已用 computer use 验证能正常启动和运行**；
- 验证过的适配改动已提交到工作分支 `staging/verify`，工作区没有未提交改动；
- **用户已明确审批阶段二合并**；
- 不兼容插件已屏蔽，原因与恢复条件已记录；
- npm 插件行：安装脚本的 `packageSpec` 已改到目标版本，worktree 构建后 profile 中安装的是该版本，插件加载无报错；
- dsh 运行时的 npm 发布状态已核对（判据见 `docs/dsh-gui/update-check.md`）；
- 主分支已合并工作分支；本次更新包含 `deepseek-harness` 或 `src-tauri/whale-icon` 时，主工程子模块已 checkout 到合并带入的指针；
- 已通知用户重新构建，构建结果与重建后各插件、agent preset 的安装由用户确认。

阶段一验收未全部通过、或用户尚未审批时，不得进入阶段二。验证失败时先在 worktree 中修正重试：继续在工作分支提交，或用 `git -c commit.gpgsign=false commit --amend` 修订最近一次提交；不要带着失败的升级改动合并回主分支。需要丢弃工作分支上的验证提交并重建 worktree 时用 `npm run staging -- clean --yes --branch`。主工程需要回滚时，git 子模块检回旧修订、npm 插件把 `packageSpec` 改回旧版本并重跑 wrapper，然后同样通知用户重新构建：

```powershell
git -C deepseek-harness checkout <旧修订>
git -C src-tauri\whale-icon checkout <旧修订>   # 本次更新含该子模块时
```

顶层仓库自身的回滚用 `git reset --hard <旧提交>`，随后同样通知用户重新构建。

## 7. 沙箱与提权

验证 worktree 及其运行时根都位于会话工作区内，以下动作不需要额外审批：

- worktree 与主仓库内的任何文件读写、编辑；
- 不触发 `sh.exe` 的 git 操作：`status`、`diff`、`log`、`add`、`commit`、`branch`、本地 `merge`、`reset`；
- worktree 内构建产物写入 `.staging/` 下的运行时根。

仍可能触发沙箱审批：

- 执行构建命令（pnpm 生命周期脚本 `spawn EPERM`、cargo）；
- 需要 Cygwin `sh.exe` 的 git 操作：`git worktree add`（git-lfs smudge filter）、`git submodule` 系列；
- 任何写出会话工作区的动作，典型是把 `DSH_HOME` 误指向 `E:\Git\dsh-gui-home\.dsh`。

处理方式按 `AGENTS.md` 的提权规则：通过工具以最窄的足够宽模式对这条命令申请一次放行，禁止用非标手段绕过；普通终端不需要提权。

**DSH_HOME 必须显式设为 `.staging/.dsh`**：dsh 会话自身导出了 `DSH_HOME=E:\Git\dsh-gui-home\.dsh`（主工程运行时根的 home），worktree 内的每条 `node` / `dsh` / `install.mjs` 调用都会继承它；不覆盖就会写进主工程 home，既污染正在运行的实例，又是工作区外的写入。

```powershell
cd .staging\dsh-gui
$env:DSH_HOME = 'E:\Git\dsh-gui-home\dsh-gui\.staging\.dsh'
```

会话工作区必须是**仓库根**（含 `plugins/`、`presets/`、`deepseek-harness/` 的目录），即嵌套布局里的 `<runtime-root>/dsh-gui`。**禁止把主工程运行时根（仓库根的父目录）作为 DSH 工作区**：沙箱会给工作区树打低完整性标签，`.dsh`、`.harness`、`.toolchain` 与入口 exe 一旦进入该范围，其中的可执行文件就以低完整性运行，随后环境临时目录不可写、`pwsh`、`grep`、`glob` 连带失效，入口 exe 还会触发 SmartScreen 提示。机制、观测症状与恢复步骤见 `docs/dsh-gui/windows-acl-low-integrity-label.md` 与 `docs/dsh-gui/nested-clone-layout.md`。验证 worktree 的运行时根是 `<仓库根>/.staging`，位于会话工作区内，其中构建出的 `.dsh`、`.harness` 与入口 exe 会进入打标范围，但这只影响可随时删除重建的验证 worktree，不影响主工程的安装。

## 8. 相关 skill

| 场景 | skill |
| --- | --- |
| 把插件安装进 profile、源码编译安装 | `dsh-plugin-install` |
| 卸载插件、清理 profile 与 submodule 残留 | `dsh-plugin-uninstall` |
| 插件 wrapper、npm 安装脚本与 in-tree 插件接线 | `dsh-gui-plugin-dev` |
| agent preset 的改动与安装 | `dsh-gui-preset-dev` |
| Cordis 组合与 preset 组合的编写与校验 | `editing-cordis-compositions` |

## 9. 常见坑

- **`source` 运行时下 harness 子模块的残留构建产物**：升级后旧的 `lib/` 与 `node_modules/` 会被 tsdown 的 workspace glob 当成构建目标，报 `MISSING_EXPORT` 并中止构建。验证 worktree 从干净检出安装，能提前暴露该问题；本工程的修复见事故复盘。
- **子模块指针漂移**：记录的修订与子模块工作区 HEAD 不一致时，`git status` 显示 ` M <path>`，仓库处于半升级状态。worktree 内的修法是让工作分支提交记录的子模块指针与子模块实际 HEAD 一致；实装后主工程用 `git submodule update --init --recursive` 把子模块 checkout 到合并带入的指针。
- **改了 pin 却没有重跑安装**：npm 插件的版本由安装脚本的 `packageSpec` 决定，只改脚本不重跑 wrapper，profile 里仍是旧版本；只改 profile 里的包版本而不改脚本，下次构建又会被精确 pin 装回旧版，新设备也按旧 pin 安装。
- **npm 插件行的 pin 必须是字面量**：desktop 更新面板扫描 `plugins/**/*.mjs` 中 `installNpmPlugin(` 附近的 `<包名>@<版本>` 字面量；从文件读取版本或用字符串拼接构造 spec 的 wrapper 不产生插件行，也不会被就地更新（约定见 `plugins/README.md` 的安装方式）。
- **npm 运行时换代后主工程的 `.harness` 可能残留混合版本树**：验证 worktree 与主工程的运行时根相互独立，worktree 侧从干净的 `.staging/.harness` 安装、必然一致，冒烟验不出；主工程是就地升级，`pnpm add` 调和既有 lockfile 时可能把顶层 `@deepseek-ai/dsh` 升到新版本、兄弟包（`dsh-sandbox`、`dsh-attachment` 等）留在旧版本。症状是启动时 `harness.log` 报 `does not provide an export named '...'`。build 的 npm 运行时分支会自动兜底：家族不一致触发干净重装（删 `.harness/node_modules` + `pnpm-lock.yaml` 后 `pnpm add`），重装后仍不一致则构建报错；`--force-harness` 也是干净重装。手动恢复：`Remove-Item .harness\node_modules, .harness\pnpm-lock.yaml -Recurse -Force` 后重跑 build。详见 `docs/dsh-gui/harness-runtime.md` 的「故障排查」。
- **`DSH_HOME` 会从会话环境继承，指向正在运行的实例**：dsh 会话自身导出了 `DSH_HOME=E:\Git\dsh-gui-home\.dsh`，worktree 里跑的每条 `node` / `dsh` / `install.mjs` 命令都会继承它，于是「worktree 内验证」实际写进了主工程的 profile。典型症状是 pnpm 报 `ERR_PNPM_UNEXPECTED_STORE`（worktree 的 store 与主工程 profile 记录的 store 不同），或主工程 `.dsh/` 冒出新的文件。worktree 内的每条命令都显式带上 `$env:DSH_HOME="E:\Git\dsh-gui-home\dsh-gui\.staging\.dsh"`。若已经写进去，按主工程 `.dsh` 的改动清单逐项复原，至少核对 `profiles/web/pnpm-workspace.yaml` 的 `storeDir`、`gui/npm-installs.json` 与 `profiles/web/package.json` 的依赖与 `dsh.profile.bundles`。
- **强杀 worktree 构建会遗留陈旧的 atomic-write 锁**：在 `dsh plugin add` 写 `package.json` 期间用 `Stop-Process -Force` 终止 worktree 的构建，会留下陈旧的 `.staging/.dsh/profiles/web/package.json.lock`（内容是刚被杀进程的 PID）。之后每次 `dsh plugin add` 都等待该锁直到超时，报 `atomic-write: timed out waiting for the writer lock at ...package.json.lock`，整体表现为构建长时间静默挂起。清理：删除该锁文件后重跑 build。
- **验收 worktree 的 WebUI / GUI 与运行中的实例争用端口**：worktree 的 web 后端与入口 exe 都默认用 3080，而正在运行的 dsh-gui 正占着它，直接启动会报 `127.0.0.1:3080 is already in use`（[`src-tauri/src/main.rs`](../../../src-tauri/src/main.rs) 的 `ensure_loopback_port_available`）。验收一律显式把 `DSH_GUI_PORT` 设到空闲端口；验收结束后关闭该实例，避免残留进程占住端口，或被后续步骤误当成「worktree 实例还在跑」。
- **把端口起来当成验证通过**：WebUI 验收看的是真实渲染结果（会话界面出来、无插件或组合的加载报错），不是进程存活、也不是 `dump-config` 无报错；harness 更新的 GUI 验收同样要用 computer use 看到窗口真正走到就绪。
- **`docs/official` 的目录链接在 Windows 上可能是文件型重解析点**：它是 git 里正常的 `120000` 链接、目标字符串也对，但文件系统层面被写成文件型（`PSIsContainer` 为 `False`），于是 `ls`、`cd` 与子路径访问都报 `Not a directory`，而 `git status` 与 `Test-Path` 都不报异常。按第 3 节的方法用 `New-Item -ItemType SymbolicLink` 重建，重建后确认 `PSIsContainer` 为 `True` 且能列出子项。
- **`git worktree add` 需要 Cygwin `sh.exe`**：仓库的 git-lfs smudge filter 在检出时调用 `sh.exe`，沙箱会拦截并报 `CreateFileMapping` 失败；`ensure` 与 `sync`（含其中的 `git submodule` 系列）因此需要按第 7 节申请放行。
- **手工删除 worktree 目录后要 `git worktree prune`**：直接删除 `.staging/dsh-gui` 会留下 `.git/worktrees/dsh-gui/` 元数据，之后 `git worktree add` 报该路径已注册。用 `git -C . worktree prune` 清理，`clean` 命令会先做这一步。
- **工作分支有未合并提交时 `sync` 会拒绝**：它提示未合并提交数与两种处理方式。先合并回主分支，或加 `--rebase` 把这些提交重放到本仓库 HEAD；不要手工 reset 工作分支，以免丢失已验证的提交。
- **worktree 工作分支的提交会因 GPG 签名失败**：仓库配置了 `commit.gpgsign=true`，dsh 沙箱内无法引用用户的私钥，`git commit` 报 `gpg failed to sign the data` 或 `fatal: failed to write commit object`，提交不产生。改用 `git -c commit.gpgsign=false commit -m "<message>"`（或 `git commit --no-gpg-sign`）只为本次提交关闭签名；不要改全局或仓库配置，主分支的提交与合并仍需要用户的签名与提交钩子。
- **主工程与验证 worktree 的子模块是相互独立的 git 仓库**：worktree 子模块的 gitdir 在 `.git/worktrees/dsh-gui/modules/<path>/`，主工程子模块在 `.git/modules/<path>/`。本流程只在子模块内 checkout 上游修订、不产生本地提交，因此合并带入的 gitlink 由主工程的 `git submodule update` 从远端取用；不要在子模块里做适配提交。
- **仓库外的 `.staging` 不属于验证工作区**：`E:\Git\dsh-gui-home\.staging`（主工程运行时根下的同名目录）不由 `scripts/staging.mjs` 维护，也不是任何验证步骤的位置；确认其中没有需要的产物后可以手动删除以释放空间，删除不影响主工程。
