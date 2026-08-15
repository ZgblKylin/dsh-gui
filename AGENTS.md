# 开发约定

## 目录结构

- .dsh: dsh配置目录
- deepseek-harness: dsh框架本体
- docs: 文档目录
- plugins: 本地插件目录
- presets: agent preset源目录（presets/<id>/自带install.mjs，npm run build时统一安装到.dsh/.agent-presets/）
- src-tauri: tauri源码目录
- scripts: 启动脚本目录

## 环境检查

不清楚当前运行环境时，先确认当前 shell 和系统，再继续操作：是 PowerShell
（pwsh）、Git Bash，还是 WSL、Linux、macOS。尤其在处理换行符、路径分隔符
或 git 行尾转换（core.autocrlf）之前必须确认；可用 `uname -a`（类 Unix
环境）或 `$PSVersionTable`（pwsh）辅助判断。

## 工具与终端

以下约定确保可用工具能被按需使用，避免在 git bash、windows换行符 等特殊环境的调用细节上反复尝试。

- Windows 环境需注意文件使用 CRLF 换行符，避免在 git bash 中使用 sed、grep 等工具时出现问题。
- Windows 环境需要调用 PowerShell 时，先检测 `pwsh` 是否可用；可用则优先使用 `pwsh`。
- 搜索文件和内容时，先检测 `rg` 是否可用；可用则优先使用 `rg`。
- 有 `skill_search` / `skill_load` 时，先按需检索是否存在所需 skill。
- 有 `dev_tool_search` 时，在需要时优先用它加载工具来代替终端命令：
  - `grep`、`sed` 等搜索和编辑工具
  - `web_search` 等进阶工具
  - `subagent`、`workflow` 等 agent 任务编排工具

## 自托管

dsh和所有插件、配置文件均需要自托管，不要使用系统全局安装。

## 非侵入

所有变更均通过插件实现，不要修改dsh框架本体。

## Commit规范

使用Conventional Commits规范。

## 文档

所有工程/子工程均需要同步维护文档，文档目录为：

- dsh-gui: docs
- 插件工程：plugins/<id>/<plugin-name>/docs
