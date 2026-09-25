# plugins/harness

dsh 工程官方插件组：把 `@deepseek-ai/dsh-*` 官方实验插件统一在一个 wrapper 里
安装。平铺结构，没有二级子目录；`install.mjs` 是流水线入口，按顺序加载目录里的
各插件 installer。

| 文件 | 插件 | 说明 |
| --- | --- | --- |
| `install.mjs` | — | 流水线入口，依次加载所有平铺 installer |
| `agent-team.mjs` | Agent Teams | 两个 npm bundle + 派生 Team-aware agent preset |
| `auto-review.mjs` | Auto review | 逐调用 LLM 授权审查层 |
| `browser-use.mjs` | Browser Use (Playwright MCP) | 独占浏览器提供方注册服务 + Playwright MCP 提供方；**默认跳过**（逐会话注册在共享层撞名，等上游修复） |
| `computer-use.mjs` | Computer Use (Cua Driver native) | 独占桌面提供方注册服务 + Cua Driver 原生提供方 |

其中 **Agent Teams 与 Auto review** 的四个包都声明 `dsh.bundle.patch`，`dsh
plugin add` 会自动把它们 reconcile 进 `dsh.profile.bundles`，由各自的 bundle 层
挂载；**它们的脚本都不写 `cordis.patch.yml` insert**（手工插入会
`duplicate loader entry id`）。**Browser Use 与 Computer Use 的包都不声明
`dsh.bundle.patch`**，是普通 npm 依赖，由 `browser-use.mjs` / `computer-use.mjs`
通过共享流水线的显式 `mount` 选项写入 insert 行（Browser Use 的服务行 + 提供方行，
提供方行带 `config`；Computer Use 的服务行 + 原生提供方行，原生提供方无配置、行不带
`config`，见下）。**Browser Use 当前默认跳过**：`installNpmPlugin` 的 `skip` 只记录
包、不写 insert，原因与恢复方式见「Browser Use」一节；`computer-use.mjs` 正常安装。

## Agent Teams

### 安装内容

| 项 | 位置 | 说明 |
| --- | --- | --- |
| `@deepseek-ai/dsh-experimental-agent-team-profile@0.1.7-rc.2` | web profile | Team 领域服务 + Remote 方法 + 九个 scoped 模型工具 + 浏览器 roster 与任务板面板 |
| `<id>-team`，每个含 delegation 行且不挂进程级工具集的官方 preset 各一个 | `$DSH_HOME/profiles/web/cordis.patch.yml` 的 `@deepseek-ai/dsh-agent-preset` 声明行 | 由官方同名 preset 的声明派生的 Team-aware 组合。当前为 `standard-team` / `ptc-team`；官方 `cordis` 不派生，原因见「派生 preset 的规则」 |

版本必须精确 pin：npm `latest` dist-tag 仍落后于已发布的 prerelease，与本仓库
pinned 的 `dsh-v0.1.7-rc.2` 对应的是同版本号；它是 prerelease，这也是它进不了
Community Market 的原因。自 `0.1.7-rc.2` 起上游把原先的
`@deepseek-ai/dsh-experimental-agent-team-web-profile` 合并进这一个 bundle 并删除了
那个包，所以这里只安装一个 spec。

### 用途与派生 preset 的规则

官方 Agent Teams 默认关闭（随附 profile 都不引用它），且它的组合与官方 preset
存在一处错配：实验 bundle 的 `cordis.patch.yml` 在顶层禁用四个 delegation 行
（`tool-subagent-control`、`tool-subagent-list-agents`、`tool-subagent`、
`tool-subagent-fork`），但 `dsh-web-app` 早已在顶层裁掉这些行，真正提供
delegation 工具的是 preset 行（`standard` / `cordis` / `ptc` 各自挂回
`tool-subagent-control` 且 `backgroundMode: continuable`）。一只 preset 的
`config.plugins` 会被挂成一棵独立的 Loader 子树，顶层 patch 够不到它，于是出现
**错配**：`send_message` / `list_agents` / `interrupt_agent` 被 Agent Teams 的
scoped 版本遮蔽（只认 Team roster 成员名），而 `subagent` / `subagent_fork` 仍在
创建 continuable 子级——父 agent 无法再寻址这种子 agent。

