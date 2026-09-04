# 更新检查（update check）与 npm 发布状态

## 功能

dsh-gui 的「检查更新」把 dsh-gui 仓库本体与每个 git submodule 同远端默认分支
比较：行内显示「当前 → 最新」、最新 tag 与提交数，并提供「更新」/「AI 更新」。
对 **npm 安装型** wrapper（`installNpmPlugin`，例如 `dsh-web-ui`、`better-sidebar`、
`plugin-market`），仓库新 tag 可能只是源码发布，上游 npm 尚未发布对应版本——
直接移动 submodule checkout 不会同步已安装的插件本体。

## AI 更新的 tag 保留规则

「AI 更新全部」与行内「AI 更新」不会把 **tag 版本更新到非 tag 提交**：若某个
模块（含顶层仓库）当前正好检出于某个 tag、而远端默认分支只有更新的提交、没有
更新的 tag（即 `announce = false` 的“仅提交更新”情形），该行不会进入
「AI 更新全部」，其行内「AI 更新」按钮置灰禁用（不建议执行）。如确需跟进这类
模块，请用行内的「更新」流程（确认后「重启并更新」）。

实现：`src-tauri/ui/app.js` 的 `isOnTagWithoutNewer`（复用 Rust 端
`announce` 字段）过滤 `updatableProjects`（AI 资格），并在 `renderUpdateDialog`
无可更新行时隐藏「AI 更新全部」；生成的 AI 提示词也加入“跳过在 tag 上且无更新
tag 的模块”的复核指令。

## AI 更新的自动预设

「AI 更新」/「AI 更新全部」启动后，dsh-ai-update 浏览器半（
`plugins/ai-update/dsh-ai-update/src/client/index.ts`）在落地空白会话上自动
调用 `ctx.remote.agentPresets.select(sessionId, 'cordis')` 选中 **「创造模式」**
（harness 内置 `cordis` preset，提供运行时检查、插件实验与 preset 创作指导），
再预填升级提示词；选择被拒绝时请求失败返回错误，而不是静默落到默认预设。用户
发送前仍可自行切换预设 chip。

## 检测与标注

- **安装记录**：共享流水线 `scripts/plugin-install.mjs` 的 `installNpmPlugin`
  把每个 npm 包名（含 wrapper 通过 `skip` 选项默认跳过的包，如
  `dsh-pet`）追加写入
  `.dsh/gui/npm-installs.json`（运行时缓存、gitignored）。
- **归属判定**：`src-tauri/src/update.rs` 扫描每个 submodule 的 `package.json`
  （根 manifest + `packages/**`），与上述 registry 求交集，得到该行所属的 npm
  包集合。
- **npm 发布状态**：当远端有更新的 tag（`latestTag` 可用）时，对每个 npm 包
  查询 `registry.npmjs.org`（经 node 临时脚本 fetch，沿用更新检查的
  文件重定向 stdio 模式），产出 `NpmUpdateInfo`：每个包当前发布的最新版本
  （`latest`）、尚未发布 tag 版本的包（`missing`）、是否全部已发布
  （`complete`）与网络错误（`error`）。
- **标注**：`src-tauri/ui/app.js` 在该行的「当前 → 最新」对比下方渲染警告：
  tag 的 npm 对应版本未发布、npm 当前最新版本、以及「本行更新只移动源码
  checkout，已安装插件需等 npm 发布后重新执行插件安装」。npm 核对失败只显示
  提示，不影响 git 更新检测结果。

## 生效路径

1. 上游发布新 tag 后，更新对话框先显示「tag 版本 npm 未发布」标注；
2. 上游恢复 npm 发布（例如 `dsh-web` 的 `NPM_PUBLISH_ENABLED`）后，
   `complete` 变为 true，标注消失；
3. 此时（以及需要解除某个 wrapper 自己的 `skip` 屏蔽时）重跑对应安装：
   `node plugins/<id>/install.mjs` 或 `npm run install:plugins`；首次安装后
   更新检查才能确认 npm 版本，因此新克隆环境建议先执行一次插件安装。

## 相关文件

- `scripts/plugin-install.mjs` —— 安装期记录 npm 包名
- `src-tauri/src/update.rs` —— registry 读取、submodule 扫描、npm 查询
- `src-tauri/ui/app.js`、`src-tauri/ui/titlebar.css` —— 行内标注渲染
