# Harness 升级后构建失败排查记录（2026-08-30）

## 背景

`deepseek-harness` 子模块从 `dsh-v0.1.1-rc.2`（b150a55，父仓库记录值）升级到
工作区 `dsh-v0.1.2-alpha.1`（cd5ef81）后，`npm run build`（即
`node scripts/dsh-gui.mjs build`）在 harness 构建阶段失败。

## 症状

- tsdown/rolldown 报 `Build failed with 7 errors`，全部为 `MISSING_EXPORT`，
  import 位置集中在残留产物 `lib/types/api-proxy.js`：
  - `resolveSessionPreset`（来自 `@deepseek-ai/dsh-agent-presets`）
  - `ApiRemoteSessionNotFound`、`ApiRemoteSubagentSessionOwnership`、
    `apiRemoteSubagentOwnershipError`、`createApiRemoteAgentResolver`
    （来自 `@deepseek-ai/dsh-api-remotes`）
  - 这些符号在新版本 `src/index.ts` 中均已不存在。
- 最终 `[ELIFECYCLE] Command failed with exit code 1`，构建中止。
- 完整日志见仓库根 `npm.log`（首次失败日志，仅供追溯）。

## 根因

上游 `dsh-v0.1.2-alpha.1` 删除了 7 个包，旧版本构建产物残留在子模块工作区：

| 残留目录 | 状态 |
| --- | --- |
| `packages/host/apiproxy` | 无 `package.json`、无 `src/`，仅剩 `lib/`、`node_modules/` |
| `packages/client/runtime` | 同上 |
| `packages/client/schema-form` | 同上 |
| `packages/client/web-react` | 同上 |
| `packages/examples/acp-demo` | 同上 |
| `packages/examples/jsonrpc-demo` | 同上 |
| `packages/test-support/acp-snapshot` | 同上 |

这些目录中 `lib/`、`node_modules/` 均被 `.gitignore`（`lib/`、`node_modules`）
忽略，`git checkout` 不清理，且 `git ls-files` 确认上游树中不存在这些路径
（tracked 文件数为 0）。

`deepseek-harness/tsdown.config.ts` 的构建扫描规则为：

```ts
workspace: ['vendor/*', 'packages/*/*', 'apps/cli'],
entry: ['lib/types/{index,invariant,startup}.js'],
```

该 glob 会把上述孤儿目录仍当作构建目标（其 `lib/types/index.js` 匹配 entry
且 re-export 了 `api-proxy.js` 等旧模块），打包时按新版本 `src/index.ts`
解析依赖并校验符号，随即报 `MISSING_EXPORT`。

另：子模块内 `package.json` 的 `packageManager` 曾被本地改为 `pnpm@11.24.0`
（与本次失败无关，属环境对齐的本地改动，已在修复时还原为上游
`pnpm@11.7.0`）。

## 诊断步骤（可复现）

```powershell
# 1. 位置确认
$PSVersionTable
git status --short            # 期望： M deepseek-harness（子模块指针漂移）
git submodule status          # 期望： +cd5ef81...（HEAD 与父仓库记录不符）

# 2. 表明确认（父仓库记录 vs 工作区 HEAD）
git ls-tree HEAD deepseek-harness            # 记录值 b150a55... = dsh-v0.1.1-rc.2
git -C deepseek-harness rev-parse HEAD        # 工作区 cd5ef81... = dsh-v0.1.2-alpha.1
git -C deepseek-harness ls-tree --name-only HEAD packages/host/ | Select-String apiproxy  # 无输出 => 包已删除

# 3. 孤儿残留扫描（workspace 中无 package.json 的目录）
Get-ChildItem deepseek-harness\packages\*\* -Directory |
  Where-Object { -not (Test-Path (Join-Path $_.FullName 'package.json')) } | % FullName

# 4. 确认残留无 tracked 文件
git -C deepseek-harness ls-files packages/host/apiproxy   # 空输出
```

## 修复步骤