`agent-team.mjs` 的派生声明把这条缝补上：在 preset 这一层把同样四行设为
`disabled: true`，使「关闭直接委派」真正落到模型可见面——委派统一走
`spawn_teammate`，消息控制交给 Agent Teams。派生只改这四个锚点，其余逐字节保留。

**声明式 preset（harness >= `dsh-v0.1.7-rc.2`）。** preset 不再是
`.dsh/.agent-presets/<id>/` 目录，而是一条 `@deepseek-ai/dsh-agent-preset` 行：
`config.id` 是会话记录的标识符，`config.plugins` 是该 agent 的 Cordis 行列表。随包
preset 由 `@deepseek-ai/dsh-web-app` bundle 的 `presets/*.patch.yml` 声明
（`dsh.bundle.patch` 自该版本起是列表）。脚本因此**读取**这些随包声明，并把派生声明
写进 profile patch 中一段带标记的块里（`writeDerivedDeclarations()`）；profile patch
在每层 bundle 之后应用，所以派生行排在最后。整个块按标记整体重写，因此本轮不再满足
派生条件的 preset 也会停止被声明。

**哪些 preset 会被派生是"发现"出来的，不是列出来的。** 脚本遍历随包声明，凡是含
delegation 行的就派生一个 `<id>-team` 兄弟，所以上游新增 preset 会在下次安装时自动
带上兄弟。`writeDerivedDeclarations()` 只在用户已手写同名行 id 时跳过并告警。

**挂进程级工具集的 preset 不派生。** 官方 `cordis`（创造模式）挂
`@deepseek-ai/dsh-tool-cordis`，它把 `Service` / `Event` / `Builtin` / `Tool`
四个 Host inspect provider 注册进进程级注册表 `ctx.cordisInspect`：注册表按 id
唯一，且该工具集没有"复用已有注册"的配置；而 preset 的 standing mount 在进程内
常驻不回收。所以含这个工具集的两份 composition 无法在同一进程内共存——后挂的那份
会在 `tool-cordis` 行上失败，报 `Host Cordis inspect provider "Service" is already
registered`。`cordis` 正是这种组合，因此脚本跳过它。`minimal` 没有
delegation 行，同样跳过。

**旧目录 preset 的清理。** 脚本会删除自己（含已退役的
`plugins/agent-team/install.mjs`）写过的 `.dsh/.agent-presets/<id>/` 目录——只删带
`generatedBy` 标记的，手写目录一律不动，并在日志里提示它们已不再被发现、需要改写
成声明行。

**为什么是生成副本而不是 `cordis:include`。** 用 include 表达同样的差异更短，但
嵌套的 `cordis:include` 是普通 `Include`，而 Loader 会把树回写到它读取的文件
（`Include.write()` → `this.filename`）。只有 preset 自己的树抑制了这一点
（`agent-preset-registry/src/mount.ts` 把 `PresetTree.write()` 覆盖为 no-op）。派生
声明整体复制随包声明的 `config.plugins`，只改四个锚点，因此其余行（包括脚本写成之后
上游新增的行）逐字节跟随上游，同时绝不把随包声明文件当作写入目标。若上游重构了这四
个锚点，脚本**报错退出**而不是静默放过。

## Auto review

### 安装内容

| 项 | 位置 | 说明 |
| --- | --- | --- |
| `@deepseek-ai/dsh-experimental-auto-review@0.1.7-rc.2` | web profile | 逐调用 LLM 授权审查层 |

