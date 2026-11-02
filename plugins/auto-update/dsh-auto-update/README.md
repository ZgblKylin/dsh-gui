# dsh-auto-update

desktop 外壳的「自动更新」插件：在标题栏最右侧提供一个「更新」入口与对话框，检测两类行——
dsh-gui 检出与其非插件 submodule 的上游变动（tag / 提交），以及 `plugins/` 安装脚本中每个
npm 插件的精确 pin 与 registry 最新版本。对话框内就地执行更新（git 行检出目标 revision；
npm 行改写安装脚本的 pin 并重新安装该插件）并流式回显日志，git 行另可查看更新日志。

本插件**只安装到 desktop profile**：`plugins/auto-update/install.mjs` 在
`DSH_PLUGIN_PROFILE !== 'desktop'` 时只打印 skip 并退出 0，普通 `web` profile 的组合
保持不变。当前态与路由契约见 [docs/dsh-gui/desktop-auto-update.md](../../../docs/dsh-gui/desktop-auto-update.md)，
迁移范围见 [docs/dsh-gui/2026-10-05-desktop-auto-update.md](../../../docs/dsh-gui/2026-10-05-desktop-auto-update.md)。

## 组成

| 产物 | 平台 | 职责 |
|---|---|---|
| `lib/index.js` | Node（Host 进程） | `/auto-update/api/*` 三条路由：检测（git 行 + npm 插件行）、就地更新、更新日志 |
| `lib/client.js` | 浏览器 | 标题栏入口按钮、两类行的对话框、更新日志弹窗、AI 更新派发 |

Host 半只依赖注入的 `webServer`（`inject = ['webServer']`），不 import 任何 dsh-gui /
外壳代码，只用 `node:*` 内置模块。所有注册都走 `ctx.effect()`，插件卸载时路由一并
注销。

## 行来源

- **git 行**：仓库根，以及 `.gitmodules` 中路径不以 `plugins/` 开头的子模块（当前为
  `deepseek-harness` 与 `src-tauri/whale-icon`）。行 id 为子模块 name，根行固定
  `dsh-gui`。
- **npm 行**：扫描 `plugins/**/*.mjs`，只处理调用了 `installNpmPlugin(` 的安装脚本。
  脚本先剥离注释，再提取形如 `<包名>@<三段版本>` 的字符串字面量；每个包一行，行 id 为
  `npm:<packageName>`，`current` 为脚本中的精确 pin，`latest` 为 registry 最新版本。
  `@deepseek-ai/dsh*` 官方包不产生行（随 deepseek-harness 行整体升级）；脚本里构造不出
  字面量 spec 的 wrapper 也不产生行（写法约定见 `plugins/README.md`）。
- 行顺序：git 行在前（根行最前），npm 行按安装脚本路径、包名排序。

## 路由

前缀 `/auto-update`，三条 `kind: 'exact'` 路由。与 `dsh-desktop-tabs` 相同的两道门：

- web server 绑定不是 `127.0.0.1` 时拒绝启动并写日志；
- 每条路由做 same-origin 校验（`sec-fetch-site: cross-site` 拒绝；无 `origin` 放行；
  有 `origin` 时其 host 必须等于 `host` 头）。

响应一律 `cache-control: no-store`；请求体上限 256 KiB。

### `GET /auto-update/api/status?mode=local|check|cached`

- `mode=local`（默认 `check`）：只读本地信息，不发网络请求。git 行沿用原占位；
  npm 行给出 `current`（脚本 pin）、`latest: "检查中…"`、`checking: true`、`behind: false`。
  既不读也不写检测缓存。
- `mode=check`：先按 `.gitmodules` 自愈子模块远端，然后在顶层执行**一次**
  `git fetch --prune --recurse-submodules -j 8 origin`；该 git 不认 `-j` 时去掉它重试一次。
  递归 fetch 与每一行的远端默认分支解析同时发起（`ls-remote --symref origin HEAD`，
  失败才回退本地 symref），随后逐行只用本地命令比较 git 行。npm 插件行的探测与 git
  工作重叠启动：解析安装脚本得到 pin，再对每个包请求 registry。
  每行给出 `kind`（npm 行）、`behind` 与 `announce`；git 行另有
  `latestTag` / `latestTagStale`，npm 行另有 `packageName` / `installScript` 与
  （可解析时的）`releaseUrl`。聚合返回 `hasUpdates`、`updateCount`、`notifyCount`、
  `allChecked`、`checkedAt`、`durationMs`、`root`、`buildCommand`。完成的 status 存入
  模块级缓存。
- `mode=cached`：有缓存返回 `200` + 该 status，无缓存返回 `204`（无 body）；不触碰 git。

