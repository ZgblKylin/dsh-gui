# AGENTS

## 目录结构

- .dsh: dsh配置目录
- deepseek-harness: dsh框架本体
- docs: 文档目录
- plugins: 本地插件目录
- src-tauri: tauri源码目录
- scripts: 启动脚本目录

## 自托管

dsh和所有插件、配置文件均需要自托管，不要使用系统全局安装。

## 非侵入

所有变更均通过插件实现，不要修改dsh框架本体。

## Commit规范

使用Conventional Commits规范。

## 文档

所有工程/子工程均需要同步维护文档，文档目录为：
- dsh-gui: docs
- 插件工程：plugins/<plugin-name>/docs
