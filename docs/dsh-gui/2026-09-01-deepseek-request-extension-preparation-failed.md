# DeepSeek provider 请求失败排查记录（2026-09-01）

> **状态：修复方案已提交决**。修复方案（仓库根 `package.json` 补 `version`）随提交
> `c8ae091` 落地，其他设备部署可参考修复方案，清理profile 的悬空
> `@dsh-external/dsh-mode-boost` 链接。

> 环境：dsh-gui 自托管（`DSH_HOME = <repo>/.dsh`，web profile），
> `deepseek-harness` 为 pinned 上游子模块（本次**未改动**，仅用于查证规范）。
>
> 版本：
> - dsh（deepseek-harness）：`dsh-v0.1.2-alpha.1`（cd5ef81481）
> - dsh-routing-suite：`v0.1.0-16-g21a7260`（21a7260，flat-submodules merge 后基线；
>   其移除 mode-boost 的版本见文末"附"）

## 背景

用户用 **DeepSeek provider（deepseek-official）的 flash 模型**发送消息时，
每次都在请求发出前报错：

```
本轮运行失败
DeepSeek request extension preparation failed
```

默认的 pi-ai 在其他网关（包括配置了thinkingFormat: deepseek）路径一切正常，切到 DeepSeek
provider 后**必现**（同一会话内连续 112 次，包含"会话标题"类请求）。

## 症状

- 报错文案 `DeepSeek request extension preparation failed`，代码
  `REQUEST_EXTENSION`，来自 `deepseek-harness/packages/llm/llm-deepseek/
  src/adapter.ts:619-628`：

  ```ts
  try {
    extensions = await this.config.prepareExtensions({ body, signal, sessionId?, purpose? })
  } catch (error) {
    throw new LlmError('DeepSeek request extension preparation failed', 'REQUEST_EXTENSION', { cause: error })
  }
  ```

  即**在向 DeepSeek API 发 HTTP 之前**，`ctx.deepseekLlmApiExtensions.prepare()`
  抛错被包装。不是 key / 网络 / 模型名问题。
- 只有 deepseek-official 适配器会运行 request extension；pi-ai 适配器没有
  这条路径，所以 pi-ai 正常、DeepSeek 必挂。
- 从 session 日志解码确认失败请求的参数：
  `provider: deepseek-official`，`model: deepseek-v4-flash-vision-exp`，
  `agentPreset: router-standard`（见下文"复现与诊断步骤"）。

## 根因

### Request extension 注册表与两个提供方

`deepseek-official` 请求前会调用
`ctx.deepseekLlmApiExtensions.prepare(request)`（注册表实现见
`packages/llm/deepseek-llm-api-extensions/src/index.ts`），遍历所有已注册的
扩展提供方，**任一 `prepare()` 抛错即整体失败**。base bundle 里只有两个
提供方：

| 提供方 | 包 | 默认 | 本次结论 |
| --- | --- | --- | --- |
| `dsh_plugin_packages` | `@deepseek-ai/dsh-plugin-package-inventory-deepseek` | `enabled: true` | **触发方** |
| `dsh_session_log` | `@deepseek-ai/dsh-session-log-deepseek` | `enabled: false` | 未启用，`apply()` 直接 return，完全不参与（源码 `src/index.ts:70`） |

profile 合并配置中两者均无覆盖配置，故只有 `dsh_plugin_packages` 生效。

### 失败点：版本缺失的仓库根 package.json 被 nearestManifest 上溯命中

`dsh_plugin_packages.prepare()` 会遍历 host 树 + 请求会话的 standing preset
树中所有 ACTIVE 条目，逐个解析其所属 `package.json`
（`packages/llm/plugin-package-inventory-deepseek/src/index.ts`）：

- 官方/社区包（`@deepseek-ai/*`、`dsh-better-sidebar` 等）是**裸包名**，
  走 `barePackageManifest()`（`createRequire(anchor).resolve.paths` 多锚点
  resolve），可解析 → 正常。
- 本环境 router-standard preset 里的**相对路径条目**不是包名
  （`barePackageName()` 返回 `undefined`），走：

  ```ts
  } else if (!entry.options.name.startsWith('cordis:')) {
    const moduleUrl = isAbsolute(entry.options.name)
      ? pathToFileURL(entry.options.name)
      : new URL(entry.options.name, treeBase)
    if (moduleUrl.protocol === 'file:') manifest = nearestManifest(fileURLToPath(moduleUrl))
  }
  ```

  逐级向上找最近的 `package.json`（`nearestManifest()`，`src/index.ts:85-94`）。
  相关相对条目：
  - `router-bootstrap` → `./router-bootstrap-v34.mjs?v=88`
  - `gitbash-executor` → `./gitbash-executor.mjs?v=49`

  它们所在目录 `.dsh/.agent-presets/router-standard/` 没有 `package.json`，
  于是沿目录一路向上，命中 **`dsh-gui\package.json`**（仓库根，有
  `name` 但**无 `version`**）。

