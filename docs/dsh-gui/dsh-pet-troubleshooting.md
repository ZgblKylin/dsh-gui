# dsh-pet 排查与清理手册（reminder）

`dsh-pet` 在两个无直接关系的仓库中同名存在，历史与"检查更新"流程中容易混为一谈。
本页是出现问题时**优先翻阅**的快速定位 + 清理清单；其余更新/构建故障见
`docs/dsh-gui/update-check.md`、`docs/dsh-gui/2026-08-30-harness-upgrade-v0-1-2-alpha-1-build-failure.md`。

## 1. 两个 dsh-pet，先分清是谁

| | `@linxin666/dsh-pet`（鲸鱼娘） | `dsh-pet`（PC2005-cloud） |
| --- | --- | --- |
| 上游 | `zhu1090093659/dsh-web` 的 `packages/dsh-pet` | `PC2005-cloud/dsh-pet`（包在仓库内 `dsh-pet/` 子目录） |
| 形态 | 浏览器 overlay，无桌面模式 | 浏览器 overlay + **可选** Electron 透明桌面小窗 |
| Loader entry id | `pet` | `pet` |
| webserver 路由 | `/api/pet` | `/dsh-pet-7340`（v0.1.8 起；旧版 `/pet`） |
| 本仓库 wrapper | ~~`plugins/dsh-web-ui`~~（已移除安装） | `plugins/dsh-pet`（npm `dsh-pet@0.2.4`） |
| 安装状态 | 默认跳过 | 默认跳过（`plugins/dsh-pet/install.mjs` 向 `installNpmPlugin` 传入 `skip` 声明） |
| 用户配置 | `$DSH_HOME/pet.json` | `$DSH_HOME/dsh-pet/main-config.json` |

> 本仓库默认 profile（检测于 2026-09-02）：两者都**未安装**、bundles 无 pet 条目，
> `node_modules` 无残留；仅 `.dsh/gui/npm-installs.json` 保留鲸鱼娘的旧登记（见 §4.3）。

## 2. 症状 → 可能原因速查

