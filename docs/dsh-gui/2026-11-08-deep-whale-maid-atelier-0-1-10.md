# deep-whale 女仆皮肤升级：maid-atelier pin 抬到 0.1.10

本文件记录把 `deep-whale` wrapper 里 `@smalltailqwq/dsh-client-ui-skin-maid-atelier`
的精确 pin 从 `0.1.9` 抬到 registry 最新发布 `0.1.10` 的取舍与验收结果。本轮不涉及
`deepseek-harness` 与 `src-tauri/whale-icon` 子模块，运行时保持 `dsh-v0.2.2-rc.1`。
流程按 skill [dsh-gui-update](../../.agents/skills/dsh-gui-update/SKILL.md)：先在副本
`.staging/dsh-gui` 换 pin、构建、验收，通过后把工作分支 `staging/verify` 合并回本工程。

## 目标版本

| 包 | 安装脚本 | 旧 pin | 新 pin |
| --- | --- | --- | --- |
| @smalltailqwq/dsh-client-ui-skin-maid-atelier | `plugins/deep-whale/install.mjs` | `0.1.9` | **0.1.10** |

未改动：`@smalltailqwq/dsh-client-ui-skin-deep-whale-manager`（`0.1.9`）、
`@smalltailqwq/dsh-client-ui-skin-orca-link`（`0.1.10`），两者都已是各自 registry 最新发布。
目标版本等于 `dist-tags.latest`，无 prerelease 或版本范围安装目标。

## 上游变更与准入

`v0.1.10` 发布说明：两套皮肤升 `0.1.10`，皮肤管理器保持 `0.1.9`。准入闸门读取包 manifest
的 `engines.dsh`（存在时），否则逐条比对 `@deepseek-ai/dsh*` peer。运行中的 harness 是
`0.2.2-rc.1`：

- maid-atelier 0.1.10 无 `engines.dsh`，peer 由 `>=0.2.0-rc.2 <0.3.0-0` 收窄为
  `@deepseek-ai/dsh >=0.2.2-0 <0.2.3-0`，`includePrerelease` 下覆盖 `0.2.2-rc.1`，放行、无需例外。
- `skin.json` 的 `dshCompatibility` 记为 `0.2.2rc1`（仅「验证于」展示，不参与准入判定）。
- entry id `ui-skin-maid-atelier` 与 bundle patch 契约不变，仍由 `dsh plugin add` reconcile 进
  `dsh.profile.bundles` 并自挂载，不写手工 cordis insert。
- 功能变更集中在皮肤本身：场景亮度可调、侧栏蕾丝装饰可关闭、嵌套工作区树与窄输入框思考强度标签、
  手机抽屉层级与宽表格呈现的修复；不新增运行时依赖，也不需要 wrapper 侧适配。

## 适配改动

| 文件 | 改动 |
| --- | --- |
| `plugins/deep-whale/install.mjs` | `SKIN_SPECS` 的 maid-atelier pin `0.1.9` → `0.1.10`；头部注释改成「两套皮肤 0.1.10、manager 0.1.9」与两套皮肤共用的 peer 区间 |
| `plugins/README.md` | 安装方式条目与 `deep-whale` 段落同步两套皮肤版本、peer 区间与 `dshCompatibility` 说明 |

## 验收（阶段一，副本内）

1. **构建**：`npm run build -- --skip-exe`（`DSH_HOME=<仓库根>/.staging/.dsh`）exit 0；
   dsh 运行时 `@deepseek-ai/dsh@0.2.2-rc.1` 复用，16 个安装脚本全部走完，deep-whale wrapper
   装出 `maid-atelier@0.1.10`，manager 与 orca-link 因版本未变沿用已装版本。
2. **组合冒烟**：build 内置的 `--profile web --dump-config` 复合检查 **passed**，
   无 `duplicate loader entry id`、无 patch 缺失；`ui-skin-deep-whale-manager` /
   `ui-skin-maid-atelier` / `ui-skin-orca-link` 三个 bundle 层都在组合中。
3. **装出的版本**：副本 profile 的三包声明为 manager `0.1.9`、maid-atelier `0.1.10`、
   orca-link `0.1.10`；`node_modules` 实际版本一致，`package.json`
   `dsh.profile.bundles` 含全部三个包。
4. **清单核对**：maid-atelier 0.1.10 的 `peerDependencies['@deepseek-ai/dsh']` 为
   `>=0.2.2-0 <0.2.3-0`，`skin.json` 的 `dshCompatibility` 为 `0.2.2rc1`。
5. **WebUI 加载验收**：副本以自身 DSH_HOME 在端口 3091 启动（3090 被另一个存活实例占用），
   用启动日志里的 token URL 打开：首页完整渲染（侧边栏 / 会话树 / 输入框 / Remote 卡 / 用量卡 /
   桌宠），设置 → 皮肤管理列出「深海女仆工坊」并标注「已适配 DSH 0.2.2rc1」，切换后皮肤
   完整渲染（深蓝蕾丝边框、宫殿背景、两位女仆立绘、Q 版侧栏），插件页正常加载，
   控制台 0 error。验收后结束该实例，3091 端口已释放。
6. **插件屏蔽**：本轮无屏蔽项。

## 风险

- 主工程 profile 需在停止运行中的实例后重跑 `npm run build` 才会换成 `0.1.10`；只改安装脚本
  不重建时，profile 仍是 `0.1.9`。
- 皮肤是否启用由皮肤管理器管理（`$DSH_HOME/cordis.patch.yml` 的 `dsh-skin managed` 段），
  升级 pin 不会改变用户的皮肤选择；未启用皮肤时界面显示官方默认主题。
