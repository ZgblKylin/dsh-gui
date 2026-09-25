# Harness 升级记录：dsh-v0.1.6-alpha.2 → dsh-v0.1.7-rc.2（含 7 个插件模块）

## 背景

按 skill `dsh-gui-update` 的两阶段约定执行：阶段一在持久化副本 `.staging/dsh-gui`
中更新、适配、构建并完成 WebUI 与 GUI 验收，阶段二在本工程实装。副本位置、维护
命令与验收命令见 [upgrade-staging-workspace.md](upgrade-staging-workspace.md)。

本次为「基座 + 插件」批量升级，共 8 个模块：

| 模块 | 路径 | 旧修订 | 新修订 |
| --- | --- | --- | --- |
| deepseek-harness（基座） | `deepseek-harness` | `ddefc45f`（dsh-v0.1.6-alpha.2） | `477b4f4205`（dsh-v0.1.7-rc.2） |
| dsh-deep-whale | `plugins/deep-whale/dsh-deep-whale` | `ce98fc01`（v0.1.2） | `db87ee6`（v0.1.5） |
| dsh-web-ui | `plugins/dsh-web-ui/dsh-web-ui` | `2629c3f5`（v0.3.22） | `41974c8c`（v0.4.2） |
| DSH-better-sidebar | `plugins/better-sidebar/DSH-better-sidebar` | `8753096a`（v0.19.1） | `d641d2e`（v0.21.1） |
| dsh-sidebar-qa | `plugins/better-sidebar/dsh-sidebar-qa` | `5fa3ce62`（v0.5.0） | `bb20e10`（v1.0.2） |
| dsh-market | `plugins/plugin-market/dsh-market` | `1860262d`（v1.46.1） | `d832e43`（v1.65.3） |
| dsh-flowglass | `plugins/better-sidebar/dsh-flowglass` | `410f6f80`（v0.6.0） | `b8999d0`（v0.7.2） |
| dsh-pet | `plugins/dsh-pet/dsh-pet` | `b4001594`（v0.2.9） | `631c531`（v0.2.12） |

8 个目标 tag 经 `git describe --tags --abbrev=0 origin/<默认分支>` 核对，都是各自默认
分支上可达的最新 tag，无需按「tag 保留规则」跳过任何模块。`harness.json` 选择 npm
运行时，build 按子模块 `apps/cli/package.json` 的版本安装 `@deepseek-ai/dsh@0.1.7-rc.2`
（该版本已发布到 registry）。

## 上游变更

发布说明（[v0.1.7-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2)）
按破坏性变更逐条说明。与本仓库组合相关的主要变更：

| 变更 | 说明 |
| --- | --- |
| **agent preset 改为声明式** | `@deepseek-ai/dsh-agent-presets` 拆分为 `dsh-agent-preset-registry`（选择与代际）与 `dsh-agent-preset`（声明）；`.dsh/.agent-presets/<id>/` 目录发现被移除且无替代路径（设计说明：`.agents/notes/implemented/architecture/2026-09-18-declarative-agent-presets.zh.md`）。一个 preset 现在是一条 `@deepseek-ai/dsh-agent-preset` 行，`config.id` 是会话记录的标识符，`config.plugins` 是该 agent 的 Cordis 行列表 |
| **随包 preset 迁入 web-app bundle** | `dsh.bundle.patch` 由字符串变为列表；`packages/bundle/web-app/presets/{standard,ptc,minimal,cordis}.patch.yml` 由 package.json 的 `dsh.bundle.patch` 依序声明 |
| **`agent-team-web-profile` 被上游删除** | 其内容合并进 `@deepseek-ai/dsh-experimental-agent-team-profile`，后者成为 Agent Teams 的单一 bundle |
| **插件版本兼容性闸门** | 安装与启动按包的 `peerDependencies`（`@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`）与运行版本比对，不兼容则拒绝安装/启动，可用 `<profile>/compatibility.json` 按「包@版本 → DSH 版本」授予例外 |
| 设置改由 profile 插件配置保存 | 旧 `settings.yaml` 只尝试导入一次；自定义设置插件需适配（`dsh-settings ≥ 0.1.7` 从插件 Config 推导可编辑字段） |
| spill-policy 预算改为 token | `maxInlineBytes` → `maxInlineTokens`（本仓库未自定义该配置） |
| Remote 二进制与双向流 | 工作区文件读取统一为 `readBytes`；本仓库 in-tree 插件不注册 Remote 方法、未使用该接口 |
| Inspector 不再默认提供 | 需单独安装 |

`SESSION_FORMAT_VERSION` 由 3 升到 4，新增会话格式迁移文档；运行时按既有迁移链
处理，本仓库不直接读写会话日志格式。

## 需要的适配

### `plugins/harness/agent-team.mjs` 改写（本次唯一的实质适配）

旧实现从 `@deepseek-ai/dsh-agent-presets` 包内定位随包 preset 目录，复制
`agent.cordis.yml` 到 `.dsh/.agent-presets/<id>-team/` 并改四个委派锚点。该机制随
0.1.7-rc.2 消失，因此改写为：

