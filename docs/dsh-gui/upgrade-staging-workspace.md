# 升级验证工作区（staging workspace）

## 用途

`.staging/dsh-gui` 是本仓库的持久化 clone 副本，连同全部子模块一起维护。插件或 harness 的升级先在该副本中更新、构建、冒烟检查，并验收 WebUI（更新含 harness 时另验 GUI）能正常加载与运行；报告用户并取得明确审批后才实装到本工程，因此中途失败的升级不会让本工程正在服务的安装无法启动。升级流程见 skill [dsh-gui-update](../../.agents/skills/dsh-gui-update/SKILL.md)。

副本自带独立的 DSH_HOME（`.staging/dsh-gui/.dsh`）、工具链（`.toolchain/`）、pnpm store（`.pnpm-store/`）与构建产物，验证过程不写入本工程的对应目录。`.staging/` 由 `.gitignore` 排除，副本永不作为本仓库的源。

## 维护命令

`scripts/staging.mjs` 通过 `npm run staging -- <命令>` 调用。

| 命令 | 行为 |
| --- | --- |
| `ensure` | 创建副本：clone 本仓库，写入本仓库已解析的子模块 URL，初始化全部子模块，把本仓库的 origin URL 注册为副本的 `upstream` 远端 |
| `sync` | 把副本移动到本仓库当前修订：fetch，检出该修订，重新钉住子模块 |
| `status` | 汇报两侧修订、子模块漂移与副本已完成的构建阶段，不联网 |
| `clean` | 删除副本，需要 `--yes` |

标记：`--from-origin` 让 `ensure` 从 origin URL 克隆顶层工程，而不是本工程的工作区路径；`--recreate` 让 `ensure` 替换已有副本；`--yes` 确认 `clean` 的删除。

## 副本的来源与远端

顶层工程的 `origin` 指向本工程的工作区路径，`sync` 因此能把本工程已提交的修订（含未推送的提交）带入副本。副本的 `upstream` 指向本工程 origin 的真实 URL，用于验证顶层仓库自身的远端更新。

子模块 URL 取自本仓库 `.git/config` 中已解析的值。`.gitmodules` 里若出现相对 URL，按 origin URL 解析后再写入副本，因此副本不依赖本工程目录的相对位置（当前在册子模块都写绝对 URL，相对形式只是保留的支持路径）。

`sync` 只带入已提交的修订。本工程的未提交改动需要你在副本中重做同样的编辑，或导出为 patch 应用到副本，否则验证的不是即将实装的状态。

## 副本内的构建

```powershell
cd .staging\dsh-gui
npm run build -- --skip-exe
```

副本内 `npm run build` 解析的 `ROOT`、`.toolchain/`、`.pnpm-store/` 与 `DSH_HOME` 全部指向副本，dsh 运行时的安装或构建、各插件安装脚本与 agent preset 安装都落在副本内，不触碰本工程的 `.dsh/`。副本的 `harness.json` 决定它安装 registry 的 CLI（产出落在副本的 `.harness/`）还是编译子模块，见 [harness-runtime.md](harness-runtime.md)。`--skip-exe` 跳过 cargo 与入口 exe 的复制，只验证 dsh 运行时与插件；需要一并验证入口 exe 时去掉该标记。

副本内不要运行 `npm run staging`：该路径解析出的 `ROOT` 是副本自身，脚本会拒绝嵌套创建副本。

## 冒烟检查

升级后先确认组合能否渲染。用 `harness.json` 选定的 dsh CLI 做配置 dump，不监听端口（在仓库根目录执行；副本为 `source` 运行时则把入口换成副本内的 `.staging\dsh-gui\deepseek-harness\apps\cli\lib\bin.js`）：

```powershell
$env:DSH_HOME = "$PWD\.staging\dsh-gui\.dsh"
node .staging\dsh-gui\.harness\node_modules\@deepseek-ai\dsh\lib\bin.js --profile web --dump-config
```

## 阶段一验收：WebUI 与 GUI

