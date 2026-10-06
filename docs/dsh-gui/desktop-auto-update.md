# Desktop 端的自动更新插件（dsh-auto-update）

## 用途与边界

`dsh-auto-update` 把外壳（Tauri）原有的「检查更新 / 更新 / 更新日志 / AI 更新」搬到 desktop 应用内：host 半以 Node 直接调 git 检测 dsh-gui 仓库本体与每个 submodule 相对远端默认分支的落后情况，client 半在标题栏画入口按钮与对话框，并可就地执行 git 更新。

它只装在 desktop profile（`plugins/auto-update/install.mjs` 在 `DSH_PLUGIN_PROFILE !== 'desktop'` 时只打印 skip 并退出 0），web profile 的组合与外壳的更新对话框都不受影响；两套更新 UI 在此期间并存，外壳侧的行为见 [update-check.md](update-check.md) 与 [update-changelog.md](update-changelog.md)。

本版范围冻结为「检测 + 对话框 + 就地更新」：更新只完成 git 层，不做分离式更新器、自动重启、npm 发布状态核对、待更新计划文件与更新日志的 AI 摘要。

## 入口位置

入口是标题栏**最右侧、窗口按键之前**的一个按钮（文案「更新」，`title`/`aria-label` 为「检查更新」），不是官方「应用」菜单旁的注入点——该菜单由 desktop preload 创建，插件没有注入位置（结论见 [2026-10-05-desktop-auto-update.md](2026-10-05-desktop-auto-update.md) 的「两个硬约束」）。

定位方式是 `position: fixed; top: 0; height: var(--dsh-windows-titlebar-height, 40px); right: var(--dsh-auto-update-controls-width, 138px)`，并设 `-webkit-app-region: no-drag`；右侧预留宽度默认 138px，可通过该 CSS 变量覆盖，插件不在 `:root` 声明它、样式足迹只落在自己的 `[data-dsh-auto-update-*]` 选择器上，Windows 实测不覆盖最小化/最大化/关闭三个按键。

`z-index` 取 2147483001，与 desktop-tabs 标签条同层、低于外壳强制提示层 2147483647；`notifyCount > 0` 时按钮上显示一个小圆点角标，角标在挂载时做一次后台检测填充（不轮询，失败时入口仍可用，原因在打开对话框时显示）。

client 半只在 `window.dshDesktop?.protocolVersion === 1` 存在时挂载，`dsh web` 页面保持完全惰性；所有 DOM 与 `<style>` 由 effect disposer 回收，重复挂载先清理旧实例。

## 对话框

点击入口打开模态浮层（半透明遮罩 + 居中卡片），Esc 与遮罩点击关闭，关闭后入口恢复可点；打开时先用 `?mode=local` 画骨架行，再 `?mode=check` 拉完整结果，避免首屏空白。

卡片内容对齐外壳的 `renderUpdateDialog`：头部是标题「自动更新」、上次检查时间与耗时、「检查更新」按钮与关闭「✕」；行内展示模块名（有 `releaseUrl` 时为外链，指向 GitHub Releases 列表页）、`当前 → 最新`、tag/commit 目标选择（`latestTagStale` 时 tag 项禁用并回退最新提交）、状态与错误，以及行内「更新」「更新日志」「AI 更新」；顶部提供「全部更新」与「AI 更新全部」。

「更新」逐行追加 host 的 NDJSON 日志到卡片内的日志区，结束时刷新状态，全过程禁用重复提交；所有网络失败（路由 404/500、断网）在对话框内以可读文案呈现，不抛未捕获异常。

对话框内常驻一条警示：`更新以 git reset --hard 检出目标版本：所选工程中未提交的改动会被丢弃（未跟踪文件保留）。`，它位于可滚动行区之外、构建提示之上，始终可见；行内「更新」与顶部「全部更新」的 tooltip 也带同一提示。

## Host 路由

