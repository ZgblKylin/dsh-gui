# harness 升级：dsh-v0.2.1-rc.3 → dsh-v0.2.2-alpha.2

本文件记录把工程基座 `deepseek-harness` 升级到目标修订的取舍与验收结果。本次按
skill [dsh-gui-update](../../.agents/skills/dsh-gui-update/SKILL.md) 的两阶段流程执行：
先在持久化副本 `.staging/dsh-gui` 完成更新、适配、构建与验收，报告并经用户审批后才
同步回本工程。流程与门槛见
[upgrade-staging-workspace.md](upgrade-staging-workspace.md)。

## 目标修订与发布状态

| 模块 | 旧修订 | 新修订 | npm |
| --- | --- | --- | --- |
| deepseek-harness | dsh-v0.2.1-rc.3（1f81c047fc） | **dsh-v0.2.2-alpha.2**（f3803c9697） | `@deepseek-ai/dsh@0.2.2-alpha.2` 已发布（`alpha` tag；`latest` 仍为 0.2.1-rc.2、`next` 为 0.2.1-rc.4） |

目标 tag 由 `git describe --tags --abbrev=0 origin/HEAD` 核实为远端默认分支可达的最新
tag。`harness.json` 保持 `{"runtime":"npm","version":null}`：构建按子模块
`apps/cli/package.json` 的版本精确安装 CLI，子模块检出即版本的唯一来源，无需改清单。

## 区间规模

| 指标 | 值 |
| --- | --- |
| 提交数 | 2170（非 release 1541） |
| 变更文件 | 7251（+311322 / -695812） |
| 新增官方升级指南 | 38 份 `guide.zh.md`，分布在 `docs/upgrade-guide/v0.2.1-*/` 各版本目录 |

指南目录名不得当作版本号使用：区间内新增的 `v0.2.1-alpha.2/…`、`v0.2.1-rc.2/…` 等目录
里也描述 rc.3→alpha.2 的变化（后补与回填错位），本次把 38 份全部读过并用代码 diff 逐条
复核。

## 上游变更

| 变更 | 说明 |
| --- | --- |
| **Node 门槛抬高** | `@deepseek-ai/dsh@0.2.2-alpha.2` 新增 `engines.node >=24.9.0`（rc.3 为 `^22.19.0 \|\| >=24.0.0`）；22.x 与 24.0–24.8 的机器升级后跑不起来 |
| **工具执行器拆分** | `@deepseek-ai/dsh-tools` 的 `Config.mode` / `maxParallelSubCalls` 改为 `z.never()`：profile 里残留这两个键会启动即 schema 报错；`DSH_TOOLS_MODE` 机制由 `tool-executor-native` / `tool-executor-ptc` 两个 overlay 行取代，二者同时进入 `requiredStartupEntryIds`。本仓 profile patch 无相关键，官方 base/web-app bundle 自带两行（`--dump-config` 已确认在组合中） |
| **模型选择改为步骤快照** | `installModelSelection` 由两参变单参（仅订阅 `agent/pre-step`），选择走 `AgentModel.select()`；`agent/request` 降级为不改 provider/model/effort 的 controls 调整（见「未决风险」） |
| **Session 投影 handle 化** | `register()` 返回 thenable handle，注册表级 `stateOf(session, key)` 弃用、`SessionProjectionStateMap` 移除、`turnBoundaryProjectionDefinition` 迁到 `ctx.agents.turnBoundaryOf(session)` |
| **`session.follow` 需 `activate`** | 省略 `activate` 时不再自动恢复冷普通 Agent（见「未决风险」） |
| **内置语言占用扩到 6 个** | `ja/es/fr/de/ru/pt` 与内置 UI 字典被官方占用，第三方同 id 语言包加载失败。本仓未安装注册 `ru` 的包（`dsh-i18n` 只存在于 dsh-web-ui 源码子模块，不在安装集），故无影响 |
| **`ui-deepseek-model-label-1017` 行/包移除** | 角标改由 DeepSeek `GET /models` 列表下发；本仓 profile 无该行，仅运行时对残留 patch 行报「找不到条目」告警 |
| **官方家族四包精确 peer** | browser-use / computer-use 两组四包 peer 精确指向 `0.2.2-alpha.2`，必须与 harness 同批抬 pin；四包未改名、未合并，`src/` 与 rc.3 无差异，`dsh-cua` / `dsh-cua-bundle` 是 darwin-only 新增项（Windows 无需改挂载） |
| **CLI 启动面零破坏** | `apps/cli/src/{args,dump-config,bin}.ts` 区间内 diff 为空，`--host/--port/--no-open/--profile/--patch/--trusted-host/--dump-config` 全在，Tauri 外壳（`web --port N --no-open`）与 `scripts/harness.mjs` 均不受影响 |
| **loader / bundle / 准入闸门未变** | entry id 冲突判定、`insert`/`override` 语义、`dsh.bundle.patch` 解析、`engines.dsh`/peer 判定（含 prerelease 精确 pin 接纳）区间内无差异；`dsh.bundle` 仅新增可选 `platforms` / `listedByDefault` |
| **Cordis service / 事件 / UI slot 无删改** | `docs/capability-seams.md` 服务表 99→107（新增 8 个可选服务），`docs/event-producer-consumer.md` 无删除无模式变更，`packages/client/ui-slots` 仅版本号变化 |

