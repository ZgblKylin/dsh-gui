# plugins/dsh-web-ui

`dsh-web-ui` 的 git submodule wrapper。这个 wrapper 安装该仓库中的**插件本体**，
全部以 npm 包形式按**精确版本 pin** 安装进 web profile（见 `plugins/README.md` 的
「安装方式」一节），版本号与子模块 git tag 保持同步（当前 `0.3.22`）：

1. **`dsh-web-ui-settings` 兼容设置桥**
   （`@linxin666/dsh-client-ui-web-ui-settings@0.3.22`，排在最前）；
2. **`dsh-plugin-manager` 插件管理器 Tab**
   （`@linxin666/dsh-client-ui-plugin-manager@0.3.22`）；
3. **`dsh-skill-explorer` 技能中心面板**
   （`@linxin666/dsh-client-ui-skill-explorer@0.3.22`）；
4. **`dsh-usage` 使用统计**
   （`@linxin666/dsh-usage@0.3.22`）；
5. **`dsh-model-capabilities` 模型能力**
   （`@linxin666/dsh-client-ui-model-capabilities@0.3.22`）。

用精确版本而非 `@latest`：pnpm 11 的 24h `minimumReleaseAge` 门禁对
`@latest`/范围解析会**静默回退旧版**，而对精确版本 pin 直接安装并自动豁免，
保证结果确定、与 git tag 一致。升级时需与子模块 tag 同步 bump 版本号。

五个包要求 `dsh >= 0.1.5-rc.1`，本工程 pinned 的 `dsh-v0.1.5-rc.2` 满足该声明。

不安装 dsh-web-ui 的其他任何包、插件、皮肤，也不安装其 agent preset（agent
preset 属于 `presets/` 流程，不在本 wrapper）。`dsh-liangshen`（梁神模式）与其
agent preset 不由本 wrapper 安装：该 preset 由插件的 host 启动同步到
`.dsh/.agent-presets/liangshen`。

## 目录

```text
plugins/dsh-web-ui/
├─ install.mjs                          # npm 安装 dsh-web-ui-settings /
│                                       #   dsh-plugin-manager / dsh-skill-explorer /
│                                       #   dsh-usage / dsh-model-capabilities
├─ README.md                            # 本说明
└─ dsh-web-ui/                          # dsh-web-ui 仓库（git submodule；上游 v0.3.x
   │                                    #   起更名 dsh-web）
   ├─ packages/dsh-liangshen/           # host 插件源（仅源码参考，wrapper 不安装）
   ├─ packages/dsh-web-settings/        # 兼容设置桥源码（npm 包名不变；wrapper 从 npm 安装）
   ├─ packages/dsh-plugin-manager/      # 插件管理器 Tab 源码（wrapper 从 npm 安装）
   ├─ packages/dsh-skill-explorer/      # 技能中心源码（wrapper 从 npm 安装）
   ├─ packages/dsh-usage/               # 使用统计源码（wrapper 从 npm 安装）
   ├─ packages/dsh-model-capabilities/  # 模型能力源码（wrapper 从 npm 安装）
   ├─ packages/dsh-session-archive/     # 会话归档管理源码（仅源码参考，wrapper 不再安装）
   ├─ packages/dsh-task-board/          # 任务板源码（仅源码参考，wrapper 不再安装）
   ├─ packages/dsh-pet/                 # 鲸鱼娘桌宠源（仅源码参考，wrapper 不再安装；
   │                                    #   PC2005-cloud 的 dsh-pet 见 plugins/dsh-pet/）
```

## 安装范围

### dsh-web-ui-settings + dsh-plugin-manager + dsh-skill-explorer + dsh-usage + dsh-model-capabilities

当前 DSH 的 `dsh-host-apiproxy` 只向 web 设置页暴露硬编码的
`WEB_SETTINGS_NAMESPACES`，不包含第三方插件的设置命名空间。`dsh-web-ui-settings`
在 host 侧提供 loopback-only 的设置桥路由，在浏览器侧把 `webUiSettings` 兼容
binder 注入给声明它的家族插件；没有它时，依赖 `webUiSettings` 的插件设置卡
只能显示“命名空间未暴露”的提示。