路由前缀 `/auto-update`，用 `ctx.webServer.register({ kind: 'exact', ... })` 逐条注册，`apply` 的 `inject` 为 `['webServer']`；与 desktop-tabs 相同的两道门：`ctx.webServer.host !== '127.0.0.1'` 时拒绝启动并写日志，每条路由做 same-origin 校验（`sec-fetch-site: cross-site` 拒绝；无 `origin` 放行；有 `origin` 时 host 必须等于 `host` 头）。

响应一律 `cache-control: no-store`，请求体上限 256 KiB（超出返回 413），方法不符返回 405。

### `GET /auto-update/api/status`

查询参数 `mode=local|check`，默认 `check`；`mode=local` 只读本地信息、不发网络请求（每行 `checking: true`、`latest` 为「检查中…」、`checkedAt: null`），`mode=check` 对顶层与每个子模块执行 `git fetch --prune origin` 后比较远端默认分支。

200 响应的行字段（camelCase，`undefined`/`null` 省略）：`id`（顶层固定 `dsh-gui`，子模块用 `.gitmodules` 的 name）、`name`（子包 `package.json` name，缺失回退 `id`）、`path`（相对仓库根的 POSIX 路径，顶层为空串）、`current`（精确 tag，否则 short sha，不可读时 `unknown`）、`latest`（远端默认分支上的版本；local 模式为「检查中…」，无法检查的行为 `—`）、`latestTag`、`latestTagStale`（tag 不严格新于本地 HEAD）、`announce`（计入角标；tag 上无更新 tag 的仅提交更新为 false）、`behind`、`checking`、`error`、`releaseUrl`（GitHub Releases 列表页）。

顶层字段：`projects`、`hasUpdates`、`updateCount`（behind 的行数）、`notifyCount`（behind && announce 的行数）、`allChecked`（任一行有 error 即 false）、`checkedAt`（unix 秒，local 模式为 null）、`durationMs`、`root`、`buildCommand`（`npm run build:desktop`，对话框底部文案取自它）。

### `POST /auto-update/api/update`

请求体 `{ "targets": [{ "id": "dsh-gui", "mode": "tag" | "commit" }] }`；响应 `200`、`content-type: application/x-ndjson`，逐行 JSON：`begin` → 若干 `log` → 每目标一条 `target`（`ok` 与 `detail`/`error`）→ `end`（`ok` 为所有行是否全部成功，附 `buildCommand`）。

单行失败只写 `{"type":"target","id":…,"ok":false,"error":"…"}` 并继续下一行；请求体非法 400、无可用目标 409、无法解析仓库根 500，这三类在开始流式输出之前返回 JSON 错误 `{ "error": string }`。

### `GET /auto-update/api/changelog`

查询参数 `id=<projectId>` 与 `mode=<tag|commit>`（`mode` 缺省为 `commit`）；200 响应含 `id`、`name`、`from`（本地当前版本）、`to`（更新目标版本）、`target`（tag 名或 `origin/<branch>`）、`targetKind`、可选的 `release`（`tag`/`name`/`url`/`body`）、`commits`（`sha`/`subject`/`author`/`date`）、`truncated` 与 `error`（仅用于本地 git 失败；此时 `from`/`to`/`target` 与 `release` 一并省略）。

提交列表来自 `git log --no-merges --date=short --pretty=%h%x09%s%x09%an%x09%ad from..to`，上限 400 条、单条 subject 200 字符；无可用更新（远端与本地相同、或该行有 error）时返回 200 且 `commits: []`，由 client 显示「无可展示的更新日志」。

## 更新执行范围

顶层 `dsh-gui` 行：`git fetch --prune origin` → `reset --hard` 到目标（`mode=tag` 取 `origin/<默认分支>` 上最新 tag，`mode=commit` 取 `origin/<默认分支>`）→ `git submodule update --init --recursive`。

子模块行：只在该子模块目录内 `git fetch --prune origin` + `reset --hard`（同样两种 mode），不做递归同步。

顶层行执行前先做与检测相同的子模块远端自愈（`.gitmodules` 是权威；只改写本地路径形式的远端覆盖项，远端形式保持不动，细节见 [update-check.md](update-check.md) 的「子模块远端的路径自愈」）；检测（`mode=check`）每次都做同样的自愈。实现绝不执行 `git clean`，绝不触碰目标以外的仓库，绝不改动工作区以外路径。