[冒烟检查](#冒烟检查)只是前置条件——阶段一的通过基准是副本真的能跑起来。

**WebUI 加载验收（每次升级都必做）**：以副本自身的 DSH_HOME 在**空闲端口**启动副本的 web 后端（正在运行的 dsh-gui 占着默认的 3080），确认 WebUI 能正确加载。

```powershell
cd .staging\dsh-gui
$env:DSH_GUI_PORT = "3090"   # 空闲端口，避免与运行中的实例争用
npm run harness              # scripts/harness.mjs：副本 .dsh 为 DSH_HOME，副本 .dsh\.agents 为 DSH_AGENTS_HOME
```

在 `http://127.0.0.1:3090` 确认会话界面正常渲染、能新建或载入会话、插件与组合没有加载失败提示或错误覆盖层；确认后结束该进程。构建全绿与 `--dump-config` 无报错都不算通过。

**GUI 启动运行验收（仅当本次更新包含 `deepseek-harness`）**：harness 换代可能让桌面外壳起不来，因此还要用 computer use 验证 GUI 能正常启动和运行。先构建入口 exe，再启动副本自己的 exe：

```powershell
cd .staging\dsh-gui
$env:DSH_GUI_PORT = "3090"
npm run build                # 不带 --skip-exe，产出副本根目录的 dsh-gui.exe
npm start                    # 启动副本根目录的入口 exe
```

副本 exe 从自身路径解析仓库根与 `.dsh`（`src-tauri/src/main.rs` 的 `repo_root`），与正在运行的实例互不干扰；唯一会冲突的是端口（`ensure_loopback_port_available`），因此必须换端口。确认窗口出现、加载页过渡到标签页、harness 就绪、能正常交互后关闭该实例。

两项验收都通过后，先向用户报告结论（副本路径、目标修订、验证命令与结果、适配改动清单、屏蔽项与未决风险），取得明确审批后才执行阶段二实装到本工程。

## 与产品内「AI 更新」的关系

更新对话框的「AI 更新」把 `src-tauri/ui/app.js` 生成的提示词预填到会话：提示词以 `/dsh-gui-update` skill 手势开头，由 skill `dsh-gui-update` 驱动升级流程，本工作区就是该流程的验证位置。提示词末尾的「验证与实装门槛」（`AI_UPDATE_GATE_NOTE`）与本节一致：先在本副本验证，**「验证通过」指副本的 WebUI 能正确加载**；本次更新包含 harness 时还要用 computer use 验证 GUI 能正常启动和运行；两项都通过后向用户报告，**等用户审批后**才把更新同步到主工程。副本跨会话保留，已完成的依赖安装与构建可以复用，重复验证不必每次重新引导工具链。

## 沙箱与提权

在 dsh 沙箱会话中，以下操作会被拦截，需要按仓库 `AGENTS.md` 的提权规则以最窄的足够宽模式申请一次放行：

- `ensure`、`sync` 与副本内的子模块操作：Windows 上 `git submodule` 是 shell 脚本，git 的本地传输同样会启动 Cygwin `sh.exe`，被拦截时 `sh.exe` 报 `CreateFileMapping` 失败。
- 副本内的 `npm run build`：pnpm 执行依赖的生命周期脚本（例如 `koffi`、`node-pty`）时 `spawn EPERM`。

在普通终端中运行不需要提权。

## 不注册为 DSH 项目

副本不作为 DSH 工作区注册。`dsh-ai-update` 的浏览器半按路径 basename 为 `dsh-gui` 选择 AI 更新会话的目标工作区，注册副本可能让它选中副本而不是本工程。副本位于本工程工作区内，会话以本工程为工作区即可读写副本。

## 相关文件

- `scripts/staging.mjs` —— 副本的创建、同步、状态与删除
- `harness.json`、`docs/dsh-gui/harness-runtime.md` —— dsh 运行时的选择、解析契约与版本来源
- `.gitignore` —— `.staging/` 条目
- `src-tauri/ui/app.js` —— 更新对话框的 AI 更新提示词
- `docs/dsh-gui/update-check.md` —— 更新检查与 npm 发布状态
- `docs/dsh-gui/2026-08-30-harness-upgrade-v0-1-2-alpha-1-build-failure.md` —— harness 升级后构建失败的事故复盘
