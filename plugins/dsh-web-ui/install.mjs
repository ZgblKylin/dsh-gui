#!/usr/bin/env node
/**
 * install.mjs — install ONLY the `liangshen` agent preset from the dsh-web-ui
 * checkout into the harness home.
 *
 * dsh-web-ui is a multi-package distribution repo tracked as the
 * `plugins/dsh-web-ui/dsh-web-ui` git submodule; this wrapper deliberately
 * does NOT use the shared
 * `scripts/plugin-install.mjs` pipeline. No dsh-web-ui package is installed,
 * built, linked, or mounted into the web profile here. The only artifact this
 * script lands is the preset directory:
 *
 *   dsh-web-ui/packages/dsh-liangshen/presets/liangshen
 *     -> $DSH_HOME/.agent-presets/liangshen
 *
 * The preset keeps its own composition (`agent.cordis.yml`), display metadata
 * (`preset.yml`), local plugin (`tool-bootstrap.mjs`), and license notices.
 * The host plugin half of dsh-liangshen (`src/`, `cordis.patch.yml`, the npm
 * package) is intentionally NOT installed: the preset alone is enough for the
 * harness roster, and no dsh-web-ui bundle enters the web profile.
 *
 * The target is replaced and re-copied on every run, so re-installs are
 * idempotent and stale files cannot survive a source change.
 *
 * Target: `$DSH_HOME/.agent-presets/liangshen`. `DSH_HOME` is pinned to
 * `<repo>/.dsh` by the desktop shell; this script honors an explicit
 * `DSH_HOME` override (the build passes one) and otherwise pins the same
 * repo-local default.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This wrapper directory: plugins/dsh-web-ui/. */
const HERE = dirname(fileURLToPath(import.meta.url))
/** Repository root: plugins/dsh-web-ui/install.mjs -> <repo>/. */
const ROOT = resolve(HERE, '..', '..')
/** The preset id; also the directory name it installs under. */
const PRESET_ID = 'liangshen'
/** The dsh-web-ui submodule checkout and the only tree this wrapper installs. */
const REPO_DIR = join(HERE, 'dsh-web-ui')
const SOURCE = join(REPO_DIR, 'packages', 'dsh-liangshen', 'presets', PRESET_ID)

/** Files the preset needs to stay mountable after the copy. */
const REQUIRED_FILES = ['agent.cordis.yml', 'tool-bootstrap.mjs']

for (const file of REQUIRED_FILES) {
  if (!existsSync(join(SOURCE, file))) {
    throw new Error(
      `${PRESET_ID}: preset source not found at ${join(SOURCE, file)} — `
      + 'initialize it with: git submodule update --init plugins/dsh-web-ui/dsh-web-ui',
    )
  }
}

const dshHome = process.env.DSH_HOME ?? join(ROOT, '.dsh')
const target = join(dshHome, '.agent-presets', PRESET_ID)

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
cpSync(SOURCE, target, { recursive: true })
console.log(`installed agent preset '${PRESET_ID}' (${SOURCE}) -> ${target}`)
