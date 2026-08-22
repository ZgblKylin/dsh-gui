# 开发约定

本仓库是deepseek-harness的tauri wrapper，以及个人自用的 DSH 插件集合。所有插件使用现有 DSH/Cordis 接口编写，目标是能在官方原版 DSH中无额外依赖直接加载。
若用于修改/编辑已有插件时，检查插件子工程内的AGENTS.md、CLAUDE.md、README.md、docs/等文档，同时需要遵循目标子工程的贡献约定（如有）。

## 目录结构

- .dsh: dsh配置目录
- deepseek-harness: dsh框架本体
- docs: 文档目录
- plugins: 本地插件目录
- presets: agent preset源目录（presets/<id>/自带install.mjs，npm run build时统一安装到.dsh/.agent-presets/）
- src-tauri: tauri源码目录
- scripts: 启动脚本目录

- `deepseek-harness/` 是 pinned 上游子模块，只用于查证规范；不要编辑其中的任何文件，不要从该目录向插件源码复制代码。
- 新增插件在 `plugins/<id>/<package>` 下创建（见 `plugins/README.md` 与 `dsh-gui-plugin-dev` skill）：wrapper `install.mjs` + 包（内嵌或 git submodule），包内 `package.json`、`src/index.ts`（或 `index.js`）、`README.md`，必要时附 `tests/`。

## 环境检查

不清楚当前运行环境时，先确认当前 shell 和系统，再继续操作：是 PowerShell
（pwsh）、Git Bash，还是 WSL、Linux、macOS。尤其在处理换行符、路径分隔符
或 git 行尾转换（core.autocrlf）之前必须确认；可用 `uname -a`（类 Unix
环境）或 `$PSVersionTable`（pwsh）辅助判断。只有 `run_code` 可直接调用时
（Code Mode），用一个 `run_code` 程序检测系统即可，无需检测 shell：

```ts
// 仅检测系统（不检测 shell）
console.log({ platform: process.platform, arch: process.arch })
// 例：{ platform: 'win32', arch: 'x64' }
```

其中 `win32` 为 Windows、`linux` 为 Linux、`darwin` 为 macOS。

## 项目 Skills

- **`dsh-plugin-install`**：安装/卸载 DSH 插件到 profile 的标准流程。涉及插件安装、卸载、更新、源码编译安装时，先加载该 skill。其内容基于 `dsh plugin --profile <profile> add --help`（受管安装器转发的 pnpm add）的权威安装方式列表：npm 包 / tag / 版本 / 版本范围 / git 简写 / git URL / 本地 tgz / tarball URL / 目录。
- Skill 存放于 `.agents/skills/<skill-name>/SKILL.md`（frontmatter 含 `name`、`description`、`whenToUse`）。

## 工具与终端

以下约定确保可用工具能被按需使用，避免在 git bash、windows换行符 等特殊环境的调用细节上反复尝试。

- Windows 环境需注意文件使用 CRLF 换行符，避免在 git bash 中使用 sed、grep 等工具时出现问题。
- Windows 环境需要调用 PowerShell 时，先检测 `pwsh` 是否可用；可用则优先使用 `pwsh`。
- 搜索文件和内容时，先检测 `rg` 是否可用；可用则优先使用 `rg`。
- 有 `skill_search` / `skill_load` 时，先按需检索是否存在所需 skill。
- 有 `dev_tool_search` 时，在需要时优先用它加载工具来代替终端命令：
  - `grep`、`sed` 等搜索和编辑工具
  - `web_search` 等进阶工具
  - `subagent`、`workflow` 等 agent 任务编排工具

## 自托管

dsh-gui的环境（dsh和插件）使用自托管，DSH_HOME安装至本仓库`.dsh`路径，不要使用系统全局安装。

无dsh-gui环境，只将本仓库作为插件列表时，使用系统全局的.dsh路径即可。

## 插件开发规范（基于官方 plugin-development.md 与生态倡议）

### 组合优先、声明清晰、兼容优先

1. **组合优先**：通过官方 slot、service 和 patch 组合能力；不要假设或覆盖其他插件的内部实现。
2. **声明清晰**：用 `inject` 显式声明依赖的 service 和 slot，不依赖运行时巧合。
3. **兼容优先**：升级保持向后兼容，不破坏已有组合。

### Cordis 基本规则