版本必须精确 pin：`0.1.7-rc.2` 与本仓库 pinned 的 `dsh-v0.1.7-rc.2` 运行时
配套，包的 peerDependencies 全部指向 `^0.1.7-rc.1`；prerelease，进不了
Community Market。

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

## Browser Use (Playwright MCP)

> **当前状态：默认跳过安装。** `browser-use.mjs` 的两个 `installNpmPlugin`
> 调用都带 `skip`：构建时只记录包、不写入 profile，输出
> `skipping 'browser-use' / 'browser-use-playwright-mcp' — <原因>`。
> 恢复安装设 `DSH_PLUGIN_FORCE_INSTALL=1`（如构建前
> `$env:DSH_PLUGIN_FORCE_INSTALL=1`）。跳过原因见「已知限制」。

### 安装内容

| 项 | 位置 | 说明 |
| --- | --- | --- |
| `@deepseek-ai/dsh-browser-use@0.1.7-rc.2` | web profile | 独占具名浏览器提供方注册服务（`ctx.browserUse`），一次只允许激活一个提供方 |
| `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp@0.1.7-rc.2` | web profile | 通过 `@playwright/mcp` 的逐 Session Chromium 浏览器工具（工具名 `mcp__playwright-mcp__<tool>`） |

两个包都精确 pin `0.1.7-rc.2`，与本仓库 pinned 的 `dsh-v0.1.7-rc.2` 运行时
配套（peerDependencies 全部指向 `^0.1.7-rc.1`）——npm `latest` 仍指向
`0.1.6-alpha.1`，不能通过 `@latest` 或范围解析。均为 prerelease，进不了
Community Market。核心服务先装：提供方 inject `browserUse`。

### 挂载与配置

两者都不声明 `dsh.bundle.patch`，属普通 npm 依赖，`browser-use.mjs` 走共享流水线
的显式 `mount` 选项写入两行 insert（这是本仓库第一个用显式 `mount`/`config` 的
wrapper；恢复安装后生成的样式如下）：

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

**默认不加 `DSH_PLUGIN_FORCE_INSTALL=1` 时本组不安装任何东西**；以该变量强装并重启
后，在允许浏览器工具且支持图片输入的模型路由上（例如官方 DeepSeek 路由），模型才会
可见 `mcp__playwright-mcp__<tool>` 工具集与浏览器指导；启动/附加的浏览器由活动
Session 独占持有。浏览器模式由 profile 组合中的该 `config` 行决定，不是会话级开关。
把浏览器工具留在 `<unlisted-tools>`（`toolOrder`）中，避免无浏览器连接的 Session
无法组装提示词。

### 已知限制

- **同一 host 仅一个存活 Session 可用（当前默认跳过的原因）**：提供方通过
  `mountSessionMcp` 逐 Session 挂载 mcp-client，其工具（`mcp__playwright-mcp__*`）、
  提示词段（`mcp:playwright-mcp`）与资源服务器（`playwright-mcp`）都注册进 DSH 的
  共享/全局层；第二个存活会话（新建或恢复历史会话）会撞名 `already registered`，
  `failOnStartupError: true` 使会话创建/恢复回滚、并从列表消失。同族的
  Chrome DevTools MCP 提供方（`browser-use-chrome-devtools-mcp`）结构相同、同样受限；
  `stagehand-native` 不走逐会话 mcp-client（工具目录只注册一次），不受影响；
  `computer-use`（cua-driver native / mcp）同样不逐会话挂载，不受影响。等待上游把
  注册改为按 agent 作用域（或使用唯一 serverName）后恢复安装。

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

## Computer Use (Cua Driver native)

### 安装内容

| 项 | 位置 | 说明 |
| --- | --- | --- |
| `@deepseek-ai/dsh-computer-use@0.1.7-rc.2` | web profile | 独占具名桌面提供方注册服务（`ctx.computerUse`），一次只允许激活一个提供方 |
| `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native@0.1.7-rc.2` | web profile | 进程内嵌入 Cua Driver 原生 npm SDK（`@trycua/cua-driver@0.28.0`）桌面工具（工具名 `cua_driver_native__<tool>`） |

