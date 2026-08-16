# plugins/dsh-web-ui

`dsh-web-ui` 的 git submodule wrapper。这个 wrapper **只安装
`dsh-liangshen` 的 agent preset（梁神模式）**，不安装 dsh-web-ui 的任何其他
包、插件、皮肤或 host 插件。

## 目录

```text
plugins/dsh-web-ui/
├─ install.mjs                     # 只把 liangshen preset 落到 .dsh/.agent-presets/
├─ README.md                       # 本说明
└─ dsh-web-ui/                     # dsh-web-ui 仓库（git submodule）
   └─ packages/dsh-liangshen/
      └─ presets/liangshen/        # 本 wrapper 实际安装的源目录
```

## 安装范围

`install.mjs` 只复制下面这个目录：

```text
dsh-web-ui/packages/dsh-liangshen/presets/liangshen
```

到：

```text
$DSH_HOME/.agent-presets/liangshen
```

其中 `DSH_HOME` 与 dsh-gui 的其他 install 脚本一致：显式传入的
`DSH_HOME` 优先，缺省为仓库内 `<dsh-gui>/.dsh`。

**不会安装 / 不会执行：**

- `@linxin666/dsh-liangshen` 这个 npm 插件包（不执行 `pnpm install` / `build`）；
- `dsh-liangshen` 的 host 同步插件（`src/index.ts`、`cordis.patch.yml`）；
- `dsh-web-ui` 的其他 package、聚合包、皮肤或脚本；
- web profile 的 `cordis.patch.yml` 挂载。

安装后重启 dsh-gui，预设选择器中会出现 **梁神模式**，其行为由
`dsh-liangshen/presets/liangshen` 内的组合与 `tool-bootstrap.mjs` 自行完成，
不需要 host 插件同步。

## 运行方式

### 由 dsh-gui 构建自动执行

`npm run build` / `npm run setup` / `npm run install:plugins` 会按目录名顺序
执行 `plugins/*/install.mjs`，其中包含本脚本。构建输出形如：

```text
--- E:\Git\dsh-gui\plugins\dsh-web-ui\install.mjs
installed agent preset 'liangshen' (...\packages\dsh-liangshen\presets\liangshen)
  -> E:\Git\dsh-gui\.dsh\.agent-presets\liangshen
```

### 手动执行

```powershell
node plugins/dsh-web-ui/install.mjs
```

## 幂等性

每次执行都先删除目标目录再整目录复制，因此重复执行结果一致，源文件变更后
重建也会清理陈旧文件。

## 更新源

`dsh-web-ui/` 已登记为 dsh-gui 的 git submodule（
`zhu1090093659/dsh-web-ui`，路径 `plugins/dsh-web-ui/dsh-web-ui`）。
更新上游并重装 preset：

```powershell
git submodule update --remote plugins/dsh-web-ui/dsh-web-ui
node plugins/dsh-web-ui/install.mjs
```

submodule 指针固定在上游具体 commit；更新前建议像其他外置源一样先审阅上游
变更，再提交新的 gitlink。
