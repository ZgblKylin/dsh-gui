# plugins/dsh-pet

[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（npm 包名 `dsh-pet`）
的 wrapper：一只住在 DSH 里的桌面宠物，浏览器 overlay 为默认形态，另有**可选**桌面模式（每只宠物一个透明置顶 Electron 小窗）。本 wrapper 默认**屏蔽桌面模式**——只装浏览器形态，不启动、不下载任何 Electron 进程。

## 目录

```text
plugins/dsh-pet/
├─ install.mjs                   # npm 安装 dsh-pet@0.3.6 + 注入桌面屏蔽配置
├─ inject-config.mjs             # 用户配置注入（纯函数，可单测）
├─ README.md                     # 本说明
└─ dsh-pet/                      # PC2005-cloud/dsh-pet 仓库（git submodule，pin v0.3.6）
   ├─ dsh-pet/                   # 真正的 npm 包源码（package.json / cordis.patch.yml / src/…）
   └─ …                          # 仓库其余部分（scripts / tools / prompts 等，仅源码参考）
```

来源形态：git submodule（整仓库，源码参考；npm 发布包在仓库内 `dsh-pet/`
子目录），安装走 **npm** 受管安装器（`installNpmPlugin`，精确版本
`dsh-pet@0.3.6`），不参与构建。

## 兼容性状态

`dsh-pet` v0.3.6 在本仓库 pin 的 harness（dsh `0.2.1-alpha.1`）下**可正常安装运行**：

- 9 条 `@deepseek-ai/dsh*` peer 均为 `^0.2.0-rc.1`，覆盖 `0.2.1-alpha.1`；安装期的准入预检与启动期的 bundle 层挂载都通过，因此不需要精确版本例外；
- host 半 `inject: ['webServer', 'agentDefaultModel', 'credentials', 'llm', 'commands']`：`agentDefaultModel` 服务由 base bundle 的 `@deepseek-ai/dsh-agent-default-model` 提供，其余服务随 base 与 web-app bundle 挂载，host 半可正常激活；
- 浏览器半在 `src/client/app.ts` 声明本地 inject
  `['slots', 'locale', 'connection', 'remote', 'remote.commands', 'commandUi']`：
  其中 `commandUi` 是官方 `dsh-client-ui-commands` 提供的「/」命令服务，随
  web-app bundle 挂载，`/pet` 选择框只在命令服务就绪后注册；
- 声明层 `dsh.client.inject` 只列出 `@deepseek-ai/dsh-client-connection`（随
  web-app bundle 挂载）；系统通知所需的浏览器通知权限由 dsh-gui 壳层的 WebView2
  授权处理（见 `src-tauri/src/views.rs` 与 `src-tauri/ui/view-bridge.js`）支持，
  不依赖浏览器的「网站设置→通知」；
- 系统通知走 **host 转发通道**：host 半监听 `session/event`（`turn/end`、
  `approval/asked`、`tool/call`）与 `agent/error`，把帧落在
  `/dsh-pet-7340/notify`，浏览器半每秒轮询该路由——不使用 DSH 0.1.5 已移除的
  `ctx.connection.api.events.mux/host`。上述事件名在本 harness 的
  `@deepseek-ai/dsh-acp` 与 `dsh-session-controller` 中均存在；
- 用户层配置自 0.3 起为 `main-config.jsonc`（JSONC，允许注释）；迁移前遗留的
  `main-config.json` 仍被读取，并在启动时重命名为 `.jsonc`。0.3 新增根字段
  `confineToScreen`、宠物字段 `workStatusEnabled` 与 `physics` 段，均由上游内置默认值提供。

因此 `plugins/dsh-pet/install.mjs` 不向 `installNpmPlugin` 传 `skip`，
`npm run install:plugins` / `npm run build` 默认安装（不会破坏 profile 启动）。

> 插件名冲突（issue
> [#16](https://github.com/PC2005-cloud/dsh-pet/issues/16)）：上游的 webserver
> 路由前缀为 `/dsh-pet-7340`，不与其它插件的 `/pet` 路由撞车。Loader entry id 自
> v0.3.6 起为 `dsh-pet`（v0.3.1 及以前是 `pet`），因此与同样曾用 `pet` 的
> `@linxin666/dsh-pet`（本仓库不安装）不再有 `duplicate loader entry id` 的可能；
> 旧版本写入的 `pet` 行不会因此被复用，升级时若 profile 里留有按 `pet` 定向的
> override 需一并改到 `dsh-pet`。

## 桌面屏蔽（安装后注入）

逻辑见 `inject-config.mjs`，上游依据 `src/host/index.ts` 的
`isDesktopVisible` / `hasDesktopPet` / `startHelper()`：只有存在
`display ∈ {desktop, both}` 的宠物时才去探测/下载/拉起 Electron Helper。
内置默认配置 `assets/config.jsonc` 的宠物 display 是 `both`，所以**装上不屏蔽
就会默认开桌面**。本 wrapper 在插件真正装入 profile 后向用户层配置注入
`display:"web"`（规则，幂等）：

1. 文件不存在 → 建立：写入默认宠物（`display:"web"`）；
2. 已有任意宠物带 `display` 字段 → 不动用户配置；
3. 存在但无 display（旧格式/手写未配）→ 宠物为空则置入默认宠物，否则给每只
   已有宠物补 `display:"web"`（保留其余字段与顶层键）。

写入路径由 `petConfigPath()` 决定：`$DSH_HOME/dsh-pet/main-config.jsonc`；该文件
不存在而 `main-config.json` 存在时就地写后者（上游的读取回落与启动迁移都会处理它）。

效果：`hasDesktopPet` 恒 false → 不解析/不下载 Electron、不 spawn 独立进程，
浏览器 overlay、设置页、「桌宠配置」「余额 / 碎碎念 / 对话」全部保留。用户之后
在任何端把 display 改回 `desktop`/`both` 即为重新启用桌面模式（设置页保存本地
配置即可）。

> 时序：`hasDesktopPet` 只在插件激活与设置页保存（PUT/DELETE /config 触发
> `syncDesktop`）时重算。本脚本在插件首次激活前写完配置，激活即生效；若宿主
> 已在跑且桌面窗口已拉起，改配置后需重启或保存一次设置页才停掉旧窗口。

## 安装

```powershell
node plugins/dsh-pet/install.mjs
```

## 更新

- 移动子模块指针到新 tag：
  `git submodule update --remote plugins/dsh-pet/dsh-pet`（先审阅上游变更）；
- 同步升级 npm 版本：把 `install.mjs` 的 `PACKAGE_SPEC` 改为新精确版本后重跑本
  脚本；新版本的 `@deepseek-ai/dsh*` peer 若不覆盖当前 harness，还需恢复
  `installNpmPlugin` 的 `exempt` 并写明接受该风险的理由。

## 验证

```powershell
# web profile 是否已装：
Test-Path .dsh/profiles/web/node_modules/dsh-pet
# 用户配置已注入 / 未被触碰：
Get-Content .dsh/dsh-pet/main-config.jsonc
```
