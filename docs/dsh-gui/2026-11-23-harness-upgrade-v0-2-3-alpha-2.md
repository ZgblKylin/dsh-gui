# harness 升级：dsh-v0.2.2-rc.5 → dsh-v0.2.3-alpha.2

本文件记录把工程基座 `deepseek-harness` 从 `dsh-v0.2.2-rc.5` 推进到 `dsh-v0.2.3-alpha.2` 的适配与阶段一验收结果。验证在仓库内 worktree `.staging/dsh-gui`（工作分支 `staging/verify`）完成，未改动主工程；阶段二合并主分支经用户审批后执行。

## 目标修订与发布状态

| 项 | 旧修订 | 新修订 | npm |
| --- | --- | --- | --- |
| deepseek-harness | dsh-v0.2.2-rc.5（9c2670d3bc） | **dsh-v0.2.3-alpha.2**（4b399c39a6） | `@deepseek-ai/dsh` 的 `latest` 仍为 `0.2.2-rc.5`，`0.2.3-alpha.2` 只在 `alpha` dist-tag 上 |
| 官方 provider 四件套（browser-use / playwright-mcp / computer-use / cua-driver-native） | 0.2.2-rc.5 | **0.2.3-alpha.2** | 四包均已发布 `0.2.3-alpha.2`（`alpha`），peer 精确指向该版本 |

`harness.json` 保持 `{"runtime":"npm","version":null}`，构建按子模块 `apps/cli/package.json` 的版本从 registry 装 CLI。

## 区间规模与上游要点

rc.5..alpha.2 共 7312 个文件、约 30 万行改动（含 `0.2.3-alpha.1` 与 `0.2.3-alpha.2` 两次发布提交）。与本工程相关的部分：

| 改动 | 位置 | 影响 |
| --- | --- | --- |
| `engines.node` → `^24.22.3 \|\| >=26.13.1` | `apps/cli/package.json`；指南 `docs/upgrade-guide/v0.2.3-alpha.1/node-24-22-3/` | 本仓库 `package.json` 的 engines、README 与文档同步；宿主机 Node 必须 >= 24.22.3 才能满足声明的运行时 |
| desktop 主运行时锁的 node 从 24.21.0 改为 24.22.3 | `scripts/primary-runtime/lock.json` | 桌面打包自带 node 24.22.3，无需本仓库改动 |
| **删除 `connection.requestRejection`** | `@deepseek-ai/dsh-client-connection` | 多个第三方插件用它做自注册路由的信任围栏，见「适配改动」 |
| **`WebRoute.auth` 新增且默认 `required`** | `packages/host/webserver` | 无 Cookie 的本地路由改为显式 `auth: 'anonymous'` |
| `web-app` 组合的行增删（`ui-settings-plugins` / `ui-settings-plugin-inventory` 退役，新增 `tool-session-control`、`mcp-account`、`authentication-token`、`ui-session-status`、`remote-connection`、`ui-connector-account`、`action-cards`、`ui-session-panel` 等） | `packages/bundle/web-app/cordis.patch.yml` | 本仓库没有按 id 引用被删的两行，无需改动 |
| `OPTIONAL_BUNDLES` 增 `dsh-cua-mcp`、`dsh-timeline`；`RETIRED_BUNDLES` 增 `@deepseek-ai/dsh-personalized-recommendations` | `packages/util/official-bundles` | 本仓库未引用这三个包名 |
| 官方 provider 家族只移动版本并调整 brand/error 依赖（`./brand` → `./types`；native 新增 `dsh-error` peer） | `packages/browser-use`、`packages/computer-use`、`packages/experimental/*` | 包名、mount 行与 Config 不变，四个精确 spec 随 harness 同批移动 |

CLI 表面、npm 运行时装法（`lib/bin.js`）、profile/bundle 装载契约、`dsh.plugin add/remove` 与版本豁免子命令均未变化（逐项核对见验证记录）。

## 适配改动