| 症状（启动/运行） | 可能原因 | 处置 |
| --- | --- | --- |
| `duplicate loader entry id: pet` / `failed to apply loader entry pet`，Harness 无法启动 | 同一 profile 里 `@linxin666/dsh-pet` 与 `dsh-pet`（或手工 patch 行）**同时**用 entry `pet` | §3.1 → 卸载其一（建议卸鲸鱼），§4.1 |
| `webserver: duplicate prefix route "/pet"` | 装了 **<0.1.8** 的 PC2005 `dsh-pet`（旧路由 `/pet`）且与其它 `/pet` 插件共存 | 升级到 ≥0.1.8（现 v0.2.4）；参考上游 issue [#16](https://github.com/PC2005-cloud/dsh-pet/issues/16)（已修复，0.1.8 起 `/dsh-pet-7340`） |
| 加载 plugin `dsh-pet` 报 `missed the module table` / client 失败 | 发布包 client 半 require `@deepseek-ai/dsh-client-runtime`，本 harness（dsh-v0.1.2-alpha.1）已移除 | 默认跳过即为正确状态；勿在正式 profile 强装（§4.2） |
| `pet` 插件行停在 PENDING / 不激活 | host 半 inject `agentDefaultModel`，本版 harness 无此服务 | 同上；等上游适配或加兼容层 |
| 意外出现独立 Electron 小窗 / 自动下载 Electron 到 `$DSH_HOME/electron/` | 某宠物 `display` 为 `desktop`/`both`（内置默认是 `both`） | §3.2 注入 `display:"web"`；已有窗口需重启或保存一次设置页才停 |
| 设置卡提示"命名空间未暴露" | 只有鲸鱼娘 family 插件依赖 `webUiSettings` 桥；PC2005 `dsh-pet` 用自己的 `/dsh-pet-7340/config`，不依赖该桥 | 与 `dsh-pet` 无关；若要鲸鱼娘设置卡需装 `@linxin666/dsh-client-ui-web-ui-settings`（同样默认跳过） |

## 3. 快速排查命令

```powershell
# 3.1 谁在 Loader 组合里（依赖 + bundles + 手工 patch 行）
$p = Get-Content .dsh\profiles\web\package.json -Raw | ConvertFrom-Json
$p.dependencies.PSObject.Properties | ? Name -match 'pet'          # 依赖
$p.dsh.profile.bundles | Select-String 'pet'                        # bundle 层
Select-String -Path .dsh\profiles\web\cordis.patch.yml -Pattern 'pet' -SimpleMatch   # 手工行

# 3.2 桌面模式当前生效宠物（display 决定是否拉 Electron）
Get-Content .dsh\dsh-pet\main-config.json                          # 不存在 = 未注入
$cfg = Get-Content .dsh\dsh-pet\main-config.json -Raw | ConvertFrom-Json
$cfg.pets | Select-Object id, display, size

# 3.3 node_modules 残留
Test-Path .dsh\profiles\web\node_modules\dsh-pet
Test-Path .dsh\profiles\web\node_modules\@linxin666\dsh-pet
Get-ChildItem .dsh\profiles\web\node_modules -Directory -Filter '*pet*'

# 3.4 npm 安装登记（含被跳过仍记录的包）
if (Test-Path .dsh\gui\npm-installs.json) { Get-Content .dsh\gui\npm-installs.json -Raw }

# 3.5 最终 Loader 组合核对（重启前先看树）
$env:DSH_HOME = 'D:\git\dsh-gui\.dsh'
node deepseek-harness/apps/cli/lib/bin.js --profile web --dump-config
```

## 4. 清理与迁移

### 4.1 卸载鲸鱼娘 `@linxin666/dsh-pet`（从 web-ui wrapper 中移除后，残留需手工清）

```powershell
$env:DSH_HOME = 'D:\git\dsh-gui\.dsh'
node deepseek-harness/apps/cli/lib/bin.js plugin --profile web remove @linxin666/dsh-pet
# 会同时清：package.json 依赖 + dsh.profile.bundles 条目 + node_modules/@linxin666/dsh-pet
# 之后 entry `pet` 让出，PC2005 dsh-pet 才可安全强装。
```

### 4.2 PC2005 `dsh-pet` 安装 / 强装 / 重建

```powershell
$env:DSH_HOME = 'D:\git\dsh-gui\.dsh'
# 默认：被跳过清单拦截（安全路径，什么都不装）
node plugins/dsh-pet/install.mjs
# 强装（⚠️ 仅临时/测试环境）：client 会 miss module table，host 停在 PENDING
$env:DSH_PLUGIN_FORCE_INSTALL = '1'; node plugins/dsh-pet/install.mjs
```

> ⚠️ 不要在正式 profile 强装 0.2.4：其发布 bundle 依赖已被本 harness 移除的
> client runtime。要验证请先复制一个临时 profile（`DSH_HOME` 指向别处）再试。
> 等待上游发布兼容构建后，把 `plugins/dsh-pet/install.mjs` 里 `installNpmPlugin`
> 的 `skip` 选项改为 `null`（或删除该选项）即可恢复正常安装——屏蔽入口在
> wrapper 脚本，共享流水线不再硬编码跳过名单。

### 4.3 清理 npm 安装登记残留（运行时缓存，仅美观）

`installNpmPlugin` 在跳过前也会把包名写进 `.dsh/gui/npm-installs.json`
（设计如此：让「检查更新」能看到上游 npm 何时发布）。旧登记不会自动消失：

```powershell
# 删掉整份缓存的 `@linxin666/dsh-pet` 一行；或直接重建（下例只留仍在安装的包）
$f = '.dsh\gui\npm-installs.json'
$arr = (Get-Content $f -Raw | ConvertFrom-Json) -ne '@linxin666/dsh-pet'
Set-Content $f ($arr | ConvertTo-Json) -Encoding utf8
```

影响：仅「检查更新」对 web-ui 行显示的 npm 状态；不改任何运行时组合。

### 4.4 重置桌面屏蔽注入 / 恢复桌面模式

```powershell
# 重新注入（删除后重跑 install.mjs 会重建 display:"web" 的默认宠物）
Remove-Item .dsh\dsh-pet\main-config.json -ErrorAction SilentlyContinue
node plugins/dsh-pet/install.mjs        # 仅当插件已装进 profile 才写
# 手动改 display 即恢复桌面：把 main-config.json 里宠物的 display 改为 desktop / both
```

> 时序提醒：`hasDesktopPet` 只在插件**激活**与设置页保存（PUT/DELETE，触发
> `syncDesktop`）时重算。安装脚本在插件首启前写配置 = 生效；若桌面窗口已在跑，
> 改配置后要**重启 DSH 或保存一次设置页**才会停掉既有 Electron。

### 4.5 释放 Electron 磁盘占用（如确定不用桌面模式）

```powershell
# dsh-pet 的默认落地目录是 $DSH_HOME/electron（上游默认 ~/.dsh/electron）
(Get-ChildItem .dsh\electron -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum  # 占用字节
Remove-Item .dsh\electron -Recurse -Force -ErrorAction SilentlyContinue   # 确认无用再删
```

## 5. 完成后验证

```powershell
# profile 纯净（无任何 pet 依赖/bundle）
Test-Path .dsh\profiles\web\node_modules\dsh-pet          # False
Test-Path .dsh\profiles\web\node_modules\@linxin666\dsh-pet  # False
Select-String -Path .dsh\profiles\web\cordis.patch.yml -Pattern 'pet' -SimpleMatch  # 无输出
# 桌面屏蔽生效
(Get-Content .dsh\dsh-pet\main-config.json -Raw | ConvertFrom-Json).pets.display  # web
# 重启后无 pet 相关 FAILED / PENDING fiber
```

## 6. 相关文件速查

- wrapper：`plugins/dsh-pet/{install.mjs,inject-config.mjs,README.md}`；子模块 `plugins/dsh-pet/dsh-pet`（pin v0.2.4）
- 跳过声明（wrapper 内）：`plugins/dsh-pet/install.mjs` 的 `skip` 选项；登记与通用机制：`scripts/plugin-install.mjs`（`recordNpmInstall`、`skipInstall`）
- 更新检查：`docs/dsh-gui/update-check.md`、`src-tauri/src/update.rs`
- 上游：`https://github.com/PC2005-cloud/dsh-pet`（issue [#16](https://github.com/PC2005-cloud/dsh-pet/issues/16) = 路由冲突，已修）