## 更新后的流程

更新只完成 git 层：desktop 应用是运行时根下已解包好的产物，代码更新后必须重新构建才会生效。对话框底部按 host 返回的 `buildCommand` 提示——关闭 Desktop 实例后手动执行 `npm run build:desktop`（构建链的插件安装与 shim 落位都要求实例已退出），再重新启动应用；`buildCommand` 缺失时降级为「更新只完成 git 层：完成后需要按仓库说明重新构建 Desktop 应用并重启，改动才会生效」。

`npm run desktop` 启动应用时注入的 `DSH_GUI_ROOT`（见下节）只影响插件解析仓库根，不改变构建流程；`npm run build:desktop` 的步骤与旗标见 [desktop-app.md](desktop-app.md)。

## 仓库根解析

host 半的 `resolveGuiRoot()` 依次尝试，第一个通过校验的获胜：`DSH_GUI_ROOT`（非空且目录存在）→ `dirname(DSH_HOME)` 下的 `dsh-gui/`（嵌套布局约定，需含 `.git`）→ `dirname(DSH_HOME)` 自身（单目录布局，需含 `.git`）；全部失败即抛错，路由返回 500 且消息提示设置 `DSH_GUI_ROOT`。

`DSH_HOME` 取 `process.env.DSH_HOME`，未设置时用 harness 惯例（`<runtime-root>/.dsh`），不猜运行时根以外的位置。

`scripts/desktop.mjs` 的 `runDesktop()` 在启动应用时注入 `DSH_HOME` 与 `DSH_GUI_ROOT: ROOT`，使第一条在真实启动下始终命中；这与外壳给后端注入 `DSH_GUI_ROOT` 的做法一致（见 [nested-clone-layout.md](nested-clone-layout.md) 的「两个根」）。

子模块清单来自仓库根 `.gitmodules`，id 用 submodule name，path 用相对仓库根的 POSIX 路径；顶层行 id 固定 `dsh-gui`。

## 更新日志

每行只要落后于远端就有「更新日志」按钮，打开弹窗：`targetKind=tag`、origin 解析为 GitHub `owner/repo` 且取到说明时，优先渲染该 Release 的标题与正文（`https://api.github.com/repos/<owner>/<repo>/releases/tags/<tag>`，匿名、45s 超时、`Accept: application/vnd.github+json`），标题旁的链接指向该 tag 的 `/releases/tag/<tag>` 子页面；取不到只回退到提交列表，不算错误。无可用更新或该行有 error 时弹窗显示「无可展示的更新日志」，行内模块名链接仍是仓库的 Releases 列表页。

首版不做 AI 摘要。后续可选增强是复用已装在 desktop profile 的 `dsh-ai-update` 的 `/dsh-gui-api/changelog` 路由（运行中 harness 的 raw-LLM 通道），让没有 Release 说明的区间由 AI 汇总，语义对齐外壳侧的 changelog 路径。

host 半另有一个测试钩子：环境变量 `DSH_AUTO_UPDATE_GITHUB_API_BASE` 覆盖 GitHub API 基址（默认 `https://api.github.com`），供 fixture 测试在无网络时覆盖 Release 回退路径。

## AI 更新

「AI 更新」与「AI 更新全部」不重写会话创建：client 半在顶层 `window` 派发 `{ type: 'dsh-gui:ai-update', version: 1, requestId, prompt }`（`window.postMessage(message, '*')`；desktop 页 `window.parent === window`，`dsh-ai-update` 的 `event.source !== window.parent` 校验自然通过），并监听 `dsh-gui:ai-update-result`（`version: 1`、`requestId` 匹配）作为回执，60s 无回执按超时处理并 toast。

