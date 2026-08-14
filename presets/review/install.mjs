#!/usr/bin/env node
/**
 * install.mjs — install the `review` agent preset into the harness home.
 *
 * A preset is a directory of two files (`agent.cordis.yml` + optional
 * `preset.yml`); the directory name under the harness home's `.agent-presets`
 * root is the preset id. This script is the preset's own install step: the
 * top-level build (scripts/dsh-gui.mjs) discovers each preset's install.mjs
 * script and runs it, so a preset can change how it lands without touching the
 * shared tooling. Copying with overwrite makes re-runs idempotent.
 *
 * Target: `$DSH_HOME/.agent-presets/review/`. `DSH_HOME` is pinned to
 * `<repo>/.dsh` by the desktop shell; this script honors an explicit
 * `DSH_HOME` override (the build passes one) and otherwise pins the same
 * repo-local default.
 */

import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This preset's directory — the source of truth for what gets installed. */
const HERE = dirname(fileURLToPath(import.meta.url))
/** Repository root: presets/<id>/install.mjs -> <repo>/. */
const ROOT = resolve(HERE, '..', '..')
/** The preset id; also the directory name it installs under. */
const PRESET_ID = 'review'
/** Files a preset directory ships to the harness home. */
const FILES = ['agent.cordis.yml', 'preset.yml']

const dshHome = process.env.DSH_HOME ?? join(ROOT, '.dsh')
const target = join(dshHome, '.agent-presets', PRESET_ID)

mkdirSync(target, { recursive: true })
for (const file of FILES) {
  copyFileSync(join(HERE, file), join(target, file))
}
console.log(`installed agent preset '${PRESET_ID}' -> ${target}`)
