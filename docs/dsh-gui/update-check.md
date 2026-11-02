# 更新检查（update check）

## 功能

更新对话框把可更新对象分成两类行。

**git 行**是 dsh-gui 仓库本体与 `.gitmodules` 中的子模块（当前为 `deepseek-harness` 与 `src-tauri/whale-icon`）：检测把本地 HEAD 与远端默认分支比较，行内显示「当前 → 最新」（有可用最新 tag 时显示 tag 名，否则显示提交）与 tag/commit 更新目标选择；顶层行的动作是「更新」「更新日志」，子模块行另有「AI 更新」。

**npm 插件行**是 `plugins/**/*.mjs` 安装脚本用 `installNpmPlugin` 精确 pin 的每个 npm 包：检测把脚本中的 pin 与 registry 的最新版本比较，行内显示「当前 → 最新」（当前为脚本 pin，最新为 registry 最新版本），动作是「更新」（就地改写安装脚本的 pin 并重新安装该插件）与「AI 更新」。

`harness.json` 选择 `npm` 运行时后，dsh 运行时本身也是 npm 安装型：`deepseek-harness` 行同样先核对最新 tag 是否已有 `@deepseek-ai/dsh` 的 npm 发布，再决定是否安装。

desktop 应用内的 `dsh-auto-update` 插件把同一套面板搬到应用内，行模型、检测语义与就地更新与外壳一致；插件侧行为与路由契约见 [desktop-auto-update.md](desktop-auto-update.md)，行模型与更新的设计见 [2026-11-01-npm-plugin-update-check.md](2026-11-01-npm-plugin-update-check.md)。

## 行清单

`projects` 中 git 行在前、npm 插件行在后；npm 插件行按安装脚本路径、再按包名排序，行顺序在多次检查之间稳定。

| 来源 | 行内容 | 版本比较 |
|---|---|---|
| git 行 | 仓库根（id `dsh-gui`）与 `.gitmodules` 中的子模块（id 为 submodule name） | 本地 HEAD 与 `origin/<默认分支>`，以及最新 tag |
| npm 插件行 | `plugins/**/*.mjs` 中调用了 `installNpmPlugin(` 的安装脚本所 pin 的每个包（id `npm:<packageName>`） | 脚本中的精确 pin 与 registry 最新版本 |

npm 插件行的线协议字段：`kind` 为 `"npm"`、`packageName` 为包名、`installScript` 为相对仓库根的 POSIX 路径（与 `path` 相同）、`current` 为脚本中的 pin、`latest` 为 registry 最新版本、`behind` 与 `announce` 同值、`releaseUrl` 为该包仓库的 GitHub Releases 列表页（可解析时）；不设置 `latestTag` 与 `latestTagStale`。git 行不设置 `kind`、`packageName`、`installScript`，旧缓存中没有这些字段的行同样按 git 行处理。

## AI 更新的 tag 保留规则

「AI 更新全部」与行内「AI 更新」不会把 **tag 版本更新到非 tag 提交**：若某个模块（含顶层仓库）当前正好检出于某个 tag、而远端默认分支只有更新的提交、没有更新的 tag（即 `announce = false` 的「仅提交更新」情形），该行不会进入「AI 更新全部」，其行内「AI 更新」按钮置灰禁用（不建议执行）。如确需跟进这类模块，请用行内的「更新」流程（确认后「重启并更新」）。npm 插件行没有 tag 目标，`announce` 等于 `behind`，该规则对它不适用：只要行处于可更新状态且没有错误，就进入 AI 更新。

实现：`src-tauri/ui/app.js` 的 `isOnTagWithoutNewer`（复用 Rust 端 `announce` 字段）过滤 `updatableProjects`（AI 资格），并在 `renderUpdateDialog` 没有 AI 资格行时隐藏「AI 更新全部」；被过滤的行因此不会进入预填的模块清单。该跳过规则同时写在 skill `dsh-gui-update` 的更新目标与跳过规则中。

## AI 更新的提示词与预设

「AI 更新」/「AI 更新全部」启动后，dsh-ai-update 浏览器半（`plugins/ai-update/dsh-ai-update/src/client/index.ts`）在落地空白会话上自动调用 `ctx.remote.agentPresets.select(sessionId, 'cordis')` 选中 **「创造模式」**（harness 内置 `cordis` preset，提供运行时检查、插件实验与 preset 创作指导），再预填升级提示词；选择被拒绝时请求失败返回错误，而不是静默落到默认预设。用户发送前仍可自行切换预设 chip。

