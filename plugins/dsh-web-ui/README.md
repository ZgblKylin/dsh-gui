# plugins/dsh-web-ui

`dsh-web-ui` 的 git submodule wrapper。这个 wrapper **只安装
`dsh-liangshen` 的 agent preset（梁神模式）**，不安装 dsh-web-ui 的任何其他
包、插件、皮肤或 host 插件。

## 目录

```text
plugins/dsh-web-ui/
├─ install.mjs                     # 复制 pristine preset 并应用 dsh-gui 侧补丁
├─ patch-liangshen.mjs             # Windows 补丁实现（锚点校验、幂等）
├─ patches/
│  └─ liangshen/
│     └─ custom-bash.mjs           # vendored from xiaobright/dsh-anchored-standard（MIT）
├─ README.md                       # 本说明
└─ dsh-web-ui/                     # dsh-web-ui 仓库（git submodule）
   └─ packages/dsh-liangshen/
      └─ presets/liangshen/        # 本 wrapper 实际安装的源目录（保持 pristine）
```

## 安装范围

`install.mjs` 分两步：

1. 只复制下面这个目录（上游内容原样，不做任何修改）：

```text
dsh-web-ui/packages/dsh-liangshen/presets/liangshen
```

2. 在复制出的安装产物上应用 `patch-liangshen.mjs` 的 Windows 补丁（见下节）。

安装目标：

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

## Windows 补丁

上游 submodule 保持 pristine，**所有改动以 install 时打补丁的方式落在
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
```

### 手动执行

```powershell
node plugins/dsh-web-ui/install.mjs
```

## 幂等性

每次执行都先删除目标目录再整目录复制，然后重新打补丁，因此重复执行结果
一致，源文件变更后重建也会清理陈旧文件。

## 更新源

`dsh-web-ui/` 已登记为 dsh-gui 的 git submodule（
`zhu1090093659/dsh-web-ui`，路径 `plugins/dsh-web-ui/dsh-web-ui`）。
更新上游并重装 preset：

```powershell
git submodule update --remote plugins/dsh-web-ui/dsh-web-ui
node plugins/dsh-web-ui/install.mjs
```

submodule 指针固定在上游具体 commit；更新前建议像其他外置源一样先审阅上游
变更，再提交新的 gitlink。上游更新后若补丁锚点失配，安装脚本会直接报错
提示复核补丁。
