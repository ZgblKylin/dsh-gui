# 升级验证工作区（staging workspace）

## 用途

`.staging/dsh-gui` 是本仓库的验证 worktree：一个 git worktree，检出工作分支 `staging/verify`，连同全部子模块一起维护；`<仓库根>/.staging/` 是它的运行时根，worktree 的 `.dsh`、`.harness`、`.toolchain`、`.pnpm-store` 与入口 exe 都在那里，全部位于会话工作区内。插件或 harness 的升级先在该 worktree 中更新、构建、冒烟检查，并验收 WebUI（更新含 harness 时另验 GUI）能正常加载与运行；验证适配改动直接提交在工作分支上，向用户报告并取得明确审批后才把工作分支合并回主分支实装，因此中途失败的升级不会让主分支正在服务的安装无法启动。升级流程见 skill [dsh-gui-update](../../.agents/skills/dsh-gui-update/SKILL.md)。

## 路径与运行时根

| 名称 | 路径 | 说明 |
| --- | --- | --- |
| 仓库根 / 会话工作区 | `<runtime-root>/dsh-gui`，本机 `E:\Git\dsh-gui-home\dsh-gui` | 不变 |
| 验证 worktree | `<仓库根>/.staging/dsh-gui`，本机 `E:\Git\dsh-gui-home\dsh-gui\.staging\dsh-gui` | `git worktree add` 创建；工作分支 `staging/verify` |
| worktree 运行时根 | `<仓库根>/.staging` | worktree 目录名是 `dsh-gui`，命中 `resolveRuntimeRoot` 的嵌套布局分支 |
| worktree DSH_HOME | `<仓库根>/.staging/.dsh` | 构建前必须显式设置 |
| worktree 工具链 | `.staging/.toolchain`、`.staging/.pnpm-store`、`.staging/.harness` | 由 worktree 内 `npm run build` 生成 |
| worktree 入口 exe | `.staging/dsh-gui.exe` | 由 worktree 内 `npm run build`（不带 `--skip-exe`）生成 |
| worktree git 元数据 | `.git/worktrees/dsh-gui/` | 主仓库 `.git` 内，位于工作区内 |
| worktree 子模块 gitdir | `.git/worktrees/dsh-gui/modules/<path>/` | 与主工程子模块的 gitdir 相互独立 |

`.staging/` 已被 `.gitignore` 忽略，worktree 不进入主仓库的版本管理视图。

## 维护命令

`scripts/staging.mjs` 通过 `npm run staging -- <命令>` 调用。

| 命令 | 行为 |
| --- | --- |
| `ensure` | 创建 worktree：`git worktree add` 把本仓库检出到 `.staging/dsh-gui`（工作分支 `staging/verify` 尚不存在时创建，已存在时检出该分支），并初始化全部子模块 |
| `sync` | 把工作分支对齐到本仓库当前 HEAD：工作分支的提交已全部包含在 HEAD 中时 `reset --hard`；存在未合并提交时拒绝，加 `--rebase` 时改用 `git rebase` 把这些提交重放到 HEAD；随后重新钉住子模块 |
| `status` | 汇报本仓库根与 HEAD、工作区改动数，worktree 路径、工作分支名、HEAD、工作区改动数与未合并提交数，子模块漂移，以及 worktree 运行时根的构建阶段；不联网；worktree 不存在时给出提示并退出 |
| `clean` | 移除 worktree 并删除运行时目录，需要 `--yes`；默认保留工作分支，加 `--branch` 时一并删除 `staging/verify` |

标记：`--recreate` 让 `ensure` 替换已有 worktree；`--rebase` 让 `sync` 重放工作分支上的未合并提交（rebase 失败时先 `git rebase --abort` 再报错）；`--yes` 确认 `clean` 的删除；`--branch` 让 `clean` 连同工作分支一起删除。`clean` 会先执行 `git worktree prune`，处理已被手工删除的 worktree 残留。

## worktree 与主仓库

worktree 与主仓库共享 object 库与 refs：`git worktree add` 只在 `.git/worktrees/dsh-gui/` 写元数据，创建与同步都不从网络拉取顶层仓库历史。`sync` 因此不 fetch 顶层仓库，本仓库当前 HEAD 就是权威基线；子模块仍可能因为新指针需要 fetch。

worktree 的子模块 gitdir 在 `.git/worktrees/dsh-gui/modules/<path>/`，与主工程子模块的 `.git/modules/<path>/` 相互独立，实装时的子模块搬运见下节。

## 工作分支与合并政策

