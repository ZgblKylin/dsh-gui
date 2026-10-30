# 插件模块升级：6 个 plugin submodule 换代

本文件记录把 `plugins/` 下 6 个插件模块升级到各自上游最新 tag 的取舍与验收结果，
与同日完成的 harness 升级（[2026-10-29-harness-upgrade-v0-2-2-alpha-2.md](2026-10-29-harness-upgrade-v0-2-2-alpha-2.md)）
配套：harness 已先升到 `dsh-v0.2.2-alpha.2`，本轮插件 pin 在同一运行时下验证。
流程按 skill [dsh-gui-update](../../.agents/skills/dsh-gui-update/SKILL.md)：先在副本
`.staging/dsh-gui` 换代、构建、验收，通过后同步回本工程。

## 目标修订

| 模块 | 路径 | 旧 → 新 tag | npm pin | 区间提交 |
| --- | --- | --- | --- | --- |
| dsh-web | `plugins/dsh-web-ui/dsh-web-ui` | v0.4.8 → **v0.4.12** | 3 包 `@linxin666/*@0.4.8` → `0.4.12` | 223 |
| DSH-better-sidebar | `plugins/better-sidebar/DSH-better-sidebar` | v0.28.0 → **v0.28.2** | `dsh-better-sidebar@0.28.0` → `0.28.2` | 94 |
| dsh-sidebar-qa | `plugins/better-sidebar/dsh-sidebar-qa` | v1.2.1 → **v1.2.2** | `dsh-sidebar-qa@1.2.1` → `1.2.2` | 4 |
| dshmarket | `plugins/plugin-market/dsh-market` | v1.70.2 → **v1.73.3** | `dshmarket@1.70.2` → `1.73.3` | 40 |
| dsh-pet | `plugins/dsh-pet/dsh-pet` | v0.3.7 → **v0.3.8-test.2** | `dsh-pet@0.3.7` → `0.3.8`（见下） | 101 |
| dsh-commandcode-provider | `plugins/commandcode-provider/dsh-commandcode-provider` | v0.15.4 → **v0.15.5** | `@mars-sea/dsh-commandcode-provider@0.15.4` → `0.15.5` | 27 |

目标 tag 均为各自远端默认分支可达的最新 tag（`git describe --tags --abbrev=0 origin/HEAD`）。

## 上游变更与准入

| 模块 | 要点 |
| --- | --- |
| dsh-web v0.4.12 | 三个安装包 peer 抬到 `@deepseek-ai/dsh >= 0.2.1-rc.3`（v0.4.9 起，此前 `>= 0.2.1-rc.2`），0.2.2-alpha.2 满足；`dsh.client.inject` 新增 `dsh-client-store` / `dsh-client-ui-renderer` / `dsh-api-remotes` 等，均在 alpha.2 中存在。子模块 0.4.12 仍不含 `dsh-model-capabilities` 源码，安装集不变（仍只装 settings / skill-explorer / usage 三包） |
| dsh-better-sidebar v0.28.2 | 13 条 dsh peer 仍全指 `^0.2.1-rc.1`，闸门通过；peer 里既有 `@huanlin/dsh-plugin-better-locale: ^0.1.0`（0.28.0 起就有，本 wrapper 不安装，pnpm 仅告警） |
| dsh-sidebar-qa v1.2.2 | `engines.dsh >=0.1.7-alpha.1` 覆盖 alpha.2；`dsh.client.inject` 与 1.2.1 一致（含 `@deepseek-ai/dsh-client-runtime`，该包在 rc.3 起就不存在，1.2.1 实测不影响加载，1.2.2 同） |
| dshmarket v1.73.3 | 无 `engines.dsh`，`@deepseek-ai/dsh-settings` peer 的 0.2 线分支（`^0.2.1-alpha.3 \|\| ^0.2.1-rc.1`）与 1.70.x 相同，闸门通过；修复更新/修复链路与目录源 tarball 看门狗 |
| dsh-pet v0.3.8-test.2 | **npm 发布滞后**：tag 建在 `v0.3.8` 发布提交之后（101 个提交），但 registry 只到 `0.3.8`（`latest` 与 `test` 两个 dist-tag 都指向它），没有 `0.3.8-test.2`。因此子模块 checkout 只作源码参考，运行时装 `dsh-pet@0.3.8`；等上游发布新版本再抬 pin |
| commandcode v0.15.5 | `engines.dsh` 仍是 `>=0.2.1-rc.2 <0.2.2-0`（`dsh.compatibility.dshReleases` 增记 rc.4），上界排除 0.2.2 线，registry 无放行版本 → 精确版本例外从 `0.15.4` 改键到 `0.15.5` |

## 适配改动