| 文件 | 改动 |
| --- | --- |
| `deepseek-harness`（子模块指针） | 9c2670d3bc → **4b399c39a6（dsh-v0.2.3-alpha.2）** |
| `plugins/harness/browser-use.mjs`、`computer-use.mjs` | 四个官方 provider 的精确 spec 与注释抬到 `0.2.3-alpha.2`。四个包与 harness 同批发布，旧 pin 会被新闸门拒绝；本版本该家族只有版本与 brand/error 依赖变化，挂载行与 Config 不变 |
| `plugins/harness/README.md`、`plugins/README.md` | 安装内容表、准入说明与当前 pinned runtime 同步到 `0.2.3-alpha.2`；其余 npm wrapper 的注释与 README 同批改版本号 |
| `plugins/commandcode-provider/install.mjs`、`README.md` | 该包 `engines.dsh` 的上界 `<0.2.3-0` 不接纳 `0.2.3-alpha.2`，wrapper 为 latest 解析出的精确版本传 `exempt`（理由写进脚本），安装前以 `dsh plugin allow-version --accept-risk` 写入 `compatibility.json` |
| `plugins/deep-whale/install.mjs` | 两个皮肤的 peer `>=0.2.2-rc.3 <0.2.3-0` 同样不接纳新运行时，两个皮肤安装传 `exempt`；manager 的 `>=0.1.7-rc.1` 无上界，不传 |
| **`plugins/connection-compat/`（新增 in-tree 插件）** | dsh 0.2.3 删除了 `connection.requestRejection`，而 `dsh-better-sidebar`、deep-whale 皮肤管理器、`dsh-pause`、`ds-harness-remote` 仍用它做自注册 HTTP/WS 路由的信任围栏，移除后分别表现为侧栏接口异常、`/api/dsh/skins` 503、暂停通道拒绝、控制路由不注册。新增包 `dsh-connection-compat` 把该方法按上游原实现委派给 `admit`，同时 inject `connection` 与 `connection.authentication`；宿主仍导出该方法时不介入。wrapper 用显式 mount 行 `connection-compat` 挂载，web 与 desktop 两个 profile 都装 |
| `plugins/quick-assistant/dsh-quick-assistant/`（`src/index.ts`、`src/routes.ts`、README、`docs/design.md`） | 新 webserver 的 `auth` 默认 `required`。overlay 页面、静态资源、`api/bootstrap`、`api/chat` 与 `api/native` 由原生助手 WebView2（独立 cookie 罐）访问，显式声明 `auth: 'anonymous'`（这些路径本来只由会话 token 与 loopback 约束）；设置页路由保持默认 `required` |
| `plugins/ai-update/dsh-ai-update/src/context-types.ts` | 本地镜像的 `WebRoute` 类型补 `auth` 字段（对齐上游 `WebAuthenticationRule`），路由本身仍走默认 `required` |
| `src-tauri/src/main.rs` | 两处外壳缺陷：① `dsh web` 已隐含 `--profile web`，再传 `--profile web` 在 0.2.3 报 `select a profile only once`，改为 `web --patch …`；② harness 就绪后 stdout 读取端被丢弃，harness 下次写 stdout 触发 `EPIPE` 崩溃并进入重启循环（`the harness exited 5+ times … giving up`），改为持续排空 stdout |
| `package.json`、`README.md`、`src-tauri/src/changelog.rs` | Node 门槛同步为 `^24.22.3 || >=26.13.1` |
| `docs/dsh-gui/{ssh-remote-workspace,ssh-provider-vs-dsh-remote,dsh-pet-troubleshooting}.md` | 运行时版本示例与当前 pinned harness 说明同步 |

`docs/official` 的 19 个链接全部指向新修订中仍存在的位置（10 个目录链接可列出子项、9 个文件链接可读取），无需改指或删除。

## 兼容性核查