## 适配改动

| 文件 | 改动 |
| --- | --- |
| `plugins/harness/browser-use.mjs` | 两个 spec pin `0.2.1-rc.3` → `0.2.2-alpha.2`；注释同步精确 peer、pinned tag 与「家族未改名、cua 为 darwin 新增项」 |
| `plugins/harness/computer-use.mjs` | 同上 |
| `plugins/commandcode-provider/install.mjs` | 保持 `0.15.4` 精确 pin，新增 `exempt:` 精确版本例外（上游 0.15.4 与最新 0.15.5 的 `engines.dsh` 上界 `<0.2.2-0` 把整条 0.2.2 prerelease 线排除，registry 无放行版本）；注释同步区间上界与撤销条件 |
| `package.json` | `engines.node` → `>=24.9.0`，对齐新运行时门槛 |
| `plugins/README.md` | 例外机制段改写为「0.2.2-alpha.2 上恰好一个 wrapper 需要例外，即 commandcode」；安装方式清单、Current plugins 段的版本、准入表述与官方家族 pin 同步 |
| `plugins/harness/README.md` | 两张安装表、pin 说明与闸门描述同步到 `0.2.2-alpha.2` |
| `plugins/dsh-web-ui/install.mjs`、`plugins/dsh-web-ui/README.md`、`plugins/better-sidebar/install.mjs`、`plugins/plugin-market/install.mjs`、`plugins/deep-whale/install.mjs`、`plugins/dsh-pet/install.mjs` | 注释里的 pinned harness 版本与准入表述同步（npm pin 全部不变，均在新区间内） |
| `plugins/commandcode-provider/README.md` | 「兼容性状态」改写为豁免路径与撤销条件；安装后应满足项补 `compatibility.json` 例外记录 |
| `README.md`、`docs/dsh-gui/ssh-remote-workspace.md`、`ssh-provider-vs-dsh-remote.md`、`dsh-pet-troubleshooting.md` | 运行时版本引用同步 |
| `AGENTS.md` | `docs/official` 两条描述校准：`cli-config-examples/` 现为 `mcp-memory/` + `ptc.yml`（`github-review` 已迁到 `packages/experimental/webhook-github/examples/github-review/`）；`capability-seams.md` 是四类服务角色而非「三种角色」 |
| 子模块指针 | `deepseek-harness` → `dsh-v0.2.2-alpha.2`（f3803c9697） |

`docs/official` 的 19 条符号链接（10 条目录、9 条文件）在目标修订上逐条核实仍可穿透，
无需改指；本工程工作树内也已实测（目录可列举、文件可读取）。

## 验收（阶段一）

