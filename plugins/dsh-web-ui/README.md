# plugins/dsh-web-ui

`dsh-web-ui` 的 git submodule wrapper。这个 wrapper 安装该仓库中的**插件本体**，
全部以 npm 包形式按**精确版本 pin** 安装进 web profile（见 `plugins/README.md` 的
「安装方式」一节），版本号与子模块 git tag 保持同步（当前 `0.3.14`）：

1. **`dsh-liangshen` host 插件**（`@linxin666/dsh-liangshen@0.3.14`）；
2. **`dsh-web-ui-settings` 兼容设置桥**
   （`@linxin666/dsh-client-ui-web-ui-settings@0.3.14`，排在最前）；
3. **`dsh-plugin-manager` 插件管理器 Tab**
   （`@linxin666/dsh-client-ui-plugin-manager@0.3.14`）；
4. **`dsh-skill-explorer` 技能中心面板**
   （`@linxin666/dsh-client-ui-skill-explorer@0.3.14`）。

用精确版本而非 `@latest`：pnpm 11 的 24h `minimumReleaseAge` 门禁对
`@latest`/范围解析会**静默回退旧版**，而对精确版本 pin 直接安装并自动豁免，
保证结果确定、与 git tag 一致。升级时需与子模块 tag 同步 bump 两个版本号。

不安装 dsh-web-ui 的其他任何包、插件、皮肤，也不安装其 agent preset（梁神模式
等 preset 属于 `presets/` 流程，不在本 wrapper）。

## 目录

```text
plugins/dsh-web-ui/
├─ install.mjs                     # npm 安装 dsh-liangshen / dsh-web-ui-settings
├─ README.md                       # 本说明
└─ dsh-web-ui/                     # dsh-web-ui 仓库（git submodule；上游 v0.3.x 起更名 dsh-web）
   ├─ packages/dsh-liangshen/      # host 插件源（npm 发布形态；wrapper 从 npm 安装）
   ├─ packages/dsh-pet/            # 鲸鱼娘桌宠源（仅源码参考，wrapper 不再安装；
   │                              #   PC2005-cloud 的 dsh-pet 见 plugins/dsh-pet/）
   └─ packages/dsh-web-settings/   # 兼容设置桥源码（npm 包名不变；wrapper 从 npm 安装）
```

## 安装范围

### dsh-liangshen + dsh-web-ui-settings + dsh-plugin-manager + dsh-skill-explorer

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

`dsh-skill-explorer` 是 DSH 技能中心：按来源（bundled / project / user /
custom / runtime）浏览已加载技能、启停、创建与删除；仅依赖官方 locale /
renderer 服务，作为独立 bundle 层自挂载。

安装步骤：共享管线的 `installNpmPlugin()` 依次执行

```powershell
dsh plugin --profile web add @linxin666/dsh-liangshen@0.3.14
dsh plugin --profile web add @linxin666/dsh-client-ui-web-ui-settings@0.3.14
dsh plugin --profile web add @linxin666/dsh-client-ui-plugin-manager@0.3.14
dsh plugin --profile web add @linxin666/dsh-client-ui-skill-explorer@0.3.14
```

四个包都声明 `dsh.bundle.patch`，`dsh plugin add` 会自动 reconcile 进 profile
的 bundle 列表，无需手工 cordis 挂载。

安装目标：

```text
.dsh/profiles/web/package.json    # 四个 npm 依赖 + dsh.profile.bundles
```

其中 `DSH_HOME` 与 dsh-gui 的其他 install 脚本一致：显式传入的
`DSH_HOME` 优先，缺省为仓库内 `<dsh-gui>/.dsh`。

**不会安装 / 不会执行：**

- `dsh-liangshen` 的 agent preset（梁神模式）——preset 属于 `presets/` 流程；
- `dsh-task-board`、`dsh-live-stats`、`dsh-remote-web-ui`、`dsh-skins`、
  `dsh-web-all`（v0.3.x 起，旧名 `dsh-web-ui-all`）等 dsh-web 其他 package；
- `@linxin666/dsh-pet`（鲸鱼娘桌宠）——已从本 wrapper 移除，改由
  `plugins/dsh-pet/`（PC2005-cloud 的 dsh-pet）独立 wrapper 安装；
- 对四个 bundle 的 `cordis.patch.yml` 手动挂载——它们都通过自身的
  bundle patch 挂载；
- 对上游 submodule 的任何修改。

## 运行方式

### 由 dsh-gui 构建自动执行

`npm run build` / `npm run setup` / `npm run install:plugins` 会按目录名顺序
执行 `plugins/*/install.mjs`，其中包含本脚本。构建输出形如：

```text
--- E:\Git\dsh-gui\plugins\dsh-web-ui\install.mjs

==> install plugin 'dsh-liangshen' (@linxin666/dsh-liangshen@0.3.14 from npm)
  @linxin666/dsh-liangshen declares dsh.bundle.patch — it mounts through its bundle layer, no cordis.patch.yml insert added
installed plugin 'dsh-liangshen' into E:\Git\dsh-gui\.dsh\profiles\web

==> install plugin 'dsh-web-ui-settings' (@linxin666/dsh-client-ui-web-ui-settings@0.3.14 from npm)
  ...
installed plugin 'dsh-web-ui-settings' into E:\Git\dsh-gui\.dsh\profiles\web

==> install plugin 'dsh-plugin-manager' (@linxin666/dsh-client-ui-plugin-manager@0.3.14 from npm)
  ...
installed plugin 'dsh-plugin-manager' into E:\Git\dsh-gui\.dsh\profiles\web

==> install plugin 'dsh-skill-explorer' (@linxin666/dsh-client-ui-skill-explorer@0.3.14 from npm)
  ...
installed plugin 'dsh-skill-explorer' into E:\Git\dsh-gui\.dsh\profiles\web
```

### 手动执行

```powershell
node plugins/dsh-web-ui/install.mjs
```

## 幂等性

`dsh plugin add <pkg>@0.3.14`（npm，精确版本）可重复执行；bundle 层挂载由受管
安装器 reconcile 保证幂等。

## 更新源

`dsh-web-ui/` 已登记为 dsh-gui 的 git submodule（
`zhu1090093659/dsh-web-ui`，路径 `plugins/dsh-web-ui/dsh-web-ui`），仅作源码
参考。升级顺序：

1. 先移动子模块到新 tag（`git -C plugins/dsh-web-ui/dsh-web-ui checkout <tag>`）；
2. 同步把本文件 `install.mjs` 与 `README.md` 中的四个 npm 版本号 bump 到新 tag
   对应的版本（精确 pin，`pnpm add` 对精确版本自动豁免发布年龄门禁）；
3. 重跑安装：

```powershell
node plugins/dsh-web-ui/install.mjs
```

> 更新对话框会核对上游新 tag 是否已有对应的 npm 发布（机制见
> `docs/dsh-gui/update-check.md`）：npm 尚未发布时该行会额外标注，此时移动
> submodule 源码 checkout 不会升级已安装的插件本体；待 npm 发布后重跑
> 本安装脚本即可。
