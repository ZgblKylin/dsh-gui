# Harness 升级记录：dsh-v0.1.5-rc.2 → dsh-v0.1.6-alpha.1

## 背景

`deepseek-harness` 子模块由 `dsh-v0.1.5-rc.2`（`fb2c4b9e`）升级到 `dsh-v0.1.6-alpha.1`
（`0a15e36e7f`）。该跨度为 800 个提交，是 `0.1.5` 发布后的下一个 alpha：`harness.json`
选择 npm 运行时，build 按子模块 `apps/cli/package.json` 的版本从 registry 安装
`@deepseek-ai/dsh@0.1.6-alpha.1`（`alpha` dist-tag）。

按 skill `dsh-gui-update` 的两阶段约定，升级先在 `.staging/dsh-gui` 副本中完成并验证，
通过后才实装到本工程。副本验证位置与命令见 [upgrade-staging-workspace.md](upgrade-staging-workspace.md)。

## 上游变更

发布说明（[v0.1.6-alpha.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.1)）
对开发者按破坏性变更逐一说明。与本仓库组合相关的主要变更：

| 变更 | 说明 |
| --- | --- |
| PTC 包与服务统一为 `ptc-runtime` 系列 | 旧名称不再兼容，`workflow-worker-thread` 改为 `workflow-ptc` |
| 预设默认关闭 `ralph` | `tool-ralph` 在 `standard` / `cordis` / `ptc` 组合中加 `disabled: true` |
| `agent/session-start` 改为异步串行的 `agent/created` | 相关插件与注册调用需适配 |
| 弃用 Session 同步历史接口 `snapshotEvents`、`eventAt`、`ownEvents` | 旧接口保留但弃用 |
| Team 模式统一 `spawn_teammate` | 关闭 `subagent` 与 `subagent_fork`，队友上限默认 8 增至 16 |
| `SandboxProvider.confine` 与 `ShellExecutor.start` 改为可取消异步接口 | 准备时间计入超时 |

`SESSION_FORMAT_VERSION` 保持 `3`，本次无会话格式迁移。`.harness` 的 `allowBuilds`
决策无需新增条目，副本构建未报 `ERR_PNPM_IGNORED_BUILDS`。

## 需要的适配

本仓库无源码引用上述被移除或改名的上游条目（`git ls-files` 范围内未命中
`workflow-worker-thread`、`tool-ralph`、`agent/created`、`snapshotEvents` 等）。

### agent-team 两个 npm bundle 的版本钉

`plugins/agent-team/install.mjs` 的 `TEAM_VERSION` 由 `0.1.5-rc.2` 提升到 `0.1.6-alpha.1`。
该 wrapper 的注释契约是「pinned to the harness revision this repository builds
against」：harness 换代后，同版本的两个官方实验 bundle
（`@deepseek-ai/dsh-experimental-agent-team-profile` 与
`@deepseek-ai/dsh-experimental-agent-team-web-profile`）在 npm `alpha` 上已发布，
且其 peer 面收窄到 `@deepseek-ai/cordis`（旧 `0.1.5-rc.2` 还声明
`dsh-agent` / `dsh-session` 等 `^0.1.5-rc.x` peer，与新 harness 家族不再匹配）。
`plugins/README.md` 与 `plugins/agent-team/README.md` 的版本行同步更新。

### 验证

- `.staging/dsh-gui` 内 `npm run build -- --skip-exe` 退出码为 `0`：dsh 运行时按
  `0.1.6-alpha.1` 安装，8 个插件 wrapper（含 dsh-web-ui 六个 npm bundle）与派生 preset
  （`standard-team` / `ptc-team`）全部完成。
- `dsh --profile web --dump-config` 渲染 630 行组合树，无 `duplicate loader entry id`、
  无缺失插件、无 patch 报错；20+ 插件行全部在位。
- agent-team bundle 升级到 `0.1.6-alpha.1` 后重跑 wrapper 退出码为 `0`，重跑
  `--dump-config` 依旧干净。
- 所有 npm 安装型 wrapper 与 dsh 运行时的 npm 发布状态已核对：`@deepseek-ai/dsh`、
  两个 agent-team bundle 的 `0.1.6-alpha.1` 均已发布。
- `dsh --version` 输出 `0.1.6-alpha.1`。

安装期出现的 peer 警告（`pnpm peers check` 报 `missing peer`）为既有现象：这些 peer 包
（`@deepseek-ai/cordis`、`dsh-agent`、`dsh-session` 等）在 `.harness` 与 profile 两种布局下
由 harness 自身依赖树提供，profile 的 `node_modules` 并不承载它们；升级前后同样出现，
不构成回归，未屏蔽任何插件。

## 对本仓库的影响

### 运行时与构建

- `harness.json` 仍为 `runtime: npm`、`version: null`，版本从子模块
  `apps/cli/package.json`（现 `0.1.6-alpha.1`）推导，无需改动。
- 根 `package.json` 的 `@deepseek-ai/dsh` 依赖已是 `^0.1.6-alpha.1`，
  与本次更新目标一致。
- 外壳（`src-tauri`）不依赖被移除或改名的上游能力；`docs/official` 的符号链接目标在
  `dsh-v0.1.6-alpha.1` 全部存在（`examples` 链接在两代 tag 下均为悬空，属既有状态）。

### 插件

`agent-team` 之外的所有 wrapper 版本钉不变，其 peer 面表达仍指 `^0.1.5-rc.x`，与新
harness 家族存在预发布版本差；副本安装与组合渲染通过，属于「上游插件发布跟进」的待办，
不阻塞本次 harness 升级。`dsh-pet` 等使用 `api.events.mux/host` 的旧路径已在插件侧
0.2.9 移除，本仓库不在该路径上。

## 运行期注意事项

- 默认模型仍由 `.dsh/settings.yaml` 显式指定，上游把 DeepSeek 默认协议改为 Messages
  不影响本机配置。
- `deepseek-harness/` 是只读子模块，本仓库未编辑其中任何文件，也未从其中向插件复制代码。

## 相关文件

- `.gitmodules` 记录的子模块指针（`deepseek-harness` → `0a15e36e7f`）
- `plugins/agent-team/install.mjs`、`plugins/agent-team/README.md`、`plugins/README.md`
  —— agent-team bundle 版本钉与版本行
- `scripts/harness-runtime.mjs`、`docs/dsh-gui/harness-runtime.md` —— 版本注释与 npm
  发布位置（`alpha`）
- `.agents/skills/dsh-gui-update/SKILL.md` —— 两阶段升级流程
- `docs/dsh-gui/upgrade-staging-workspace.md` —— 副本的位置、维护与冒烟检查
- `docs/dsh-gui/2026-09-11-harness-upgrade-v0-1-5-rc-2.md` —— 上一次 harness 升级记录