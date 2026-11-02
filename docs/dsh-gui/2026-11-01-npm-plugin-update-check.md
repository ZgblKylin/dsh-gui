# npm 插件更新检测方案

本文件描述更新面板的 npm 插件行：行清单、检测流程、更新执行与提示词语义。检测与执行的现状见 [update-check.md](update-check.md) 与 [desktop-auto-update.md](desktop-auto-update.md)。

## 背景

git 行对应一个 git checkout：行清单取仓库根与 `.gitmodules` 中的子模块（`plugins/auto-update/dsh-auto-update/src/paths.ts` 的 `listProjects`），检测比较本地 HEAD 与远端默认分支，更新执行 `git reset --hard` 并递归同步子模块；路径以 `plugins/` 开头的子模块不产生 git 行。

npm 型插件以发布包安装：wrapper 的 `install.mjs` 调 `installNpmPlugin` 精确 pin 包版本，仓库内不保留源码 checkout；in-tree 型插件（`installPlugin`）随仓库自身更新，不产生 npm 行。npm 包的新版本因此需要自己的检测与更新入口。

约束：更新必须同时落到仓库的安装脚本。只升级当前 profile 里的 npm 包会在下次构建时被 wrapper 的精确 pin 装回旧版，新设备重新部署也仍然按旧 pin 安装。

## 目标与非目标

目标：

- 插件行是 npm 包：行来自 `plugins/` 下的安装脚本，版本比较是脚本中的 pin 与 registry 最新版本。
- 行内「更新」同时修改安装脚本的 pin 并重新安装该 wrapper，保证本机生效且新设备重新部署时安装到新版本。
- 行内「AI 更新」复用现有提示词与 `dsh-gui:ai-update` 通道，提示词包含安装脚本更新。
- 计数与角标沿用现有语义：npm 行的可更新数量直接进入 `updateCount` 与 `notifyCount`。

非目标：

- 不检测官方 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 包，它们随 `deepseek-harness` 子模块行整体升级。
- 不检测 `link:` 源码安装的 wrapper（`remote`、`ai-update`、`opencode-session`、`mcp-on-demand`、`auto-update`、`desktop-tabs`），它们随仓库更新。
- 不提供逐版本的发布时间、弃用标记与 AI 摘要。

## 行清单

`projects` 数组包含两类行，用 `kind` 区分：

| 来源 | 行内容 | 版本比较 |
|---|---|---|
| git 行 | 仓库根、`.gitmodules` 中不在 `plugins/` 下的子模块（当前为 `deepseek-harness`、`src-tauri/whale-icon`） | 本地 HEAD 与 `origin/<默认分支>`，以及最新 tag |
| npm 行 | `plugins/**/*.mjs` 中调用 `installNpmPlugin` 的脚本所安装的每个 npm 包 | 脚本中的精确 pin 与 registry 最新版本 |

`plugins/` 下的路径不产生 git 行：desktop 插件在 `submoduleEntries` 的结果上按 `path.startsWith('plugins/')` 过滤；外壳读取 `.gitmodules`，当前只含 `deepseek-harness` 与 `src-tauri/whale-icon`。

npm 行的排序按安装脚本路径，再按包名，保证行顺序稳定。

## 检测流程

1. 解析插件行（本地，无网络）：扫描 `plugins/` 下所有 `.mjs`（跳过 `node_modules`），对包含 `installNpmPlugin(` 的文件提取 spec：
   - 提取文件中形如 `<包名>@<semver>` 的字符串字面量，包名可以是 `name` 或 `@scope/name`；
   - 排除 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`；
   - 同一文件内按包名去重；每个包一行，`current` 为该 spec 中的版本；
   - 提取不到任何 spec 的文件不产生行。
2. 查询 registry：对每个包请求 `GET <registry>/<encodeURIComponent(name)>/latest`，一次响应同时给出 `version` 与 `repository`。请求头 `accept: application/json`——该端点不接受 abbreviated 类型（会返回 406），完整响应同时携带 `repository`；desktop 插件的 registry 基址可由 `DSH_AUTO_UPDATE_NPM_REGISTRY_BASE` 覆盖。desktop 插件沿用 `src/npm.ts` 的调度（跨包有界并发 ≤8、首个探测先单独发起、首个传输层失败熔断、整体 10 秒预算）；外壳用一次 node 调用并发查询全部包（单请求 15 秒超时、整体 60 秒预算）。非 2xx 与不可解析 body 只记该包错误，不熔断。
3. 组装行：`behind = semver.gt(latest, current)`；`announce = behind`；`releaseUrl` 从 `repository`（字符串或 `url` 成员）解析出 GitHub 的 `owner/repo` 后拼为 `https://github.com/<owner>/<repo>/releases`；请求失败只写该行 `error`，不影响 git 行与 `allChecked`。
4. `mode=local`：返回 git 行的占位与 npm 行的占位（`current` 为脚本 pin、`latest` 为「检查中…」、`checking: true`、`behind: false`），不联网。
5. `mode=check` 完成后缓存整个 status（含 npm 行）；`mode=cached` 原样返回。外壳侧对应 `check_updates`（检测并写缓存）、`cached_update_status`（读缓存）与 `local_update_projects`（本地预览）三个命令。

