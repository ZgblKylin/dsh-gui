# harness 升级：dsh-v0.2.2-alpha.3 → dsh-v0.2.2-rc.1

本文件记录在 `dsh-v0.2.2-alpha.3` 已交付（`bf41680`）之后，把工程基座继续推进到
`dsh-v0.2.2-rc.1` 的取舍与验收结果。alpha.3 阶段的完整验收记录见
[2026-11-07-harness-upgrade-v0-2-2-alpha-3.md](2026-11-07-harness-upgrade-v0-2-2-alpha-3.md)。

`dsh-v0.2.2-rc.1` 是 alpha 线提交的汇总 tag：alpha.3 之后的 4 个提交只改版本字段，
没有源码、资源或目录树变化，因此本轮按用户口径只做编译验证即可交付，不再重跑
WebUI / GUI 验收（alpha.3 的验收结论对 rc.1 成立）。

## 目标修订与发布状态

| 项 | 旧修订 | 新修订 | npm |
| --- | --- | --- | --- |
| deepseek-harness | dsh-v0.2.2-alpha.3（05b1cae8db） | **dsh-v0.2.2-rc.1**（66491b05e3） | `@deepseek-ai/dsh@0.2.2-rc.1` 已发布，`latest` 与 `next` 均指向它 |

官方家族四包（browser-use / playwright-mcp / computer-use / cua-driver-native）的 peer
精确指向 `0.2.2-rc.1`，必须与 harness 同批抬 pin；`@deepseek-ai/dsh-ssh` 家族、`dsh-base`、
`dsh-web-app` 等官方包在 registry 上同样有 `0.2.2-rc.1` 发布。`harness.json` 保持
`{"runtime":"npm","version":null}`，无需改清单。

## 区间规模

| 指标 | 值 |
| --- | --- |
| 提交数 | 4（`release(dsh): 0.2.2-rc.1` 收尾，另含 vendored 依赖换代与其合并提交） |
| 变更文件 | 387（+387 / -387），全部是 `package.json` 的版本字段 |
| 实质变更 | vendored cordis 4.1.0、cosmokit 1.9.0、group/hmr/include/loader/logger-console/schemastery/timer 的 stable 版本号；无源码改动 |

## 适配改动

| 文件 | 改动 |
| --- | --- |
| `deepseek-harness`（子模块指针） | 05b1cae8db → **66491b05e3（rc.1）** |
| `plugins/harness/browser-use.mjs`、`plugins/harness/computer-use.mjs` | 四个官方家族包 spec 抬到 `@deepseek-ai/*@0.2.2-rc.1`；注释与 README 同步 pinned tag |
| `plugins/harness/README.md` | 两张安装表与闸门描述的版本同步 |
| `plugins/README.md` | 安装方式清单、Current plugins 段、例外机制段与官方家族 pin 同步到 rc.1 |
| `plugins/{better-sidebar,deep-whale,ds-harness-remote,dsh-pause,dsh-pet,commandcode-provider,plugin-market,skill-mcp-center,dsh-web-ui}/install.mjs` 及对应 README | 注释/文档里的 pinned harness 版本与准入表述同步；npm pin 不变（新区间仍全部放行） |
| `docs/dsh-gui/{ssh-provider-vs-dsh-remote,ssh-remote-workspace,dsh-pet-troubleshooting}.md` | 运行时版本引用同步到 rc.1 |

`plugins/commandcode-provider` 的精确版本例外不需要改代码：`installNpmPlugin` 的 `exempt`
在安装时按实际运行时版本重新授予（alpha.3 阶段已验证该机制）。

## 验收（阶段一）

全部在 worktree `.staging/dsh-gui` 内完成；运行与构建都使用 worktree 自己的运行时根
（`.staging/`）与 DSH_HOME（`.staging/.dsh`），未触碰正在运行的 Desktop 实例与主仓库。

| 项目 | 命令 / 手段 | 结果 |
| --- | --- | --- |
| desktop 构建（编译验证） | `npm run build:desktop -- --skip-plugins` | 退出码 0（2026-11-08T01:58）；源 `66491b05e3`（0.2.2-rc.1）；产物 7787 文件 / 1.04 GB 落 `.staging/desktop`，入口与 shim 重建 |
| 打包产物版本抽查 | 打包 CLI `--expose-internals app.asar/dsh/.../dsh-desktop-host/lib/cli.js --version` | `0.2.2-rc.1`，退出码 0 |

alpha.3 阶段已完成并记录：desktop 构建、desktop profile 安装（24 依赖 / 22 bundle）、
`docs/official` 19 条链接全通、打包产物 smoke 手动补跑（Host/前端/CLI 插件装卸/Office 转换）、
WebUI 加载验收与 computer use GUI 启动验收。rc.1 相对 alpha.3 仅版本字段变化，这些结论对
rc.1 同样成立。

## 偏差与风险

- **构建期 smoke 仍临时跳过**：`runtime:smoke` 与打包产物 smoke 在本机检查完成后会挂住，
  验证时通过 `scripts/desktop.mjs` 的 `SOURCE_PATCHES` 临时跳过；该临时改动已在交付前撤销，
  不进入工作分支。打包产物 smoke 的完整检查已在 alpha.3 阶段手动补跑通过，rc.1 只改版本
  字段，未再补跑。
- **构建跳过插件安装**（`--skip-plugins`）：避免改写正在运行的 Desktop 实例的 profile；
  主工程重建时由用户停掉实例后由构建正常安装 rc.1 的官方家族包。
- **rc.1 的 WebUI / GUI 未重跑**：按用户口径（汇总 tag 验证编译即可交付），且区间内无源码
  差异；如后续对 rc.1 产物做实际启动发现异常，再按 alpha.3 的方式补验。
- 改动不做提交：工作分支上的变更留给用户签名提交，合并与重建也由用户执行。