可发起 AI 更新的行与外壳的资格规则一致：顶层 `dsh-gui` 行不进入 AI 流程（行内按钮灰显，批量时也被过滤，顶层只走就地 git 更新）；当前正好停留在某个 tag、而远端只有更新的提交没有更新的 tag（`behind && announce === false`）的行同样灰显，提示改用「更新」。批量入口因此只包含子模块行。

目标工作区选择与「创造模式」预设由 `dsh-ai-update` 承担（该插件已在 desktop profile 中，见 [update-check.md](update-check.md) 的「AI 更新的提示词与预设」）；提示词由 client 半的 `ai-prompt.ts` 生成，语义对齐 `src-tauri/ui/app.js` 的 `buildAiUpdatePrompt` 与两个基座构造器，`/dsh-gui-update` skill 手势与验收门槛（先在 `.staging/dsh-gui` 副本验证；含 harness 时用 computer use 验证 GUI；报告并取得用户审批后再实装）保留，构建命令统一写成 `npm run build:desktop`。

## 明确不做的项

- 分离式更新器与自动重启：不生成独立更新器脚本、不等应用退出后自动执行；更新由用户在对话框内就地触发。
- `npm run build:desktop` 的自动执行：git 更新后由用户手动关闭应用并构建。
- npm 发布状态核对：不查询 `registry.npmjs.org`，不标注 tag 的 npm 对应版本是否已发布（外壳侧仍有该能力）。
- 待更新计划文件：不写 `pending-updates.json`。
- 更新日志的 AI 摘要：首版不做，预留复用 `dsh-ai-update` 的 `/dsh-gui-api/changelog`。
- 修改官方代码：插件只用官方 slot/service 组合，不改 `deepseek-harness` 子模块。

## 已知限制

- 只装在 desktop profile；普通 `dsh web` 页面与 Tauri 外壳都不加载该插件，更新入口仍是外壳自己的对话框。
- 更新执行是 `reset --hard` 语义：所选工程未提交的改动会被丢弃（未跟踪文件保留），对话框不提供二次确认或暂存，仅以常驻警示与「更新」/「全部更新」的 tooltip 提示。
- 更新只完成 git 层；不 build 就直接重启应用仍是旧代码。
- 仓库根解析失败时三条路由都返回 500，对话框只能给出「设置 `DSH_GUI_ROOT`」的可读错误。
- 子模块远端自愈只改写本地路径形式的覆盖项，远端形式的覆盖（镜像、fork）保持原样，这类配置下检测可能失败。
- 更新日志的 Release 只取目标那一个 tag 的说明，不覆盖本次更新引入的全部 Release（外壳侧的多 Release 汇总见 [update-changelog.md](update-changelog.md)）。

## 相关文件

- `plugins/auto-update/install.mjs` —— desktop-only 安装 wrapper，其他 profile 只 skip
- `plugins/auto-update/dsh-auto-update/README.md` —— 插件自身的用途、组成、构建与不做项
- `plugins/auto-update/dsh-auto-update/package.json`、`cordis.patch.yml` —— bundle 声明与 `id: auto-update` 插入行
- `plugins/auto-update/dsh-auto-update/src/index.ts` —— 路由注册与两道门
- `plugins/auto-update/dsh-auto-update/src/paths.ts` —— 仓库根与 `DSH_HOME` 解析
- `plugins/auto-update/dsh-auto-update/src/git.ts` —— git 调用与错误摘要
- `plugins/auto-update/dsh-auto-update/src/check.ts` —— `mode=local|check` 检测与行状态
- `plugins/auto-update/dsh-auto-update/src/update.ts` —— 就地更新与 NDJSON 流
- `plugins/auto-update/dsh-auto-update/src/changelog.ts` —— 提交列表与 Release 说明
- `plugins/auto-update/dsh-auto-update/src/client/**` —— 入口按钮、对话框、更新日志弹窗、AI 更新派发
- `scripts/desktop.mjs` —— `runDesktop()` 注入 `DSH_GUI_ROOT`
- `docs/dsh-gui/desktop-app.md` —— desktop 构建与插件安装
- `docs/dsh-gui/nested-clone-layout.md` —— 仓库根与运行时根两个契约
