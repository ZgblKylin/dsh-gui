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
 * harness 0.2.2-rc.3 落在第二段（`0.2.2-alpha.2 <= 0.2.2-rc.3 < 0.2.3-0`）。
 * 闸门只看 engines.dsh，因此该包自行被接纳，不需要 `exempt` 例外；若某次 latest
 * 改成不包含当前 harness 的区间，构建会以该包名失败，处理方式见
 * plugins/README.md。
 *
 * Target: `$DSH_HOME/profiles/web/`. `DSH_HOME` is pinned to `<runtime-root>/.dsh`
 * by the desktop shell; this script honors an explicit `DSH_HOME` override (the
 * build passes one) and otherwise pins the same runtime-root default.
 */

import { installNpmPlugin } from '../../scripts/plugin-install.mjs'

await installNpmPlugin({
  id: 'commandcode-provider',
  packageSpec: '@mars-sea/dsh-commandcode-provider@latest',
})