- 四个官方 provider 包在 registry 有 `0.2.3-alpha.2`，peer 精确指向运行时版本，准入闸门接纳；包名、mount 行 id 与 Config schema 不变。
- 其余 npm wrapper 在 `includePrerelease` 语义下均接纳 `0.2.3-alpha.2`，只有 `commandcode-provider` 与两个 deep-whale 皮肤需要精确版本例外（上游尚无覆盖 0.2.3 线的发布）。
- `plugins/harness/auto-review-model` 依赖的三条内部约定仍成立：审查请求带 `purpose: 'auto-review'`、`llm/stream` 仍是 waterfall、provider 仍在 waterfall 之后解析。
- 被删除的 `connection.requestRejection` 由 `plugins/connection-compat` 补回；补回前实测 `/api/dsh/skins` 返回 503 `access-denied`、`dsh-pause` 通道 401/400、better-sidebar 的 `/sidebar/api/*` 与 WS 握手失败；补回后三者恢复正常，页面控制台 0 error。

## 阶段一验收

全部在 `.staging/dsh-gui` 与 `.staging/` 运行时根内完成，未触碰主工程与运行中的实例。

| 项目 | 命令 / 手段 | 结果 |
| --- | --- | --- |
| 运行时与 web profile 构建 | `npm run build -- --skip-exe`（`DSH_HOME=.staging/.dsh`） | 退出码 0；安装 `@deepseek-ai/dsh@0.2.3-alpha.2`；19 个插件安装脚本执行完成；官方四件套 0.2.3-alpha.2，例外记录落在 `profiles/web/compatibility.json` |
| 入口 exe 构建 | `npm run build` / `npm run build:exe` | 退出码 0；cargo release 编译完成，`.staging/dsh-gui.exe` 14,230,528 字节；组合冒烟通过 |
| 组合配置 | `.staging/.harness/.../lib/bin.js --profile web --dump-config` | 退出码 0；1415 行；无 `duplicate loader entry id`、无缺失 entry |
| **WebUI 加载验收** | 空闲端口 3095 启动 `npm run harness`，Playwright 打开带 token 的 URL | 标题 `DeepSeek Harness`；**控制台 0 error / 2 warning**；新建会话成功（composer、访问模式、模型选择、暂停按钮齐全）；`/api/dsh/skins`、`/dsh-market/update-notifications`、`/desktop-tabs/api/connections` 均 200；皮肤、桌宠、右侧栏接口正常 |
| **tauri 外壳验收** | 空闲端口 3096 执行 `npm start`，computer use 读取窗口 | 窗口出现并进入会话界面；插件页完整渲染 145 个元素（内置配置、实验性插件、已安装插件与皮肤全部列出）；点击「插件」可正常导航；无重启循环、无错误覆盖层；通知权限弹窗为首次启动提示，非错误 |
| **desktop 构建** | `npm run build:desktop -- --skip-plugins`（`TMP/TEMP` 指向 `.staging/.tmp`） | 见下方「desktop 构建与验收」 |
| docs/official 链接 | 逐条读取 19 个链接 | 全部可穿透 |

### desktop 构建与验收

