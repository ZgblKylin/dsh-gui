#!/usr/bin/env node
/**
 * install.mjs — build, install, and mount the `modlens` plugin
 * into the web profile.
 *
 * The package is a local clone at
 * plugins/modlens/modlens
 * (https://github.com/liustack/modlens); the `sourceHint` below puts the
 * recovery command into the missing-checkout error. It declares a `build`
 * script, so the shared pipeline builds it in place with the pinned toolchain
 * pnpm and repo-local store. It declares `dsh.bundle.patch`, so the shared
 * pipeline does not append a manual mount row to
 * `.dsh/profiles/web/cordis.patch.yml`; the package mounts itself through its
 * own bundle layer (entry id `modlens`).
 *
 * Target: `$DSH_HOME/profiles/web/`. `DSH_HOME` is pinned to `<repo>/.dsh`
 * by the desktop shell and the build; this script honors an explicit
 * `DSH_HOME` override and otherwise keeps the shared pipeline's default.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPlugin } from '../../scripts/plugin-install.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = join(HERE, 'modlens')

// pnpm 11 creates a placeholder pnpm-workspace.yaml on first install when a
// dependency ships a build script; that placeholder is not part of the modlens
// repo, so a fresh submodule checkout would fail with ERR_PNPM_IGNORED_BUILDS.
// Pin the review decision here: esbuild's postinstall is not needed (the
// platform binary comes from the optional dependency), so deny it explicitly.
if (existsSync(PACKAGE_DIR)) {
  writeFileSync(join(PACKAGE_DIR, 'pnpm-workspace.yaml'), 'allowBuilds:\n  esbuild: false\n')
}

installPlugin({
  id: 'modlens',
  packageDir: PACKAGE_DIR,
  sourceHint: 'git clone https://github.com/liustack/modlens.git plugins/modlens/modlens',
})