1. 只安装 `@deepseek-ai/dsh-experimental-agent-team-profile@0.1.7-rc.2`（web-profile
   已并入并删除）；
2. 从**已安装**的 `@deepseek-ai/dsh-web-app` bundle 读取 `dsh.bundle.patch` 列表里的
   `presets/*.patch.yml`，解析每条 `@deepseek-ai/dsh-agent-preset` 声明的
   `config.id` / `order` / `plugins` 块（多候选路径：`.harness` 的 CLI 依赖、profile
   的 node_modules、最后回退到 `deepseek-harness/packages/bundle/web-app`）；
3. 对含委派行且不挂进程级工具集的 preset，把 `config.plugins` 逐字节复制并把四个
   委派行标为 `disabled: true`，作为派生声明写入 profile patch 的**标记块**
   （`# --- agent-team derived presets ... ---` / `# --- end ... ---`），整块按标记
   重写，保留用户在同一文件里的其他内容；
4. 清理旧机制留下的 `.dsh/.agent-presets/<id>/` 目录（只删带 `generatedBy` 标记的），
   并对仍留在该目录、新 harness 已不再发现的手写 preset 打出告警。

派生规则与旧实现一致：遍历发现、只改四个锚点、上游重构锚点即报错退出、挂
`@deepseek-ai/dsh-tool-cordis` 的 `cordis` preset 不派生。实测派生结果为
`standard-team` 与 `ptc-team`（`minimal` 无委派行、`cordis` 挂进程级工具集，均跳过）。

### 安装脚本的版本钉

| 文件 | 改动 |
| --- | --- |
| `plugins/harness/agent-team.mjs` | `TEAM_VERSION` → `0.1.7-rc.2`；移除 web-profile 的安装 |
| `plugins/harness/auto-review.mjs` | `@deepseek-ai/dsh-experimental-auto-review@0.1.7-rc.2` |
| `plugins/harness/browser-use.mjs` | 两个包 → `0.1.7-rc.2`（本次仍保持默认跳过；随后在该版本上核实并解除屏蔽，见 [2026-09-26-browser-use-unmask.md](2026-09-26-browser-use-unmask.md)） |
| `plugins/harness/computer-use.mjs` | 两个包 → `0.1.7-rc.2` |
| `plugins/better-sidebar/install.mjs` | `dsh-better-sidebar@0.21.1`、`dsh-flowglass@0.7.2`、`dsh-sidebar-qa@1.0.2` |
| `plugins/plugin-market/install.mjs` | `dshmarket@1.65.3` |
| `plugins/dsh-pet/install.mjs` | `dsh-pet@0.2.12` |
| `plugins/dsh-web-ui/install.mjs` | 四个包 → `@0.4.2` |

发布状态已逐一核对：`@deepseek-ai/dsh@0.1.7-rc.2` 与上述全部 npm 目标版本均已发布
（`npm view <spec> version` 命中精确版本）。官方 dsh 家族包中
`@deepseek-ai/dsh-experimental-agent-team-web-profile` 没有 0.1.7 发布，因为它已被上游
删除；其余（agent-team-profile、auto-review、browser-use 两包、computer-use 两包）
均有 `0.1.7-rc.2` 发布。

兼容性闸门核对：本次全部目标包的 `@deepseek-ai/dsh*` peer 都接受 0.1.7-rc.2
（better-sidebar `^0.1.7-rc.1`、flowglass `^0.1.5-rc.1 || ^0.1.6-alpha.2 || ^0.1.7-alpha.2`、
sidebar-qa `^0.1.0-rc.8` / `>=0.1.2-alpha.2`、dsh-pet `^0.1.1-rc.2`、dshmarket
`^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2`、dsh-web-ui `>=0.1.7-rc.2`、
deep-whale `>=0.1.7-rc.1 <0.1.8-0`），构建过程中未被拒绝，也不需要
`compatibility.json` 例外。

### 文档同步

`presets/README.md`（改写为声明式落地方式）、`plugins/README.md`、
`plugins/harness/README.md`、`plugins/dsh-web-ui/README.md`、`AGENTS.md`、`README.md`、
`scripts/dsh-gui.mjs` 的注释、`scripts/staging.mjs` 的状态行。

## 验收

在副本 `.staging/dsh-gui` 内执行，DSH_HOME 显式指向副本 `.dsh`：

1. `npm run build -- --skip-exe` 全绿；
2. `npm run build`（含入口 exe）全绿，内含 `--profile web --dump-config` 组合冒烟检查
   （输出以 `Composition smoke check passed.` 结束）；