- `identityFromManifest(manifest, allowAnonymous=true)`
  （`src/index.ts:60-68`）只在 `name` 缺失时放行，`name` 存在而
  `version` 缺失/非字符串时**直接抛错**：

  ```ts
  if (typeof manifest.name !== 'string' || manifest.name.length === 0
    || typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`plugin-package-inventory-deepseek: ${path} must declare non-empty name and version`)
  }
  ```

- 该异常发生在 `prepare()` 里、**失败不进缓存**（抛错先于 cache.set），
  因此每个 deepseek-official 请求都重放一次并再次抛出 → 必现。

> 结论：这是**仓库环境布局**触发 harness（pinned 上游）的严格解析行为——
> 相对条目经 `nearestManifest` 上溯到版本缺失的仓库根 `package.json`。
> 修不了上游，就在本仓库消除触发条件。

### 顺带发现的环境卫生问题（与本次报错无直接因果）

`.dsh/profiles/web/package.json` 声明了 `@dsh-external/dsh-mode-boost`：
`link:.../routing-suite/dsh-routing-suite/mode-boost`，而该目录**不存在**
（rg/pwsh 均报"找不到文件"），形成悬空符号链接。mode-boost 不在
`dsh.profile.bundles` 里、非 active 条目，故不是本报错的直接原因，但会
破坏 node_modules 遍历/重装工具，一并清理。

## 复现与诊断步骤

```powershell
# 1. 确认 profile 合并装配中 agent-default-model 指向 deepseek-official
$env:DSH_HOME = 'dsh-gui\.dsh'
node deepseek-harness/apps/cli/lib/bin.js --profile web --dump-config |
  Select-String -Pattern 'provider: deepseek-official' -Context 1,1
#   agent-default-model → provider: deepseek-official, model: deepseek-v4-flash

# 2.解压失败会话日志（初次发现，zstd，逐帧解码；复用 harness 自带 scanZstdFrames）
#    .dsh/sessions/--D-git-dsh-gui--/session-9ff97111-*/session.jsonl.zstd
#    → 112 处 "DeepSeek request extension preparation failed" / REQUEST_EXTENSION
#    → 请求头：provider=deepseek-official, model=deepseek-v4-flash-vision-exp

# 3. 复现 inventory 的失败分支（改动前）
#    nearestManifest('./router-bootstrap-v34.mjs?v=88', presetDir)
#      → dsh-gui\package.json（name 存在、version 缺失）
#    identityFromManifest(…, allowAnonymous=true) ⇒ throw must declare non-empty ...
```

## 修复步骤

### 1.（根因）仓库根 `package.json` 补 `version`

`dsh-gui\package.json`：`name=dsh-gui`，无 `version`；补上与
`src-tauri/tauri.conf.json` 一致的 `"version": "0.1.0"`：

```json
{
  "name": "dsh-gui",
  "version": "0.1.0",
  "private": true
}
```

改后 `identityFromManifest` 返回 `{ name: "dsh-gui", version: "0.1.0" }`
（作为 inventory 里的一个无害"包"条目），不再抛错。无需重启进程即对
下一次 DeepSeek 请求生效（失败结果不缓存，每次重新 `readFileSync`）。

### 2.（卫生）清理悬空的 `@dsh-external/dsh-mode-boost` 链接

```powershell
# a) 从 profile 依赖移除（本环境 .dsh 为 gitignored 运行时）
#    编辑 .dsh/profiles/web/package.json，删除 dependencies 中的
#    "@dsh-external/dsh-mode-boost": "link:.../mode-boost" 一行
# b) 删除 node_modules 中的悬空符号链接
Remove-Item .dsh/profiles/web/node_modules/@dsh-external/dsh-mode-boost -Recurse -Force
# c) 核验剩余 @dsh-external 全部可解析（skin-manager / maid-atelier /
#    orca-link / super-injector）
```

## 验证结果

- **逻辑重放**（与 inventory 完全一致的 `nearestManifest` +
  `identityFromManifest`，改动后）：
  `RESOLVED OK -> {"name":"dsh-gui","version":"0.1.0"}`，不再抛错。
- **profile 装配 smoke**：`dsh --profile web --dump-config` 正常（563 行）。
- **会话复现证据**：`session-9ff97111`（2026-09-01 16:24）解码出 112 处
  `REQUEST_EXTENSION`，请求头与上述描述一致。
