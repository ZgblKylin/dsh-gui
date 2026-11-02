# npm 插件更新检测方案

本文件给出把更新面板的插件检测从 git tag 改为 npm 包版本的方案，供实施前评审。检测与执行的现状见 [update-check.md](update-check.md) 与 [desktop-auto-update.md](desktop-auto-update.md)。

## 背景

更新面板当前的行清单是仓库根加 `.gitmodules` 子模块（`plugins/auto-update/dsh-auto-update/src/paths.ts:162` 的 `listProjects`）。每行是一个 git checkout，检测比较本地 HEAD 与远端默认分支，更新执行 `git reset --hard` 并递归同步子模块。

`plugins/` 下的插件已改为 npm 安装：wrapper 的 `install.mjs` 调 `installNpmPlugin` 精确 pin 包版本，子模块 checkout 只作源码参考。计划随后删除 `plugins/` 下的全部子模块，届时子模块行不再对应任何可更新对象，而 npm 包的新版本没有任何检测与更新入口。

约束：更新必须同时落到仓库的安装脚本。只升级当前 profile 里的 npm 包会在下次构建时被 wrapper 的精确 pin 装回旧版，新设备重新部署也仍然按旧 pin 安装。

## 目标与非目标

目标：

- 插件行改为 npm 包：行来自 `plugins/` 下的安装脚本，版本比较是脚本中的 pin 与 registry 最新版本。
- 行内「更新」同时修改安装脚本的 pin 并重新安装该 wrapper，保证本机生效且新设备重新部署时安装到新版本。
- 行内「AI 更新」复用现有提示词与 `dsh-gui:ai-update` 通道，提示词包含安装脚本更新。
- 计数与角标沿用现有语义：npm 行的可更新数量直接进入 `updateCount` 与 `notifyCount`。

非目标：

- 不改外壳侧（`src-tauri/` 与 `src-tauri/ui/app.js`）；本期只做 desktop 插件。
- 不检测官方 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 包，它们随 `deepseek-harness` 子模块行整体升级。
- 不检测 `link:` 源码安装的 wrapper（`remote`、`ai-update`、`opencode-session`、`mcp-on-demand`、`auto-update`、`desktop-tabs`），它们随仓库更新。
- 不提供逐版本的发布时间、弃用标记与 AI 摘要。

## 行清单

`projects` 数组包含两类行，用 `kind` 区分：

| 来源 | 行内容 | 版本比较 |
|---|---|---|
| git 行 | 仓库根、`.gitmodules` 中**不在 `plugins/` 下**的子模块（当前为 `deepseek-harness`、`src-tauri/whale-icon`） | 本地 HEAD 与 `origin/<默认分支>`，以及最新 tag |
| npm 行 | `plugins/**/*.mjs` 中调用 `installNpmPlugin` 的脚本所安装的每个 npm 包 | 脚本中的精确 pin 与 registry 最新版本 |

`plugins/` 下的子模块不再产生 git 行：`submoduleEntries` 的结果按 `path.startsWith('plugins/')` 过滤。子模块删除后该过滤自然保持生效，行来源不需要再改。

npm 行的排序按安装脚本路径，再按包名，保证行顺序稳定。

## 检测流程