- 验证 worktree 检出工作分支 `staging/verify`（首次 `ensure` 时基于本仓库 HEAD 创建）。工作分支上的提交不需要用户审批：它不改变主分支，也不影响正在运行的实例。验证适配改动直接在 worktree 内 `git add` 与 `git commit`，提交信息遵循仓库的 Conventional Commits 约定。仓库配置了 `commit.gpgsign=true`，而沙箱内无法引用用户的 GPG 签名，因此 worktree 内的提交显式关闭签名：`git -c commit.gpgsign=false commit ...`。该分支是临时验证分支，合并回主分支的 merge commit 由用户签名。
- 把工作分支合并回主分支是实装动作，需要用户明确审批，并由用户执行。主分支在验证期间前进过时，先在工作分支上 `git rebase`，或把主分支 merge 进工作分支，再执行合并：

  ```powershell
  cd E:\Git\dsh-gui-home\dsh-gui
  git status --porcelain                         # 期望为空
  git merge --no-ff staging/verify -m "feat: bump <module> to <revision>"
  ```

- 合并后主工程子模块指针随 gitlink 更新，需要 `git submodule update --init --recursive` 把主工程子模块 checkout 到新指针（可能需要网络 fetch）。
- 子模块内部的适配改动不会随顶层合并传递：主工程与 worktree 的子模块是相互独立的 git 仓库。实装时用本地 `fetch` 把 worktree 子模块的提交取进主工程子模块后 `cherry-pick`，或导出 `format-patch` 后 `git am`。`deepseek-harness/` 是 pinned 上游子模块，禁止编辑。

## 构建

```powershell
cd .staging\dsh-gui
$env:DSH_HOME = 'E:\Git\dsh-gui-home\dsh-gui\.staging\.dsh'   # 必须显式；下文用 <仓库根>/.staging/.dsh
npm run build -- --skip-exe     # dsh 运行时 + 插件 + preset
npm run build                   # 含入口 exe
```

worktree 内 `npm run build` 解析出的仓库根是 worktree 检出，运行时根自动是 `<仓库根>/.staging`：`.toolchain/`、`.pnpm-store/`、`.harness/`、`DSH_HOME` 与入口 exe 全部落在 `.staging/` 下，位于会话工作区内；cargo 的 `target` 留在 worktree 的 `src-tauri/target/`（被 `.gitignore` 忽略）。`--skip-exe` 跳过 cargo 与入口 exe 的复制，只验证 dsh 运行时与插件；需要一并验证入口 exe 时去掉该标记。

`DSH_HOME` 必须显式设置：dsh 会话导出了主工程的 `DSH_HOME=E:\Git\dsh-gui-home\.dsh`，worktree 内的每条 `node`、`dsh`、`install.mjs` 调用都会继承它；不覆盖就会写进主工程 home，既污染正在运行的实例，又是工作区外的写入。`harness.json` 决定 worktree 安装 registry 的 CLI（产出落在 `.staging/.harness/`）还是编译子模块，见 [harness-runtime.md](harness-runtime.md)。

worktree 内不要运行 `npm run staging`：脚本会拒绝在 `.staging` 路径内创建嵌套 worktree。

## 冒烟检查

升级后先确认组合能否渲染。用 `harness.json` 选定的 dsh CLI 做配置 dump，不监听端口；在仓库根执行（worktree 为 `source` 运行时则把入口换成 `.staging\dsh-gui\deepseek-harness\apps\cli\lib\bin.js`）：

```powershell
$env:DSH_HOME = 'E:\Git\dsh-gui-home\dsh-gui\.staging\.dsh'
node .staging\.harness\node_modules\@deepseek-ai\dsh\lib\bin.js --profile web --dump-config
```

## 阶段一验收：WebUI 与 GUI