## 行模型

`UpdateProject` 增加字段，其余字段含义不变：

```ts
interface UpdateProject {
  /** 行来源；缺省按 git 行处理。 */
  kind?: 'git' | 'npm'
  /** npm 行的包名。 */
  packageName?: string
  /** npm 行的安装脚本，相对仓库根（例如 plugins/skill-mcp-center/install.mjs）。 */
  installScript?: string
  // 现有字段：id、name、path、current、latest、behind、announce、checking、error、releaseUrl
}
```

npm 行各字段取值：`id` 为 `npm:<packageName>`；`name` 为包名；`path` 与 `installScript` 相同；`current` 为脚本 pin 版本；`latest` 为 registry 最新版本；不设置 `latestTag`、`latestTagStale`。

## 界面

- git 行渲染不变（tag/commit 选择、「更新」「更新日志」「AI 更新」）。
- npm 行渲染：名称（有 `releaseUrl` 时为 GitHub Releases 链接）、`当前 → 最新`、状态；动作只有「更新」与「AI 更新」，不渲染 tag/commit 选择器。「更新日志」按钮在 npm 行隐藏——GitHub Release 与 npm 版本无法可靠对应，避免给出错误内容。
- 摘要行把两类行一起计数：「N 个模块/插件有可用更新」；空态沿用「均为最新版本」。
- 顶部「全部更新」与「AI 更新全部」按 `behind` 过滤，npm 行自然参与。
- 详情面板底部警示同时说明两类更新：git 行以 `git reset --hard` 检出目标版本，所选工程中未提交的改动会被丢弃（未跟踪文件保留）；npm 行更新会修改安装脚本中的版本 pin 并重新安装该插件（当前 profile 就地生效，新设备重新部署也会按新的 pin 安装），完成后重启应用生效，不需要重新构建。

## 更新执行

更新按行类型分流：git 行沿用现有检出流程；npm 行的流程在 desktop 插件侧为：

1. 重新扫描插件行定位目标包；包已不在脚本中时返回该行失败（提示重新打开更新对话框）。
2. 备份脚本原文，把该行当前的 spec 字面量替换为 `<包名>@<latest>`；同一文件内该 spec 出现多处一并替换（注释中的同文也属于同一 pin，一并更新）。
3. 写回脚本，执行 `node <installScript>`，环境变量为 `DSH_HOME`、`DSH_PLUGIN_PROFILE=<当前 profile 名>`、`DSH_PLUGIN_MIN_AGE=0`；stdout 逐行作为 NDJSON `log` 事件回显。
4. 脚本退出码非零时把备份写回并返回该行失败；成功时返回 `已更新到 <latest>`。
5. 该行完成后刷新 status；构建与重启提示沿用现有底部文案。

外壳侧的同一流程由 `update_npm_plugin` 命令承担：重新扫描定位行、查询 registry、替换 pin 并备份原文、重跑 wrapper，写盘失败或脚本失败时写回备份；日志经 `update-root-log` 事件逐行回显，安装脚本超时为 10 分钟，成功时提示重启 dsh-gui 后生效、不需要重新构建。

desktop 插件的批量更新按安装脚本合并同一脚本的多个包，只重装一次；外壳的批量更新逐行调用就地更新命令，同一脚本装多个包时会各执行一次该脚本。