提示词由 `src-tauri/ui/app.js` 生成（`buildAiUpdatePrompt`、`buildNpmPluginPrompt` 与两个基座提示词构造器），以 `/dsh-gui-update` skill 手势开头：host 侧的 `dsh-tool-skill` 会把该 skill 的内容注入会话，升级流程全部由该 skill 承载，提示词只补充模块名、路径、当前版本、更新目标，以及 skill 无法从对话框得知的验收门槛（`AI_UPDATE_GATE_NOTE`，单模块、npm 插件单行、仅 harness、批量与 harness 合并这几类提示词都带这段）：

1. 先在验证 worktree `.staging/dsh-gui` 中完成更新与验证（它是本仓库的 git worktree，检出工作分支 `staging/verify`）；**「验证通过」指该 worktree 的 WebUI 能正确加载**（会话界面正常渲染、能新建或载入会话、插件与组合无加载报错），构建全绿与 `--dump-config` 无报错都只是前置条件；适配改动直接提交在工作分支上，不需要用户审批；
2. 本次更新包含 `deepseek-harness` 时，还要用 computer use 验证 GUI（桌面外壳）能在该 worktree 中正常启动和运行；
3. 验证全部通过后先向用户报告结论，**等用户明确审批后**才执行阶段二，把工作分支合并回主分支并更新主工程子模块指针完成实装。

npm 插件行的提示词去掉「更新子模块」相关内容，说明包名、安装脚本、当前 pin 与 registry 目标，并要求更新安装脚本中的 `packageSpec` 精确版本，保证当前 profile 与重新部署的新设备都安装到新版本：

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

批量提示词按行类型分组：两类行同时参与时，git 行归入「仓库模块（git 子模块）：」，npm 行归入「npm 插件（更新安装脚本中的版本 pin 并重新安装）：」并在组末附上述要求行；只含一类行时不加分组标题，git 行沿用原条目格式，npm 行在组末附上述要求行。含 `deepseek-harness` 的合并提示词保持先基座、再其余行的顺序，npm 行单独成组。

验收命令与判据见 [upgrade-staging-workspace.md](upgrade-staging-workspace.md) 与 skill `dsh-gui-update`。

## 检测与标注

### git 行

- **安装记录**：共享流水线 `scripts/plugin-install.mjs` 的 `installNpmPlugin` 把每个 npm 包名（含被 `DSH_PLUGIN_SKIP` / wrapper `skip` 默认跳过的包——记录先于安装判定写入，跳过与否都留档）追加写入 `.dsh/gui/npm-installs.json`（运行时缓存、gitignored）；`harness.json` 的 `npm` 运行时在（重）安装后由 `scripts/dsh-gui.mjs` 追加 `@deepseek-ai/dsh`。
- **归属判定**：`src-tauri/src/update.rs` 扫描每个 submodule 的 `package.json`（根 manifest + `apps/*` + `packages/**`），与上述 registry 求交集，得到该行所属的 npm 包集合。`apps/*` 覆盖 dsh 运行时所在的 `@deepseek-ai/dsh`。
- **npm 发布状态**：当远端有更新的 tag（`latestTag` 可用）时，对每个 npm 包查询 `registry.npmjs.org`（经 node 临时脚本 fetch，沿用更新检查的文件重定向 stdio 模式），产出 `NpmUpdateInfo`：每个包当前发布的最新版本（`latest`）、尚未发布 tag 版本的包（`missing`）、是否全部已发布（`complete`）与网络错误（`error`）。
- **标注**：`src-tauri/ui/app.js` 在该行的「当前 → 最新」对比下方渲染警告：tag 的 npm 对应版本未发布、npm 当前最新版本、以及「本行更新只移动源码 checkout，已安装插件需等 npm 发布后重新执行插件安装」。npm 核对失败只显示提示，不影响 git 更新检测结果。

### npm 插件行

