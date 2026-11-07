# plugins/dsh-pause

[better-er/dsh-pause](https://github.com/better-er/dsh-pause)（npm 包名
`dsh-pause`）的 wrapper：「DSH·暂停」——在 agent 完成一轮工具交互、正要发出下一次
模型请求之前插一个暂停点，保持 composer 可用；人类按回车（或点暂停控件）放行，草稿
非空时作为 steer 插话随本次请求一并发出，模型侧全程无感知。

来源形态：**npm 发布包**。安装走共享流水线的 `installNpmPlugin`，精确版本
`dsh-pause@0.1.6`；本 wrapper 不构建、不 link 本地源码（发布包已含预构建的
`lib/index.js` 与 `lib/client.js`）。

## 目录

```text
plugins/dsh-pause/
├─ install.mjs                               # npm 安装 0.1.6（bundle 自挂载）
└─ README.md                                 # 本说明
```

## 功能与使用

- **暂停点**：host 半监听 `agent/pre-step` waterfall，只在一个 turn 的工具续跑请求前
  挂起（每个 turn 的第一次请求 step 为 1，永不暂停）；暂停发生在请求真正发出之前，
  不打断任何在途 API 调用。
- **开关默认关闭**：Config `defaultEnabled` 默认 `false`，可在 composer 工具行逐会话
  开启；开关状态与暂停点都在插件内存里按 session 维护。
- **放行语义**：主输入框按裸 Enter 或点「已暂停·回车或点此继续」都能放行。草稿为空
  无感继续；有文字（含图片）则作为插话随本次请求一并发出。暂停点未到时按 Enter 同样
  有效——消息立即以 `agent.steer` 送出，空闲时由 steer 自己开新的一轮。
- **browser 半**：经 `conversation.input.right` slot 在 composer 工具行渲染控件；插件
  开启期间用 DOM capture 拦截裸 Enter（composer 的 Enter 由 InputBar 私有 keymap
  处理，第三方无 hook 点），改走主机裁决，不改 DSH 源码。
- **RPC 通道**：向 host webServer 自注册 `/dsh-pause` 前缀路由，复用 `connection`
  的信任判定与浏览器鉴权，信封格式与官方一致；`webServer` / `connection` 缺席时
  不挂载该通道，其余功能不受影响。

配置写在 profile 的 Loader entry 上（`cordis.patch.yml` / bundle 层），只有一个键：

```yaml
config:
  defaultEnabled: false
```

## 挂载与组合

包声明 `dsh.bundle.patch`（`cordis.patch.yml` 插入 entry id `dsh-pause`、name
`dsh-pause`），因此 `dsh plugin add` 会把它 reconcile 进 `dsh.profile.bundles`，
由包自己的 bundle 层挂载 entry——本 wrapper **不写**手工 `cordis.patch.yml`
insert（手写会双挂载，报 `duplicate loader entry id`）。

## 兼容性状态

- **准入**：manifest 没有 `engines.dsh`，闸门按 `@deepseek-ai/dsh*` peer 判定：
  `@deepseek-ai/dsh`、`dsh-llm`、`dsh-client-connection`、
  `dsh-client-ui-conversation`、`dsh-client-ui-renderer`、`dsh-client-ui-slots`
  六条均为 `^0.2.0-rc.2`（等价 `>=0.2.0-rc.2 <0.3.0-0`），本仓库 pin 的
  `dsh-v0.2.2-rc.1` 落在区间内，安装期预检与启动期挂载都通过，**无需**精确版本
  例外（对照 `commandcode-provider`）。
- **`engines.node`**：包声明 `>=26.3.1`，高于 harness 的 `>=24.9.0`。profile 的
  pnpm 未开 `engine-strict`，安装只告警不拒绝；发布产物是纯 ESM + React，不依赖
  Node 26 专有 API（本仓库在 pinned harness 上做了安装与启动冒烟验证）。
- **`dsh.client.inject`**：声明里列出的 `@deepseek-ai/dsh-client-runtime` 在
  0.2.2-rc.1 中已不存在。该字段是 informational 的包名边缘（preflight 展示与
  HMR 对比），不参与 entry 激活排序，组合与客户端加载都会跳过缺席的行；插件真正的
  依赖是 Cordis 服务 inject——host 半 `connection` / `agents`，浏览器半
  `slots` / `connection` / `conversation`，均随 base 与 web-app bundle 就绪。因此
  暂停控件与 `/dsh-pause` 路由不受这一项影响。
- 挂载后的组合层是单行 `- id: dsh-pause`，无重复 entry id、无跳过 bundle 报告。

## 安装

```powershell
# 自托管（运行时根 = E:\Git\dsh-gui-home）
node plugins/dsh-pause/install.mjs
```

`$DSH_HOME` 缺省由共享流水线 pin 到运行时根的 `.dsh`，脚本也接受显式覆盖；不会写
系统全局位置。整个插件组仍走 `npm run install:plugins` / `npm run build`（按目录名
字典序，本 wrapper 排在 `dsh-pause`）；安装产物都在 gitignored 的 `.dsh/`。

## 验证

```powershell
$env:DSH_HOME = 'E:\Git\dsh-gui-home\.dsh'
# profile 依赖与 bundles
(Get-Content .dsh/profiles/web/package.json -Raw | ConvertFrom-Json).dsh.profile.bundles
# 组合层（退出码 0，且含 id dsh-pause）
node ..\.harness\node_modules\@deepseek-ai\dsh\lib\bin.js --profile web --dump-config
```

重启 dsh-gui / harness 后生效：打开任一会话，在 composer 工具行右侧点「暂停」按钮变
「暂停开」；之后该会话的工具续跑请求会停在暂停点，主输入框按 Enter 放行。未开启的
会话不拦截任何按键。

## 更新

1. 审阅上游变更（GitHub Releases 与 npm `dist-tags.latest` 对齐）后，把 `install.mjs`
   的 `packageSpec` 改为上游新发布的精确 npm 版本；
2. 重跑本 wrapper（`node plugins/dsh-pause/install.mjs`）并重启生效。

`engines.node` 门槛随上游发布变化；若新版本抬高 `@deepseek-ai/dsh*` peer 区间而排除
pin 的 harness，按 `plugins/README.md` 的例外流程给 `installNpmPlugin` 传 `exempt`，
不要回退插件版本号。

## 已知限制

- **纯插件自包含，但与 dsh-gui 无耦合**：只用 harness 的公开 manifest 约定
  （`dsh.bundle`、`dsh.client`）与 Cordis 服务/事件/slot，可在只装
  `deepseek-harness` 的环境用 `dsh plugin add dsh-pause` 直接加载；本 wrapper 只负责
  构建期的安装与挂载。
- 暂停点只用「同一 turn 内 step > 1」近似工具续跑，无法区分工具续跑与人类中途插话
  造成的 step；对暂停语用而言两者都是「模型进一步作答前的暂停点」，行为可接受。
- 插话只支持文字与图片；文件附件不支持随插话发送（会被移出输入框并提示重新选择）。
  带图插话经浏览器把草稿图片序列化成 base64 上传，RPC 请求体上限因此放宽到
  300 MiB。
- 上游以 `github:` spec 安装时靠 `prepare` 脚本现场构建；本 wrapper 固定 npm 发布包，
  不走该路径，也没有本地构建步骤。
- 暂停状态只存在于主机内存，插件重载/DSH 重启后按 `defaultEnabled` 重新初始化。

## 卸载

```powershell
$env:DSH_HOME = 'E:\Git\dsh-gui-home\.dsh'
node ..\.harness\node_modules\@deepseek-ai\dsh\lib\bin.js plugin --profile web remove dsh-pause
```

彻底移除（wrapper 目录、profile 依赖与 `.dsh` 运行期残留）按 `dsh-plugin-uninstall`
skill 的清单执行。