## AI 更新提示词

复用 `plugins/auto-update/dsh-auto-update/src/client/ai-prompt.ts` 的现有结构（`/dsh-gui-update` 手势、工作区说明、验证门槛），按行类型替换模块描述：

- git 行（`deepseek-harness` 与其他子模块）保持现有提示词。
- npm 行使用插件模板，移除「更新子模块」相关内容：

```
/dsh-gui-update

请更新当前 dsh-gui 仓库中的「<包名>」插件：

- 插件：<包名>
- 安装脚本：plugins/<id>/install.mjs
- 当前 pin：<current>；更新目标：npm 最新版本 <latest>
- 要求：更新安装脚本中的 packageSpec 精确版本，并保证当前 profile 与重新部署的新设备都会安装到新版本；改完重新构建验证。

<工作区说明>

<验证门槛>
```

- 行内「AI 更新」与批量「AI 更新全部」继续派发 `dsh-gui:ai-update` 并等待回执。
- 批量提示词按行类型分组列出：git 行沿用现有条目格式，npm 行使用「安装脚本 + pin 更新」条目。
- 顶层 `dsh-gui` 行仍不进入 AI 流程。

外壳侧的提示词由 `src-tauri/ui/app.js` 的 `buildNpmPluginPrompt` 与批量分组构造器生成，内容与上述模板一致。

## npm wrapper 的 spec 约定

检测与更新都按 `<包名>@<精确版本>` 字符串字面量定位 spec，因此 npm wrapper 必须以这种形式写 pin（常量或数组字面量均可）。`plugins/deep-whale/install.mjs` 用 `SKIN_SPECS` 数组逐个安装：

```js
const SKIN_SPECS = [
  '@smalltailqwq/...-manager@0.1.8',
  ...
]
for (const spec of SKIN_SPECS) installNpmPlugin({ id: ID, packageSpec: spec })
```

其余 wrapper 采用同样的字面量形式（含常量形式，如 `const PACKAGE_SPEC = 'dsh-pet@0.3.8'`）。`plugins/README.md` 记录该约定：npm wrapper 的 spec 必须以 `<包名>@<精确版本>` 字面量出现在脚本中，检测与更新都按此字符串定位。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `plugins/auto-update/dsh-auto-update/src/paths.ts` | git 行清单（过滤 `plugins/` 子模块）与 npm 插件行解析（扫描脚本、提取 spec、排除官方包） |
| `plugins/auto-update/dsh-auto-update/src/npm.ts` | 按包查询 `<name>/latest`（拿版本与仓库地址），复用并发与预算 |
| `plugins/auto-update/dsh-auto-update/src/check.ts` | 两类行的构建、`local` 模式的 npm 占位行与汇总计数 |
| `plugins/auto-update/dsh-auto-update/src/update.ts` | npm 行的定位、脚本改写、wrapper 重装与失败回滚 |
| `plugins/auto-update/dsh-auto-update/src/index.ts` | status 与 update 路由 |
| `plugins/auto-update/dsh-auto-update/src/client/api.ts` | 行类型 |
| `plugins/auto-update/dsh-auto-update/src/client/dialog.ts` | 按行类型渲染动作、摘要与警示文案 |
| `plugins/auto-update/dsh-auto-update/src/client/ai-prompt.ts` | 插件行提示词与批量分组 |
| `plugins/deep-whale/install.mjs` | `SKIN_SPECS` 形式的 `pkg@version` 字面量 |
| `plugins/README.md` | npm wrapper 的 spec 写法约定 |
| `plugins/auto-update/dsh-auto-update/README.md`、`docs/dsh-gui/desktop-auto-update.md`、`update-check.md` | 检测来源、行模型与更新执行的文档 |

外壳侧对应的实现为 `src-tauri/src/update.rs`（行扫描、`/<pkg>/latest` 探测、`run_npm_plugin_update` 就地更新与回滚）、`src-tauri/src/main.rs`（`update_npm_plugin` 命令）、`src-tauri/src/update_script.mjs`（计划只含 git 行的防御过滤）与 `src-tauri/ui/app.js`（npm 行渲染、就地更新、批量执行顺序与 AI 提示词）。

## 测试与验收

新增 `plugins/auto-update/dsh-auto-update/tests/`：

