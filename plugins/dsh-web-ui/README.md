# plugins/dsh-web-ui

`dsh-web-ui` 的 git submodule wrapper。这个 wrapper 安装该仓库中的**插件本体**，
全部以 npm 包形式按 `@latest` 安装进 web profile（见 `plugins/README.md` 的
「安装方式」一节）：

1. **`dsh-liangshen` host 插件**（`@linxin666/dsh-liangshen@latest`）；
2. **`dsh-web-ui-settings` 兼容设置桥**
   （`@linxin666/dsh-client-ui-web-ui-settings@latest`，排在最前）；
3. **`dsh-pet`（鲸鱼娘桌宠）**（`@linxin666/dsh-pet@latest`）。

不安装 dsh-web-ui 的其他任何包、插件、皮肤，也不安装其 agent preset（梁神模式
等 preset 属于 `presets/` 流程，不在本 wrapper）。

## 目录

```text
plugins/dsh-web-ui/
├─ install.mjs                     # npm 安装 dsh-liangshen / dsh-web-ui-settings / dsh-pet
├─ README.md                       # 本说明
└─ dsh-web-ui/                     # dsh-web-ui 仓库（git submodule；上游 v0.3.x 起更名 dsh-web）
   ├─ packages/dsh-liangshen/      # host 插件源（npm 发布形态；wrapper 从 npm 安装）
   ├─ packages/dsh-pet/            # 桌宠插件源（npm 发布形态；wrapper 从 npm 安装）
   └─ packages/dsh-web-settings/   # 兼容设置桥源码（npm 包名不变；wrapper 从 npm 安装）
```

## 安装范围

### dsh-liangshen + dsh-pet + dsh-web-ui-settings

当前 DSH 的 `dsh-host-apiproxy` 只向 web 设置页暴露硬编码的
`WEB_SETTINGS_NAMESPACES`，不包含第三方插件的设置命名空间（包括
`dsh-pet` 的 `pet`）。`dsh-web-ui-settings` 在 host 侧提供 loopback-only 的
设置桥路由，在浏览器侧把 `webUiSettings` 兼容 binder 注入给家族插件；没有
它时，`dsh-pet` 的设置卡只能显示“命名空间未暴露”的提示。安装顺序为
设置桥 → dsh-pet（与上游 `packages/dsh-web-all/aggregate.yml` 的顺序约定一致）。

安装步骤：共享管线的 `installNpmPlugin()` 依次执行

```powershell
dsh plugin --profile web add @linxin666/dsh-liangshen@latest
dsh plugin --profile web add @linxin666/dsh-client-ui-web-ui-settings@latest
dsh plugin --profile web add @linxin666/dsh-pet@latest
```

三个包都声明 `dsh.bundle.patch`，`dsh plugin add` 会自动 reconcile 进 profile
的 bundle 列表，无需手工 cordis 挂载。

安装目标：

```text
.dsh/profiles/web/package.json    # 三个 npm 依赖 + dsh.profile.bundles
```

其中 `DSH_HOME` 与 dsh-gui 的其他 install 脚本一致：显式传入的
`DSH_HOME` 优先，缺省为仓库内 `<dsh-gui>/.dsh`。

**不会安装 / 不会执行：**

- `dsh-liangshen` 的 agent preset（梁神模式）——preset 属于 `presets/` 流程；
- `dsh-task-board`、`dsh-live-stats`、`dsh-remote-web-ui`、`dsh-skins`、
  `dsh-web-all`（v0.3.x 起，旧名 `dsh-web-ui-all`）等 dsh-web 其他 package；
- 对三个 bundle 的 `cordis.patch.yml` 手动挂载——它们都通过自身的
  bundle patch 挂载；
- 对上游 submodule 的任何修改。

## 运行方式

### 由 dsh-gui 构建自动执行

`npm run build` / `npm run setup` / `npm run install:plugins` 会按目录名顺序
执行 `plugins/*/install.mjs`，其中包含本脚本。构建输出形如：

```text
--- E:\Git\dsh-gui\plugins\dsh-web-ui\install.mjs

==> install plugin 'dsh-liangshen' (@linxin666/dsh-liangshen@latest from npm)
  @linxin666/dsh-liangshen declares dsh.bundle.patch — it mounts through its bundle layer, no cordis.patch.yml insert added
installed plugin 'dsh-liangshen' into E:\Git\dsh-gui\.dsh\profiles\web

==> install plugin 'dsh-web-ui-settings' (@linxin666/dsh-client-ui-web-ui-settings@latest from npm)
  ...
installed plugin 'dsh-web-ui-settings' into E:\Git\dsh-gui\.dsh\profiles\web

==> install plugin 'dsh-pet' (@linxin666/dsh-pet@latest from npm)
  ...
installed plugin 'dsh-pet' into E:\Git\dsh-gui\.dsh\profiles\web
```

### 手动执行

```powershell
node plugins/dsh-web-ui/install.mjs
```

## 幂等性

`dsh plugin add <pkg>@latest`（npm）可重复执行；bundle 层挂载由受管安装器
reconcile 保证幂等。

## 更新源

`dsh-web-ui/` 已登记为 dsh-gui 的 git submodule（
`zhu1090093659/dsh-web-ui`，路径 `plugins/dsh-web-ui/dsh-web-ui`），仅作源码
参考。更新 npm `@latest`：

```powershell
node plugins/dsh-web-ui/install.mjs
```