两个包都精确 pin `0.1.7-rc.2`，与本仓库 pinned 的 `dsh-v0.1.7-rc.2` 运行时
配套（peerDependencies 全部指向 `^0.1.7-rc.1`）。均为 prerelease，进不了
Community Market。核心服务先装：提供方 inject `computerUse`。

### 挂载与配置

两者都不声明 `dsh.bundle.patch`，属普通 npm 依赖，`computer-use.mjs` 走共享流水线
的显式 `mount` 选项写入两行 insert；**原生提供方无配置字段**（Config 为空 schema），
所以两行都不带 `config:`：

```yaml
- insert:
    - id: computer-use
      name: '@deepseek-ai/dsh-computer-use'
- insert:
    - id: computer-use-cua-driver-native
      name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native'
```

### 使用时

```powershell
npm run install:plugins        # 或 npm run build
```

重启后在允许桌面工具且支持图片输入的模型路由上（例如官方 DeepSeek 路由），模型
可见 `cua_driver_native__<tool>` 工具集与桌面操作指导；截图以持久化附件传给模型。
桌面由活动 Session 与其它应用共享，调用方自行协调完整的「观察→操作→验证」流程。

### 已知限制

- **每个部署一次只启用一个桌面提供方**（`ctx.computerUse` 独占注册）；本 wrapper
  只安装 native 提供方，同一族的**已安装 MCP** 提供方
  （`@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp`）**未安装**——两者
  抢占同一个注册位，不可同时激活。
- **需要启动主机的桌面权限**：npm 安装不授予桌面访问、也不创建图形会话；请向启动
  DSH 的应用授予权限。此提供方不安装独立持权的 Cua Driver 应用——若你更希望由独立
  应用持权并可切换驱动进程身份，改用同族的 MCP 提供方。
- **原生崩溃可能终止 DSH host 进程**：native 运行时与主机共享进程；若需要独立驱动
  进程兜底，请改用 MCP 提供方。
- **共享桌面**：提供方不为 Session 预留窗口或完整工作流；其它调用方和应用可能在
  两次调用之间改动同一桌面；取消的调用可能已投递输入，重试前必须重新查看状态。
- macOS 无头 Node host 上光标叠加层操作可能返回 `facility_unavailable`（截图与后台
  输入仍可用）。卸载时若原生关闭失败，注册位保持占用，需重启主机后才能挂载其它桌面
  提供方。

## 使用

```powershell
npm run install:plugins        # 或 npm run build
```

重启后：

- **Agent Teams**：在新会话预设选择器里选择带 `+ Agent Teams` 后缀的预设（目录名
  `<id>-team`）。派生 preset 必须与两个 Team bundle 成对使用，且要在**新会话开始前**
  选。
- **Auto review**：在当前会话权限选择器（composer 旁的「访问模式」菜单，或
  `/permission` slash 选择器）中选择带 `EXP` 角标的 `Auto review`，在确认对话框中
  勾选「我已了解这些风险，并愿意继续」后点「启用 Auto review」；直接键入
  `/permission auto` 也构成明确同意。通用设置行与新会话默认值都不提供 Auto。
- **Browser Use (Playwright MCP)**：**默认跳过、不安装**（原因见其一节）；只有以
  `DSH_PLUGIN_FORCE_INSTALL=1` 强装并重启后才随组合挂载，工具以
  `mcp__playwright-mcp__<tool>` 出现；是否对模型可见还取决于工具目录装配与模型
  路由是否支持图片输入。
- **Computer Use (Cua Driver native)**：安装后即随组合挂载（无二次开关），重启后
  工具以 `cua_driver_native__<tool>` 出现；前提是支持图片输入的模型路由 + 附件
  存储，并向启动 DSH 的应用授予桌面权限。