全部在副本 `.staging/dsh-gui` 内完成（副本自带 DSH_HOME 与工具链，构建产物落 `.staging/`）。
本次验证的临时产物（计划/进度/四份只读分析/构建日志/验收截图）放在未纳入版本管理的
`.work/upgrade-2026-10b/`，验证结束后已按用户要求清理；副本本身保留供下次升级复用。

1. **基线对齐**：副本原停在旧修订且带 23 处未提交改动，先 `reset --hard` +
   `submodule update --init --recursive` + `clean -fd` 清空，再 `npm run staging -- sync`
   到 2098ba0，9 个子模块重新钉住。
2. **构建**：`npm run build` exit 0（cargo 4m24s，入口 exe 13,186,048 B）；
   `--skip-exe` 的中间轮次亦 exit 0。
3. **组合冒烟**：`--profile web --dump-config` passed —— `tool-executor-native` /
   `tool-executor-ptc` 两行都在，无 `duplicate loader entry id`、无 `patch: entry … not found`、
   无被跳过的 bundle。
4. **WebUI 加载验收**：副本以自身 DSH_HOME 在空闲端口启动 `npm run harness`，
   浏览器打开后会话界面完整渲染（侧边栏、会话树、输入框、插件面板、用量卡、宠物），
   **0 console error / 0 warning**，可新建会话；后端日志无 warn/error。
5. **GUI 启动验收**：`npm run build` 产出副本自己的 `dsh-gui.exe`，以 `DSH_GUI_PORT=3091`
   启动后用 computer use 观察真实窗口：标题「DeepSeek Harness」→ 连接标签「本机」→
   harness 就绪后加载出完整 WebUI，通知权限弹窗可正常交互关闭。外壳只传
   `--port --no-open`（不带 `--profile`），所用组合即第 3、4 项验证过的 web profile。
   验收后已终止实例并释放端口。
6. **屏蔽**：本次没有屏蔽任何插件。

## 屏蔽与例外

- 无屏蔽插件。
- 唯一例外：`@mars-sea/dsh-commandcode-provider@0.15.4` 在 `0.2.2-alpha.2` 上的
  精确版本例外（`installNpmPlugin` 的 `exempt`）。例外精确绑定包版本与运行版本，
  下一次 harness 变更自动失效；上游发布接纳 0.2.2 的版本后应删除该 `exempt`。
- npm 安装型 wrapper 与运行时发布状态已核对：`@deepseek-ai/dsh@0.2.2-alpha.2` 已发布，
  官方家族四包 `0.2.2-alpha.2` 已发布；其余 11 个第三方 pin 在新运行时的准入闸门下
  全部放行，版本不动。

## 未决风险

- **`dsh-better-sidebar@0.28.0`（含上游最新 0.28.2）仍以两参调用
  `installModelSelection(agent.ctx, ref)`**：新契约只收一个参数，侧聊的模型选择 ref
  路径失效（选择仍会经 `session.append('model/selection', …)` 生效，但可能出现重复
  的切换提示）。需上游适配或改用 `agent.model.select()/current()`。
- **`dsh-sidebar-qa@1.2.1`（含上游最新 1.2.2）的 `session.follow` 未传 `activate: true`**：
  冷会话被跟随打开后不再自动激活 agent，面板显示历史但不产生回答。需上游适配。
- 两处均为上游未修的运行时行为回归，不是本次升级引入的崩溃点；本次未改这两个模块的
  pin（它们属于独立的插件模块升级）。
- **desktop profile**：`npm run build` 只装 web profile，desktop profile 的插件仍是
  上一轮版本；需要 desktop 端同步时执行 `npm run build:desktop`。
- **本工程的 `.harness` 是就地升级**：运行时换代后兄弟包可能残留混合版本，构建的 npm
  运行时分支会自动检测家族不一致并做干净重装（详见
  [harness-runtime.md](harness-runtime.md) 的「故障排查」）；`--force-harness` 亦可强制干净重装。
- **Node 版本**：构建与运行都需要 ≥24.9.0（本机 v24.19.0 满足）。