3. **WebUI 加载验收**：以副本 DSH_HOME 在空闲端口 3099 启动副本的
   `dsh web --no-open`，用 CDP 驱动真实浏览器渲染
   `http://127.0.0.1:3099/?token=…`，结果为：`document.title = "DeepSeek Harness"`、
   `readyState = complete`、517 个 DOM 节点、`window.__DSH_BOOT__` 携带 78 个客户端
   entry；**未捕获异常 0、加载失败请求 0、日志错误 0**，控制台仅有一条
   `[dsh-pet] 余额查询失败 reason=credential-missing`（副本无 API Key，属环境性提示）。
   页面内 81 个客户端 bundle URL 全部返回 HTTP 200；
4. **preset roster 验收**：在渲染出的界面打开预设选择器，列出标准模式 / PTC 模式 /
   极简模式 / 创造模式，以及本次派生的 **standard-team** 与 **ptc-team**，描述为
   「Agent Teams 版：关闭 subagent / subagent_fork 直接委派…」，与设计一致；
5. **GUI 启动运行验收**：见下节。

### GUI 启动运行验收

按 skill 步骤 7，用副本内 `npm run build` 产出的副本根目录入口 exe（
`.staging/dsh-gui/dsh-gui.exe`，13.1 MB），以 `DSH_GUI_PORT=3099` 启动副本自己的实例
（`npm start` → `launched …\.staging\dsh-gui\dsh-gui.exe`，后端在 127.0.0.1:3099 监听），
再用 computer use 观察真实窗口，结果为：

- 窗口出现：`dsh-gui.exe (pid …)`，标题 `DeepSeek Harness`，WebView2 子进程已创建；
- 加载页过渡到标签页：Tauri 外壳渲染出标题栏、`连接` 标签（本机 / dsh）、新建连接、
  菜单与最小化/最大化/关闭，内嵌页面从首个对话框推进到主会话界面；
- harness 就绪：主界面出现新会话、技能中心、流镜、插件、工作区会话树、今日消费与
  设置；皮肤（deep-whale maid-atelier）正常渲染；无错误覆盖层；
- 正常交互：连续三次输入均生效且应用状态随之推进（关闭「通知权限」提示、关闭
  「内测声明」、在 API Key 引导页选择「稍后配置」到达主界面），UIA 树元素从 30 降到
  65（主界面）并暴露 Button / Tree / Edit / MenuBar 等可操作控件。

验收后已关闭该实例并确认端口 3099 释放；正在运行的 dsh-gui（本工程 `dsh-gui.exe`）
全程未受影响。

## 发现与遗留

- **旧目录 preset 已失效且不再被发现**：副本 `.dsh/.agent-presets/review/`（「审阅模式」，
  手写，18613 字节的 `agent.cordis.yml`）不属于本次升级引入的问题——它引用了
  `@deepseek-ai/dsh-workflow-worker-thread`，该包在 **0.1.6-alpha.1** 已改名为
  `dsh-workflow-ptc`，因此在当前运行的 0.1.6-alpha.2 上本就无法挂载。0.1.7-rc.2 起目录
  发现被移除，它连「加载失败的 preset」都不会再出现。installer 会告警但不删除手写
  目录。如需保留，应按当前 `standard` 声明重新生成（复制 `config.plugins` 后替换
  persona），而不是照抄这份过期副本。
- **两个陈旧 bundle 需要从 profile 卸载**：本工程与副本的 profile 都残留了
  `@deepseek-ai/dsh-experimental-agent-team-web-profile`（上游已删除，且其 `ui-agent-team`
  插入行与新合并 bundle 重复）与 `@linxin666/dsh-client-ui-plugin-manager`（本仓库自
  0.1.6-alpha.2 起就不再安装，其 `ui-plugin-manager` 与官方 web-app bundle 的同名行重复）。
  副本内已用 `dsh plugin remove` 清除并重跑构建验证；本工程需在阶段二由用户执行同样的
  两条命令（见下）。跨 bundle 层的同名 entry 实测按 id 覆盖（运行中的 0.1.6-alpha.2
  实例就带着重复的 `ui-plugin-manager` 正常工作），因此这不是启动阻断项，但会留下
  已删除上游包的依赖与重复插入行。
- **`dsh plugin add dshmarket@1.65.3` 曾挂死一次**：pnpm 已完成安装（profile 已被正确
  写入）后，`dsh plugin` 进程零 CPU、无 socket 地阻塞 13 分钟，连带持有
  `profiles/web/package.json.lock`。终止该子树、删除锁文件后重跑构建正常。疑似网络
  （registry 供应链接策略校验/DNS）等待，本次未再复现；处置方式见 skill 第 9 节
  「强杀副本构建会遗留陈旧的 atomic-write 锁」。

## 阶段二状态

**尚未执行。** 阶段二（同步到本工程）按 skill 第 4 节要求，须在用户明确审批后进行。

用户执行时需要的动作：

```powershell
# 1) 停止正在运行的 dsh-gui
# 2) 从本工程 profile 卸载两个陈旧 bundle
dsh plugin --profile web remove @deepseek-ai/dsh-experimental-agent-team-web-profile
dsh plugin --profile web remove @linxin666/dsh-client-ui-plugin-manager
# 3) 重新构建
npm run build
```
