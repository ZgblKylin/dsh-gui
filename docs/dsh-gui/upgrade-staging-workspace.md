# 升级验证工作区（staging workspace）

## 用途

`.staging/dsh-gui` 是本仓库的持久化 clone 副本，连同全部子模块一起维护。插件或 harness 的升级先在该副本中更新、构建与冒烟检查，通过后才实装到本工程，因此中途失败的升级不会让本工程正在服务的安装无法启动。升级流程见 skill [dsh-gui-update](../../.agents/skills/dsh-gui-update/SKILL.md)。

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

子模块 URL 取自本仓库 `.git/config` 中已解析的值。`.gitmodules` 里的相对 URL（例如 `plugins/review/dsh-review` 的 `../dsh-review`）按 origin URL 解析后再写入副本，因此副本不依赖本工程目录的相对位置。

`sync` 只带入已提交的修订。本工程的未提交改动需要你在副本中重做同样的编辑，或导出为 patch 应用到副本，否则验证的不是即将实装的状态。

## 副本内的构建

```powershell
cd .staging\dsh-gui
npm run build -- --skip-exe
```

副本内 `npm run build` 解析的 `ROOT`、`.toolchain/`、`.pnpm-store/` 与 `DSH_HOME` 全部指向副本，harness 构建、各插件安装脚本与 agent preset 安装都落在副本内，不触碰本工程的 `.dsh/`。`--skip-exe` 跳过 cargo 与入口 exe 的复制，只验证 harness 与插件；需要一并验证入口 exe 时去掉该标记。

副本内不要运行 `npm run staging`：该路径解析出的 `ROOT` 是副本自身，脚本会拒绝嵌套创建副本。

## 冒烟检查

升级后先确认组合能否渲染。用 harness CLI 的配置 dump 检查，不监听端口（在仓库根目录执行）：

```powershell
$env:DSH_HOME = "$PWD\.staging\dsh-gui\.dsh"
node .staging\dsh-gui\deepseek-harness\apps\cli\lib\bin.js --profile web --dump-config
```

## 与产品内「AI 更新」的关系

更新对话框的「AI 更新」把 `src-tauri/ui/app.js` 生成的提示词预填到会话，其中要求 agent 在系统临时目录建立一次性副本再验证。本工作区是该流程的持久化形式：副本跨会话保留，已完成的依赖安装与构建可以复用，重复验证不必每次重新引导工具链。

## 沙箱与提权

在 dsh 沙箱会话中，以下操作会被拦截，需要按仓库 `AGENTS.md` 的提权规则以最窄的足够宽模式申请一次放行：

- `ensure`、`sync` 与副本内的子模块操作：Windows 上 `git submodule` 是 shell 脚本，git 的本地传输同样会启动 Cygwin `sh.exe`，被拦截时 `sh.exe` 报 `CreateFileMapping` 失败。
- 副本内的 `npm run build`：pnpm 执行依赖的生命周期脚本（例如 `koffi`、`node-pty`）时 `spawn EPERM`。

在普通终端中运行不需要提权。

## 不注册为 DSH 项目

副本不作为 DSH 工作区注册。`dsh-ai-update` 的浏览器半按路径 basename 为 `dsh-gui` 选择 AI 更新会话的目标工作区，注册副本可能让它选中副本而不是本工程。副本位于本工程工作区内，会话以本工程为工作区即可读写副本。

## 相关文件

- `scripts/staging.mjs` —— 副本的创建、同步、状态与删除
- `.gitignore` —— `.staging/` 条目
- `src-tauri/ui/app.js` —— 更新对话框的 AI 更新提示词
- `docs/dsh-gui/update-check.md` —— 更新检查与 npm 发布状态
- `docs/dsh-gui/2026-08-30-harness-upgrade-v0-1-2-alpha-1-build-failure.md` —— harness 升级后构建失败的事故复盘
