#!/usr/bin/env node
/**
 * install.mjs — install and mount the `review` plugin into the web profile.
 *
 * The plugin source lives in the `dsh-review` package beside this script. It
 * ships prebuilt (`lib/index.js`, plain ESM with no build step), so the shared
 * installer skips pnpm install + build for it and links the package directory
 * as-is into `.dsh/profiles/web/`. The package declares no `dsh` manifest
 * convention; this wrapper owns the mount: `cordis.patch.yml` beside this
 * script holds the insert row (`id: review`, `name: dsh-review`), which the
 * shared installer writes idempotently into the profile's cordis.patch.yml.
 * That layer is live-watched by a running profile, so a reinstall mounts the
 * entry without a restart, and the same row is the copy-paste mount for
 * standalone installs.
 *
 * Target: `$DSH_HOME/profiles/web/`. `DSH_HOME` is pinned to `<repo>/.dsh` by
 * the desktop shell; this script honors an explicit `DSH_HOME` override (the
 * build passes one) and otherwise pins the same repo-local default.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPlugin, parseInsertRows } from '../../scripts/plugin-install.mjs'

/** This plugin's wrapper directory — owns the in-tree plugin package. */
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Read the wrapper's cordis.patch.yml and extract its single mount row. The
 * file is this plugin's mount recipe, so the mounted entry and the standalone
 * copy-paste row cannot drift apart.
 * @returns {{ id: string, name: string }}
 */
function readMount() {
  const rows = parseInsertRows(readFileSync(join(HERE, 'cordis.patch.yml'), 'utf8'))
  if (rows.length === 0) {
    throw new Error('review: cordis.patch.yml holds no mount row (expected one `- insert:` block with an `- id:`/`name:` pair)')
  }
  if (rows.length > 1) {
    throw new Error(`review: cordis.patch.yml must hold exactly one mount row, found ${rows.length}`)
  }
  return rows[0]
}

installPlugin({
  id: 'review',
  packageDir: join(HERE, 'dsh-review'),
  mount: readMount(),
})
