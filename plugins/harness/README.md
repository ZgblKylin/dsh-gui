# plugins/harness

dsh 工程官方插件组：把 `@deepseek-ai/dsh-*` 官方实验插件统一在一个 wrapper 里管理。installer 平铺；`skills/` 与 `auto-review-model/` 包目录是仅有的子目录。`install.mjs` 是流水线入口，按顺序加载目录里的各插件 installer，`skills/` 存放 WSL 专用 skill 模板、由 `wsl-workarounds.mjs` 安装。本 wrapper 安装 Browser Use（Playwright MCP）与 Auto review 模型覆盖（本仓库自研的 in-tree 包）两组插件，并为 Windows 上的 Computer Use 构建官方要求的原生 helper（Windows 编译脚本）并启用官方可选 bundle `@deepseek-ai/dsh-cua-bundle`；Computer Use 本体不再由本仓库安装（见下文「Computer Use」）。Agent Teams 已内置在 web-app 组合中，旧的可选 bundle 已退役；Auto review 本体仍是随 dsh 安装提供的官方可选 bundle，由插件页开关直接管理，本 wrapper 不安装它。本 wrapper 不派生任何 preset。

| 文件 | 插件 | 说明 |
| --- | --- | --- |
| `install.mjs` | — | 流水线入口，依次加载所有平铺 installer |
| `browser-use.mjs` | Browser Use (Playwright MCP) | 独占浏览器提供方注册服务 + Playwright MCP 提供方 |
| `cua-windows.mjs` | Computer Use（Windows） | 从子模块源码构建 `dsh-cua-windows.exe`、把 `cua-windows` 行的 `helperPath` 指过去，并启用官方 `@deepseek-ai/dsh-cua-bundle`；非 Windows 平台跳过 |
| `auto-review-model.mjs` | Auto review 模型覆盖 | in-tree 包 `auto-review-model/` 的安装入口，把审查请求改派到配置的 provider/model |
| `auto-review-model/` | Auto review 模型覆盖 | 零依赖 ESM Host 半（`index.js`，含 Schemastery `Config`）、`src/client/` 插件信息页卡片、构建产物 `lib/client.js`、README 与 `tests/` |
| `wsl-workarounds.mjs` | — | WSL 专用 skill 与 AGENTS.md 小节的安装逻辑，由 `scripts/dsh-gui.mjs` 在全局模板安装后调用 |
| `skills/` | — | WSL skill 模板：`wsl-edge-browser-use`、`wsl-computer-use`，以及一次性安装 skill `wsl-xvfb-service` |

## WSL workaround

WSL 下 browser-use 与 computer-use 各有一处环境限制：browser-use 无法连接 Windows 端 Edge 监听的 loopback 调试端口；computer-use 无法使用 WSLg 的 X 显示（Weston 占用窗口管理器，Xwayland 的 root window 不可截图）。`wsl-workarounds.mjs` 在 `scripts/dsh-gui.mjs` 的 `setup` / `build` 流程中、全局 agent 模板安装之后执行，仅在检测到 WSL 时安装以下内容：

- 把 `skills/wsl-edge-browser-use/SKILL.md` 与 `skills/wsl-computer-use/SKILL.md` 复制到 `<DSH_HOME>/skills/`，目标文件已存在时不覆盖；
- 在 `<DSH_HOME>/AGENTS.md` 末尾追加两个独立小节（`## WSL workaround：Edge browser-use 端口转发` 与 `## WSL workaround：computer-use 虚拟桌面`），以标题行作为幂等键，已存在时不再写入；
- 检测 `~/.config/systemd/user/xvfb.service` 与 `openbox.service`，缺失时在终端以强调字体提示用户后续通过 dsh 会话按一次性 skill `wsl-xvfb-service` 安装虚拟桌面。

一次性安装 skill `wsl-xvfb-service` 不复制到 `<DSH_HOME>/skills/`：它检测真实环境（二进制路径、可用显示编号、分辨率、已有 service）后生成 Xvfb 与 openbox 的 systemd user service，只需执行一次。虚拟桌面装好之后，computer-use 的日常说明由 `wsl-computer-use` 提供。