- **行扫描**：`plugin_npm_rows` 递归扫描 `plugins/` 下的 `.mjs`（跳过 `node_modules` 与点目录），只处理内容包含 `installNpmPlugin(` 的脚本，且路径至少为 `plugins/<wrapper>/…`；先剥离 `//` 行注释与 `/* */` 块注释（字符串与模板字面量原样保留），再提取字符串字面量中形如 `<包名>@<三段 semver>` 的精确 pin（单引号、双引号、反引号均可，包名可为 `name` 或 `@scope/name`，版本可带 prerelease）；同一脚本内按包名去重；`@deepseek-ai/dsh*` 官方包不产生行（随 `deepseek-harness` 行整体升级）。
- **registry 探测**：一次检查对全部包只启动一次 node 临时脚本（沿用「写临时文件 + 文件重定向 stdio」模式），对每个包请求 `GET https://registry.npmjs.org/<encodeURIComponent(name)>/latest`，请求头 `accept: application/json`（该端点不接受 abbreviated 类型，会返回 406；完整响应同时给出 `version` 与 `repository`）与 `user-agent: dsh-gui-update-check`，单请求 15 秒超时，整次调用 60 秒预算；非 2xx 与不可解析响应只记该包错误，其余包不受影响。
- **标注**：`behind = is_newer(latest, pin)`，`announce = behind`；`releaseUrl` 由 manifest 的 `repository` 解析为 `https://github.com/<owner>/<repo>/releases`（覆盖 `git+https://`、`https://`、`ssh://git@github.com/`、`git@github.com:` 等形式），非 GitHub 仓库或未声明时省略。
- **失败隔离**：探测失败的行只带 `error`（`latest` 为「—」、`behind=false`、不计入角标），不改变任何 git 行的状态；`allChecked` 只反映 git 行完整性，npm 行的失败不翻转它，状态行的「N 个工程检查失败」也只统计 git 行。整次调用失败（超时、node 启动失败）时所有 npm 行记录同一错误。
- **本地预览**：`local_update_projects` 在 git 行之后追加 npm 插件行占位：`current` 为脚本 pin、`latest` 为「检查中…」、`checking=true`、不联网。

## 行内模块名的 Releases 页链接

更新对话框每一行的**模块名**都链接到该仓库的 GitHub Releases 列表页（`https://github.com/<owner>/<repo>/releases`），便于在更新前直接查看上游发布了哪些版本。git 行的链接由 Rust 侧构造每一行时解析（`src-tauri/src/update.rs` 的 `release_page_for`），骨架行（`local_check` → `local_preview_project`）同样携带，因此第一帧就是链接，不依赖网络检查结果。npm 插件行的链接来自 registry `/<pkg>/latest` 响应中的 `repository` 字段（`github_releases_url` 解析），registry 探测失败或仓库不在 GitHub 时该行名称保持纯文本。

解析顺序与取舍：

- 优先取该行自己的 `git remote get-url origin`：更新实际拉取的就是这个远端；
- 该行还不是 git 仓库（submodule 尚未初始化）时回退到 `.gitmodules` 记录的 `url`；
- 远端不是 GitHub（自建 GitLab、镜像、本地路径）时值为 `None`，模块名保持纯文本；
- 链接目标是 **Releases 列表页**，不是 `/releases/tag/<tag>` 子页面：一行并不绑定某一个版本。

线协议字段为 `releaseUrl`（`ProjectUpdate.release_url` 经 camelCase 序列化），`None` 时整个字段省略。前端（`src-tauri/ui/app.js` 的 `updateRow` 与 `updateNpmRow`）在 URL 通过 `externalSafeUrl` 的 http(s)/mailto 校验后才渲染成 `<a>`；普通单击经 `open_external` 交给系统默认浏览器，Ctrl/Cmd+点击由 document 级捕获监听器处理，本地处理器在带修饰键时放行，避免同一次点击打开两个标签页。更新日志弹窗标题的链接复用同一个 `releasePageAnchor` 构造函数，但触发条件不同（见 [update-changelog.md](update-changelog.md)）。

## 更新执行

### 顶层 dsh-gui 行

`update_root` 命令在弹窗内就地执行 git 层更新：顶层 `git reset --hard` 到目标（`mode=tag` 取 `origin/<默认分支>` 上最新 tag，否则取 `origin/<默认分支>`），再 `git submodule update --init --recursive` 递归同步子模块；进度行经 `update-root-log` 事件流式渲染在弹窗内。应用不退出；git 层完成后需要按提示重新执行 `npm run build` 做全量构建并重启，代码改动才会生效。

