#!/usr/bin/env node
/**
 * install.mjs — install the `dsh-connection-compat` plugin into the selected profile.
 *
 * In-tree package (`dsh-connection-compat/` beside this script), no build step:
 * the package is plain ESM with zero runtime dependencies, so the shared
 * pipeline uses it as shipped. The package declares no `dsh.bundle.patch`, so
 * this wrapper passes an explicit `mount` entry and the pipeline writes the
 * insert row (`id: connection-compat`, `name: dsh-connection-compat`) into the
 * profile's `cordis.patch.yml` — a package without a bundle layer has no other
 * way to become a Loader entry.
 *
 * The package restores `connection.requestRejection`, which
 * `@deepseek-ai/dsh-client-connection` removed; third-party plugins still call
 * it as the trust fence of their self-registered HTTP/WS routes, so every
 * profile that mounts those plugins also needs this entry.
 *
 * `DSH_PLUGIN_PROFILE` selects the profile (default `web`); the desktop build
 * re-runs every wrapper with `DSH_PLUGIN_PROFILE=desktop`, so the plugin lands
 * in both profiles. Only `$DSH_HOME/profiles/<profile>` is written (`$DSH_HOME`
 * defaults to `<runtime-root>/.dsh`); nothing global.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPlugin } from '../../scripts/plugin-install.mjs'

/** This plugin's directory — the wrapper that owns the plugin package. */
const HERE = dirname(fileURLToPath(import.meta.url))

installPlugin({
  id: 'connection-compat',
  packageDir: join(HERE, 'dsh-connection-compat'),
  mount: { id: 'connection-compat', name: 'dsh-connection-compat' },
})
