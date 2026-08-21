#!/usr/bin/env node
/**
 * install.mjs — build, install, and mount the `cache-hit-precision` plugin
 * into the web profile.
 *
 * The package is a git submodule at
 * plugins/cache-hit-precision/dsh-cache-hit-precision
 * (https://github.com/ZgblKylin/dsh-cache-hit-precision); the `sourceHint`
 * below puts the recovery command into the missing-checkout error. It
 * declares a `build` script, so the shared pipeline builds it in place
 * with the pinned toolchain pnpm and repo-local store. It declares
 * `dsh.bundle.patch`, so the shared pipeline leaves mounting to its own
 * bundle layer and does not append a manual insert row to
 * `.dsh/profiles/web/cordis.patch.yml`.
 *
 * Target: `$DSH_HOME/profiles/web/`. `DSH_HOME` is pinned to `<repo>/.dsh`
 * by the desktop shell and the build; this script honors an explicit
 * `DSH_HOME` override and otherwise keeps the shared pipeline's default.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPlugin } from '../../scripts/plugin-install.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

installPlugin({
  id: 'cache-hit-precision',
  packageDir: join(HERE, 'dsh-cache-hit-precision'),
  sourceHint: 'git submodule update --init plugins/cache-hit-precision/dsh-cache-hit-precision',
})