### npm 插件行

`update_npm_plugin` 命令（参数 `{ id }`）在弹窗内就地更新单个 npm 插件行，应用保持运行：

1. 重新扫描安装脚本定位同 id 的行；脚本中已找不到该包时返回「安装脚本中已找不到插件「…」，请重新检查更新」。
2. 重新查询该包在 registry 的最新版本；不高于当前 pin 时记录「已是最新（<pin>）」并结束，不写文件。
3. 读取目标安装脚本，把其中的 spec 字面量 `<包名>@<旧 pin>` 全部替换为 `<包名>@<最新版本>`（同一文件中的多处出现一并替换），先保留原文作为备份；写盘失败时恢复原文并报错。
4. 以仓库根为工作目录执行 `node <installScript>`，环境变量设 `DSH_PLUGIN_PROFILE`（继承外壳已有值，缺省 `web`）与 `DSH_PLUGIN_MIN_AGE=0`，其余环境（含 `DSH_HOME`）继承外壳；stdout 与 stderr 重定向到临时文件并逐行转发为 `update-root-log` 事件；10 分钟未结束时终止直接子进程。
5. 脚本非零退出或超时时写回备份并返回错误（文案附「已回滚安装脚本」）；成功时记录「安装脚本已按 <spec> 重新安装」与「重启 dsh-gui 后新版本插件生效；不需要重新构建」。
6. 命令只写目标安装脚本这一个文件，不执行 `git clean`；它与检测、顶层更新共用外壳的更新锁，串行执行。

### 批量执行

「全部更新」把全部 `behind` 且无错误的行加入选择，两类行都参与；按钮文案随选择变化：含 git 行时为「重启并更新」，只含 npm 插件行时为「更新插件」；加入选择的 npm 插件行显示「待执行」，git 行显示「待重启」。

点击执行时先按顺序逐个就地执行 npm 插件行（应用保持运行，单行失败只汇总、不阻塞后续行），随后把剩余的 git 行（含顶层 `dsh-gui` 行）交给分离式更新器：应用退出，git 更新、重建与重启在控制台窗口中完成。npm 行的失败汇总会并入退出前的同一条提示。选择中只有 npm 插件行时，全部执行后不退出应用，提示重启 dsh-gui 后生效。

### 分离式更新器

`start_update` 把选中 id 交给分离式更新器：它先等待 dsh-gui 与 harness 进程退出（超时则中止），再按 `pending-updates.json` 逐行 `git fetch`、`reset --hard` 到目标 revision 并递归同步子模块，完成后执行 `node scripts/dsh-gui.mjs build` 重建，最后重启 dsh-gui；Windows 上过程显示在控制台窗口，非 Windows 平台写入 `.dsh/gui/update.log`。

计划文件与更新脚本只包含 git 行：`check_and_sync` 写计划前过滤 `kind` 非空的行，只有存在 git 行更新时才写计划与脚本，git 行全部检查成功且没有 git 行更新时把计划、更新脚本与控制台启动器一并删除；`start_update` 对含 npm 行 id 的请求返回「npm 插件行请用行内「更新」（就地执行）」；`start` 与 `update_script.mjs` 也各自按 `kind` 过滤，避免把 npm 行当成 checkout 执行 `reset --hard`。

## git 行的 npm 发布状态与生效路径

1. 上游发布新 tag 后，git 行的更新对话框先显示「tag 版本 npm 未发布」标注；
2. 上游恢复 npm 发布（例如 `dsh-web` 的 `NPM_PUBLISH_ENABLED`）后，`complete` 变为 true，标注消失；
3. 此时（以及需要解除某个 wrapper 自己的 `skip` 屏蔽时）重跑对应安装：`node plugins/<id>/install.mjs` 或 `npm run install:plugins`；首次安装后更新检查才能确认 npm 版本，因此新克隆环境建议先执行一次插件安装。

## 已知限制

