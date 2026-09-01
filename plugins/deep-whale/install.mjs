#!/usr/bin/env node
/**
 * install.mjs — install and mount the `deep-whale` skin series into
 * the web profile (免编译源码安装, per plugins/README.md's 安装方式 section).
 *
 * Since upstream 4803ea6 this wrapper installs the full trio matching the
 * upstream INSTALL.md / dsh-skin-install skill's 完整安装:
 *   - skin-manager  (@dsh-external/dsh-client-ui-skin-deep-whale-manager, 常驻)
 *   - maid-atelier  (@dsh-external/dsh-client-ui-skin-maid-atelier)
 *   - orca-link     (@dsh-external/dsh-client-ui-skin-orca-link)
 * All three ship prebuilt `lib/` committed in the repo and declare
 * `dsh.bundle.patch`, so `dsh plugin add` reconciles each into
 * `dsh.profile.bundles` and each mounts through its own bundle patch layer
 * (entry ids ui-skin-deep-whale-manager / ui-skin-maid-atelier /
 * ui-skin-orca-link) — no manual cordis.patch.yml insert is added (that would
 * double-mount them).
 *
 * Skin mutual exclusion (the two skins must not both be enabled) is the
 * skin-manager's job: on boot it detects "two skins enabled" and atomically
 * falls back to the official default. For the local-link flow the upstream
 * skill pre-stages the target BEFORE the first add; this wrapper does the
 * same ON FIRST BOOTSTRAP only — when neither patch layer carries the
 * manager-managed block yet — keeping `maid-atelier` active for continuity.
 * Once the block exists (first run or a user switch via 设置→皮肤管理 /
 * /api/dsh/skins), later runs leave it alone.
 *
 * Target: `$DSH_HOME/profiles/web/`. `DSH_HOME` is pinned to `<repo>/.dsh` by
 * the desktop shell; this script honors an explicit `DSH_HOME` override (the
 * build passes one) and otherwise pins the same repo-local default.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPlugin } from '../../scripts/plugin-install.mjs'
import { run, WEB_HOME } from '../../scripts/toolchain.mjs'

/** This plugin's directory — the wrapper that owns the submodule checkout. */
const HERE = dirname(fileURLToPath(import.meta.url))
/** Upstream distribution repo checkout inside this wrapper. */
const REPO = join(HERE, 'dsh-deep-whale')

const sourceHint = 'git submodule update --init plugins/deep-whale/dsh-deep-whale'

/** Upstream skill helper that pre-stages the skin mutual-exclusion rows. */
const STAGE_SCRIPT = join(
  REPO,
  '.agents', 'skills', 'dsh-skin-install', 'scripts', 'stage-mutual-exclusion.mjs',
)
/** skin-manager managed-block marker; presence in either layer means staged. */
const MANAGED_MARKER = '# --- dsh-skin managed (auto-generated; do not edit) ---'
/** Skin kept active by the first-bootstrap pre-stage (preserves current look). */
const FIRST_TARGET = 'maid-atelier'

const dshHome = process.env.DSH_HOME ?? WEB_HOME
const patchPaths = [
  join(dshHome, 'profiles', 'web', 'cordis.patch.yml'),
  join(dshHome, 'cordis.patch.yml'),
]

// 1) First-bootstrap mutual exclusion (local-link flow per dsh-skin-install:
//    pre-stage BEFORE the first add). Gated so user switches are never
//    clobbered by later install runs, and skipped entirely when the checkout
//    is missing (installPlugin below then reports the sourceHint error).
let staged = false
for (const path of patchPaths) {
  try {
    if (readFileSync(path, 'utf8').includes(MANAGED_MARKER)) {
      staged = true
      break
    }
  } catch {
    // layer missing or unreadable — still not staged
  }
}
if (!staged && existsSync(join(REPO, 'skin-manager', 'package.json'))) {
  console.log(`  first bootstrap: pre-staging skin mutual exclusion (target: ${FIRST_TARGET})`)
  run('node', [STAGE_SCRIPT, '--profile', 'web', '--target', FIRST_TARGET, '--dsh-home', dshHome])
  console.log(`  pre-staged: ${FIRST_TARGET} enabled, other skins disabled (switch later in 设置→皮肤管理)`)
} else if (staged) {
  console.log('  skin mutual-exclusion block already present — keeping user\'s skin choice')
}

// 2) Register the three distribution packages (idempotent link: installs in
//    upstream order: manager first, then the two skins).
for (const pkg of ['skin-manager', 'maid-atelier', 'orca-link']) {
  installPlugin({
    id: 'deep-whale',
    packageDir: join(REPO, pkg),
    sourceHint,
    build: false,
  })
}