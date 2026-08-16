# plugins/dsh-web-ui

`dsh-web-ui` 的 git submodule wrapper。这个 wrapper 安装三类产物：

1. **`dsh-liangshen` 的 agent preset（梁神模式）**：复制 pristine preset 到
   `$DSH_HOME/.agent-presets/liangshen`，并对安装副本应用 dsh-gui 的 Windows 补丁；
2. **`dsh-pet`（鲸鱼娘桌宠）**：从 `dsh-web-ui/packages/dsh-pet` 构建并链接进
   web profile；
3. **`dsh-web-ui-settings` 兼容设置桥**：从
   `dsh-web-ui/packages/dsh-web-ui-settings` 构建并链接进 web profile，让
   `dsh-pet` 的 `pet` 设置命名空间可以在设置页编辑。

三个产物都来自 dsh-web-ui 仓库，但这里不安装 dsh-web-ui 的其他任何包、
插件、皮肤或 host 插件。

## 目录

```text
plugins/dsh-web-ui/
├─ install.mjs                     # 安装 preset + 构建/安装 pet 与设置桥
├─ patch-liangshen.mjs             # Windows 补丁实现（锚点校验、幂等）
├─ patches/
│  └─ liangshen/
│     └─ custom-bash.mjs           # vendored from xiaobright/dsh-anchored-standard（MIT）
├─ README.md                       # 本说明
└─ dsh-web-ui/                     # dsh-web-ui 仓库（git submodule）
   ├─ packages/dsh-liangshen/
   │  └─ presets/liangshen/        # preset 源目录（保持 pristine）
   ├─ packages/dsh-pet/            # 桌宠插件源（lib/ 由 install.mjs 构建）
   └─ packages/dsh-web-ui-settings/
      └─ src/                      # 兼容设置桥源码（lib/ 由 install.mjs 构建）
```

## 安装范围

### 1. liangshen preset

`install.mjs` 只复制下面这个目录（上游内容原样，不做任何修改）：

```text
dsh-web-ui/packages/dsh-liangshen/presets/liangshen
```

然后在复制出的安装产物上应用 `patch-liangshen.mjs` 的 Windows 补丁（见下节）。

安装目标：

```text
$DSH_HOME/.agent-presets/liangshen
```

### 2. dsh-pet + dsh-web-ui-settings

当前 DSH 的 `dsh-host-apiproxy` 只向 web 设置页暴露硬编码的
`WEB_SETTINGS_NAMESPACES`，不包含第三方插件的设置命名空间（包括
`dsh-pet` 的 `pet`）。`dsh-web-ui-settings` 在 host 侧提供 loopback-only 的
设置桥路由，在浏览器侧把 `webUiSettings` 兼容 binder 注入给家族插件；没有
它时，`dsh-pet` 的设置卡只能显示“命名空间未暴露”的提示。因此两个 bundle
一起安装，并把设置桥排在 `dsh-pet` 之前。

安装步骤：

1. 在 `dsh-web-ui/` 工作区内对两个包执行一次过滤安装
   （`--filter @linxin666/dsh-client-ui-web-ui-settings...` 与
   `--filter @linxin666/dsh-pet...`），使用 dsh-gui 的 repo-local pnpm
   与 store（--frozen-lockfile，避免改写上游 pnpm-lock.yaml），不拉取整个 monorepo；
2. 分别执行两个包的 `pnpm --filter <pkg> run build`；build 关闭
   verify-deps-before-run，避免脚本运行前触发全 workspace 安装；
3. 调用共享管线 `installPlugin()` 依次执行
   `dsh plugin --profile web add link:<dsh-web-ui-settings>` 和
   `dsh plugin --profile web add link:<dsh-pet>`；两个包都声明
   `dsh.bundle.patch`，会自动挂载到 profile 的 bundle 列表；
4. 最后校验 profile 清单：`dsh-web-ui-settings` 的 dependency 键与
   `dsh.profile.bundles` 项都排在 `dsh-pet` 之前——与上游
   `dsh-web-ui-all/aggregate.yml` 的顺序约定一致（`dsh-pet` 在激活时只读取
   一次 `webUiSettings`）。

安装目标：

```text
.dsh/profiles/web/package.json    # 两个 link: 依赖 + dsh.profile.bundles
```

其中 `DSH_HOME` 与 dsh-gui 的其他 install 脚本一致：显式传入的
`DSH_HOME` 优先，缺省为仓库内 `<dsh-gui>/.dsh`。

**不会安装 / 不会执行：**

