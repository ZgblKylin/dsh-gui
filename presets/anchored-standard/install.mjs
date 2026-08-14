#!/usr/bin/env node
/**
 * install.mjs — install the `anchored-standard` agent preset into the harness
 * home.
 *
 * This preset's source lives in the dsh-anchored-standard git submodule
 * checkout beside this script: its `preset/` directory holds the composition,
 * the display metadata, and a local plugin module the composition loads by
 * relative path (./tool-bootstrap.mjs). The whole directory is copied because
 * that relative load resolves against the preset directory in the harness
 * home — copying single files would leave the composition unloadable. The
 * target is replaced and re-copied on every run, so re-installs are
 * idempotent and stale files cannot survive a source change.
 *
 * Target: `$DSH_HOME/.agent-presets/anchored-standard/`. `DSH_HOME` is pinned
 * to `<repo>/.dsh` by the desktop shell; this script honors an explicit
 * `DSH_HOME` override (the build passes one) and otherwise pins the same
 * repo-local default.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This preset's directory — the wrapper that owns the submodule checkout. */
const HERE = dirname(fileURLToPath(import.meta.url))
/** Repository root: presets/<id>/install.mjs -> <repo>/. */
const ROOT = resolve(HERE, '..', '..')
/** The preset id; also the directory name it installs under. */
const PRESET_ID = 'anchored-standard'
/** Source of truth inside the dsh-anchored-standard submodule, per its README. */
const SOURCE = join(HERE, 'dsh-anchored-standard', 'preset')

const dshHome = process.env.DSH_HOME ?? join(ROOT, '.dsh')
const target = join(dshHome, '.agent-presets', PRESET_ID)

if (!existsSync(join(SOURCE, 'agent.cordis.yml'))) {
  throw new Error(
    `${PRESET_ID}: preset source not found at ${SOURCE} — initialize the submodule `
    + 'with: git submodule update --init presets/anchored-standard/dsh-anchored-standard',
  )
}

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
cpSync(SOURCE, target, { recursive: true })
console.log(`installed agent preset '${PRESET_ID}' (${SOURCE}) -> ${target}`)
