# plugins/dsh-you-should-know

[lolipop-1x1/dsh-you-should-know](https://github.com/lolipop-1x1/dsh-you-should-know)
（npm 包名 `dsh-you-should-know`）的 wrapper：「You Should Know」——在任务进行时，
后台观察主会话，把值得了解的重要事实、方案取舍与背景知识以浮层提醒你，支持按需解释、
标记已了解、带回主会话继续讨论与独立设置。

来源形态：**npm 发布包**。安装走共享流水线的 `installNpmPlugin`，spec 为
`dsh-you-should-know@latest`：安装时解析 registry 的 latest 精确版本，已装同一版本
时跳过；本 wrapper 不构建、不 link 本地源码（发布包已含预构建的
`dist/host/index.js` 与 `dist/client.js`）。

## 目录

```text
plugins/dsh-you-should-know/
├─ install.mjs                               # npm 安装（registry latest，bundle 自挂载）
└─ README.md                                 # 本说明
```

## 功能与使用

- **任务提醒**：host 半在主会话模型请求扩展点取得完整请求快照（系统提示、用户消息、
  助手回答、已有工具调用/结果与工具声明），默认每 6 个模型步骤在后台用独立观察者模型
  判断是否有值得提醒的事实、取舍与背景知识；同一轮最多展示一条提醒，没有价值时保持
  安静。
- **浮层展示**：browser 半在输入框上方以悬浮面板展示，可收起，不挤占会话内容。
- **按需解释**：展开查看事项的原因与实际影响；已了解的主题可标记，之后减少重复提醒。
- **带回主会话**：把提醒与解释填入输入框继续讨论（无草稿/附件时生效），由你决定是否
  发送。
- **独立设置**：语言（跟随系统 / 中文 / English）、观察模型（跟随主会话 / 独立选择）、
  观察步长、每轮检查次数上限，以及跨会话的主题记录（已展示 / 已了解）。

观察者只读取已有上下文，不运行工具、不读取新文件，观察请求与响应不写入主会话记录；
跟随主会话模型时保留请求前缀，方便提供方尝试复用缓存。自动观察默认开启并会产生额外
模型用量，可关闭或调大步长控制。

默认设置在 **设置 → You Should Know** 中调整，配置沿用上游出厂默认值，本 wrapper 不
额外注入配置。

## 挂载与组合

包声明 `dsh.bundle.patch`（`cordis.patch.yml` 插入 entry id `dsh-you-should-know`、
name `dsh-you-should-know`），因此 `dsh plugin add` 会把它 reconcile 进
`dsh.profile.bundles`，由包自己的 bundle 层挂载 entry——本 wrapper **不写**手工
`cordis.patch.yml` insert（手写会双挂载，报 `duplicate loader entry id`）。

## 兼容性状态

- **准入**：manifest 没有 `engines.dsh`，闸门按 `@deepseek-ai/dsh*` peer 判定：
  `@deepseek-ai/dsh-agent`、`dsh-client-connection`、`dsh-llm`、`dsh-session`、
  `dsh-storage-domain` 五条均为 `>=0.2.0-rc.2 <0.3.0-0`，本仓库 pin 的
  `dsh-v0.2.3-alpha.2` 按 includePrerelease 落在区间内，安装期预检与启动期挂载都通过，
  **无需**精确版本例外。
- **`@deepseek-ai/cordis` peer**：非 dsh 相关 peer，闸门不评估；`^4.0.4 ||
  ^4.0.5-alpha.1` 由运行时 cordis 4.x 线满足（`4.1.0` 落在 `^4.0.4` 内）。
- **`engines.node`**：包声明 `>=22.19.0`，低于 harness 的 Node 下限，无阻。
- **`dsh.client.inject`**：声明列出的若干 client 包名（如 `dsh-api-gateway`）是
  informational 的包名边缘（preflight 展示与 HMR 对比），缺席的行被跳过；插件真正的
  依赖是 Cordis 服务 inject——host 半 `llm` / `agent` / `session`，浏览器半会话输入区
  插槽，均随 base 与 web-app bundle 就绪。
- 挂载后的组合层是单行 `- id: dsh-you-should-know`，无重复 entry id、无跳过 bundle
  报告。

## 安装

```powershell
# 自托管（运行时根 = D:\git\dsh-gui-home）
node plugins/dsh-you-should-know/install.mjs
```

`$DSH_HOME` 缺省由共享流水线 pin 到运行时根的 `.dsh`，脚本也接受显式覆盖；不会写
系统全局位置。整个插件组仍走 `npm run install:plugins` / `npm run build`（按目录名
字典序，本 wrapper 排在 `dsh-pet` 之后、`harness` 之前）；安装产物都在 gitignored
的 `.dsh/`。

## 验证

```powershell
$env:DSH_HOME = 'D:\git\dsh-gui-home\.dsh'
# profile 依赖与 bundles
(Get-Content .dsh/profiles/web/package.json -Raw | ConvertFrom-Json).dsh.profile.bundles
# 组合层（退出码 0，且含 id dsh-you-should-know）
node ..\.harness\node_modules\@deepseek-ai\dsh\lib\bin.js --profile web --dump-config
```

重启 dsh-gui / harness 后生效：新建或继续一个任务，任务运行过程中若观察模型判断出
值得了解的事项，输入框上方会出现浮层提醒；可在 **设置 → You Should Know** 中调整
语言、观察模型与检查节奏。

## 更新

1. 重跑本 wrapper（`node plugins/dsh-you-should-know/install.mjs`）或执行下一次构建：
   安装时解析 registry 的 latest 精确版本，与已装版本不同才重新安装；
2. 重启 dsh-gui / harness 生效。

若上游新版本抬高 `@deepseek-ai/dsh*` peer 区间而排除 pin 的 harness，准入闸门会拒绝
安装并让构建以包名失败。此时临时固定一个兼容版本，或按 `plugins/README.md` 的例外流程
给 `installNpmPlugin` 传 `exempt`，不要回退插件版本号。

## 已知限制

- **纯插件自包含，但与 dsh-gui 无耦合**：只用 harness 的公开 manifest 约定
  （`dsh.bundle`、`dsh.client`）与 Cordis 服务/事件/插槽，可在只装
  `deepseek-harness` 的环境用 `dsh plugin add dsh-you-should-know` 直接加载；本
  wrapper 只负责构建期的安装与挂载。
- 自动观察会额外调用模型（即使没有展示提醒也可能产生用量），且当前固定使用完整会话
  上下文、不裁剪——这是上游行为，不是本 wrapper 可配置项；通过关闭自动观察、增大步长
  或设置每轮上限控制。
- 0.3 系列 harness 尚不被上游支持（兼容声明覆盖 0.2 系列）；升级 harness 后如准入
  闸门或启动期挂载失败，优先复核包 README 的兼容声明。
- 上游以 `github:` spec 安装时靠 `prepare` 脚本现场构建；本 wrapper 固定 npm 发布包，
  不走该路径，也没有本地构建步骤。

## 卸载

```powershell
$env:DSH_HOME = 'D:\git\dsh-gui-home\.dsh'
node ..\.harness\node_modules\@deepseek-ai\dsh\lib\bin.js plugin --profile web remove dsh-you-should-know
```

彻底移除（wrapper 目录、profile 依赖与 `.dsh` 运行期残留）按 `dsh-plugin-uninstall`
skill 的清单执行。