- npm 行的解析依赖安装脚本以 `<包名>@<精确三段版本>` 字面量写 pin：从其他文件读取版本、用拼接构造 spec、写成版本范围 / `latest` / 带 build metadata / 非三段版本的脚本都不产生行。
- 同一包被两个安装脚本 pin 时行 id 重复（`npm:<packageName>`），更新只落扫描顺序第一个脚本；当前仓库没有这种情况。
- 同一 wrapper 安装多个包时，逐行执行「更新」会各执行一次该安装脚本；外壳的批量执行不按脚本合并（desktop 插件在批量更新时按脚本合并）。
- 安装脚本超时（10 分钟）只终止直接 node 子进程；wrapper 内部再 spawn 的 pnpm/dsh 孙进程可能残留。
- npm 行不提供更新日志：GitHub Release 与 npm 版本无法可靠对应。
- npm 行的「更新」不经过 `.staging` 验证，与 git 行就地更新的定位一致；需要完整验证时走「AI 更新」。
- 更新会改写仓库安装脚本，属于仓库文件写操作，不可用 git 回滚；执行前备份原文，脚本失败或超时时写回；与检测、顶层更新共用更新锁，串行执行。
- npm 行的 `releaseUrl` 来自 registry 响应的 `repository` 字段，包未声明仓库或仓库不在 GitHub 时行名没有外链。
- 更新完成后需要重启 dsh-gui 才会加载新的插件版本；npm 行不需要重新构建，git 行需要 `npm run build`。
- 分离式更新器只处理 git 行：`pending-updates.json` 不包含 npm 行，调用 `start_update` 请求 npm 行 id 会被拒绝。

## 一次性 node 脚本的退出约定

更新检查的 npm 版本核对（git 行的发布状态与 npm 插件行的 `/<pkg>/latest` 探测）与「更新日志」都靠 Rust 侧写出临时 `.mjs`、再以文件重定向 stdio 启动 `node` 执行。这类脚本**不得调用 `process.exit()`**：在 Windows 上 `fetch`（undici）的连接池仍持有待处理的 async 句柄，此时退出会让 libuv 断言

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
```

并把进程判为异常退出。这条约定、根因与回归测试见 [update-changelog.md](update-changelog.md)。

## 子模块远端的路径自愈

git 在 `git submodule update --init` 时会把解析出的 URL 固化进仓库的 `submodule.<name>.url` 覆盖项与每个子模块的 `remote.origin.url`。检出迁移到新目录后，这些值仍指向旧位置的绝对路径（例如 `E:/Git/dsh-gui/<path>`），于是更新检查的每一行都报 `fatal: '<旧路径>' does not appear to be a git repository`，全部 submodule 显示「不可检查」。

`.gitmodules` 是权威来源：它就在检出内部，URL 相对**当前**仓库根（`DSH_GUI_ROOT` 解析出的那个根）生效，不依赖任何记录下来的绝对路径。因此 `src-tauri/src/update.rs` 的 `reconcile_submodule_remotes` 在每次检查前、以及弹窗内顶层「更新」的递归子模块同步前，把**本地路径形式**的覆盖项与子模块 `origin` 改写成 `.gitmodules` 记录的 URL；远端形式的覆盖（镜像、fork）视为刻意配置，保持不动。修复计数写入 `.dsh/gui/gui.log`。

验证 worktree 与主仓库共享 git 配置，`scripts/staging.mjs` 因此不单独处理子模块 URL：其中的 `git submodule update --init --recursive` 直接沿用主仓库解析出的远端。

## 相关文件

- `scripts/plugin-install.mjs` —— 安装期记录 npm 包名
- `src-tauri/src/update.rs` —— git 行检测、npm 插件行扫描与 registry 探测、就地更新（`run_npm_plugin_update`）、`release_page_for` 与 `github_releases_url`
- `src-tauri/src/main.rs` —— `check_updates`、`local_update_projects`、`cached_update_status`、`update_root`、`update_npm_plugin`、`start_update` 命令
- `src-tauri/src/update_script.mjs` —— 分离式更新器（只处理 git 行）
- `src-tauri/src/changelog.rs` —— `releases_page_url`（行内与标题链接共用的 URL 解析）
- `src-tauri/ui/app.js` —— 两类行的渲染与就地/批量更新、AI 提示词、行内链接渲染
- `docs/dsh-gui/desktop-auto-update.md`、`docs/dsh-gui/2026-11-01-npm-plugin-update-check.md` —— desktop 插件侧行为与行模型设计
- `scripts/staging.mjs`、`docs/dsh-gui/upgrade-staging-workspace.md` —— 升级验证 worktree