Auto review 是随 dsh 安装提供的官方可选 bundle（`@deepseek-ai/dsh-experimental-auto-review`，见 `deepseek-harness/packages/util/official-bundles/src/bundles.ts` 的 `OPTIONAL_BUNDLES`）：插件页（插件 → 自动授权审查）的开关把它写入 profile 的 `dsh.profile.bundles`，本 wrapper 不安装它，也不向 patch 层写入任何 preset 声明。Agent Teams 现在由 web-app 组合内置（见下一节）。**Browser Use 的两个包都不声明 `dsh.bundle.patch`**，是普通 npm 依赖，由 `browser-use.mjs` 通过共享流水线的显式 `mount` 选项写入两行 insert（服务行 + 提供方行，提供方行带 `config`）。Computer Use 由官方可选 bundle 自己挂载，本 wrapper 不写任何它的行。

## Agent Teams

Agent Teams 由 web-app 组合内置（自 `dsh-v0.2.2-rc.3` 起）：`deepseek-harness/packages/bundle/web-app/cordis.patch.yml` 的 `ui-agent-team` 行挂载 `@deepseek-ai/dsh-client-ui-agent-team`，不需要安装或开关。旧的 `@deepseek-ai/dsh-experimental-agent-team-profile` 已列入 harness 的 `RETIRED_BUNDLES`（`deepseek-harness/packages/util/official-bundles/src/bundles.ts`，`dsh-v0.2.2-rc.1` 时即如此），不在 `OPTIONAL_BUNDLES` 中；profile 的 `dsh.profile.bundles` 若仍保留该包名，启动时会被跳过并打印一条告警（`packages/boot/app-boot/src/profile.ts` 的 `reportSkippedBundles`），可以直接删除该条目。本仓库不安装它，也不派生 preset。

### 当前状态

该实验 bundle 已 retired、不再加载，此前记录的「实验 bundle 与官方 preset 的 delegation 工具错配」不再适用于当前组合；本仓库不向 preset 层写入任何声明，也不假设内置 Team 组合的具体工具面。

## Auto review

官方 `@deepseek-ai/dsh-experimental-auto-review` 是逐调用 LLM 授权审查层，随 dsh 安装提供，并列入 harness 的 `OPTIONAL_BUNDLES`。本仓库不安装它：插件页（插件 → 自动授权审查）的开关把该 bundle 写进 profile 的 `dsh.profile.bundles`。

### 用途

每次原生工具调用、以及每个已开始的 PTC `tools.*` inner call 在 body 执行前，都由
与当前 agent 相同的 provider/model 发起一次额外的 review 请求。审查通过后调用按
Full access 执行（复用未改变的 `danger-full-access + never` 旋钮），拒绝则 body
绝不执行。外层 `run_code` transport 与 PTC 程序内直接 Node 效果不在审查范围内。

审查按动作的实际效果分类：普通项目内操作与精确清理本会话创建的对象属于 `low`，
直接允许；不可逆删除既有对象、生产操作、外部写入与安全控制变更属于 `medium`，
需要当前 human 或直接父级明确授权动作、目标与范围；跨信任边界泄露敏感信息属于
`high`，始终拒绝。效果不明确、授权冲突未解决、响应不合法与技术失败都按拒绝处理
（fail closed）。

详细机制见官方包源码
`deepseek-harness/packages/experimental/auto-review/README.zh.md` 与设计文档
`deepseek-harness/.agents/notes/implemented/feature/2026-08-28-auto-review.zh.md`。

## Auto review 模型覆盖

`auto-review-model` 是可选覆盖层，区别于「Auto review 开关」：开关决定是否启用逐调用审查，本插件决定审查请求由哪个 provider/model 执行。两者独立装卸，单独装本插件不会启用审查。

Auto review 本体从被审 agent 的最新请求头取 provider 与 model，没有 reviewer 模型配置项。本插件在 `llm/stream` waterfall 的链首识别 `purpose: 'auto-review'` 的请求，构造替换请求重新派发，因此只影响审查调用。

