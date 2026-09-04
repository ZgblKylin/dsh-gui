# plugins/dsh-pet

[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（npm 包名 `dsh-pet`）
的 wrapper：一只住在 DSH 里的桌面宠物，浏览器 overlay 为默认形态，另有**可选**
桌面模式（每只宠物一个透明置顶 Electron 小窗）。本 wrapper 默认**屏蔽桌面模式**
——只装浏览器形态，不启动、不下载任何 Electron 进程。

## 目录

```text
plugins/dsh-pet/
├─ install.mjs                   # npm 安装 dsh-pet@0.2.4 + 注入桌面屏蔽配置
├─ inject-config.mjs             # 用户配置注入（纯函数，可单测）
├─ README.md                     # 本说明
└─ dsh-pet/                      # PC2005-cloud/dsh-pet 仓库（git submodule，pin v0.2.4）
   ├─ dsh-pet/                   # 真正的 npm 包源码（package.json / cordis.patch.yml / src/…）
   └─ …                          # 仓库其余部分（scripts / tools / prompts 等，仅源码参考）
```

来源形态：git submodule（整仓库，源码参考；npm 发布包在仓库内 `dsh-pet/`
子目录），安装走 **npm** 受管安装器（`installNpmPlugin`，精确版本
`dsh-pet@0.2.4`），不参与构建。

## 兼容性状态（默认跳过）

`dsh-pet` 0.2.4 与本仓库 pin 的 harness（dsh-v0.1.2-alpha.1）**不兼容**：

- client 半按旧 harness 构建，运行时 `require('@deepseek-ai/dsh-client-runtime')`
  ——该包在本 harness 中已移除，加载会 miss module table（与已移除的
  `@linxin666/dsh-pet` 同因）；
- host 半 `inject: ['webServer', 'agentDefaultModel', …]`，其中
  `agentDefaultModel` 服务在本 harness 中不存在，即便强装也停在 PENDING。

因此 wrapper 在 `plugins/dsh-pet/install.mjs` 里向 `installNpmPlugin` 传入
`skip` 声明默认跳过（屏蔽入口在插件脚本，共享流水线只负责机制），
`npm run install:plugins` / `npm run build` 默认
跳过（不会破坏 profile 启动）。待上游（或本仓库适配层）提供兼容构建后，把
该 `skip` 选项改为 `null` 即可恢复。临时强制：`$env:DSH_PLUGIN_FORCE_INSTALL=1`
后重跑本脚本。

> 插件名冲突（issue
> [#16](https://github.com/PC2005-cloud/dsh-pet/issues/16)）：上游已把 webserver
> 路由前缀 `/pet` 改为 `/dsh-pet-7340`（0.1.8 起，v0.2.4 已含），不再与其它插件的
> `/pet` 路由撞车。残留风险是 Loader entry id `pet` 与其它同样用 `pet` 的插件
> 同 profile 共存会 `duplicate loader entry id`——本仓库已移除 `dsh-web-ui` 对
> `@linxin666/dsh-pet`（同为 entry `pet`）的安装，默认 profile 不会双挂。

## 桌面屏蔽（安装后注入）

逻辑见 `inject-config.mjs`，上游依据 `src/host/index.ts` 的
`isDesktopVisible` / `hasDesktopPet` / `startHelper()`：只有存在
`display ∈ {desktop, both}` 的宠物时才去探测/下载/拉起 Electron Helper。
内置默认配置 `assets/config.jsonc` 的宠物 display 是 `both`，所以**装上不屏蔽
就会默认开桌面**。本 wrapper 在插件真正装入 profile 后向用户层
`$DSH_HOME/dsh-pet/main-config.json` 注入 `display:"web"`（规则，幂等）：

1. 文件不存在 → 建立：写入默认宠物（`display:"web"`）；
2. 已有任意宠物带 `display` 字段 → 不动用户配置；
3. 存在但无 display（旧格式/手写未配）→ 宠物为空则置入默认宠物，否则给每只
   已有宠物补 `display:"web"`（保留其余字段与顶层键）。

效果：`hasDesktopPet` 恒 false → 不解析/不下载 Electron、不 spawn 独立进程，
浏览器 overlay、设置页、「桌宠配置」「余额 / 碎碎念 / 对话」全部保留。用户之后
在任何端把 display 改回 `desktop`/`both` 即为重新启用桌面模式（设置页保存本地
配置即可）。

> 时序：`hasDesktopPet` 只在插件激活与设置页保存（PUT/DELETE /config 触发
> `syncDesktop`）时重算。本脚本在插件首次激活前写完配置，激活即生效；若宿主
> 已在跑且桌面窗口已拉起，改配置后需重启或保存一次设置页才停掉旧窗口。

## 安装

```powershell
# 默认（会被跳过清单拦截）
node plugins/dsh-pet/install.mjs
# 强制安装（不兼容，host 大概率 PENDING）
$env:DSH_PLUGIN_FORCE_INSTALL = '1'; node plugins/dsh-pet/install.mjs
```

## 更新

- 移动子模块指针到新 tag：
  `git submodule update --remote plugins/dsh-pet/dsh-pet`（先审阅上游变更）；
- 同步升级 npm 版本：把 `install.mjs` 的 `PACKAGE_SPEC` 改为新精确版本后重跑本脚本。

## 验证

```powershell
# web profile 未装（默认跳过）：
Test-Path .dsh/profiles/web/node_modules/dsh-pet
# 用户配置已注入 / 未被触碰：
Get-Content .dsh/dsh-pet/main-config.json
```