1. 解析插件行（本地，无网络）：扫描 `plugins/` 下所有 `.mjs`（跳过 `node_modules`），对包含 `installNpmPlugin(` 的文件提取 spec：
   - 提取文件中形如 `<包名>@<semver>` 的字符串字面量，包名可以是 `name` 或 `@scope/name`；
   - 排除 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`；
   - 同一文件内按包名去重；每个包一行，`current` 为该 spec 中的版本；
   - 提取不到任何 spec 的文件不产生行，并写一条内核日志说明，便于发现写法约定被破坏。
2. 查询 registry：对每个包请求 `GET <registry>/<encodeURIComponent(name)>/latest`，一次响应同时给出 `version` 与 `repository`。请求头与 registry 基址沿用现有 npm 阶段（`accept: application/vnd.npm.install-v1+json`、`DSH_AUTO_UPDATE_NPM_REGISTRY_BASE`）。跨包有界并发（≤8）、首个探测先单独发起、首个传输层失败熔断、整体 10 秒预算，均沿用 `src/npm.ts` 的现有机制。
3. 组装行：`behind = semver.gt(latest, current)`；`announce = behind`；`releaseUrl` 从 `repository.url` 解析出 GitHub 的 `owner/repo` 后拼为 `https://github.com/<owner>/<repo>/releases`；请求失败只写该行 `error`，不影响 git 行与 `allChecked`。
4. `mode=local`：返回 git 行的占位与 npm 行的占位（`current` 为脚本 pin、`latest` 为「检查中…」、`checking: true`、`behind: false`），不联网。
5. `mode=check` 完成后缓存整个 status（含 npm 行）；`mode=cached` 原样返回。

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
- 详情面板底部警示按类型区分：git 行沿用 reset 警示；npm 行提示「更新会修改安装脚本并重新安装该插件；完成后需重新构建应用」。

## 更新执行

`POST /auto-update/api/update` 的 target 增加 npm 行 id，host 按行的 `kind` 分流：

git 行：现有流程不变。

npm 行：

1. 重新扫描插件行，确认目标包存在、脚本中仍保留 `current` 对应的 spec 字面量；缺失则返回该行失败。
2. 备份脚本原文，把 spec 中的 `@<current>` 替换为 `@<latest>`；同一文件内该 spec 出现多处一并替换（注释中的同文也属于同一 pin，一并更新）。
3. 写回脚本，执行 `node <installScript>`，环境变量为 `DSH_HOME`、`DSH_PLUGIN_PROFILE=<当前 profile 名>`、`DSH_PLUGIN_MIN_AGE=0`；stdout 逐行作为 NDJSON `log` 事件回显。
4. 脚本退出码非零时把备份写回并返回该行失败；成功时返回 `已更新到 <latest>`。
5. 该行完成后刷新 status；构建与重启提示沿用现有底部文案。

同一 wrapper 安装多个包时，逐行更新会各执行一次脚本；批量更新同一脚本的多个包时按脚本合并为一次执行，避免重复安装。

## AI 更新提示词

复用 `src/client/ai-prompt.ts` 的现有结构（`/dsh-gui-update` 手势、工作区说明、验证门槛），按行类型替换模块描述：

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

## 前置重构

`plugins/deep-whale/install.mjs` 目前把包名与版本分开放置：

```js
const SKIN_PACKAGES = [
  { name: '@smalltailqwq/...-manager', version: '0.1.8' },
  ...
]
```

检测与替换需要统一的 `pkg@version` 字面量形态，改为：

```js
const SKIN_SPECS = [
  '@smalltailqwq/...-manager@0.1.8',
  ...
]
for (const spec of SKIN_SPECS) installNpmPlugin({ id: ID, packageSpec: spec })
```

行为等价。其余 wrapper 已使用 `pkg@version` 字面量（含常量形式，如 `const PACKAGE_SPEC = 'dsh-pet@0.3.8'`），无需改动。

`plugins/README.md` 补充一条约定：npm wrapper 的 spec 必须以 `<包名>@<精确版本>` 字面量出现在脚本中，检测与更新都按此字符串定位。

## 文件改动

| 文件 | 改动 |
|---|---|
| `plugins/auto-update/dsh-auto-update/src/paths.ts` | 过滤 `plugins/` 子模块；新增插件行解析（扫描脚本、提取 spec、排除官方包） |
| `plugins/auto-update/dsh-auto-update/src/npm.ts` | 新增按包查询 `<name>/latest`（拿版本与仓库地址），复用并发与预算 |
| `plugins/auto-update/dsh-auto-update/src/check.ts` | 行构建增加 npm 行；`local` 模式产出 npm 占位行；汇总计数包含两类行 |
| `plugins/auto-update/dsh-auto-update/src/update.ts` | npm 行的定位、脚本改写、wrapper 重装、失败回滚 |
| `plugins/auto-update/dsh-auto-update/src/index.ts` | status 与 update 路由沿用；响应结构不变 |
| `plugins/auto-update/dsh-auto-update/src/client/api.ts` | 行类型扩展 |
| `plugins/auto-update/dsh-auto-update/src/client/dialog.ts` | 按行类型渲染动作；摘要与警示文案 |
| `plugins/auto-update/dsh-auto-update/src/client/ai-prompt.ts` | 插件行提示词与批量分组 |
| `plugins/deep-whale/install.mjs` | spec 改为 `pkg@version` 字面量 |
| `plugins/README.md` | npm wrapper 的 spec 写法约定 |
| `plugins/auto-update/dsh-auto-update/README.md`、`docs/dsh-gui/desktop-auto-update.md`、`update-check.md` | 检测来源、行模型、更新执行的文档同步 |