- **悬空链接核验**：`@dsh-external` 仅剩 4 个均可解析。
- ⚠️ 真机复测为**用户侧步骤**：重启 GUI 后，用 DeepSeek provider 的 flash
  模型发一条消息确认恢复（失败不缓存，理论上重启与否都会立即生效，但
  重启可一并应用 mode-boost 清理）。

## 预防措施

- **仓库根 `package.json` 保持 `name` + `version` 齐全**，并与
  `src-tauri/tauri.conf.json` 同步。任何"放在仓库树内、由相对模块条目组成"
  的 preset/loose 模块，都可能被 `nearestManifest` 上溯到这一文件。
- 新增/调整 agent preset 后，若仍走相对条目，可（作为长期方向）让 preset
  自带带 `name`/`version` 的 `package.json`（如 `dsh-router-standard`），使
  `nearestManifest` 在 preset 目录即停住、语义更正确 —— 但这里**不改
  routing-suite 上游 submodule**，仅记录该思路。
- 升级 harness 后若此类报错复现，优先检查：
  ① 生效 provider 是否 deepseek-official；② preset 相对条目向上命中的
  `package.json` 是否有 `name`+`version`；③ `.dsh/sessions` 里解码最近一次
  失败证明确切 cause。
- 插件依赖管理的卫生检查：`node_modules/@dsh-external` 下不应有悬空
  `link:` 符号链接；`dsh plugin --profile web ...` 是受管增删通道。

## 附：dsh-routing-suite 移除 mode-boost 的版本查证（2026-09-01）

结论先行：**mode-boost 不在任何"已发布版本"中被移除**。dsh-routing-suite
目前唯一发布标签 `v0.1.0` 的树里**仍包含** mode-boost（子模块 gitlink
`a9a666a6`）；移除发生在 `v0.1.0` 之后第 3 个提交 `d924ed0`（未打 tag），
并已进入当前安装基线 `21a7260` 与远端 main。

| 项 | 值 |
| --- | --- |
| 添加 mode-boost | `b8bb696`（2026-08-16，`suite: add mode-boost as submodule (v0.1.0 standalone repo)`），早于 `v0.1.0` |
| `v0.1.0` 标签树 | 含 mode-boost（`git ls-tree v0.1.0 -- mode-boost` → gitlink `a9a666a6`） |
| **移除 mode-boost** | **`d924ed0`**（2026-08-18，`suite: remove mode-boost submodule (cancelled plugin)`）；`git describe --tags d924ed0` = `v0.1.0-3-gd924ed0`（即 `v0.1.0` 之后 3 个提交，**无后续发布标签**） |
| 移除后的流向 | 位于当前 HEAD `21a7260`（`v0.1.0-16-g21a7260`，PR #62 `refactor/flat-submodules`）与远端 `origin/main` 的祖先 |

核验命令（在 `plugins/routing-suite/dsh-routing-suite/` 内）：

```bash
git tag --list                                        # 仅 v0.1.0
git describe --tags d924ed0                           # v0.1.0-3-gd924ed0
git ls-tree v0.1.0 -- mode-boost                      # 仍在（gitlink a9a666a6）
git ls-tree d924ed0 -- mode-boost                     # 空 → 已移除
git merge-base --is-ancestor d924ed0 origin/main      # yes → 官方主线
```

含义：本环境安装的套件基线（`21a7260`）已不含 mode-boost，因此 profile
里遗留的 `@dsh-external/dsh-mode-boost`（`link:.../routing-suite/dsh-routing-suite/mode-boost`）
目标目录必然不存在 —— 这正是上文清理的**悬空链接的历史来源**：依赖项在
套件移除 mode-boost 后未同步从 profile 删除。本次已一并从 `.dsh/profiles/web/
package.json` 移除该依赖并删除悬空符号链接。

## 涉及文件

- `package.json`（仓库根，根因修复：补 `version`；已随 `c8ae091` 提交）
- `.dsh/profiles/web/package.json`（移除孤儿 `@dsh-external/dsh-mode-boost`
  依赖；`.dsh` 为 gitignored 运行时）
- `.dsh/profiles/web/node_modules/@dsh-external/dsh-mode-boost`（删除悬空
  符号链接；gitignored 运行时）
- 本记录文件（docs，随本提交入库）

> 只读参考（pinned 上游，未改动）：`deepseek-harness/` 下
> `packages/llm/llm-deepseek/src/adapter.ts`、
> `packages/llm/plugin-package-inventory-deepseek/src/index.ts`、
> `packages/session/session-log-deepseek/src/index.ts`。