`dsh-plugin-manager` 在官方「插件」设置分区注册 `settings.plugins.tab` Tab
（id `family-plugins`，order 20，与官方安装器 Tab 并列）：运行时优先走官方
`/plugin-installer` RPC 通道（单写入器 = 官方安装器），否则经其 host 半区的
loopback HTTP 网关（`/api/plugin-manager/*`）spawn 官方 `dsh plugin` CLI——
两种通道最终都由官方写入器落盘。提供插件列表 / 启停开关 / npm·git 安装 /
更新·卸载 / 安装冲突对账 / 失败修复会话（seed 不含任何密钥/token）。
聚合包（如 `dsh-web-all`）携带的子行默认折叠为「N/M child plugins on」摘要，
可逐行启用/禁用（只写单行 `disabled` 覆盖，不动兄弟行），列出的启停值反映
下一次启动的有效状态。

`dsh-skill-explorer` 是 DSH 技能中心：按来源（bundled / project / user /
custom / runtime）浏览已加载技能、启停、创建与删除；仅依赖官方 locale /
renderer 服务，作为独立 bundle 层自挂载。面板提供搜索框（按名称或描述过滤，
名称命中优先，与工作区选择器叠加），并支持多工作区展示。

`dsh-usage` 是使用统计：host 半区按轮询周期（默认 60 秒）探测各 provider 的余额
与编程套餐配额，并从 `session/event` 折叠实时 token 台账（持久化到
`$DSH_HOME/dsh-usage/usage-ledger.json`，按本地日保留）；设置页一级分区「使用统计」
提供用量 / 个人套餐 / Token 银行三个页签。API key 经宿主凭据缝解析，不进入浏览器。
宠物公告气泡读取可选的 `pet` 服务，本工程安装的 `plugins/dsh-pet/`（PC2005-cloud
的 `dsh-pet`）不提供该服务，因此气泡静默，其余功能不受影响。

`dsh-model-capabilities` 是模型能力：在 Models 设置页每张自定义提供方卡片注册
可折叠的「模型能力」扩展区，逐模型声明图片输入与推理档位；能力写入官方
`llm-pi-ai` 命名空间（每次保存整体替换该提供方的 `models` 数组），并提供
提供方禁用/启用——禁用先把 profile 存档进本插件的 `dsh-model-capabilities`
命名空间，再以 `unset` 下线路由。

安装步骤：共享管线的 `installNpmPlugin()` 依次执行

```powershell
dsh plugin --profile web add @linxin666/dsh-client-ui-web-ui-settings@0.3.22
dsh plugin --profile web add @linxin666/dsh-client-ui-plugin-manager@0.3.22
dsh plugin --profile web add @linxin666/dsh-client-ui-skill-explorer@0.3.22
dsh plugin --profile web add @linxin666/dsh-usage@0.3.22
dsh plugin --profile web add @linxin666/dsh-client-ui-model-capabilities@0.3.22
```

五个包都声明 `dsh.bundle.patch`，`dsh plugin add` 会自动 reconcile 进 profile
的 bundle 列表，无需手工 cordis 挂载。

安装目标：

```text
.dsh/profiles/web/package.json    # 五个 npm 依赖 + dsh.profile.bundles
```

其中 `DSH_HOME` 与 dsh-gui 的其他 install 脚本一致：显式传入的
`DSH_HOME` 优先，缺省为仓库内 `<dsh-gui>/.dsh`。

**不会安装 / 不会执行：**

- `dsh-liangshen` host 插件（梁神模式）及其 agent preset——该 preset 由插件的
  host 启动同步，本 wrapper 不安装；
- `dsh-remote-web-ui`、`dsh-skins`、`dsh-web-all`（v0.3.x 起，旧名
  `dsh-web-ui-all`）等 dsh-web 其他 package；
- `@linxin666/dsh-client-ui-task-board`（任务板）与
  `@linxin666/dsh-session-archive`（会话归档管理）——已从本工程移除，不再安装，
  见「已移除插件」一节；
- `@linxin666/dsh-pet`（鲸鱼娘桌宠）——由
  `plugins/dsh-pet/`（PC2005-cloud 的 dsh-pet）独立 wrapper 安装；