[冒烟检查](#冒烟检查)只是前置条件：阶段一的通过基准是 worktree 真的能跑起来。

**WebUI 加载验收（每次升级都必做）**：以 worktree 自身的 DSH_HOME 在**空闲端口**启动它的 web 后端（正在运行的 dsh-gui 占着默认的 3080），确认 WebUI 能正确加载。

```powershell
cd .staging\dsh-gui
$env:DSH_GUI_PORT = "3090"   # 空闲端口，避免与运行中的实例争用
npm run harness              # scripts/harness.mjs：把 DSH_HOME 钉到 worktree 运行时根的 .dsh；不设 DSH_AGENTS_HOME
```

在 `http://127.0.0.1:3090` 确认会话界面正常渲染、能新建或载入会话、插件与组合没有加载失败提示或错误覆盖层；确认后结束该进程。构建全绿与 `--dump-config` 无报错都不算通过。

**GUI 启动运行验收（仅当本次更新包含 `deepseek-harness`）**：harness 换代可能让桌面外壳起不来，因此还要用 computer use 验证 GUI 能正常启动和运行。先构建入口 exe，再启动 worktree 自己的 exe：

```powershell
cd .staging\dsh-gui
$env:DSH_GUI_PORT = "3090"
npm run build                # 不带 --skip-exe，产出 .staging\dsh-gui.exe
npm start                    # 启动 .staging\dsh-gui.exe
```

入口 exe 从自身路径解析两个根（`src-tauri/src/roots.rs` 的 `repo_root` 与 `runtime_root`），与正在运行的实例互不干扰；唯一会冲突的是端口（`ensure_loopback_port_available`），因此必须换端口。确认窗口出现、加载页过渡到标签页、harness 就绪、能正常交互后关闭该实例。

两项验收都通过后，先向用户报告结论（worktree 路径、工作分支与提交、目标修订、验证命令与结果、适配改动清单、屏蔽项与未决风险），取得明确审批后才把工作分支合并回主分支实装。

## 与产品内「AI 更新」的关系

更新对话框的「AI 更新」把 `src-tauri/ui/app.js` 生成的提示词预填到会话：提示词以 `/dsh-gui-update` skill 手势开头，由 skill `dsh-gui-update` 驱动升级流程，本工作区就是该流程的验证位置。提示词末尾的「验证与实装门槛」（`AI_UPDATE_GATE_NOTE`）与本节一致：先在 `.staging/dsh-gui` 的验证 worktree 中验证，整个 worktree 位于会话工作区内，文件读写与工作分支上的提交复用工作区写权限、不需要额外审批，需要额外审批的只有执行（构建命令，以及 `git submodule` 依赖的 `sh.exe`）与写出工作区的动作，构建时把 `DSH_HOME` 显式设为 `<仓库根>/.staging/.dsh`；**「验证通过」指 worktree 的 WebUI 能正确加载**；本次更新包含 harness 时还要用 computer use 验证 GUI 能正常启动和运行；适配改动直接提交到 `staging/verify` 工作分支，两项都通过后向用户报告并**等用户审批后**才把工作分支合并回主分支完成实装。worktree 跨会话保留，已完成的依赖安装与构建可以复用，重复验证不必每次重新引导工具链。

## 沙箱与提权

验证 worktree 及其运行时根都位于会话工作区内，以下动作不需要额外审批：worktree 与主仓库内的文件读写与编辑；不触发 `sh.exe` 的 git 操作（`status`、`diff`、`log`、`add`、`commit`、`branch`、本地 `merge`、`reset`）；worktree 内构建产物写入 `.staging/` 运行时根。

以下操作可能被拦截，需要按仓库 `AGENTS.md` 的提权规则以最窄的足够宽模式申请一次放行：

- `ensure`、`sync`：`git worktree add` 的 git-lfs smudge filter 与 `git submodule` 系列都依赖 Cygwin `sh.exe`，被拦截时 `sh.exe` 报 `CreateFileMapping` 失败。
- worktree 内的 `npm run build`：pnpm 执行依赖的生命周期脚本（例如 `koffi`、`node-pty`）时 `spawn EPERM`，cargo 构建同样需要执行放行。

写出会话工作区的动作仍需要放行，典型是把 `DSH_HOME` 误指向主工程运行时根的 `.dsh`。在普通终端中运行不需要提权。

## 不注册为 DSH 项目

验证 worktree 不作为 DSH 工作区注册。它的目录名同样是 `dsh-gui`，而 `dsh-ai-update` 的浏览器半按路径 basename 为 `dsh-gui` 选择 AI 更新会话的目标工作区，注册 worktree 可能让它选中 worktree 而不是本工程。会话以本工程的工作区（仓库根）为工作区即可读写 worktree；**主工程运行时根不得作为 DSH 工作区**，沙箱会给工作区树打低完整性标签，`.dsh`、`.harness`、`.toolchain` 与入口 exe 一旦进入该范围，其中的可执行文件就以低完整性运行，见 [windows-acl-low-integrity-label.md](windows-acl-low-integrity-label.md)。

## 相关文件

- `scripts/staging.mjs` —— worktree 的创建、同步、状态与删除
- `scripts/harness-runtime.mjs` —— 仓库根与运行时根的解析契约
- `harness.json`、`docs/dsh-gui/harness-runtime.md` —— dsh 运行时的选择、解析契约与版本来源
- `docs/dsh-gui/nested-clone-layout.md` —— 两个根的契约、硬约束与迁移步骤
- `src-tauri/ui/app.js` —— 更新对话框的 AI 更新提示词
- `docs/dsh-gui/update-check.md` —— 更新检查与 npm 发布状态
- `docs/dsh-gui/2026-08-30-harness-upgrade-v0-1-2-alpha-1-build-failure.md` —— harness 升级后构建失败的事故复盘