`mode=check` 单飞：并发到达的检查共享同一次运行与同一份结果，运行结束即释放；
`mode=local` 与 `mode=cached` 不参与单飞、不被阻塞。

`announce` 语义：git 行沿用外壳规则——检出正好落在某个 tag 上、远端只多了没有新 tag 的
提交时，更新仍显示在对话框里但不计入角标；npm 行 `announce` 与 `behind` 相同。

registry 请求为 `<registry>/<name>/latest`（`accept: application/json`，该端点不接受
abbreviated 类型，且完整响应同时给出 `version` 与 `repository`）。跨包最多 8 个探测并发，
首个（且仅首个）探测先单独发起；首个**传输层**失败（连接/超时/DNS）立即熔断，其余未完成
的探测复用同一错误文案，非 2xx 与不可解析 body 不熔断。该阶段整体预算 10s。npm 行的失败
只写该行 `error`（`latest: "—"`、`behind: false`），不影响 git 行，也不改变 `allChecked`
（它只反映 git 行完整性）。

git 行的 `npm` 字段保持原语义：仅当「该行 `behind`、`latestTag` 不是陈旧 tag、且该工程的
npm 包集合非空」时出现，用于提示 tag 版本尚未发布到 npm。`packages` 取
`<DSH_HOME>/gui/npm-installs.json` 与该工程清单名（根 `package.json` + `apps/**` +
`packages/**`，跳过 `node_modules`/`.git`/`target`/`dist` 与点目录）的交集，`latest` 取
registry 的 `dist-tags.latest`，`missing` 为 `versions` 中缺少目标版本的包，`complete`
表示全部命中且无请求失败。请求头 `accept: application/vnd.npm.install-v1+json`、
`user-agent: dsh-gui-update-check`，单请求 15s 超时。

### `POST /auto-update/api/update`

请求体 `{ "targets": [{ "id": "dsh-gui", "mode": "tag" | "commit" }] }`，响应为
`application/x-ndjson` 流，逐行事件：

```
{"type":"begin","targets":["dsh-gui"]}
{"type":"log","id":"dsh-gui","line":"fetch origin（顶层工程）"}
{"type":"target","id":"dsh-gui","ok":true,"detail":"已更新到 v1.3.0"}
{"type":"end","ok":true,"buildCommand":"npm run build:desktop"}
```

- git 行：顶层行 `git fetch` → `reset --hard` 到目标（`tag` 取 `origin/<默认分支>` 上最新
  tag，`commit` 取 `origin/<默认分支>`）→ `git submodule update --init --recursive`；
  submodule 行只在该目录内 `git fetch` + `reset --hard`，不做递归同步。执行前按
  `.gitmodules` 自愈子模块远端（只改写本地路径形式的远端覆盖项）。
- npm 行：`mode` 无意义（client 固定传 `commit`）。同一安装脚本的多行合并为一个执行单元：
  - 重新扫描安装脚本，确认每行仍在（包消失或脚本变化 → 该行单独失败，提示重新打开对话框）；
  - 对组内每行查 registry 最新版：失败只标记该行；已是最新的行单独返回「已是最新」；
  - 一次性把组内要更新的 pin 改写为新 spec（读一次原文作备份，任一 pin 无法替换则整组
    不写盘），只 spawn 一次安装脚本（`node <script>`，cwd 为仓库根，环境继承
    `DSH_HOME`，并设 `DSH_PLUGIN_PROFILE=<当前 profile>` 与 `DSH_PLUGIN_MIN_AGE=0`）；
  - 成功 → 组内每个已更新行各自 `target ok`；脚本失败或超时（10 分钟）→ 写回备份，
    组内这些行各自返回同一失败原因。
- 事件契约：`begin` 按请求顺序列出全部 id，之后每个 id 恰好一条 `target`，最后 `end`；
  `end.ok` 为是否全部成功。执行单元按首个 target 在请求中的位置排序，同一脚本的 target
  事件在组完成后按组内请求顺序相邻发出。
- 单行失败不中止整次运行；绝不执行 `git clean`。npm 行只写目标安装脚本这一个文件；git 行
  只触碰顶层检出与 `.gitmodules` 声明的 submodule 目录。请求体非法 → 400，无可用目标 →
  409，无法解析仓库根 → 500（这三种都在开始流式输出之前返回 JSON `{ "error": … }`）。

### `GET /auto-update/api/changelog?id=<projectId>&mode=tag|commit`

仅 git 行使用。返回本地当前版本、更新目标、目标类型、提交列表（`git log --no-merges`，
上限 400 条、单条 subject 上限 200 字符、`truncated` 标记）、`count`
（`git rev-list --count <from>..<to>`，含 merge 提交且不受 400 条上限约束，无可用更新时为
0）、`diffstat`（`git diff --stat`，上限 3000 字符，超出截断并附 `…（已截断）`，无可用
更新时为空串），以及——仅当 `mode=tag` 且 `origin` 为 GitHub 时可取到说明时的 `release`
（tag / name / url / body）。

