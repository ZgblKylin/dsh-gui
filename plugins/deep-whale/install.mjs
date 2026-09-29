#!/usr/bin/env node
/**
 * install.mjs — install and mount the `deep-whale` skin series into the web
 * profile from npm (per plugins/README.md's 安装方式 section: not marked as a
 * source install).
 *
 * Upstream INSTALL.md makes the published packages the regular install path and
 * scopes the bundled `dsh-skin-install` skill to legacy migration, local
 * development builds, specified-commit testing and diagnosis. This wrapper
 * therefore installs the published trio in upstream order:
 *   - @smalltailqwq/dsh-client-ui-skin-deep-whale-manager (常驻 manager)
 *   - @smalltailqwq/dsh-client-ui-skin-maid-atelier
 *   - @smalltailqwq/dsh-client-ui-skin-orca-link
 * Every tarball ships its prebuilt `lib/` and its own `cordis.patch.yml`, so
 * `dsh plugin add` reconciles each into `dsh.profile.bundles` and each mounts
 * through its own bundle layer (entry ids ui-skin-deep-whale-manager /
 * ui-skin-maid-atelier / ui-skin-orca-link) — no manual cordis.patch.yml insert
 * is added (that would double-mount them) and nothing is compiled locally.
 *
 * Each package carries its own version in the pinned `v0.1.6` tag: the two skins
 * moved to 0.1.6, while the manager is still 0.1.5 there and was never published
 * at 0.1.6 (`@smalltailqwq/dsh-client-ui-skin-deep-whale-manager@0.1.6` does not
 * exist on npm). One shared version constant would therefore 404 on the manager,
 * so the pins are per package.
 *
 * The two skins declare `@deepseek-ai/dsh: >=0.1.7-rc.1 <0.1.8-0`; the harness
 * dsh-v0.2.0-rc.2 admission gate compares that range with the running version and
 * rejects it, which fails `dsh plugin add` (exit 1) and drops the bundle layer at
 * boot. Upstream has not published a 0.2-compatible skin, so the two skins carry
 * an exact-version exemption (installNpmPlugin's `exempt`); the manager declares
 * `>=0.1.7-rc.1`, which 0.2.0-rc.2 satisfies, so it needs none. An exemption is
 * recorded per exact package version and runtime version, so the next harness
 * change invalidates it and the gate blocks the skins again.
 *
 * Skin mutual exclusion is the manager's own job: on the first restart after
 * installing it detects "two skins enabled at once" and atomically falls back
 * to the official default, after which a skin is chosen in 设置→皮肤管理. The
 * npm flow needs no pre-stage, so this wrapper stages nothing.
 *
 * Retired placeholder scope: installs made from GitHub before upstream 0.1.3
 * used `@dsh-external/*` dependency keys. Upstream's INSTALL.md requires
 * removing all three, otherwise the profile keeps two identities for the same
 * skins and two bundles inserting the same loader entry ids. This wrapper
 * performs that removal idempotently.
 *
 * The `dsh-deep-whale` submodule beside this script pins the version and stays
 * as a source reference only, like the dsh-web-ui and dsh-market wrappers: it is
 * neither built nor linked here.
 *
 * Target: `$DSH_HOME/profiles/web/`. `DSH_HOME` is pinned to `<runtime-root>/.dsh` by
 * the desktop shell; this script honors an explicit `DSH_HOME` override (the
 * build passes one) and otherwise pins the same runtime-root default.
 */

import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { requireHarnessRuntime } from '../../scripts/harness-runtime.mjs'
import { installNpmPlugin } from '../../scripts/plugin-install.mjs'
import { pinnedPath, ROOT, run, WEB_HOME } from '../../scripts/toolchain.mjs'

/** Wrapper id: the `plugins/<id>/` directory name, used for logs and skip checks. */
const ID = 'deep-whale'

