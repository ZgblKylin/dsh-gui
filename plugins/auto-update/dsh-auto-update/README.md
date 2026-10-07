# dsh-auto-update

desktop 外壳的「自动更新」插件：在标题栏最右侧提供一个「更新」入口与对话框，检测
dsh-gui 检出及其 submodule 的上游变动（tag / 提交），在对话框内就地执行 git 更新并
流式回显日志，并展示本次更新的更新日志。

本插件**只安装到 desktop profile**：`plugins/auto-update/install.mjs` 在
`DSH_PLUGIN_PROFILE !== 'desktop'` 时只打印 skip 并退出 0，普通 `web` profile 的组合
保持不变。迁移范围见 [docs/dsh-gui/desktop-auto-update.md](../../../docs/dsh-gui/desktop-auto-update.md)，
方案背景见 [docs/dsh-gui/2026-10-05-desktop-auto-update.md](../../../docs/dsh-gui/2026-10-05-desktop-auto-update.md)。

## 组成

| 产物 | 平台 | 职责 |
|---|---|---|
| `lib/index.js` | Node（Host 进程） | `/auto-update/api/*` 三条路由：检测、就地更新、更新日志 |
| `lib/client.js` | 浏览器 | 标题栏入口按钮、对话框、更新日志弹窗、AI 更新派发 |

Host 半只依赖注入的 `webServer`（`inject = ['webServer']`），不 import 任何 dsh-gui /
外壳代码，只用 `node:*` 内置模块。所有注册都走 `ctx.effect()`，插件卸载时路由一并
注销。

## 路由

前缀 `/auto-update`，三条 `kind: 'exact'` 路由。与 `dsh-desktop-tabs` 相同的两道门：

- web server 绑定不是 `127.0.0.1` 时拒绝启动并写日志；
- 每条路由做 same-origin 校验（`sec-fetch-site: cross-site` 拒绝；无 `origin` 放行；
  有 `origin` 时其 host 必须等于 `host` 头）。

响应一律 `cache-control: no-store`；请求体上限 256 KiB。

### `GET /auto-update/api/status?mode=local|check|cached`

- `mode=local`（默认 `check`）：只读本地信息，不发网络请求；每行 `checking: true`、
  `latest: "检查中…"`、`checkedAt: null`；既不读也不写检测缓存。
- `mode=check`：先按 `.gitmodules` 自愈子模块远端，然后在顶层执行**一次**
  `git fetch --prune --recurse-submodules origin`；之后每一行只用本地命令比较
  （远端默认分支仍先查 `git ls-remote --symref origin HEAD`，失败才回退本地 symref）。
  递归 fetch 非零退出不算整体失败：仅对本地仍缺少 `origin/<默认分支>` ref 的行退化为
  该行单独 `git fetch --prune origin`，该次失败即该行的 `error`。每行给出
  `behind` / `latestTag` / `latestTagStale` / `announce` 与（满足条件时的）`npm` 状态；
  聚合返回 `hasUpdates`、`updateCount`、`notifyCount`、`allChecked`、`checkedAt`、
  `durationMs`、`root`、`buildCommand`。完成的 status 存入模块级缓存。
- `mode=cached`：有缓存返回 `200` + 该 status，无缓存返回 `204`（无 body）；不触碰 git。

`announce` 语义与外壳一致：检出正好落在某个 tag 上、远端只多了没有新 tag 的提交时，
更新仍然显示在对话框里，但不计入角标。

每行的 `npm` 字段仅在「该行 `behind`、`latestTag` 不是陈旧 tag、且该工程的 npm 包集合
非空」时出现，用于提示 tag 版本尚未发布到 npm：`packages` 取 `<DSH_HOME>/gui/npm-installs.json`
与该工程清单名（根 `package.json` + `apps/**` + `packages/**`，跳过
`node_modules`/`.git`/`target`/`dist` 与点目录）的交集，`latest` 取 registry 的
`dist-tags.latest`，`missing` 为 `versions` 中缺少目标版本（tag 去掉前缀 `v`）的包，
`complete` 表示全部命中且无请求失败。registry 请求并发，请求头
`accept: application/vnd.npm.install-v1+json`、`user-agent: dsh-gui-update-check`，
单请求 15s 超时。任何失败只写进 `npm.error`（网络错误原文或 `HTTP <status>`），
不影响该行的 git 检测结果。

### `POST /auto-update/api/update`

请求体 `{ "targets": [{ "id": "dsh-gui", "mode": "tag" | "commit" }] }`，响应为
`application/x-ndjson` 流，逐行事件：

```
{"type":"begin","targets":["dsh-gui"]}
{"type":"log","id":"dsh-gui","line":"fetch origin（顶层工程）"}
{"type":"target","id":"dsh-gui","ok":true,"detail":"已更新到 v1.3.0"}
{"type":"end","ok":true,"buildCommand":"npm run build:desktop"}
```

