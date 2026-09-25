# 更新检查（update check）与 npm 发布状态

## 功能

dsh-gui 的「检查更新」把 dsh-gui 仓库本体与每个 git submodule 同远端默认分支
比较：行内显示「当前 → 最新」、最新 tag 与提交数，并提供「更新」/「AI 更新」。
对 **npm 安装型** wrapper（`installNpmPlugin`，例如 `dsh-web-ui`、`better-sidebar`、
`plugin-market`），仓库新 tag 可能只是源码发布，上游 npm 尚未发布对应版本——
直接移动 submodule checkout 不会同步已安装的插件本体。
`harness.json` 选择 `npm` 运行时后，dsh 运行时本身也是 npm 安装型：该行同样
先核对最新 tag 是否已有 `@deepseek-ai/dsh` 的 npm 发布，再决定是否安装。

## AI 更新的 tag 保留规则

「AI 更新全部」与行内「AI 更新」不会把 **tag 版本更新到非 tag 提交**：若某个
模块（含顶层仓库）当前正好检出于某个 tag、而远端默认分支只有更新的提交、没有
更新的 tag（即 `announce = false` 的“仅提交更新”情形），该行不会进入
「AI 更新全部」，其行内「AI 更新」按钮置灰禁用（不建议执行）。如确需跟进这类
模块，请用行内的「更新」流程（确认后「重启并更新」）。

实现：`src-tauri/ui/app.js` 的 `isOnTagWithoutNewer`（复用 Rust 端
`announce` 字段）过滤 `updatableProjects`（AI 资格），并在 `renderUpdateDialog`
无可更新行时隐藏「AI 更新全部」；被过滤的行因此不会进入预填的模块清单。该跳过
规则同时写在 skill `dsh-gui-update` 的更新目标与跳过规则中。

## AI 更新的提示词与预设

「AI 更新」/「AI 更新全部」启动后，dsh-ai-update 浏览器半（
`plugins/ai-update/dsh-ai-update/src/client/index.ts`）在落地空白会话上自动
调用 `ctx.remote.agentPresets.select(sessionId, 'cordis')` 选中 **「创造模式」**
（harness 内置 `cordis` preset，提供运行时检查、插件实验与 preset 创作指导），
再预填升级提示词；选择被拒绝时请求失败返回错误，而不是静默落到默认预设。用户
发送前仍可自行切换预设 chip。

提示词由 `src-tauri/ui/app.js` 生成（`buildAiUpdatePrompt` 与两个基座提示词
构造器），以 `/dsh-gui-update` skill 手势开头：host 侧的 `dsh-tool-skill` 会把
该 skill 的内容注入会话，升级流程全部由该 skill 承载，提示词只补充模块名、
路径、当前版本、更新目标，以及 skill 无法从对话框得知的验收门槛
（`AI_UPDATE_GATE_NOTE`，三类提示词——单模块、仅 harness、harness 与插件批量
——都带这段）：

1. 先在 `.staging/dsh-gui` 副本中更新与验证；**「验证通过」指副本的 WebUI
   能正确加载**（会话界面正常渲染、能新建或载入会话、插件与组合无加载报错），
   构建全绿与 `--dump-config` 无报错都只是前置条件；
2. 本次更新包含 `deepseek-harness` 时，还要用 computer use 验证 GUI（桌面
   外壳）能在副本中正常启动和运行；
3. 验证全部通过后先向用户报告结论，**等用户明确审批后**才执行阶段二，把更新
   同步到本工程。

验收命令与判据见
[upgrade-staging-workspace.md](upgrade-staging-workspace.md) 与 skill
`dsh-gui-update`。

## 检测与标注

- **安装记录**：共享流水线 `scripts/plugin-install.mjs` 的 `installNpmPlugin`
  把每个 npm 包名（含被 `DSH_PLUGIN_SKIP` / wrapper `skip` 默认跳过的包——记录
  先于安装判定写入，跳过与否都留档）追加写入
  `.dsh/gui/npm-installs.json`（运行时缓存、gitignored）；`harness.json` 的
  `npm` 运行时在（重）安装后由 `scripts/dsh-gui.mjs` 追加 `@deepseek-ai/dsh`。
- **归属判定**：`src-tauri/src/update.rs` 扫描每个 submodule 的 `package.json`
  （根 manifest + `apps/*` + `packages/**`），与上述 registry 求交集，得到该行
  所属的 npm 包集合。`apps/*` 覆盖 dsh 运行时所在的 `@deepseek-ai/dsh`。
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

## 一次性 node 脚本的退出约定

更新检查的 npm 版本核对与「更新日志」都靠 Rust 侧写出临时 `.mjs`、再以文件重定向
stdio 启动 `node` 执行。这类脚本**不得调用 `process.exit()`**：在 Windows 上
`fetch`（undici）的连接池仍持有待处理的 async 句柄，此时退出会让 libuv 断言

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
```

并把进程判为异常退出。这条约定、根因与回归测试见
[update-changelog.md](update-changelog.md)。

## 相关文件

- `scripts/plugin-install.mjs` —— 安装期记录 npm 包名
- `src-tauri/src/update.rs` —— registry 读取、submodule 扫描、npm 查询
- `src-tauri/ui/app.js`、`src-tauri/ui/titlebar.css` —— 行内标注渲染
- `scripts/staging.mjs`、`docs/dsh-gui/upgrade-staging-workspace.md` —— 升级验证副本
