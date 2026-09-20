# Harness 升级记录：dsh-v0.1.6-alpha.1 → dsh-v0.1.6-alpha.2

## 背景

`deepseek-harness` 子模块由 `dsh-v0.1.6-alpha.1`（`0a15e36e7f`）升级到
`dsh-v0.1.6-alpha.2`（`ddefc45fbc`）。`harness.json` 仍为 `runtime: npm`、
`version: null`，build 按子模块 `apps/cli/package.json` 的版本从 registry 安装
`@deepseek-ai/dsh@0.1.6-alpha.2`（`alpha` dist-tag）。

按 skill `dsh-gui-update` 的两阶段约定，升级先在 `.staging/dsh-gui` 副本中完成并
验证，通过后才实装到本工程。副本验证位置与命令见
[upgrade-staging-workspace.md](upgrade-staging-workspace.md)。

## 上游变更

`0a15e36e7f..ddefc45fbc` 之间约 70 个 first-parent 合并提交，以 web UI、插件管理
（`feat/plugin-mgmt-4-web`、`plugin-manager`）、桌面更新（`feat/desktop-update`）与
修复为主。本仓库组合没有需要改写的破坏性契约面：副本构建与组合渲染在升级前后均
通过，未发现被移除或改名的上游条目命中本仓库源码（`git ls-files` 范围内未命中
`workflow-worker-thread`、`tool-ralph`、`agent/created`、`snapshotEvents` 等）。

## 需要的适配

本仓库没有直接使用被移除或改名的上游接口；适配集中在「与 pinned harness 同版本
配套」的精确 pin 与版本标注上：

- `plugins/harness/agent-team.mjs`：`TEAM_VERSION` 由 `0.1.6-alpha.1` 提升到
  `0.1.6-alpha.2`，覆盖 `@deepseek-ai/dsh-experimental-agent-team-profile` 与
  `@deepseek-ai/dsh-experimental-agent-team-web-profile`。
- `plugins/harness/auto-review.mjs`、`browser-use.mjs`、`computer-use.mjs`：其余五个
  官方 family 包（`@deepseek-ai/dsh-experimental-auto-review`、
  `@deepseek-ai/dsh-browser-use`、`@deepseek-ai/dsh-experimental-browser-use-playwright-mcp`、
  `@deepseek-ai/dsh-computer-use`、`@deepseek-ai/dsh-experimental-computer-use-cua-driver-native`）
  的精确 pin 同步到 `0.1.6-alpha.2`。
- 根 `package.json` 的 `@deepseek-ai/dsh` 依赖引用到 `^0.1.6-alpha.2`；
  `package-lock.json` 重建（1636 处 `0.1.6-alpha.2`，无 `0.1.6-alpha.1` 残留）。
- 注释与文档中的版本标注同步：`plugins/harness/README.md`、
  `plugins/README.md`、`scripts/harness-runtime.mjs`（tag 到 version 的推导示例）、
  `docs/dsh-gui/harness-runtime.md`（`latest` 落后于预发布的示例）、
  `docs/dsh-gui/ssh-remote-workspace.md`（当前运行时与 ssh 家族安装命令）。

`harness.json` 无需改动，版本仍从子模块 manifest 推导。

## 验证

- `.staging/dsh-gui` 内 `npm run build -- --skip-exe` 退出码为 `0`：dsh 运行时按
  `0.1.6-alpha.2` 安装，全部插件 wrapper 与派生 preset（`standard-team` /
  `ptc-team`）完成。
- `--profile web --dump-config` 组合渲染干净，无 `duplicate loader entry id`、无
  缺失插件、无 patch 报错。
- npm 安装型 wrapper 与 dsh 运行时的 npm 发布状态已核对：`@deepseek-ai/dsh`、七个
  family 插件包、四个 ssh 家族包的 `0.1.6-alpha.2` 均已发布，无需屏蔽任何插件。
- 明确的子模块指针不会漂移：本工程检出的 `ddefc45fbc` 与副本一致。

## 运行期注意事项

- 本工程已实装子模块指针与 11 个版本化文件；停止运行中的实例后重跑
  `npm run build` 才会按新版本安装 `.harness` 与插件。入口 exe 被占用时可加
  `--skip-exe`。
- 本工程 `.harness` 是就地升级，由构建的家族一致性检查与干净重装兜底，避免重演
  alpha.1 的混合版本树事故（见
  [2026-09-16-harness-upgrade-v0-1-6-alpha-1.md](2026-09-16-harness-upgrade-v0-1-6-alpha-1.md)）。
- 本次副本构建第一次在 `dsh plugin add` 写 `package.json` 期间被强杀，遗留陈旧的
  atomic-write 锁（`.dsh/profiles/web/package.json.lock`），后续构建等待该锁直到超时。
  清理方式见 skill `dsh-gui-update` 的常见坑。

## 相关文件

- `.gitmodules` 记录的子模块指针（`deepseek-harness` → `ddefc45fbc`）
- `plugins/harness/{agent-team,auto-review,browser-use,computer-use}.mjs` —— 七个
  family 包的版本 pin 与注释
- `plugins/README.md`、`plugins/harness/README.md` —— 版本行
- `package.json`、`package-lock.json` —— 根依赖引用与锁文件
- `scripts/harness-runtime.mjs`、`docs/dsh-gui/harness-runtime.md` —— 版本注释
- `docs/dsh-gui/ssh-remote-workspace.md` —— 当前运行时与 ssh 家族安装命令
- `.agents/skills/dsh-gui-update/SKILL.md` —— 两阶段升级流程与常见坑