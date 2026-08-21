# dsh-file-explorer（文件资源管理器插件）

dsh-gui 内置的全局文件资源管理器插件。上游仓库：
[joejojoking-cloud/dsh-file-explorer](https://github.com/joejojoking-cloud/dsh-file-explorer)
（MIT），以 git submodule 形式落在
`plugins/file-explorer/dsh-file-explorer`（wrapper 为 `plugins/file-explorer/`）。

在任意会话标题栏右侧提供「文件」切换按钮，打开页面右侧可调宽度的文件树
（260–900px）：目录懒加载展开/折叠、递归搜索（跳过 `.git` / `node_modules`，
最多 300 条）、Markdown/语法高亮预览、面板内编辑写回、一键在 VS Code 中打开
工作区。功能细节与上游 README 保持一致，见
`plugins/file-explorer/dsh-file-explorer/README.md`。

## 集成方式

该插件是 **prebuilt + bundle-patch** 形态，与本仓库安装器的适配逻辑：

1. **无 `build` 脚本**：`lib/` 直接随仓库分发，`plugins/file-explorer/install.mjs`
   委托 `scripts/plugin-install.mjs` 对其跳过 `pnpm install` + `pnpm run build`。
2. **自带 `dsh.bundle.patch`**（`cordis.patch.yml`，插入
   `id: file-explorer, name: dsh-file-explorer`）：`dsh plugin add` 的
   reconcile 逻辑把它追加进 profile 的 `dsh.profile.bundles`，该 bundle layer
   自行把 entry 插进 host 组合；install 脚本对声明了 `dsh.bundle.patch`
   的插件不再写 `cordis.patch.yml` insert（否则会重复挂载）。
3. 运行期两个半部：
   - host 半部（`lib/index.js`）：`fs` 服务 + `/plugins/file-explorer/*`
     HTTP 路由（list / search / read / write / open-vscode）；
   - client 半部（`lib/client.js`）：`dsh.client`（platform web）row，
     `window.__ModuleLoader__` bundle，渲染 `shell.overlay` 面板与标题栏按钮。

安装/更新流程（全部仓库内自托管）：

```powershell
# 首次安装或安装器行为变化后
npm run install:plugins

# 上游出新版本时
git submodule update --remote plugins/file-explorer/dsh-file-explorer
npm run install:plugins
```

重启 `dsh-gui` 后生效（插件集变更在 boot 时加载）。

## 验证

```powershell
# 1. 组合树中 entry 恰好出现一次（来自 dsh-file-explorer bundle layer）
$env:DSH_HOME = (Get-Location).Path + '\.dsh'
node deepseek-harness\apps\cli\lib\bin.js web --dump-config | Select-String 'file-explorer'

# 2. 运行时路由冒烟（另起临时实例，端口避开正在运行的 3080）
node deepseek-harness\apps\cli\lib\bin.js web --port 3199
Invoke-WebRequest 'http://127.0.0.1:3199/plugins/file-explorer/list?path=<urlencoded-path>'
```

## 已知约束

- `open-vscode` 依赖 PATH 中的 `code`（或 `shell`/`subprocess` 服务回退）；
  未安装 VS Code 时返回 `ok: false` 提示，不影响其余功能。
- 超过 1 MB 的文件不提供预览。