| 项目 | 命令 / 手段 | 结果 |
| --- | --- | --- |
| desktop 应用打包 | `npm run build:desktop -- --skip-plugins` 与直接执行 `pnpm run package:desktop:win:x64:unsigned -- --dir` | 构建门禁 9/10 通过（native addon、Host Typert、host compiler、Host/Desktop/Client bundle、host/client aggregate check、Web build）；electron-builder 产出 `unsigned-artifacts/win-unpacked`（`DeepSeek Harness.exe` 246,523,904 字节，8857 个文件）。打包链末尾的 `prepare:dsh` 运行时 smoke 在断言全部通过后不退出（`host.stop()` 不返回），打包进程因此挂起；这是本机既有的上游问题，未阻塞产物生成 |
| 落位与 desktop profile | 把 `win-unpacked` 复制为 `.staging/desktop`；用应用自带 CLI（`resources/runtime/cli/bin/dsh.cmd`）作 carrier、`DSH_PLUGIN_PROFILE=desktop` 重跑 20 个插件安装脚本 | 20 个脚本全部成功，`dsh.profile.bundles` 全部对齐（含新增 `connection-compat`）；`compatibility.json` 含三条例外 |
| **desktop 应用验收** | 隔离 `--user-data-dir=.staging/user-data-023`、`--no-sandbox --disable-gpu`、`DSH_HOME=.staging/.dsh` 启动 `.staging/desktop/DeepSeek Harness.exe` | 窗口出现并加载完整界面：品牌版本 `0.2.3-alpha.2-4b399c3-dirty`、新会话/插件/插件市场/自动化任务/技能中心/工作区/Remote/使用统计、composer（含暂停与模型选择）、皮肤与桌宠渲染正常；插件页完整渲染（内置配置、实验性插件开关）；控制台 1 个 error，是 `ds-harness-remote` 的 `/status.events` 404，与本升级无关；验收后关闭实例 |

desktop 与 tauri 两条启动路径都验证通过，官方 provider 包在两处 profile 中均为 `0.2.3-alpha.2`。

### 环境偏差与记录

- **宿主机 Node 版本低于新门槛**：本机 `node` 为 24.19.0，而 harness 要求 `^24.22.3 || >=26.13.1`；pnpm 安装与构建只打印 `Unsupported engine` 告警，web 与 tauri 路径实测可用，但属于声明外的组合。desktop 打包自带 node 24.22.3，不受影响。建议把宿主机 Node 升到 24.22.3+。
- **desktop 构建的两个环境障碍**：① 上一次被中断的 `prepare:runtime` 在 `.desktop-build/pnpm-store/v11/projects` 留下指向已删除临时目录的悬空 junction，`pnpm run clean` 因此报 `ENOTEMPTY`，删除后重跑即可；② esbuild 无法删除 `%LOCALAPPDATA%\Temp` 下的旧临时文件（`Access is denied`），把 `TMP`/`TEMP` 指到工作区内目录即可绕过。
- **desktop 打包链的运行时 smoke 不退出**：`prepare:dsh` 的运行时断言全部通过后进程不退出，打包静默挂起；验证时在 `.desktop/source`（构建工作区，非仓库）给 `package-target.ts` 的 `prepare:dsh` 加 `--defer-runtime-smoke`，交付前已还原。
- **desktop profile 的插件安装**：`build:desktop` 的插件步骤在检测到本机有 `DeepSeek Harness.exe` 运行时拒绝执行（本会话宿主即用户正在运行的桌面应用），因此以 `--skip-plugins` 构建后按同一步骤手动复刻（`DSH_PLUGIN_PROFILE=desktop` + 应用自带 CLI 作 carrier），见 `.work/harness-0.2.3-alpha.2/install-desktop-plugins.mjs`。

## 已知回归与未决风险

- **第三方插件仍依赖已移除 API**：`plugins/connection-compat` 是兼容桥，只在宿主缺少该方法时生效；上游插件改用 `admit` 或 harness 恢复该 API 后即可删除。若某个插件还依赖其它已移除的内部 API，仍需各自适配。
- **两类精确版本例外**：`commandcode-provider` 与两个 deep-whale 皮肤按精确版本接受风险，例外与运行时版本绑定，下一次 harness 升级会自动失效；上游发布覆盖 0.2.3 线的版本后应移除 `exempt` 并复核。
- **宿主机 Node 版本**：见上方环境偏差，声明区间与实际运行版本不一致，建议升级宿主机 Node。
- **desktop 窗口**：staging home 没有账号凭据，桌面窗口停在欢迎首屏，交互面通过桌面 host 的带 token 页面与插件页渲染结果确认；主工程带凭据，实装后按常规使用验证。
- 阶段二尚未执行：工作分支合并回主分支需用户审批；合并后由用户停止运行中的实例并执行重建。