- 安装：`auto-review-model.mjs` 把 in-tree 包 `auto-review-model/` 以 `link:` 装进 profile。包声明 `dsh.bundle.patch`，由 bundle 层自挂载 entry `auto-review-model`，不写手工 insert。Desktop 应用用的是 `desktop` profile，而该 profile 由 Electron 应用独占管理：只能关闭应用后用应用自带的 CLI 安装，或走 `npm run build:desktop`；不要手动设 `DSH_PLUGIN_PROFILE=desktop` 运行 installer（会被拒绝，并在失败前改写该 profile 的 pnpm `storeDir`）。
- 配置：包内 `cordis.patch.yml` 的 `config` 块给出 `enabled`、`provider`、`model` 与可选的 `reasoningEffort`；`provider` 与 `model` 必须成对。未配置或 `enabled: false` 时直接放行，审查沿用 agent 当前模型；监听始终注册，字段是 volatile 引用，界面保存由下一次审查读取新值。
- 界面：重启后在插件页打开该包详情，`plugins.bundle.config` 卡片提供开关与 provider/model 下拉，保存即时生效并写入 profile 的 Cordis patch；包内置的 client 半由 `pnpm --dir plugins/harness/auto-review-model run build` 产出 `lib/client.js`。
- 用法、成本与边界见 [auto-review-model/README.md](auto-review-model/README.md)。

本插件依赖三条 harness 内部约定，升级 harness 后必须复核：

1. auto-review 仍以 `purpose: 'auto-review'` 标记审查请求。
2. `llm/stream` 仍是 waterfall，listener 不调用 `next()` 即短路整条链。
3. provider 解析仍发生在 waterfall 之后。