- `@linxin666/dsh-liangshen` 这个 npm 插件包，以及 `dsh-liangshen` 的 host
  同步插件（`src/index.ts`、`cordis.patch.yml`）；
- `dsh-task-board`、`dsh-live-stats`、`dsh-remote-web-ui`、`dsh-skins`、
  `dsh-web-ui-all` 等 dsh-web-ui 其他 package；
- 对两个 bundle 的 `cordis.patch.yml` 手动挂载——它们都通过自身的
  bundle patch 挂载；
- 对上游 submodule 的任何修改。

安装后重启 dsh-gui：

- 预设选择器中会出现 **梁神模式**，其行为由 preset 内的组合与
  `tool-bootstrap.mjs` 自行完成；
- 桌面会出现鲸鱼娘桌宠，设置页的「宠物」分区可正常编辑（宠物选择、
  显隐、尺寸、位置、插件开关）。

## Windows 补丁

上游 submodule 保持 pristine，**preset 的所有改动以 install 时打补丁的方式落在
dsh-gui 侧**，实现方式参考 `presets/anchored-standard` 的 custom-bash：

- **原因**：DSH 的 PTY 后端仅支持 linux/darwin。上游 liangshen preset 的
  phase-1 `bash` 是 PTY 持久 shell，在 Windows 上冷启动 bootstrap 拿不到
  可用的 bash 工具，会话固定进入降级（full-catalog fallback）而不是晋升；
- **补丁内容**（`patch-liangshen.mjs`）：
  1. 复制 `patches/liangshen/custom-bash.mjs`（vendored from
     xiaobright/dsh-anchored-standard，MIT，与 anchored-standard 源逐字节一致）：
     Windows 上以普通 subprocess 运行 Git Bash 的同名 `bash` 工具；
  2. `agent.cordis.yml`：persistent-shell 组加
     `disabled: !!js process.platform === 'win32'`；新增 custom-bash 行
     （win32 专属、`bashPath` 固定 Git Bash）；两处注释补充平台拆分说明；
  3. `NOTICE` 追加 custom-bash.mjs 的出处归属；
- **鲁棒性**：所有文本补丁带锚点校验，上游文件形状变化时安装立即报错，
  绝不静默产出半补丁 preset；重复执行幂等。

## 运行方式

### 由 dsh-gui 构建自动执行

`npm run build` / `npm run setup` / `npm run install:plugins` 会按目录名顺序
执行 `plugins/*/install.mjs`，其中包含本脚本。构建输出形如：

```text
--- E:\Git\dsh-gui\plugins\dsh-web-ui\install.mjs
installed agent preset 'liangshen' (...\packages\dsh-liangshen\presets\liangshen)
  -> E:\Git\dsh-gui\.dsh\.agent-presets\liangshen
  patched: custom-bash.mjs copied, agent.cordis.yml: ...

==> build dsh-web-ui bundles (...\dsh-web-ui)
...
==> install plugin 'dsh-web-ui-settings' (...\packages\dsh-web-ui-settings)
installed plugin 'dsh-web-ui-settings' into E:\Git\dsh-gui\.dsh\profiles\web

==> install plugin 'dsh-pet' (...\packages\dsh-pet)
installed plugin 'dsh-pet' into E:\Git\dsh-gui\.dsh\profiles\web
```

### 手动执行

```powershell
node plugins/dsh-web-ui/install.mjs
```

## 幂等性

- preset：每次执行都先删除目标目录再整目录复制，然后重新打补丁，因此重复
  执行结果一致，源文件变更后重建也会清理陈旧文件。
- 两个 bundle：`pnpm install` / `build` 可重复执行；`dsh plugin add link:` 与
  bundle 层挂载由共享管线保证幂等；设置桥排在 `dsh-pet` 之前的顺序修正
  也只在不满足时重写 profile 清单。

## 更新源

`dsh-web-ui/` 已登记为 dsh-gui 的 git submodule（
`zhu1090093659/dsh-web-ui`，路径 `plugins/dsh-web-ui/dsh-web-ui`）。
更新上游并重装三个产物：

```powershell
git submodule update --remote plugins/dsh-web-ui/dsh-web-ui
node plugins/dsh-web-ui/install.mjs
```

submodule 指针固定在上游具体 commit；更新前建议像其他外置源一样先审阅上游
变更，再提交新的 gitlink。上游更新后若补丁锚点失配，安装脚本会直接报错
提示复核补丁；pet 与设置桥源码变化会在每次安装时重新构建。
