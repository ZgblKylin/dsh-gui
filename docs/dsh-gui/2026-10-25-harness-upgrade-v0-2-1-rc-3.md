# harness 升级：dsh-v0.2.1-rc.2 → dsh-v0.2.1-rc.3

本文件记录把工程基座 `deepseek-harness` 与 5 个插件模块升级到目标修订的取舍与验收结果。本次按用户要求跳过副本（`.staging/dsh-gui`）阶段，直接在主工程更新，并以 Tauri 侧编译作为验收；完整流程与门槛见 skill [dsh-gui-update](../../.agents/skills/dsh-gui-update/SKILL.md)。

## 目标修订与发布状态

| 模块 | 旧修订 | 新修订 | npm |
| --- | --- | --- | --- |
| deepseek-harness | dsh-v0.2.1-rc.2（687f282e86） | dsh-v0.2.1-rc.3（1f81c047fc） | `@deepseek-ai/dsh@0.2.1-rc.3` 已发布（`next` tag，`latest` 仍为 rc.2） |
| dsh-deep-whale | v0.1.8（15e9aa0） | v0.1.9（e74fa84） | 皮肤 0.1.9、manager 0.1.8 均已发布 |
| dsh-web-ui | v0.4.6（3cd18493d） | v0.4.8（f4ed14fb9） | 三包 0.4.8 均已发布 |
| dsh-sidebar-qa | v1.2.0（3c671f3） | v1.2.1（469cb28） | 1.2.1 已发布 |
| dshmarket | v1.66.21（b8948c1） | v1.70.2（e320461） | 1.70.2 已发布（`latest`） |
| @mars-sea/dsh-commandcode-provider | v0.13.4（2e0bb2d） | v0.15.4（e5cf934） | 0.15.4 已发布（`latest`） |

用户给定的 dshmarket 目标是 v1.70.1；核对时 `origin/main` 的最新 tag 与 npm `latest` 均已到 v1.70.2，经用户裁定按 v1.70.2 更新。v1.70.2 相对 v1.70.1 的 6 个提交含 carrier 型 bundle 开关的缺陷修复，正好命中本工程 desktop profile 的组合形态。

## 上游变更

| 变更 | 说明 |
| --- | --- |
| **rc.3 的范围** | 相对 rc.2 共 6 个提交：release 提交只改 349 个 `package.json` 的版本号，功能提交 5 个（LLM `/models`、入口定制 UI、埋点、菜单修复、New Session 空白复用）。Cordis service 无增删，bundle 契约、准入闸门与 slot 框架的源码与 rc.2 一致；UI 侧新增 3 个 additive slot，web-app bundle 新增 `entry-customization` 行，loader id 与现有 insert 不冲突 |
| **官方家族包随基座换代** | browser-use、computer-use、browser-use-playwright-mcp、computer-use-cua-driver-native 四包的 dsh peer 精确指向 `0.2.1-rc.3`，必须与 harness 同批抬 pin；这四包在 registry 的 `latest` 停在 `0.1.6-alpha.1`，只能精确 pin |
| **commandcode-provider 引擎声明改为区间** | 0.15.4 的 `engines.dsh` 为 `>=0.2.1-rc.2 <0.2.2-0`，`dsh.compatibility.dshReleases` 记录 rc.2 与 rc.3；因此不再需要精确版本例外 |
| **dshmarket 的 peer 检查** | 1.70.0 起自身 peer 检查按 `includePrerelease` 接纳 prerelease 宿主线（此前在 0.2.1 线上会报假 peer 警告）；1.70.2 修复 carrier 型 bundle 开关的半写层（会留下两边 UI 都没有的窗口，重启不可修复）、保留分组内插件描述、长安装提示与桌面端双语进度 |
| **dsh-sidebar-qa 的信任围栏** | 1.2.1 把信任围栏从 rc.2 已删除的 `webRuntime` 迁到 `webStartup`，修复 LAN / `--trusted-host` 访问 `/sidebarqa/api` 恒 403；client 半恢复流式并显示失败原因 |
| **deep-whale 的皮肤 peer** | v0.1.9 两块皮肤声明 `@deepseek-ai/dsh >=0.2.0-rc.2 <0.3.0-0`，manager 仍为 0.1.8（`>=0.1.7-rc.1`）；`skin.json` 的 `dshCompatibility: 0.2.1rc2` 只是管理器的「验证于」展示，准入判定读 package peer |
| **dsh-web-ui 的宿主下限** | 三包自 0.4.7 起把 peer 抬到 `>=0.2.1-rc.2`，rc.3 满足；三包把 `engines.dsh` 写在 `dsh.engines.dsh`（非官方位置），官方 evaluator 只读顶层 `engines.dsh`，因此实际走 peer 判定 |

## 适配改动