## 已知限制

- **Agent Teams 只为派生 preset 修复**。官方 `standard` / `cordis` / `ptc` 本身
  仍是原样，错配依旧存在；要让所有会话一致，需把某个 `*-team` preset 设为默认
  （`agentPresets.default`），本 wrapper 不做这件事。创造模式无法 Team 化；直接委派
  在 `-team` preset 下全面关闭（只剩 `spawn_teammate` 与一次性 `workflow`）；上游
  仍在孵化，promotion 时 npm 名会去掉 `experimental-`。
- **Auto review 是实验功能、需显式安装**。它不是确定性安全边界：每次受支持调用
  额外产生一次模型请求并增加延迟，模型分类可能误放行或误拒绝；不提供豁免、缓存
  grant、人工 fallback、可配置策略或重试。卸载时存活 Auto 会话被迁移到 Full
  access；重装只恢复选项，不把存活会话切回 Auto。
- **依赖上游形态**。Agent Teams 的四个锚点由安装脚本在安装时校验，上游重构会让
  安装失败而不是降级；届时需要更新脚本中的锚点常量。

## 卸载

```powershell
dsh plugin --profile web remove @deepseek-ai/dsh-experimental-agent-team-profile
dsh plugin --profile web remove @deepseek-ai/dsh-experimental-auto-review
dsh plugin --profile web remove @deepseek-ai/dsh-browser-use
dsh plugin --profile web remove @deepseek-ai/dsh-experimental-browser-use-playwright-mcp
dsh plugin --profile web remove @deepseek-ai/dsh-computer-use
dsh plugin --profile web remove @deepseek-ai/dsh-experimental-computer-use-cua-driver-native
# 派生 preset 是 profile patch 里的标记块；删除该块（含两条标记注释与其中内容）即卸载
Select-String -Path <DSH_HOME>\profiles\web\cordis.patch.yml -Pattern 'agent-team derived presets'
```

`dsh plugin remove` 会把对应 bundle 从 `dsh.profile.bundles` 移除；派生 preset 位于
`<DSH_HOME>\profiles\web\cordis.patch.yml` 中一段以 `# --- agent-team derived presets`
开始、以 `# --- end agent-team derived presets` 结束的块里，连同标记一起删除即可。
**Browser Use 与 Computer Use 的四行
insert 是手工挂载，`dsh plugin remove` 不会清理** —— 需手动删除
`.dsh/profiles/web/cordis.patch.yml` 里 `id: browser-use`、
`id: browser-use-playwright-mcp`、`id: computer-use`、`id: computer-use-cua-driver-native`
四行（Browser Use 提供方行含 `config`），否则重启会报错误（entry 对应的包已不存在）。
若要从本仓库安装流水线中整体去掉某个插件，删除 `install.mjs` 中对应的 loader 行即
可。

## 约束

- `DSH_HOME` 缺省 `<repo>/.dsh`，只写该目录；**从不写官方 preset 安装目录**。
- 幂等：重复执行结果一致（npm 安装由 `dsh plugin add` 去重，派生 preset 每次重新
  生成）。
- 依赖 `scripts/plugin-install.mjs` 的共享流水线；各包经 `installNpmPlugin`
  安装，每个 installer 也可单独运行。Browser Use 与 Computer Use 是头两个用显式
  `mount` 的 wrapper（服务/提供方均为普通 npm 依赖、不声明 `dsh.bundle.patch`），
  原本各写两行 insert（Browser Use 提供方行带 `config`）；**Browser Use 当前默认
  跳过**（`skip`），其两行 insert 只在 `DSH_PLUGIN_FORCE_INSTALL=1` 强装时写入，
  Computer Use 的两行 insert 正常写入；Agent Teams 与 Auto review 仍是 bundle
  自挂载。