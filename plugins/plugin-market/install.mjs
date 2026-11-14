#!/usr/bin/env node
/**
 * install.mjs — install the `dshmarket` plugin into the web profile.
 *
 * 来源：npm 发布包 `dshmarket`，spec 为 `dshmarket@latest`：安装时由共享流水线
 * 查询 registry 的 latest 精确版本并安装该版本，已装同一版本时跳过，因此上游发布
 * 新版本后重跑本脚本即可升级，仓库内不维护版本号。包声明 `dsh.bundle.patch`，
 * `dsh plugin add` 会把它 reconcile 进 `dsh.profile.bundles` 并由 bundle 层自行
 * 挂载，因此本脚本不写手工 insert（那会 double-mount）。
 *
 * 准入：harness dsh-v0.2.2-rc.3 的闸门按包声明的 dsh 依赖判定——有 `engines.dsh`
 * 时只看它，否则看 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer。
 * `dshmarket` 的 `@deepseek-ai/dsh-settings` peer 自 1.66.4 起带 0.2 线分支
 * （`^0.2.0-rc.1`），1.70.x 起改为 `^0.2.1-alpha.3 || ^0.2.1-rc.1` 并把自己的
 * peer 检查按 includePrerelease 执行，0.2.2-rc.3 因此被接纳；低于这两个下限的
 * 发布会被安装前置检查拒绝。
 *
 * Target: `$DSH_HOME/profiles/web/`. `DSH_HOME` is pinned to `<runtime-root>/.dsh`
 * by the desktop shell; this script honors an explicit `DSH_HOME` override
 * (the build passes one) and otherwise pins the same runtime-root default.
 */

import { installNpmPlugin } from '../../scripts/plugin-install.mjs'

await installNpmPlugin({
  id: 'plugin-market',
  packageSpec: 'dshmarket@latest',
})
