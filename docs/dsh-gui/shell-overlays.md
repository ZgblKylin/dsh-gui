# 外壳专属插件层（shell overlays）

## 用途

有些插件只对桌面外壳有意义（需要原生窗口、全局快捷键或外壳专属的宿主接口），不应出现在浏览器打开的 Web UI 里。Tauri 外壳与浏览器页面共用 `web` profile，因此这类插件的安装脚本不写 profile 的 `cordis.patch.yml`，而是把挂载行写入外壳专用的 overlay 文件：

```
<DSH_HOME>/gui/shell-overlays/<name>.patch.yml
```

外壳启动 `dsh web` 时按文件名顺序把这些文件作为额外 `--patch` 层应用，组合结果只存在于外壳进程内；直接运行 `dsh web`（浏览器访问）不加载这些层。

## 启动参数的约束

`dsh` 启动器先解析自己的选项，遇到第一个不认识的参数后把其余参数原样交给被启动的应用（`--port`、`--no-open` 等）。因此只要存在 overlay 文件，外壳使用：

```
dsh --profile web --patch <overlay-1.patch.yml> [--patch <overlay-2.patch.yml> …] --port <port> --no-open
```

没有 overlay 文件时保持：

```
dsh web --port <port> --no-open
```

`--patch` 必须位于应用参数之前；写成 `dsh web --port … --patch …` 会由 web 应用解析并报 `unknown option '--patch'`。

## 安装脚本的写法

插件包本身声明普通依赖即可（不声明 `dsh.bundle.patch`），安装脚本按 profile 分流：

```js
import { installPlugin, shellOverlayPatchPath } from '../../scripts/plugin-install.mjs'

const profile = (process.env.DSH_PLUGIN_PROFILE ?? 'web').trim() || 'web'
const options = { id: 'my-plugin', packageDir }

if (profile === 'desktop') installPlugin(options)
else installPlugin({ ...options, mountFile: shellOverlayPatchPath('my-plugin') })
```

`installPlugin` 的 `mountFile` 会把挂载行写入该文件（幂等，已有同 id 行时保留），并让「已安装且已挂载」的快速路径按同一文件判断状态。声明了 `dsh.bundle.patch` 的包不能用 `mountFile`：它通过自己的 bundle 层挂载。

## 现状

`plugins/quick-assistant` 是当前唯一的 shell overlay 使用者：它在 `web` profile 只安装依赖，挂载行写入 `shell-overlays/quick-assistant.patch.yml`；Electron 桌面（`desktop` profile）则正常挂载。