- 对五个 bundle 的 `cordis.patch.yml` 手动挂载——它们都通过自身的
  bundle patch 挂载；
- 对上游 submodule 的任何修改。

## 已移除插件（dsh-task-board / dsh-session-archive）

`dsh-task-board`（`@linxin666/dsh-client-ui-task-board`）与
`dsh-session-archive`（`@linxin666/dsh-session-archive`）曾由 dsh-web-ui 全家桶随
版本安装进 web profile，现均已从本工程移除：wrapper 不再安装，profile 也已卸载。
移除动作做了三件事（完整流程见 skill `dsh-plugin-uninstall`）：

1. profile 卸载：
   `dsh plugin --profile web remove <package>`，移出依赖、`node_modules` 与
   `dsh.profile.bundles` 条目；
2. `.dsh` 运行期残留清理：`.dsh/gui/npm-installs.json` 里的包名、
   `.dsh/settings.yaml` 的 `task-board` / `dsh-session-archive` 段（如有）、
   `.dsh/task-board/`（账本与调度器状态）与 `.dsh/dsh-session-archive/`
   （state.json）；
3. 本 wrapper 的 `install.mjs` 与 `README.md` 去掉 session-archive 条目，避免
   下次 `npm run install:plugins` 把它装回来。

dsh-web-ui 上游子模块中的 `packages/dsh-task-board/` 与
`packages/dsh-session-archive/` 仅作源码参考保留，与安装无关。

## 运行方式

### 由 dsh-gui 构建自动执行

`npm run build` / `npm run setup` / `npm run install:plugins` 会按目录名顺序
执行 `plugins/*/install.mjs`，其中包含本脚本。构建输出形如：

```text
--- E:\Git\dsh-gui\plugins\dsh-web-ui\install.mjs

==> install plugin 'dsh-web-ui-settings' (@linxin666/dsh-client-ui-web-ui-settings@0.3.22 from npm)
  ...
installed plugin 'dsh-web-ui-settings' into E:\Git\dsh-gui\.dsh\profiles\web

==> install plugin 'dsh-plugin-manager' (@linxin666/dsh-client-ui-plugin-manager@0.3.22 from npm)
  ...
installed plugin 'dsh-plugin-manager' into E:\Git\dsh-gui\.dsh\profiles\web

==> install plugin 'dsh-skill-explorer' (@linxin666/dsh-client-ui-skill-explorer@0.3.22 from npm)
  ...
installed plugin 'dsh-skill-explorer' into E:\Git\dsh-gui\.dsh\profiles\web

==> install plugin 'dsh-usage' (@linxin666/dsh-usage@0.3.22 from npm)
  ...
installed plugin 'dsh-usage' into E:\Git\dsh-gui\.dsh\profiles\web

==> install plugin 'dsh-model-capabilities' (@linxin666/dsh-client-ui-model-capabilities@0.3.22 from npm)
  ...
installed plugin 'dsh-model-capabilities' into E:\Git\dsh-gui\.dsh\profiles\web
```

### 手动执行

```powershell
node plugins/dsh-web-ui/install.mjs
```

## 幂等性

`dsh plugin add <pkg>@0.3.22`（npm，精确版本）可重复执行；bundle 层挂载由受管
安装器 reconcile 保证幂等。

## 更新源

`dsh-web-ui/` 已登记为 dsh-gui 的 git submodule（
`zhu1090093659/dsh-web-ui`，路径 `plugins/dsh-web-ui/dsh-web-ui`），仅作源码
参考。升级顺序：

1. 先移动子模块到新 tag（`git -C plugins/dsh-web-ui/dsh-web-ui checkout <tag>`）；
2. 同步把本文件 `install.mjs` 与 `README.md` 中的五个 npm 版本号 bump 到新 tag
   对应的版本（精确 pin，`pnpm add` 对精确版本自动豁免发布年龄门禁）；
3. 重跑安装：

```powershell
node plugins/dsh-web-ui/install.mjs
```

> 更新对话框会核对上游新 tag 是否已有对应的 npm 发布（机制见
> `docs/dsh-gui/update-check.md`）：npm 尚未发布时该行会额外标注，此时移动
> submodule 源码 checkout 不会升级已安装的插件本体；待 npm 发布后重跑
> 本安装脚本即可。