```powershell
# 1. 还原子模块本地改动（packageManager → pnpm@11.7.0）
git -C deepseek-harness checkout -- package.json

# 2. 删除 7 个孤儿残留目录（均无 tracked 文件，仅 gitignore 产物）
Remove-Item deepseek-harness\packages\host\apiproxy -Recurse -Force
# 同理：client/runtime、client/schema-form、client/web-react、
#       examples/acp-demo、examples/jsonrpc-demo、test-support/acp-snapshot
# 等价方式：git -C deepseek-harness clean -fdX packages/host/apiproxy

# 3. 验证构建（跳过 cargo，聚焦 harness + 插件 + presets）
node scripts/dsh-gui.mjs build --skip-exe
```

## 验证结果

- 完整构建通过：tsc（host 面）+ tsdown（host/client 面）+ vite web dist +
  218 个 client artifacts 全部产出，耗时正常。
- 插件安装脚本（ai-update、better-sidebar、flowglass、sidebar-qa、deep-whale、
  dsh-web-ui、plugin-market、remote、review、routing-suite 等）与 agent preset
  安装全部成功，无报错。
- 子模块工作区干净，外层仓库仅剩 `git add deepseek-harness` 记录升级指针。

## 预防措施

- 升级 harness 子模块后、构建前，先执行上文"诊断步骤"第 3 步的 孤儿目录
  扫描；存在无 `package.json` 的 `packages/*/*` 目录即说明上游删包残留。
- 升级后建议顺手校验 `git ls-files`，确认残留目录无 tracked 文件后再删除，
  避免误删上游真实文件。
- 不要在子模块内保存本地改动（如 packageManager），升级时一并还原/提交。
- 记录知识：`tsdown.config.ts` 的 `workspace`/`entry` 扫描逻辑不校验
  `package.json` 存在性，任何"被忽略产物目录"都可能混入构建目标。

---

# 附：升级后运行期问题排查记录（同日复验）

构建通过后运行期还有两个问题，均已处置并验证。

## 问题 2：dsh-gui 无窗口 + 90s 超时（浏览器认证未适配）

### 症状

`gui.log` 显示 `timed out after 90s waiting for the harness on 127.0.0.1:3080`，
窗口不出现；`harness.log` 里 harness 正常启动并打印：

```
dsh web: http://127.0.0.1:3080/?token=...
```

### 根因

`dsh-v0.1.2-alpha.1` 的 Web profile 引入浏览器认证
（`packages/client/connection/src/browser-auth.ts`，经 web-app bundle 挂载）：

- 启动时签发一次性 launch token，并打印带 `?token=` 的 URL；
- 无 token 且无有效 cookie 时，`GET /` 与所有 `/api*` 路由统一返回 **401**；
- 首次带 token 的 `GET /?token=...` 返回 `303` + 签名 `Set-Cookie`（cookie
  名形如 `dsh-auth-<hash>`，值与 Host authority 绑定），此后凭 cookie 访问。

而 dsh-gui（升级前版本）的启动协议只认"HTTP 200"：

- `spawn_harness` 把 stdout 直接重定向到 `harness.log`，拿不到 token；
- `main.rs` 的 `http_get_ok` 仅接受 `200` → 401 永远不满足；
- webview 加载裸 `http://127.0.0.1:<port>/` → 无 cookie → 401；
- 主进程无 cookie 的 `remote_call` / changelog 请求同样会被 401 拦截。

### 修复（`src-tauri/src/main.rs`，2026-08-30）

1. `spawn_harness`：stdout/stderr 改为管道，工作线程按行 append 到
   `harness.log`（append 模式句柄，两个流互不覆盖），stdout 行同时回放
   channel 供解析。
2. 新增 `HarnessProcess`（child + 行接收器）与 `HarnessAuth`
   （web_url + cookie）；`wait_ready` 在轮询 HTTP 的同时解析
   `?token=`（`parse_launch_token`），把 **401（gate 就绪）与 200（旧版无认证）
   都视为"已在服务"**，并等待 token 行到达。
3. 新增 `fetch_session_cookie`：token 换取 `Set-Cookie` 首对 `name=value`。
4. `harness_url` 返回带 token 的 URL（wrapper iframe 用它完成 303+cookie）；
   `http_post_json_raw` / `http_post_json` / changelog `web_summary` 增加
   cookie 参数并随请求头发送。