- 脚本解析：多包 wrapper、常量形式、scope 包、排除官方包、无 `installNpmPlugin` 的文件不产生行、同一包去重。
- 版本比较：latest 更高、相同、更低、非法版本；prerelease 版本比较。
- registry 失败隔离：单包失败只写 `error`，其余行与 git 行不受影响。
- `mode=local` 占位与 `mode=cached` 缓存包含 npm 行。
- 更新执行：脚本替换正确性（含同文件多处）、重装失败回滚、环境变量传递。
- 提示词：npm 行包含包名、pin、目标版本与安装脚本路径；批量提示词按类型分组。

外壳侧在 `src-tauri/src/update.rs` 的测试模块里覆盖同一组纯函数：版本比较、`repository` 到 Releases 列表页的解析、spec 替换、注释剥离与字面量提取、registry 响应映射，以及 `allChecked` 只反映 git 行。

手工验收：

1. 当前所有 pin 与 registry 最新一致时，npm 行全部显示「已是最新」，不计入可更新数量与角标。
2. 在 fixture registry 中把 `@max-null/dsh-skill-mcp-center` 的 latest 指到 0.7.1 后：面板出现该 npm 行并计入角标；「更新」把 `plugins/skill-mcp-center/install.mjs` 的 pin 改到 0.7.1 并完成重装；构建后 profile 中该包版本为 0.7.1。
3. desktop 插件与外壳两侧分别验证：面板同时渲染 git 行与 npm 行，npm 行的「更新」改写安装脚本并重装，重启应用后生效，git 行不受影响。
4. 断网时 npm 行显示错误文案，git 行与「全部更新」可用。

## 风险与取舍

- 脚本解析依赖 spec 的写法约定。当前仓库的 npm wrapper 均以这种字面量写 pin；从其他文件读取版本或拼接构造 spec 的 wrapper 会解析不到，需要按约定调整。
- 「更新」写仓库脚本属于仓库文件写操作，与 git reset 同级但不可用 git 回滚；执行前备份、失败写回，单飞执行避免并发。
- wrapper 重装会执行 pnpm 与 `dsh plugin add`，耗时可达数十秒；对话框流式显示日志，失败只影响该行。安装脚本超时（10 分钟）只终止直接 node 子进程，wrapper 内部再 spawn 的 pnpm/dsh 孙进程可能残留。
- 同一包被两个安装脚本 pin 时行 id 重复，更新只落扫描顺序第一个脚本；当前仓库无此情况。
- npm 行的「更新」不经过 `.staging` 验证，与现有 git 行「更新」的定位一致；需要完整验证时走「AI 更新」。
- 外壳与 desktop 插件共用同一行模型与检测语义；外壳的 npm 行更新逐行执行（不按脚本合并），git 行仍由就地顶层更新或分离式更新器处理。

## 实施范围

desktop 插件与外壳实现同一套行模型、pin 扫描、registry 探测、更新执行与回滚、AI 提示词语义，差异只在执行载体与批量调度：

- desktop 插件（`plugins/auto-update/dsh-auto-update`）在标题栏对话框内检测与就地更新；批量更新把同一安装脚本的多个包合并为一个执行单元，检测结果有进程内缓存（`mode=cached`）。
- 外壳（`src-tauri`）在更新对话框内检测两类行；npm 行的「更新」由 `update_npm_plugin` 命令改写安装脚本并重跑 wrapper，应用保持运行；git 行仍由就地顶层更新（`update_root`）或分离式更新器（`start_update` 与 `update_script.mjs`）处理，`pending-updates.json` 只包含 git 行。

npm 行的 GitHub Release 说明、发布时间与弃用标记不实现：GitHub Release 与 npm 版本无法可靠对应。

## 决策（2026-11-02 用户确认）

1. npm 行按「每个 npm 包一行」展示；捆绑包（deepseek-harness 这类 git 行）保持一行。
2. npm 行的「更新」沿用现有常驻警示文案，不增加二次确认弹窗。
3. 外壳与 desktop 插件采用同一套行模型与检测/执行语义，外壳的分离式更新器只处理 git 行。
4. 角标沿用现有语义，npm 行的可更新数量直接计入。
5. 行内链接沿用现有 GitHub Releases 列表形式。
