#!/usr/bin/env node
/**
 * install.mjs — install the `commandcode-provider` plugin into the web profile.
 *
 * 来源：npm 发布包 `@mars-sea/dsh-commandcode-provider`，spec 为
 * `@mars-sea/dsh-commandcode-provider@latest`：安装时由共享流水线查询 registry
 * 的 latest 精确版本并安装该版本，已装同一版本时跳过，因此上游发布新版本后重跑
 * 本脚本即可升级，仓库内不维护版本号。
 *
 * 包声明 `dsh.bundle.patch`，`dsh plugin add` 会把它 reconcile 进
 * `dsh.profile.bundles`，其 `cordis.patch.yml` 插入 entry（id
 * `llm-commandcode`，name `@mars-sea/dsh-commandcode-provider`）；本脚本不写手工
 * insert（那会 double-mount）。
 *
 * 准入：包以 `engines.dsh` 声明
 * `>=0.2.1-rc.2 <0.2.2-0 || >=0.2.2-alpha.2 <0.2.3-0`，本工程 pinned 的
 * harness 0.2.3-alpha.2 落在区间外：第二段的上界 `<0.2.3-0` 排除 0.2.3 线的
 * 预发布。闸门只看 engines.dsh，因此该包会被拒绝；wrapper 经下方调用的 `exempt`
 * 按精确版本接受风险，安装前以 `dsh plugin allow-version --accept-risk` 写入
 * profile 的 compatibility.json。例外按「精确包版本 + 精确运行时版本」生效，
 * 下一次 harness 升级会自动失效，届时重新评估该包的声明区间（见
 * plugins/README.md 的例外说明）。
 *
 * Target: `$DSH_HOME/profiles/web/`. `DSH_HOME` is pinned to `<runtime-root>/.dsh`
 * by the desktop shell; this script honors an explicit `DSH_HOME` override (the
 * build passes one) and otherwise pins the same runtime-root default.
 */

import { installNpmPlugin } from '../../scripts/plugin-install.mjs'

await installNpmPlugin({
  id: 'commandcode-provider',
  packageSpec: '@mars-sea/dsh-commandcode-provider@latest',
  exempt: '该包当前 latest 的 engines.dsh 上界 <0.2.3-0 不接纳 pinned 的 dsh-v0.2.3-alpha.2，上游尚无覆盖 0.2.3 线的发布，因此按精确版本接受该风险，直到上游放宽区间；例外按「精确包版本 + 精确运行时版本」生效，下一次 harness 升级会自动失效。',
})
