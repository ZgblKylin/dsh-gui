# Browser Use 解除屏蔽：第二个会话不再建立失败

## 背景

本仓库自 0.1.6-alpha.2 起把 Browser Use（Playwright MCP）设为**默认跳过安装**，理由写在
[`plugins/harness/browser-use.mjs`](../../plugins/harness/browser-use.mjs) 的头部与
[`plugins/harness/README.md`](../../plugins/harness/README.md) 的已知限制里：

> Playwright MCP 提供方逐 Session 挂载 mcp-client，但它的工具、提示词段与资源服务器都
> 落在 DSH 的共享/全局注册层，同一 host 只有第一个存活 Session 能用；第二个会话（新建
> 或恢复）报 `already registered`，会话创建/恢复回滚并从列表消失。

本次在升级到 `dsh-v0.1.7-rc.2` 后重新核查：该问题已由上游修复，故解除屏蔽。

## 根因

上游 [issue #4573](https://github.com/deepseek-ai/deepseek-harness/issues/4573)，由
`packages/experimental/browser-use-runtime/tests/host-runtime-duplication.spec.ts` 固定：

> profile 安装的这个包与 dsh 安装并排，会装上**自己那份 `@deepseek-ai/dsh-scope`**，
> 于是一个宿主进程里并存两个 scope 模块实例。`dsh-scope` 的 scope 标签符号是**按模块
> 实例**生成的，副本的 `createScope` 写出的标签宿主注册表不认 —— 于是每个 Agent 的 MCP
> 工具都注册进**全局工具层**，第一个 Agent 成功，**之后每个 Agent 的工具同步都碰撞**。

该文件第一条用例把失败钉死（`agents.create` 第二个会话 reject，报
`mcp-client(...): initial connection or tool synchronization failed`），第二条固定修复后
的形态（一个实例、两个 Agent、各持自己的浏览器客户端）。

## 修复

**① 依赖形态（决定性）**：`@deepseek-ai/dsh-scope` 由 **dependency 改为 peer**。逐版本核对
`@deepseek-ai/dsh-experimental-browser-use-runtime`：

| 版本 | `dsh-scope` 声明 |
| --- | --- |
| 0.1.6-alpha.1 | dependency `^0.1.6-alpha.1`（问题形态） |
| 0.1.6-alpha.2（屏蔽时） | dependency `^0.1.6-alpha.2`（仍是问题形态） |
| 0.1.7-alpha.1 | **peer** `^0.1.7-alpha.1`（修复） |
| 0.1.7-rc.2 | **peer** `0.1.7-rc.2` |

**② 运行结构**：`browser-use-runtime` 的 `SessionResources` 按 **Agent** 惰性持有资源
（`Map<Agent, Entry>`，按会话串行、会话之间互不影响），MCP 客户端挂进
`createScope(ctx, agent)` 的 **agent scope**，工具因此只对该 Agent 可见。

**③ 降级而非失败**：只有 `mode: attach` 是独占的；第二个会话拿不到该连接时状态为
`blocked`，其浏览器工具被 `tools.restrict({ deny })` 掩码、`mcp:<name>` 提示词段被摘除，
但会话照常可用。本仓库配的是 `mode: launch`（`exclusive: config.mode === 'attach'` 为
false），每个会话各起一份，根本不进入争用路径。

## 副本验证记录

环境：副本 `.staging/dsh-gui`，`DSH_HOME` 指向副本 `.dsh`，空闲端口 3099（正在运行的实例
占 3080，全程未受影响）。以 `DSH_PLUGIN_FORCE_INSTALL=1` 执行
`plugins/harness/browser-use.mjs`，即解除屏蔽后 wrapper 走的那条分支。

| 检查 | 结果 |
| --- | --- |
| 安装与挂载 | 两个包安装成功，各自 `declares dsh.bundle.patch` 不成立 → 手工 insert 两行（`browser-use` / `browser-use-playwright-mcp`）；Chromium 探测到 `C:\Program Files\Google\Chrome\Application\chrome.exe` |
| 单实例 | `browser-use-runtime` 包内无嵌套 `@deepseek-ai/dsh-scope`；从 provider 目录解析该包得到 `.harness\node_modules\@deepseek-ai\dsh-scope\package.json`，与 CLI 侧一致（`.dsh/profiles/node_modules/@deepseek-ai/dsh-scope` 是指向它的符号链接） |
| 启动基线 | 副本后端启动后 **0 个** `@playwright/mcp/cli.js` 进程 —— MCP 按 agent 惰性启动 |
| 第一个会话 | 客户端载入首页建空白会话 → `agent/created` → 1 个 MCP 进程（父进程为副本后端），命令行 `node …\@playwright\mcp\cli.js --browser chromium --isolated --headless --executable-path "…chrome.exe"` |
| **第二个会话** | 点「新建会话」→ 输入 → 发送：**会话建立成功**（新会话以首条消息为标题入列），本轮仅在模型调用处失败 `llm-deepseek: no API key for provider route "deepseek-official"`（副本无凭据，与本次无关）；**MCP 进程数变为 2**，两个进程都挂在副本后端下、各自独立 |
| 错误面 | 副本后端 stderr 全程为空；无 `already registered`、无 `initial connection or tool synchronization failed` |

验证后关闭该实例并释放端口，卸载两个包、用共享流水线的 `removeLegacyInsertBlocks` 清掉
两行 insert，副本 profile 已还原。

## 结论与仍然存在的契约

解除屏蔽成立：`dsh-scope` 改 peer 消除了重复模块实例，按 Agent 的 `SessionResources` +
agent scope 挂载消除了全局命名空间争用，`mode: launch` 不进入独占路径。

**仍然存在、本次一并接受**：提供方以 `failOnStartupError: true` 启动 MCP，而
`agent/created` 是 serial 事件、其监听器失败会 reject agent 创建 —— 因此**浏览器/MCP 进程
起不来**（缺 Chromium、spawn 被拦、包损坏）时，**该次会话创建会失败**，而不是降级。副本
这次 Chromium 探测与启动都成功，未触发该路径。wrapper 保留安装期的 Chromium 探测：找不到
就省略 `executablePath`，交由上游浏览器发现。

同族的 Chrome DevTools MCP 与 Stagehand native 提供方本仓库**不启用**：前者同属
逐会话 MCP 结构、本次未评估；后者依赖 `@browserbasehq/stagehand` 与
`@puppeteer/browsers`（需下载浏览器），且把 `@deepseek-ai/dsh-mcp-client` 列为
**dependency**（runtime 则当 peer）——正是 #4573 那类重复实例的形态，启用前需单独验证。