可执行命令与判据见 [auto-review-model/README.md 的「Harness 升级检查清单」](auto-review-model/README.md#harness-升级检查清单)，其中第 4 条给出上游补齐 reviewer 模型配置后的退役判据。

## Browser Use (Playwright MCP)

> **当前状态：正常安装。** 本 wrapper 曾在 0.1.6-alpha.2 上屏蔽安装，因为提供方把
> MCP 工具注册进共享/全局层，同一 host 只有第一个存活 Session 能用，之后每个
> Session 都建立失败。根因是 profile 里多出一份 `@deepseek-ai/dsh-scope` 模块实例
> （上游 issue #4573），其按模块实例生成的 scope 标签宿主注册表不认。
> `dsh-scope` 在 0.1.7-alpha.1 前后改为 peer 声明，提供方也改为每个存活 Agent 持有
> 一份 `SessionResources` 并把 MCP 客户端挂进该 Agent 的 scope，因此每个 Session
> 各自拿到浏览器客户端。副本实测见
> [`docs/dsh-gui/2026-09-26-browser-use-unmask.md`](../../docs/dsh-gui/2026-09-26-browser-use-unmask.md)。

### 安装内容

| 项 | 位置 | 说明 |
| --- | --- | --- |
| `@deepseek-ai/dsh-browser-use@0.2.3-alpha.2` | web profile | 独占具名浏览器提供方注册服务（`ctx.browserUse`），一次只允许激活一个提供方 |
| `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp@0.2.3-alpha.2` | web profile | 通过 `@playwright/mcp` 的逐 Session Chromium 浏览器工具（工具名 `mcp__playwright-mcp__<tool>`） |

两个包都精确 pin `0.2.3-alpha.2`，与本仓库 pinned 的 `dsh-v0.2.3-alpha.2` 运行时
配套（Playwright MCP 提供方的 `@deepseek-ai/dsh*` peer 全部指向 `0.2.3-alpha.2`）。
**这个 pin 必须随 harness 同批移动**：准入闸门拿运行中的 dsh 版本逐条比对每个
`@deepseek-ai/dsh*` peer，peer 指向更早运行时的包会被 0.2.3-alpha.2 的准入闸门拒绝。
dsh 家族实验包的 npm `latest` dist-tag 落后于已发布的 prerelease，不能通过
`@latest` 或范围解析。均为 prerelease，进不了 Community Market。核心服务先装：
提供方 inject `browserUse`。

### 挂载与配置

两者都不声明 `dsh.bundle.patch`，属普通 npm 依赖，`browser-use.mjs` 走共享流水线
的显式 `mount` 选项写入两行 insert（生成的样式如下）：

```yaml
- insert:
    - id: browser-use
      name: '@deepseek-ai/dsh-browser-use'
- insert:
    - id: browser-use-playwright-mcp
      name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
      config:
        mode: launch
        headless: true
```

配置字段：`mode`（必填，`launch` / `attach`，本次提供方激活期间固定）、`headless`
（默认 true）、`executablePath`（上游发现 / 本机 Chromium）、`endpoint`（attach 时
必填）、`toolCallTimeoutMs`。`mode: attach` 需要向已运行浏览器的调试端点（HTTP(S)
调试 URL 或 WS(S) 浏览器端点）提供 `endpoint`；新 Session 初始化时占用该连接，卸载
时才释放。默认 `mode: launch` + `headless: true`。

`browser-use.mjs` 在安装时从标准 Windows 位置解析一个 Chromium 可执行文件
（`DSH_BROWSER_EXECUTABLE` 可覆盖；缺省找 Google Chrome / Microsoft Edge 的
x64/x86 安装路径），找到就写进提供方行的 `config.executablePath`，找不到则省略该
字段、交由上游浏览器发现。想改用 `mode: attach` 或指向其它二进制，直接编辑
`.dsh/profiles/web/cordis.patch.yml` 里那两行的 `config` 即可。

### 使用时

```powershell
npm run install:plugins        # 或 npm run build
```

安装并重启后，在允许浏览器工具且支持图片输入的模型路由上（例如官方 DeepSeek 路由），
模型才会可见 `mcp__playwright-mcp__<tool>` 工具集与浏览器指导；`mode: launch` 下每个
存活 Session 各持一份自己启动的浏览器。浏览器模式由 profile 组合中的该 `config` 行
决定，不是会话级开关。把浏览器工具留在 `<unlisted-tools>`（`toolOrder`）中，避免无
浏览器连接的 Session 无法组装提示词。

### 已知限制

- **每个存活 Session 各持一份浏览器客户端**：提供方通过
  `SessionResources` 为每个存活 Agent 惰性获取一份 mcp-client，并把它挂进
  `createScope(ctx, agent)` 生成的 Agent 作用域，因此工具（`mcp__playwright-mcp__*`）、
  提示词段（`mcp:playwright-mcp`）与资源服务器（`playwright-mcp`）只对该 Agent 可见。
  副本实测：连开两个会话时后端下出现两个独立的 `@playwright/mcp/cli.js` 进程，两个
  会话都建立成功。此前 0.1.6-alpha.2 会因 profile 里多出一份 `@deepseek-ai/dsh-scope`
  而把注册写进全局层，第二个会话直接建立失败（上游 issue #4573；`dsh-scope` 改为
  peer 声明后消失）。
  `mode: attach` 是唯一跨会话争用的路径：第二个会话拿不到该连接时**不报错**，只是没有
  浏览器工具（工具被掩码、提示词段被摘除），可继续其它轮次。

- **启动失败仍会让该次会话创建失败**：提供方以 `failOnStartupError: true` 启动 MCP，
  而 `agent/created` 是 serial 事件、其监听器失败会 reject agent 创建。缺 Chromium、
  spawn 被拦或包损坏时该次会话建不起来；修好环境后新建会话即可。同族的
  Chrome DevTools MCP 与 Stagehand native 提供方本 wrapper 不安装。

- **每个部署一次只启用一个浏览器提供方**；`dsh-browser-use` 服务本身不持有浏览器
  状态，注册位由提供方独占（`ctx.browserUse.register`）。本 wrapper 只安装 Playwright
  MCP 提供方，同一族的 Chrome DevTools MCP 与 Stagehand 均未安装。
- **仅支持 Chromium**；不能切 Firefox / WebKit。启动失败或取消会拒绝 Session 创建或
  恢复并触发清理，断开的客户端不重试——修复原因后新建 Session（或卸载重装）。
- 连接独占仅限本提供方实例内；外部进程与浏览器用户仍可改动同一页面。
- 无系统 Chromium 且未装 Playwright 自带浏览器时，`mode: launch` 会失败：需安装
  Playwright 浏览器（如 `npx playwright install chromium`）或用
  `DSH_BROWSER_EXECUTABLE` / 编辑 `config` 指定 `executablePath`。
- 工具 schema 跟随固定的实验依赖版本，不承诺 DSH 稳定性；浏览器工具与截图会增加
  工具目录与提示词文本（幻像 KV Cache 前缀复用率可能变化）。

## Computer Use（官方可选 bundle）

自 `dsh-v0.2.3-alpha.2` 起，Computer Use 由 harness 随附的官方可选 bundle
`@deepseek-ai/dsh-cua-bundle` 提供（列入 `OPTIONAL_BUNDLES`），本 wrapper 不再安装它、
也不再往 profile 写 `@deepseek-ai/dsh-computer-use` /
`@deepseek-ai/dsh-experimental-computer-use-cua-driver-native` 的 insert 行。

### 组合

`dsh-cua-bundle` 的 `cordis.patch.yml` 插入四行：

| id | 包 | 说明 |
| --- | --- | --- |
| `cua-provider-registry` | `@deepseek-ai/dsh-computer-use` | 独占具名桌面提供方注册服务（`ctx.computerUse`），一次只允许激活一个提供方 |
| `cua-windows` | `@deepseek-ai/dsh-cua-windows` | Windows 提供方：按 AUMID 发现应用、观察并操作明确选择的窗口 |
| `cua-macos` | `@deepseek-ai/dsh-cua-macos` | macOS 提供方 |
| `ui-cua` | `@deepseek-ai/dsh-cua` | 工具面与 `cuaAccess` 服务（系统权限、应用授权、PTC 配置） |

`ctx.computerUse` 是独占注册位：同一 profile 只能有一个提供方。本 wrapper 原先的
`computer-use` / `computer-use-cua-driver-native` 两行会与 bundle 的
`cua-provider-registry` 抢同一个服务，先注册的一方占位，另一方报
`service "computerUse" has been registered`，整条 cua 链因此不激活，客户端看到
`Service "cuaAccess" is unavailable`。两行已从 wrapper 移除；升级后已有的 profile 需手动
删掉这两段 insert（见「卸载」）。

### 启用

插件页「插件 → 实验性插件 → 计算机使用」开关把 `@deepseek-ai/dsh-cua-bundle` 写进
profile 的 `dsh.profile.bundles`，重启后生效。工具面为 `cua_*`，截图以持久化附件传给
模型；桌面由活动 Session 与其它应用共享，调用方自行完成「观察→操作→验证」流程。

### Windows 的原生 helper

`@deepseek-ai/dsh-cua-windows` 需要原生 helper `dsh-cua-windows.exe`，而**npm 安装的包里
不含该二进制**（`files` 白名单写了 `native/bin`，tarball 里却没有 `native/` 目录）。本仓库
用 `cua-windows.mjs` 自动补齐这一步：用 .NET 10 SDK 从 pinned 子模块的源码构建，把产物
放在 `<DSH_HOME>/cua/win-<arch>`，再把 `cua-windows` 行的 `config.helperPath` 指向它；
同时把 `@deepseek-ai/dsh-cua-bundle` 写进 profile 的 `dsh.profile.bundles`（等价于插件页
开关）。构建按子模块 revision 打 `build.json` 戳，同 revision 重跑直接用缓存；缺少 dotnet
或构建失败时只告警、不启用开关，不会让构建失败。

`npm run build` / `npm run install:plugins` 会为 web 与 desktop 两个 profile 各跑一次
（desktop profile 归 Electron 应用所有，改动要在应用关闭时进行）。也可以单独执行：

```powershell
$env:DSH_HOME = '<runtime-root>\.dsh'
$env:DSH_PLUGIN_PROFILE = 'web'      # 或 desktop
node plugins/harness/cua-windows.mjs
```

### 升级检查点

每次升级 harness 后复核（升级记录里也要提醒主人）：

1. `@deepseek-ai/dsh-cua-windows@<version>` 的 npm 包是否开始携带
   `native/bin/win-<arch>/dsh-cua-windows.exe`（解包 tarball 验证，不能只看 `files`）。
2. 桌面打包产物里是否自带该 helper（`desktop/resources/app.asar.unpacked/.../native/bin/...`）。
3. 上游 `cua-bundle` 的文档或 patch 是否给出 helper 的默认位置 / 发布 ZIP / 默认 `helperPath`。

任一条成立，就删掉 `cua-windows.mjs` 的编译段与 profile 里的 `helperPath` 覆盖，改用官方产物。
脚本在运行时也会检查第 1 条：一旦包里出现该 exe，会打印「检查点」提醒并要求更新本脚本。

缺少 helper 时提供方激活失败，症状同样是 `cuaAccess` 不可用。

### 已知限制

- **每个部署一次只启用一个桌面提供方**（`ctx.computerUse` 独占注册）。
- **需要桌面权限**：向启动 DSH 的应用授予屏幕录制 / 辅助功能等权限；npm 安装本身不授权。
- **共享桌面**：取消的调用可能已投递输入，重试前必须重新查看状态。
- macOS 无头 Node host 上光标叠加层操作可能返回 `facility_unavailable`（截图与后台输入仍可用）。
## 使用

```powershell
npm run install:plugins        # 或 npm run build
```

重启后：

- **Agent Teams**：随 web-app 组合内置（`ui-agent-team` 行），无需插件页开关；旧「智能体团队」
  开关与对应 bundle 已退役。新会话的预设选择器由官方 preset 决定，本仓库不派生 preset；
  内置 Team 组合的具体工具面以实际运行为准（见本文「Agent Teams」一节）。
- **Auto review**：在插件页开启「自动授权审查」后重启，再在当前会话权限选择器
  （composer 旁的「访问模式」菜单，或 `/permission` slash 选择器）中选择带 `EXP`
  角标的 `Auto review`，在确认对话框中勾选「我已了解这些风险，并愿意继续」后点
  「启用 Auto review」；直接键入 `/permission auto` 也构成明确同意。通用设置行与新
  会话默认值都不提供 Auto。
- **Auto review 模型覆盖**：安装后即随组合挂载（无二次开关）。推荐在
  `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 用顶层 `- id: auto-review-model`
  覆盖 `config`，不动仓库源码；也可直接改包内
  `plugins/harness/auto-review-model/cordis.patch.yml` 的 `config`，bundle patch 在
  下次启动读取。未配置 `provider` 与 `model` 时它不介入，审查仍用 agent 当前模型。
- **Browser Use (Playwright MCP)**：安装后即随组合挂载（无二次开关），重启后工具以
  `mcp__playwright-mcp__<tool>` 出现；是否对模型可见还取决于工具目录装配与模型
  路由是否支持图片输入。
- **Computer Use (Cua Driver native)**：安装后即随组合挂载（无二次开关），重启后
  工具以 `cua_driver_native__<tool>` 出现；前提是支持图片输入的模型路由 + 附件
  存储，并向启动 DSH 的应用授予桌面权限。

## 已知限制

- **Agent Teams 已随 web-app 组合内置**（`ui-agent-team` 行），旧的实验 bundle 已
  retired、不再加载；本仓库不安装它、不派生 preset，也不代为把某个预设设为默认
  （`agentPresets.default`）。此前记录的「实验 bundle 与官方 preset 的 delegation
  工具错配」只属于那个已退役的 bundle；内置 Team 组合的工具面以实际运行为准，本仓库
  不做假设。
- **Auto review 是实验功能、需在插件页开启**。它不是确定性安全边界：每次受支持调用
  额外产生一次模型请求并增加延迟，模型分类可能误放行或误拒绝；不提供豁免、缓存
  grant、人工 fallback、可配置策略或重试。关闭开关并重启后，存活的 Auto 会话被迁移
  到 Full access；重新开启只恢复选项，不把存活会话切回 Auto。
- **Auto review 模型覆盖依赖 harness 内部约定**：审查请求的 purpose 标签、`llm/stream`
  waterfall 的短路语义，以及 provider 在 waterfall 之后解析。升级 harness 后按
  [auto-review-model/README.md](auto-review-model/README.md#harness-升级检查清单)
  复核；改动任一约定都会让改派失效或静默退回 agent 自身模型。

## 卸载

在插件页关闭「自动授权审查」开关：开关把该 bundle 从 profile 的
`dsh.profile.bundles` 移除，该层在下次启动时不再加载。Agent Teams 没有开关（已内置）；
profile 里若还留着退役的 `@deepseek-ai/dsh-experimental-agent-team-profile` 条目，直接从 `dsh.profile.bundles` 删除即可。本 wrapper 不向 patch 层写入 preset 声明，因此没有额外的清理步骤。

Auto review 模型覆盖是 in-tree 包，从 profile 卸载后 bundle 层随之消失：

```powershell
dsh plugin --profile web remove dsh-auto-review-model
```

Browser Use 从 profile 卸载：

```powershell
dsh plugin --profile web remove @deepseek-ai/dsh-browser-use
dsh plugin --profile web remove @deepseek-ai/dsh-experimental-browser-use-playwright-mcp
```

**Browser Use 的两行 insert 是手工挂载，`dsh plugin remove` 不会清理** —— 需手动删除
`.dsh/profiles/web/cordis.patch.yml` 里 `id: browser-use`、`id: browser-use-playwright-mcp`
两行（提供方行含 `config`），否则重启会报错误（entry 对应的包已不存在）。
若要从本仓库安装流水线中整体去掉某个插件，删除 `install.mjs` 中对应的 loader 行即可。

Computer Use 由官方 bundle 提供，关闭插件页的「计算机使用」开关即可；从旧版 wrapper 升级
上来的 profile 还留着 `computer-use` / `computer-use-cua-driver-native` 两段手工 insert，
需要手动删除（bundle 里的 `cua-provider-registry` 已经注册同一个 `computerUse` 服务，
两行并存会报 `service "computerUse" has been registered`）。不再需要时也可一并清掉
`@deepseek-ai/dsh-computer-use` 与
`@deepseek-ai/dsh-experimental-computer-use-cua-driver-native` 两个依赖：

```powershell
dsh plugin --profile web remove @deepseek-ai/dsh-computer-use
dsh plugin --profile web remove @deepseek-ai/dsh-experimental-computer-use-cua-driver-native
```

## 约束

- `DSH_HOME` 缺省 `<runtime-root>/.dsh`，只写该目录；**从不写官方 preset 安装目录**。
- 幂等：重复执行结果一致（npm 安装由 `dsh plugin add` 去重）；profile 已按精确版本
  装好且挂载完整时，`installNpmPlugin` 直接跳过该包的安装，`npm run rebuild` /
  `DSH_PLUGIN_REBUILD=1` 可强制重装。
- 依赖 `scripts/plugin-install.mjs` 的共享流水线：Browser Use 与 Computer Use 的 npm 包经 `installNpmPlugin` 安装，`auto-review-model` 走 `installPlugin`（in-tree 包、无 build 脚本），每个 installer 也可单独运行。Browser Use 与 Computer Use 是仅有的两个用显式 `mount` 的 wrapper（服务/提供方均为普通 npm 依赖、不声明 `dsh.bundle.patch`），各自写入两行 insert（Browser Use 提供方行带 `config`）。`auto-review-model` 声明 `dsh.bundle.patch`，由 bundle 层自挂载，不写手工 insert。Auto review 本体不经过共享流水线：它是 dsh 安装随附的官方可选 bundle，只由插件页开关写入 `dsh.profile.bundles`；Agent Teams 已由 web-app 组合内置，不需要安装。`DSH_PLUGIN_SKIP=<wrapper id>` 因此只对 browser-use 与 computer-use 生效；`DSH_PLUGIN_FORCE_INSTALL=1` 反过来强制安装。
- Browser Use 与 Computer Use 的四个 npm 包都不传 `exempt`：它们的 peer 已被 0.2.3-alpha.2 的准入闸门接受，不需要版本例外（例外只用于上游尚未适配 0.2 的包，见 `plugins/README.md`）。`auto-review-model` 是 in-tree 包，没有 peer 声明，不进入准入闸门。