| 文件 | 改动 |
| --- | --- |
| `plugins/dsh-web-ui/install.mjs` | 三包 pin `0.4.8` → `0.4.12`；头部 tag/peer 说明同步 |
| `plugins/better-sidebar/install.mjs` | `dsh-better-sidebar` `0.28.0` → `0.28.2`、`dsh-sidebar-qa` `1.2.1` → `1.2.2`；补两条「已知限制」（见下） |
| `plugins/plugin-market/install.mjs` | pin `1.70.2` → `1.73.3`；说明补 1.73.x 沿用的 peer 区间 |
| `plugins/dsh-pet/install.mjs` | pin `0.3.7` → `0.3.8`；补 npm 发布滞后说明 |
| `plugins/commandcode-provider/install.mjs` | pin `0.15.4` → `0.15.5`；`exempt` 原因改写，例外改键到 0.15.5 |
| `plugins/README.md` | 例外机制段与六个插件条目同步（含 dshmarket/better-sidebar/sidebar-qa/dsh-pet/commandcode/dsh-web-ui 的版本与说明），并修正英文 Current plugins 段里 commandcode 的旧结论（该段曾写成「区间接纳 alpha.2、无需例外」） |
| `plugins/dsh-web-ui/README.md` | 三包版本与 tag `0.4.8` → `0.4.12`；peer 下限改为 `>= 0.2.1-rc.3`（v0.4.9 起） |
| `plugins/dsh-pet/README.md` | 版本与 tag 同步（tag `v0.3.8-test.2`、npm `0.3.8`）；补 npm 滞后说明；顺带修正失效的 harness 版本引用（`0.2.1-alpha.2` → `0.2.2-alpha.2`） |
| `plugins/commandcode-provider/README.md` | 版本/tag/发布日（0.15.5 于 2026-10-27 发布）同步；兼容性状态与已知限制改为「区间不覆盖 0.2.2，wrapper 授予精确版本例外」 |
| `README.md` | dsh-web-ui 三包版本 `0.4.8` → `0.4.12` |
| 子模块指针 | 六个插件子模块同步到上表的新 tag |

## 验收（阶段一，副本内）

1. **换代**：六个子模块在副本中各自 `fetch --tags` 后检出目标 tag（全部 exit 0）。
2. **构建**：`npm run build`（含 cargo 入口 exe）exit 0；cargo 增量 1m36s。
3. **组合冒烟**：`--profile web --dump-config` **passed**，无 `duplicate loader entry id`、
   无 `patch: entry … not found`、无被跳过的 bundle；`llm-commandcode` 行在组合中。
4. **装出的版本**（副本 profile）：`@linxin666/dsh-client-ui-web-ui-settings@0.4.12`、
   `…skill-explorer@0.4.12`、`@linxin666/dsh-usage@0.4.12`、`dsh-better-sidebar@0.28.2`、
   `dsh-sidebar-qa@1.2.2`、`dshmarket@1.73.3`、`dsh-pet@0.3.8`、
   `@mars-sea/dsh-commandcode-provider@0.15.5`（例外放行）。
5. **WebUI 加载验收**：副本以自身 DSH_HOME 在端口 3095 启动，界面完整渲染
   （侧边栏 / 会话树 / 输入框 / 插件面板 / 技能中心 / 用量卡 / 宠物 / 右侧栏），
   **0 console error / 0 warning**，后端日志无告警。
6. **GUI 启动验收**：副本入口 exe 以 `DSH_GUI_PORT=3091` 启动，computer use 观察到
   真实窗口：标题「DeepSeek Harness」→ 连接标签「本机」→ harness 就绪后加载出完整
   WebUI；dsh-pet 的通知权限弹窗可正常拒绝，界面保持可交互。验收后已终止实例并释放端口。
7. **屏蔽**：本轮没有屏蔽任何插件。

## 已知限制（上游未修，非本次引入的崩溃点）

- **`dsh-better-sidebar@0.28.2` 仍未适配 harness 0.2.2 的模型选择契约**：
  `src/sidechat-routes.ts` 以两参调用 `installModelSelection(agent.ctx, ref)`，而 0.2.2
  起该函数只收 `agentCtx`、选择改由 `agent.model.select()` 记录，因此侧聊的模型选择
  ref 路径失效（选择本身仍经 `session.append('model/selection', …)` 生效）。
- **`dsh-sidebar-qa@1.2.2` 的 `session.follow` 仍未传 `activate: true`**：0.2.2 起省略
  该字段不再自动恢复冷普通 Agent，跟随一个未激活会话时面板显示历史但不产生回答。
- **dsh-pet 的 npm 滞后**：见上表，运行时装的是 0.3.8 的内容，`v0.3.8-test.2` 的源码改进
  要等上游发布才能进入安装产物。
- **commandcode-provider 的例外**仍在：豁免精确绑定 `0.15.5` + `0.2.2-alpha.2`，
  上游发布接纳 0.2.2 的版本后应删除 `exempt`。
- **desktop profile**：`npm run build` 只装 web profile；desktop 端要同步时执行
  `npm run build:desktop`。