- 顶层行：`git fetch` → `reset --hard` 到目标（`tag` 取 `origin/<默认分支>` 上最新 tag，
  `commit` 取 `origin/<默认分支>`）→ `git submodule update --init --recursive`。
- submodule 行：只在该目录内 `git fetch` + `reset --hard`，不做递归同步。
- 执行前先做与检测相同的子模块远端自愈：以 `.gitmodules` 为权威，只改写**本地路径形式**
  的远端覆盖项（superproject 的 `submodule.<name>.url` 与 submodule 自身的
  `origin`），远端形式的覆盖（镜像、fork）保持不动。
- 单行失败只写一行 `{"type":"target","id":…,"ok":false,"error":"…"}` 并继续；`end.ok`
  为是否全部成功。
- 绝不执行 `git clean`；除顶层检出与 `.gitmodules` 声明的 submodule 目录外不触碰任何
  路径。请求体非法 → 400，无可用目标 → 409，无法解析仓库根 → 500（这三种都在开始
  流式输出之前返回 JSON `{ "error": … }`）。

### `GET /auto-update/api/changelog?id=<projectId>&mode=tag|commit`

返回本地当前版本、更新目标、目标类型、提交列表（`git log --no-merges`，上限 400 条、
单条 subject 上限 200 字符、`truncated` 标记）、`count`（`git rev-list --count <from>..<to>`，
含 merge 提交且不受 400 条上限约束，无可用更新时为 0）、`diffstat`
（`git diff --stat`，上限 3000 字符，超出截断并附 `…（已截断）`，无可用更新时为空串），
以及——仅当 `mode=tag` 且 `origin` 为 GitHub 时可取到说明时的 `release`
（tag / name / url / body）。

`mode=tag` 但 GitHub 取不到 Release 时**只回退提交列表，不算错误**；`error` 只用于本地
git 失败。远端与本地相同（无可展示更新）时返回 200 且 `commits: []`、`count: 0`、
`diffstat: ""`。

## 仓库根解析

Host 进程运行在解包的 desktop 应用里，检出不等于 `process.cwd()`。`resolveGuiRoot()`
依次尝试，取第一个通过校验者：

1. `DSH_GUI_ROOT`（`scripts/desktop.mjs` 注入；只要求目录存在）；
2. `dirname(DSH_HOME)/dsh-gui`（嵌套布局，需含 `.git`）；
3. `dirname(DSH_HOME)`（单目录布局，需含 `.git`）。

全部失败时抛错，路由返回 500 且提示设置 `DSH_GUI_ROOT`。`DSH_HOME` 只取
`process.env.DSH_HOME`，不做其他猜测。

## Client 行为（摘要）

- 仅当 `window.dshDesktop?.protocolVersion === 1` 时挂载；`dsh web` 页面保持惰性。
- 入口按钮：`position: fixed`，落在标题栏带内、窗口按键之前，`notifyCount > 0` 时显示
  角标。
- 对话框：客户端缓存存在时立即渲染；否则先问 `?mode=cached`，有结果即渲染；都没有才
  `?mode=local` 画骨架、再 `?mode=check` 拉完整结果（`hasUpdates === false` 时后台静默
  重查）。「检查更新」始终执行 `mode=check`。每行提供「更新 / 更新日志 / AI 更新」，
  顶部提供「全部更新 / AI 更新全部」，底部提示更新只完成 git 层，完成后需手动执行
  `buildCommand` 并重启 Desktop 应用。
- 更新日志：`mode=tag` 取到 GitHub Release 时直接渲染 `release.body`；否则把 `commits`
  与 `diffstat` 交给 `dsh-ai-update` 的 `/dsh-gui-api/changelog` 汇总，副标题用 `count`
  计提交数；AI 路由不可用时回退提交列表。
- 「AI 更新」复用已装在 desktop profile 的 `dsh-ai-update`：在顶层 `window` 派发
  `{ type: 'dsh-gui:ai-update', version: 1, requestId, prompt }` 并等待
  `dsh-gui:ai-update-result` 回执（60s 超时）。

## 本版不做

分离式更新器与自动重启、`pending-updates.json` 计划文件。npm 发布状态与更新日志的
AI 摘要由 host 的 `npm` 字段与 `diffstat`/`count` 支撑，汇总请求由 client 半发起。
更新完成后由用户在关闭 Desktop 实例后手动执行 `npm run build:desktop`。

## 配置与测试钩子

无用户可见配置项。两个测试用环境变量：`DSH_AUTO_UPDATE_GITHUB_API_BASE` 覆盖 GitHub API
基址（默认 `https://api.github.com`），`DSH_AUTO_UPDATE_NPM_REGISTRY_BASE` 覆盖 npm
registry 基址（默认 `https://registry.npmjs.org`）；两者都供 fixture 测试在不依赖外网的
情况下覆盖 Release 与 npm 的请求路径。

## 构建

```
pnpm install --store-dir <runtime-root>/.pnpm-store
pnpm run build      # tsdown → lib/index.js（ESM）+ lib/client.js（CJS closure）
pnpm run watch
```