- 插件是一个返回 `{ name, inject, apply(ctx) }` 的对象（或 Service 子类）。`inject` 列出必需依赖；Cordis 会让插件等待这些服务出现后再激活。
- **注册是 effect**：任何注册（事件监听、工具、命令、定时器、流）都必须通过 `ctx.effect()` / `ctx.on()` 或返回 disposer 的官方 helper，保证 reload/teardown 可逆、顺序可控。
- **Waterfall 监听器必须调用 `next()`** 才能把（可能被包装的）结果传给下一个监听器；不调用即为短路。需要先于普通注册运行时才用 `prepend: true`。
- 事件按 `emit` / `waterfall` / `parallel` / `serial` 四种模式分发，模式是事件的公开契约，不得混用。
- 捕获行为优先走事件（拦截/策略），直接能力调用优先走 service 方法。

### 读取可选服务

- 用 `ctx.get('serviceName')` 读取可选服务并处理 `undefined`；只有硬依赖才放进 `inject`。
- 只有声明在 `inject` 里的服务才能作为 `ctx.serviceName` 访问，绝不访问未声明的服务。

### 跨环境插件（普通 DSH + dsh-gui）

- 同一插件若要在普通 `dsh web` 和 dsh-gui 都能运行，不要把 dsh-gui 放进顶层 required `inject`。先注入普通依赖，再在 `apply` 中探测桌面封装环境。
  - 不存在 → 挂载普通 DSH fallback（fallback 仍是插件的权威实现）。
- dsh-gui only 插件才把桌面封装的相关依赖放进顶层 `inject`。

### 安全边界

- Capability/权限声明用于兼容判断、用户确认与审计，**不是安全沙箱**。受信任的同进程 JS 插件可以绕过 `ctx` 直接调操作系统接口。
- 不要在文档中把"声明通过"描述成安全审核或权限强制。

### 插件市场（Community Market）约束

Market 是社区开发的开放插件市场，只消费 npm package，**不发明新插件格式**；本仓库插件如要在市场中被收录/安装，需满足其已实现的公开契约：

- **包必须可被受管安装器接纳**：发布到 npm 的 package 应使用精确稳定的 SemVer 版本；不得依赖 GitHub URL、版本范围、`latest` tag 或 prerelease 作为安装目标。
- **不得定义安装 lifecycle script**：manifest 中不得出现 `preinstall`、`install`、`postinstall` 或 `prepare`（受管安装器会拒绝这类 package）。
- **运行时兼容**：声明的 DSH/Cordis 依赖需与官方 DSH runtime 兼容；`engines.node` 需接受 Node.js LTS runtime。
- **需要 DSH bundle 证据**：若要作为 bundle 被加载，`dsh.bundle.patch` 必须指向 package 内真实存在的文件，且不得越出 package 目录。
- **安全合规**：package 需由官方 npm 提供 HTTPS tarball 与合法 SHA-512 integrity。
- **收录 ≠ 安全审核**：目录条目被展示或出现在"可安装"页，不代表任何一方审核、推荐或背书；插件 README 与文档不得暗示这一点。

### bundle 加载（`dsh.bundle.patch`）注意事项

- `dsh.bundle.patch` 是**官方契约**（非社区私有约定）：npm 包的 manifest 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，即成为一个可安装的 profile bundle 层。
- 官方依据：`packages/boot/app-boot/src/profile.ts` 的 `DshBundleManifest`；`docs/user/develop/basic/publish.md`（bundle 教程）；`apps/cli/reference/README.md`（`dsh plugin add` 后按该声明 reconcile `dsh.profile.bundles`）；`docs/architecture.md`（"`dsh.bundle` points at a bundle's patch file"）；官方内置 `packages/bundle/{base,web-app,headless}/` 均为此格式。
- 流程：`dsh plugin --profile <name> add <pkg>` 安装后，若 manifest 声明了 `dsh.bundle`，CLI 自动把该包追加进 `dsh.profile.bundles`；profile 启动时按列表顺序应用各 bundle 的 patch 层。
- 因此**同时带 client 半的插件**（`dsh.client`）也走 bundle 通道即可：patch 里 `insert` 自己的 Loader row（`name` 为包名），Node 半侧扫描该 entry 的 `dsh.client` 并服务浏览器 bundle，无需手工改 profile 的 `cordis.patch.yml`。
- patch 文件必须随发布包含（`files` 白名单加 `cordis.patch.yml`），且路径不得越出 package 目录（Market 安装器会校验）。
- 未声明 `dsh.bundle` 的包仍可安装，但只作为普通依赖、不激活任何层（CLI 打印一次性警告）。

## 质量要求

- 每个插件至少验证：
  - 在普通 DSH 中无 dsh-gui 时能加载（或按产品定义保持 pending）；
  - dsh-gui 中读取的 profile name/dir 与用户实际选择一致；
  - package operation 的取消、非零退出、spawn failure 与 teardown 路径；
  - 插件变更重启后 bundle 能进入下一次 Loader 组合。