`mode=tag` 但 GitHub 取不到 Release 时**只回退提交列表，不算错误**；`error` 只用于本地
git 失败。远端与本地相同（无可展示更新）时返回 200 且 `commits: []`、`count: 0`、
`diffstat: ""`。npm 行不提供更新日志（GitHub Release 与 npm 版本无法可靠对应）。

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
- 对话框：客户端缓存存在时立即渲染、不等网络；否则先问 `?mode=cached`，有结果即渲染；
  都没有才 `?mode=local` 画骨架、再 `?mode=check` 拉完整结果。
- git 行：`当前 → 最新` 与 tag/commit 目标选择，动作为「更新 / 更新日志 / AI 更新」。
- npm 行：`当前 pin → 最新`，名称在有 `releaseUrl` 时链接到包的 GitHub Releases 列表；
  不提供 tag/commit 选择与「更新日志」；动作为「更新 / AI 更新」，已是最新时显示
  「已是最新」与禁用的更新按钮。更新失败的行显示行内错误与「不可检查」。
- 顶部「全部更新 / AI 更新全部」按 `behind` 过滤，两类行都参与；角标与 `notifyCount`
  同样覆盖两类行。
- 底部提示按行类型说明：git 行更新只完成 git 层，需要执行 `buildCommand` 重新构建并重启
  Desktop 应用；npm 行已把安装脚本改写并就地重装到当前 profile，重启 Desktop 应用后生效，
  重建 desktop 应用产物为可选项。`buildCommand` 只来自 host 的单一来源。
- 更新日志：git 行 `mode=tag` 取到 GitHub Release 时直接渲染 `release.body`；否则把
  `commits` 与 `diffstat` 交给 `dsh-ai-update` 的 `/dsh-gui-api/changelog` 汇总，副标题用
  `count` 计提交数；AI 路由不可用时回退提交列表。
- 「AI 更新」复用已装在 desktop profile 的 `dsh-ai-update`：在顶层 `window` 派发
  `{ type: 'dsh-gui:ai-update', version: 1, requestId, prompt }` 并等待
  `dsh-gui:ai-update-result` 回执（60s 超时）。git 行保持原提示词；npm 行的提示词说明
  包名、安装脚本、当前 pin 与 registry 目标，并要求更新脚本中的 `packageSpec` 精确版本、
  保证当前 profile 与重新部署的新设备都安装到新版本，再重新构建验证；批量提示词按行类型
  分组。

## 已知限制

- 同一包被两个安装脚本 pin 时行 id 重复，更新只落扫描顺序第一个脚本（当前仓库无此情况）。
- 安装脚本超时（10 分钟）只终止直接 node 子进程；wrapper 内部再 spawn 的 pnpm/dsh 孙进程
  可能残留。
- npm 行的解析依赖安装脚本以 `pkg@version` 字面量写精确 pin（见 `plugins/README.md`）；
  从其他文件读取版本或用拼接构造 spec 的写法不产生行。
- npm 行的「更新」不经过 `.staging` 验证；需要完整验证时走「AI 更新」。
- 外壳侧（Tauri 内置对话框）仍只做 git 行检测；`plugins/` 下的子模块即使尚未删除，也不再
  产生 git 行。
- 更新完成后需要重启 Desktop 应用才会加载新的插件版本；git 行另需重新构建。

## 本版不做

分离式更新器与自动重启、`pending-updates.json` 计划文件。npm 行的 GitHub Release 说明与
发布时间/弃用标记（GitHub Release 与 npm 版本无法可靠对应）。更新完成后由用户在关闭
Desktop 实例后手动执行 `npm run build:desktop`（仅重建 desktop 应用产物时需要）。

## 配置与测试钩子

无用户可见配置项。两个测试用环境变量：`DSH_AUTO_UPDATE_GITHUB_API_BASE` 覆盖 GitHub API
基址（默认 `https://api.github.com`），`DSH_AUTO_UPDATE_NPM_REGISTRY_BASE` 覆盖 npm
registry 基址（默认 `https://registry.npmjs.org`）；两者都供 fixture 测试在不依赖外网的
情况下覆盖 Release 与 npm 的请求路径。

## 构建与测试

```
pnpm install --store-dir <runtime-root>/.pnpm-store
pnpm run build      # tsdown → lib/index.js（ESM）+ lib/client.js（CJS closure）
pnpm run watch
node --test tests/  # 或在受限沙箱中逐文件 node tests/<name>.test.ts
```