## 测试与验收

新增 `plugins/auto-update/dsh-auto-update/tests/`：

- 脚本解析：多包 wrapper、常量形式、scope 包、排除官方包、无 `installNpmPlugin` 的文件不产生行、同一包去重。
- 版本比较：latest 更高、相同、更低、非法版本；prerelease 版本比较。
- registry 失败隔离：单包失败只写 `error`，其余行与 git 行不受影响。
- `mode=local` 占位与 `mode=cached` 缓存包含 npm 行。
- 更新执行：脚本替换正确性（含同文件多处）、重装失败回滚、环境变量传递。
- 提示词：npm 行包含包名、pin、目标版本与安装脚本路径；批量提示词按类型分组。

手工验收：

1. 当前所有 pin 与 registry 最新一致时，面板只显示 git 行，无 npm 行提示。
2. 在 fixture registry 中把 `@max-null/dsh-skill-mcp-center` 的 latest 指到 0.7.1 后：面板出现该 npm 行并计入角标；「更新」把 `plugins/skill-mcp-center/install.mjs` 的 pin 改到 0.7.1 并完成重装；构建后 profile 中该包版本为 0.7.1。
3. 删除 `plugins/` 下的子模块 checkout 后，面板不再有对应 git 行，npm 行不受影响。
4. 断网时 npm 行显示错误文案，git 行与「全部更新」可用。

## 风险与取舍

- 脚本解析依赖 spec 的写法约定。当前 9 个 npm wrapper 均满足（`deep-whale` 经前置重构后）；未来出现从文件读取版本的写法会解析不到，需要按约定调整。
- 「更新」写仓库脚本属于仓库文件写操作，与 git reset 同级但不可用 git 回滚；执行前备份、失败写回，单飞执行避免并发。
- wrapper 重装会执行 pnpm 与 `dsh plugin add`，耗时可达数十秒；对话框流式显示日志，失败只影响该行。安装脚本超时（10 分钟）只终止直接 node 子进程，wrapper 内部再 spawn 的 pnpm/dsh 孙进程可能残留。
- 同一包被两个安装脚本 pin 时行 id 重复，更新只落扫描顺序第一个脚本；当前仓库无此情况。
- npm 行的「更新」不经过 `.staging` 验证，与现有 git 行「更新」的定位一致；需要完整验证时走「AI 更新」。
- `plugins/` 子模块过滤后，源码子模块的更新不再出现在面板；删除前它们的更新只影响源码参考，不影响运行版本。
- 外壳侧面板仍按 git 行检测，删除插件子模块后只显示根与内置子模块；本期不改。

## 分阶段

- S1（本期）：插件行解析、registry 比较、混合行模型、更新执行与回滚、AI 提示词、测试与文档同步。
- S2（后续，可选）：npm 行的 GitHub Release 说明展示、发布时间与弃用标记；外壳侧对齐。

## 决策（2026-11-02 用户确认）

1. npm 行按「每个 npm 包一行」展示；捆绑包（deepseek-harness 这类 git 行）保持一行。
2. npm 行的「更新」沿用现有常驻警示文案，不增加二次确认弹窗。
3. 第一期只做 desktop 插件版，外壳侧保持 git 行检测。
4. 角标沿用现有语义，npm 行的可更新数量直接计入。
5. 行内链接沿用现有 GitHub Releases 列表形式。