/** Why the two skins are accepted despite their rejected @deepseek-ai/dsh peer. */
const SKIN_EXEMPTION = '两块皮肤的 @deepseek-ai/dsh peer 为 >=0.1.7-rc.1 <0.1.8-0，不含 0.2.0；上游在 v0.1.6 未发布适配 0.2 的皮肤包'

/**
 * Exact npm pins matching each package's own version in the pinned submodule tag
 * (`v0.1.6`), in upstream install order (manager first, then the two skins).
 * Exact versions bypass pnpm 11's default supply-chain `minimumReleaseAge` gate,
 * which would otherwise silently fall back to an older release for `@latest` or
 * a range.
 */
const SKIN_PACKAGES = [
  { name: '@smalltailqwq/dsh-client-ui-skin-deep-whale-manager', version: '0.1.5' },
  { name: '@smalltailqwq/dsh-client-ui-skin-maid-atelier', version: '0.1.6', exempt: SKIN_EXEMPTION },
  { name: '@smalltailqwq/dsh-client-ui-skin-orca-link', version: '0.1.6', exempt: SKIN_EXEMPTION },
]

/** Keys the retired `@dsh-external/*` placeholder scope left behind. */
const LEGACY_PACKAGES = [
  '@dsh-external/dsh-client-ui-skin-deep-whale-manager',
  '@dsh-external/dsh-client-ui-skin-maid-atelier',
  '@dsh-external/dsh-client-ui-skin-orca-link',
]

/**
 * Drop the retired placeholder-scope dependency keys from the web profile.
 *
 * Runs after the npm installs so the profile store is already pinned, and acts
 * only on keys the manifest still declares, so a re-run is a no-op.
 * @param {string} dshHome - the harness home whose web profile is inspected.
 */
function removeLegacyPlaceholderPackages(dshHome) {
  const manifestPath = join(dshHome, 'profiles', 'web', 'package.json')
  if (!existsSync(manifestPath)) return
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    // An unreadable manifest is not this cleanup's problem; installNpmPlugin
    // above already reported whatever the CLI said.
    return
  }
  const installed = LEGACY_PACKAGES.filter((name) => manifest.dependencies?.[name] !== undefined)
  if (installed.length === 0) return
  console.log(`\n==> remove retired '@dsh-external/*' placeholder packages (${installed.length})`)
  const cli = requireHarnessRuntime(ROOT)
  for (const name of installed) {
    console.log(`  dsh plugin remove ${name}`)
    run('node', [cli.bin, 'plugin', '--profile', 'web', 'remove', name], {
      env: { DSH_HOME: dshHome, PATH: pinnedPath() },
    })
  }
}

/**
 * Unlink the `@dsh-external/*` symlinks a retired `link:` install left in the
 * profile. pnpm drops the dependency but not the link it created, and the
 * leftover link is a second path to the same skin. Only entries that are
 * symbolic links are unlinked, so the source directories they point at are
 * never traversed; the scope directory itself is dropped once it is empty.
 * @param {string} dshHome - the harness home whose web profile is inspected.
 */
function removeLegacyPlaceholderLinks(dshHome) {
  const scopeDir = join(dshHome, 'profiles', 'web', 'node_modules', '@dsh-external')
  if (!existsSync(scopeDir)) return
  let removed = 0
  for (const entry of readdirSync(scopeDir)) {
    const path = join(scopeDir, entry)
    if (!lstatSync(path).isSymbolicLink()) continue
    rmSync(path, { force: true })
    removed += 1
  }
  if (removed > 0) console.log(`  unlinked ${removed} retired '@dsh-external/*' profile link(s)`)
  if (readdirSync(scopeDir).length === 0) rmSync(scopeDir, { recursive: true, force: true })
}

for (const skin of SKIN_PACKAGES) {
  installNpmPlugin({
    id: ID,
    packageSpec: `${skin.name}@${skin.version}`,
    exempt: skin.exempt ?? null,
  })
}

const dshHome = process.env.DSH_HOME ?? WEB_HOME
removeLegacyPlaceholderPackages(dshHome)
removeLegacyPlaceholderLinks(dshHome)