- 为每个插件写简短 README：说明用途、依赖的 service/slot、配置项、已知限制。
- 插件行为有显著变化时更新 README，保持文档与代码同步。

## 沙箱与提权

- 构建、安装、运行、调试等操作可能被 dsh 沙箱拦截。
- 被拦截时**不要尝试用非标手段绕过**（改路径、直接调底层二进制、禁用安全检查、手工模拟产物等）。
- 正确做法：**通过工具（pwsh 等）以 `sandbox_permissions` 向用户申请提权**，使用最窄的足够宽模式（通常 `danger-full-access`），并附一句理由；由用户在审批弹窗中决定是否放行。
- 提权只针对被拦截的那条命令；审批被拒或环境限制（如沙箱端口/连接数限制）依然存在时，如实报告并换用合规手段（如降低并发重试），不反复尝试绕过。

## Git 提交规范

- 采用 Conventional Commits：`feat:` / `fix:` / `chore:` / `docs:` / `build:` / `refactor:`，正文按需使用。
- 外层仓库与 `plugins/<id>/` 子模块各自独立提交；改动跨越两者时分别编写 commit message。
- **不主动执行 `git commit`**：dsh 沙箱限制下由 dsh 生成的提交无法引用用户 GPG 签名，直接提交会绕过用户的签名配置。
- 完成代码改动后，将变更添加到暂存区（`git add`），编写 commit message，并在回复中提醒用户手动执行 `git commit`（以便 GPG 签名与提交钩子生效）。
- 提交前检查 `git status` 确认暂存范围正确；不要提交 `node_modules/`、`lib/` 等构建产物（已由 `.gitignore` 排除）。

### 预提交 checklist（每次提交前逐项核对）

**官方指南（DSH/Cordis）**
- [ ] 插件遵循 Cordis 插件模型：`inject` 显式声明依赖，注册均为 effect（`ctx.effect`/`ctx.on`/disposer）。
- [ ] 未依赖任何 dsh-gui 内部接口。
- [ ] 跨环境插件：普通 DSH fallback 为权威实现，dsh-gui 相关功能通过探测环境条件启动。
- [ ] `package.json` 的 `dsh` 段、`exports`、构建产物路径与官方 client/bundle 契约一致。
- [ ] README 反映当前行为；显著行为变化已同步更新。

**社区约定（生态倡议 / Fabric 约束参考）**
- [ ] 组合优先：未覆盖或假设其他插件内部实现；通过官方 slot/service/patch 组合。
- [ ] 声明清晰：依赖的 service/slot 已显式声明，无运行时巧合依赖。
- [ ] 兼容优先：未破坏已有组合；升级保持向后兼容。
- [ ] Fabric 仅作约束参考：插件代码/README/package.json 未引用或 import Fabric 的 Draft 接口。

**插件市场（Community Market）约束**
- [ ] 版本为精确稳定 SemVer；无 GitHub URL、版本范围、`latest` tag 或 prerelease 安装目标。
- [ ] 未定义 `preinstall`/`install`/`postinstall`/`prepare` lifecycle script。
- [ ] `engines.node` 与 dsh-gui 内置 Node LTS 兼容。
- [ ] `dsh.bundle.patch`（若声明）指向 package 内真实文件且不越界。
- [ ] `files` 白名单正确，发布 tarball 只含必要构建产物；`private` 标记与发布意图一致。
- [ ] README 未暗示"被收录/审核/推荐"。

## 文档

所有工程/子工程均需要同步维护文档，来自官方和第三方仓库的文档参考文档通过符号链接汇总：

- `docs/official`: 官方 DSH 文档与源码参考（`deepseek-harness/` 内的官方内容）：
  - `cordis-primer.md` — Cordis 五种核心思想、事件模式、waterfall 语义
  - `develop-basic/` — 开发者基础教程目录（含 `publish.md` bundle 打包/发布教程、`config.md`、`index.md`、`tool.md` 等）
  - `cli-reference.md` — profile 组合、`dsh plugin add` 与 bundles reconcile 行为
  - `app-boot-profile.ts` — `DshBundleManifest` 与 profile/bundle 加载契约
  - `packages-bundle/` — 官方内置 bundle（base / web-app / headless）的 patch 层实例
  - `examples/` — 官方示例（`deepseek-harness/examples`）
- `docs/dsh-gui`: 本仓库（dsh-gui）文档
- `plugins/<plugin-name>/<plugin-submodule>/docs`: 插件文档