| 文件 | 改动 |
| --- | --- |
| `plugins/harness/browser-use.mjs`、`computer-use.mjs` | 官方家族四包 pin → `0.2.1-rc.3`；注释同步精确 peer、pinned tag 与闸门版本 |
| `plugins/dsh-web-ui/install.mjs` | 三包 pin `0.4.6` → `0.4.8`；注释同步版本与 rc.3 准入 |
| `plugins/dsh-web-ui/README.md` | 三包版本、子模块 tag 与准入表述同步 |
| `plugins/better-sidebar/install.mjs` | `dsh-sidebar-qa` pin `1.2.0` → `1.2.1`（better-sidebar 保持 `0.28.0`）；注释同步 1.2.1 的信任围栏修复与 rc.3 准入 |
| `plugins/better-sidebar/README.md` | 版本与准入说明同步 |
| `plugins/deep-whale/install.mjs` | 分包 pin：manager `0.1.7` → `0.1.8`、maid-atelier 与 orca-link `0.1.8` → `0.1.9`；注释同步皮肤 peer 与 rc.3 准入 |
| `plugins/deep-whale/README.md` | 版本与分包口径同步 |
| `plugins/plugin-market/install.mjs` | `dshmarket` pin `1.66.21` → `1.70.2`；硬下限说明改写为「1.66.4 起接纳 0.2 线、1.70.x 用 includePrerelease 检查 prerelease 宿主线」 |
| `plugins/commandcode-provider/install.mjs` | pin → `0.15.4`；删除 `exempt` 精确版本例外，注释改写为区间声明 |
| `plugins/commandcode-provider/README.md` | 版本、引擎声明、例外状态与更新步骤同步 |
| `plugins/dsh-pet/install.mjs` | 注释里的 harness pin → `0.2.1-rc.3`（`dsh-pet@0.3.7` 版本不变） |
| `plugins/harness/README.md` | 两张安装表与 pin 说明、闸门描述同步到 rc.3 |
| `plugins/README.md` | 例外机制段、安装方式清单、Current plugins 段的版本与准入表述同步 |
| `README.md` | dsh-web-ui 三包版本与 `dsh-web-app` bundle 的 pinned harness 版本 |
| `docs/dsh-gui/ssh-remote-workspace.md`、`ssh-provider-vs-dsh-remote.md`、`dsh-pet-troubleshooting.md` | 运行版本与准入闸门引用更新为 `0.2.1-rc.3` |
| 子模块指针 | harness、deep-whale、dsh-web-ui、sidebar-qa、dsh-market、commandcode 六个指针同步到新修订 |

`docs/official` 的 19 条符号链接（10 条目录、9 条文件）在 rc.3 上逐条核对仍可穿透，无需改指。

## 验收

本次跳过副本验证，在主工程以 Tauri 侧编译（`npm run build`：按子模块 `apps/cli/package.json` 的版本安装 dsh 运行时 → 安装 web profile 插件 → `cargo build` 入口 exe）作为验收。构建 exit 0，结果：

1. 运行时：`@deepseek-ai/dsh@0.2.1-rc.3` 装入运行时根的 `.harness/`，替换此前的 rc.2。
2. 插件：兼容性扫描后逐个运行 `plugins/*/install.mjs`，全部安装成功。web profile 依赖落在目标版本：官方家族四包 `0.2.1-rc.3`、dsh-web-ui 三包 `0.4.8`、`dsh-sidebar-qa@1.2.1`、deep-whale manager `0.1.8` 与两皮肤 `0.1.9`、`dshmarket@1.70.2`、`@mars-sea/dsh-commandcode-provider@0.15.4`。`dsh-better-sidebar@0.28.0` 与 `dsh-pet@0.3.7` 版本未变，安装器按快路径跳过。
3. 例外：构建日志无 `exempt` 与 `allow-version` 记录，`compatibility.json` 未写入新例外。
4. Tauri 外壳：`cargo build --release` 通过并复制入口 exe 到运行时根。Tauri 外壳源码本轮未改动，二进制与上一轮一致。
5. 组合：`--dump-config` 冒烟检查通过，22 个 bundle 层登记完整，无 `duplicate loader entry id`，无被跳过的 bundle 加载。

构建期另有一条 `patch: entry "cot-translation" not found` 警告：web profile 的 `cordis.patch.yml` 里有一条落在 `dsh-skin managed` 区段内的 `cot-translation` insert，引用的 `@deepseek-ai/dsh-experimental-client-ui-cot-translation` 未安装。该行由来早于本次升级（配置文件时间为 2026-10-19），且不属于本仓库受版本管理的配置；警告为 warning 级别，未影响组合加载。需要启用 CoT 翻译时安装对应版本的包即可。

## 屏蔽与例外

- 本次没有屏蔽任何插件。
- 精确版本例外已清空：commandcode-provider 0.15.4 的 `engines.dsh` 区间覆盖 rc.3，wrapper 不再授予例外；其余 wrapper 的声明范围同样接纳 rc.3。
- web profile 的 `compatibility.json` 可能残留上一轮的 `@mars-sea/dsh-commandcode-provider@0.13.4` 例外键（键精确绑定运行时版本，在 rc.3 下必然失效），残留不影响启动，构建时按新判定刷新。

## 未决风险

- 未执行副本的 WebUI 加载验收与 desktop 实机启动验收，rc.3 的 client 侧变化（182 个文件）只经静态核对，未实机渲染验证。
- 未重建 desktop 应用：desktop profile 仍装上一轮的插件版本。用户停止运行中的 Desktop 实例后执行 `npm run build:desktop`，新版本才在 desktop 端生效。
- `dshmarket@1.70.2` 发布不足 24 小时，构建侧由 `DSH_PLUGIN_MIN_AGE=0` 与精确 pin 的 `minimumReleaseAgeExclude` 保护；上游撤回该版本时安装会失败。