5. 旧版（无 token）harness 自动兼容：无 token 行时用裸 URL、cookie 为 None。

### 验证（实测通过）

```
GET /?token=...        → HTTP 303 + set-cookie
GET / + cookie         → HTTP 200（页面正常）
GET / 无 cookie        → HTTP 401（gate 仍收紧）
gui.log:
[dsh-gui] harness ready at http://127.0.0.1:3080/?token=...
```

`cargo check` / `cargo test`（21 用例全过，含新增
`launch_token_is_extracted_from_the_url_line`）。

## 问题 3：页面 Failed to load plugins（第三方插件旧版 bundle）

### 症状

浏览器打开带 token 的 URL 后页面报：

```
Failed to load plugins
dsh-flowglass
failed to import loader entry ... (@linxin666/dsh-client-ui-web-ui-settings):
client-modules: require("@deepseek-ai/dsh-client-runtime/client") missed the module table ...
```

### 根因（确认为第三方插件生态漂移）

- `@linxin666/dsh-client-ui-web-ui-settings@0.3.6` 的 `lib/client.js` 有
  `require("@deepseek-ai/dsh-client-runtime/client")`（源码注释明示按 rc.6/rc.7
  时代设计），`dsh-flowglass@0.4.1` 的 peerDependencies 也声明
  `@deepseek-ai/dsh-client-ui-primitives=^0.1.1-rc.2`。
- alpha.1 已移除/改名 client 运行时（仅剩 `@deepseek-ai/dsh-client-test-runtime`），
  `PLATFORM_MODULES`（packages/client/web/src/platform.ts）中无
  `@deepseek-ai/dsh-client-runtime` → module table 无 seed → 装载失败。
- 上游 alpha 预发布立场允许自由重命名/重组包、不承诺兼容；npm latest
  （0.3.6/0.4.1）已是最新，无修复版可装。

运行时确实 require 旧包的：`@linxin666/dsh-client-ui-web-ui-settings`、
`@linxin666/dsh-pet`；声明引用旧 peer 的还有 dsh-flowglass、dsh-better-sidebar、
dsh-sidebar-qa、dshmarket。报错画面中 flowglass 只是最先露头的 loader entry。

### 处置（默认跳过，等待 upstream 适配）

- `scripts/plugin-install.mjs`：`skipInstall(id)` 改为**默认名单**机制——
  `DEFAULT_SKIPPED_PLUGINS`（flowglass / dsh-web-ui-settings / dsh-pet）默认
  跳过，`installNpmPlugin` 内部统一判断并打印原因；`DSH_PLUGIN_SKIP` 环境
  变量仍可追加，`DSH_PLUGIN_FORCE_INSTALL=1` 可强制安装（upstream 适配后
  无需改代码即可恢复）。
- `plugins/better-sidebar` / `plugins/dsh-web-ui` 的 `install.mjs` 保持直接
  调用（判断已下沉共享脚本，注释说明恢复方法）。
- 已从 profile 移除三个包（`dsh plugin --profile web remove`，bundles 全部
  清除）。`npm run build` 验证：显示 `skipping '...' — version-incompatible ...`，
  deps/bundles 均不再出现三者。

### 恢复条件

`@linxin666/*`（dsh-web 全家桶）与 dsh-flowglass 发布基于 0.1.2 系列
（不再 require `@deepseek-ai/dsh-client-runtime`）的新版本后：
从 `scripts/plugin-install.mjs` 的 `DEFAULT_SKIPPED_PLUGINS` 中移除对应 id
（无需改 wrapper），或临时以 `DSH_PLUGIN_FORCE_INSTALL=1 npm run build`
强制安装，然后重新 `dsh plugin --profile web add <spec>` 确认。

### 遗留核对

dsh-better-sidebar / dsh-sidebar-qa / dshmarket / @linxin666/dsh-liangshen 仍
保留在 profile（仅声明引用旧包名的 peer，不含运行时 require）。下次启动后
核实这些插件无加载错误；若出现同类 module-table 报错，同样加入 `DSH_PLUGIN_SKIP`。
