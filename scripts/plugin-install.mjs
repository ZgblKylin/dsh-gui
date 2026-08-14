/**
 * Shared implementation behind every per-plugin install script
 * `plugins/<id>/install.mjs`.
 *
 * Each wrapper script only owns its identity (id, package directory, and the
 * submodule hint); the build/install/mount pipeline lives here so every plugin
 * is handled identically:
 *
 *  1. build the package in place when it declares a `build` script (with the
 *     pinned toolchain pnpm and the repo-local store),
 *  2. pin the web profile's pnpm store so plain-terminal and desktop-shell
 *     installs share `.pnpm-store`,
 *  3. `dsh plugin --profile web add link:<package dir>` records the dependency
 *     (a `link:` spec, so edits to the package show up on the next boot),
 *  4. append an idempotent insert row to `.dsh/profiles/web/cordis.patch.yml`
 *     unless the package mounts itself through `dsh.bundle.patch`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  bootstrapPnpm,
  HARNESS_BIN,
  pinnedPath,
  pnpm,
  run,
  STORE,
  WEB_HOME,
} from './toolchain.mjs'

/**
 * Build the plugin package in place. A package without a `build` script ships
 * ready to use (prebuilt `lib/`, or config-only), so installing its dev deps
 * and looking for a build would only fail; its runtime deps resolve from the
 * profile install, which links the package directory as-is.
 * @param {string} packageDir - absolute path to the plugin package.
 */
function buildPackage(packageDir) {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  if (manifest.scripts?.build === undefined) {
    console.log(`  no build script — using ${basename(packageDir)} as shipped, skipping install + build`)
    return
  }
  console.log(`  pnpm install (repo-local store)`)
  pnpm(['install', '--store-dir', STORE], { cwd: packageDir, env: { CI: 'true' } })
  console.log('  pnpm run build')
  pnpm(['run', 'build'], { cwd: packageDir })
}

/**
 * Pin the profile's pnpm store. `dsh plugin` runs pnpm with the profile as cwd
 * and without --store-dir; pnpm >=10 reads its settings from
 * pnpm-workspace.yaml, and the unset default store resolves from the invoking
 * environment's home variables, which differ between a plain terminal and the
 * desktop shell. Without the pin, an install made from one context fails the
 * other with ERR_PNPM_UNEXPECTED_STORE.
 * @param {string} profileDir - absolute path to the web profile directory.
 */
function pinProfileStore(profileDir) {
  mkdirSync(profileDir, { recursive: true })
  const workspacePath = join(profileDir, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) {
    // Mirror the harness's profile template (hoisted linker, no auto peers).
    writeFileSync(workspacePath, 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  }
  let lines = readFileSync(workspacePath, 'utf8').split(/\r?\n/).filter((line) => !/^\s*storeDir\s*:/.test(line))
  while (lines.length > 0 && lines.at(-1) === '') lines.pop()
  lines.push('', `storeDir: '${STORE.replace(/'/g, "''")}'`, '')
  writeFileSync(workspacePath, lines.join('\n'))
}

/**
 * Record the plugin as a `link:` dependency of the web profile.
 * `dsh plugin add` only writes the dependency; mounting happens separately
 * (or through the package's own bundle layer).
 * @param {string} dshHome - the harness home to install into.
 * @param {string} packageDir - absolute path to the plugin package.
 */
function addDependency(dshHome, packageDir) {
  run('node', [HARNESS_BIN, 'plugin', '--profile', 'web', 'add', `link:${packageDir}`], {
    env: {
      DSH_HOME: dshHome,
      // `dsh plugin` forwards to `pnpm` on PATH; prepend the pinned toolchain
      // so the compatible pnpm is used no matter which system pnpm is installed.
      PATH: pinnedPath(),
    },
  })
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Mount a plugin entry into the web composition. The harness scans the
 * Loader's ENTRIES for `dsh.client` declarations, so a plugin stays inert
 * until a cordis.patch.yml insert turns it into an entry. Appends are
 * idempotent; user content is preserved.
 * @param {string} profileDir - absolute path to the web profile directory.
 * @param {{ id: string, name: string }} mount - the loader entry to insert.
 * @returns {boolean} whether the insert was newly written.
 */
function mountEntry(profileDir, mount) {
  mkdirSync(profileDir, { recursive: true })
  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) {
    // Mirror the harness's profile patch template.
    writeFileSync(patchPath, [
      '# Your patch layer for this dsh profile, applied after every bundle layer:',
      '# a top-level YAML array of loader patch entries (id-targeted config',
      '# overrides, disables, and insert lists; `!!js` expressions allowed).',
      '[]',
      '',
    ].join('\n'))
  }
  const text = readFileSync(patchPath, 'utf8')
  // Inline modifiers ((?m) etc.) are rejected under Node's default
  // type-stripping parse path, so flags go through the constructor.
  const pattern = `^\\s*-\\s*insert\\s*:\\s*$[^\\r\\n]*\\r?\\n[^\\r\\n]*-\\s*id:\\s*${escapeRegExp(mount.id)}[^\\r\\n]*\\r?\\n[^\\r\\n]*name:\\s*${escapeRegExp(mount.name)}\\s*$`
  if (new RegExp(pattern, 'm').test(text)) {
    console.log(`  already mounted as entry '${mount.id}'`)
    return false
  }
  const block = `- insert:\n    - id: ${mount.id}\n      name: ${mount.name}`
  const body = text.split(/\r?\n/).filter((line) => !/^\s*#/.test(line) && !/^\s*$/.test(line)).join('\n')
  let newText
  if (body.trim() === '[]') {
    // Replace the empty default; keep the template comments.
    newText = text.split(/\r?\n/).filter((line) => !/^\s*\[\]\s*$/.test(line)).join('\n').trimEnd() + '\n' + block + '\n'
  } else {
    newText = text.trimEnd() + '\n' + block + '\n'
  }
  writeFileSync(patchPath, newText)
  console.log(`  mounted ${mount.name} as entry '${mount.id}'`)
  return true
}

/**
 * Install one plugin package into the repo-local web profile.
 *
 * @param {{ id: string, packageDir: string, sourceHint?: string }} options
 *   - id: the plugin id (the `plugins/<id>/` wrapper directory name).
 *   - packageDir: absolute path to the plugin package (second-level directory).
 *   - sourceHint: optional submodule-init hint shown when the package is missing.
 */
export function installPlugin({ id, packageDir, sourceHint = null }) {
  const manifestPath = join(packageDir, 'package.json')
  if (!existsSync(manifestPath)) {
    const hint = sourceHint === null ? '' : ` — initialize it with: ${sourceHint}`
    throw new Error(`${id}: plugin package not found at ${packageDir}${hint}`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const packageName = String(manifest.name ?? basename(packageDir))

  console.log(`\n==> install plugin '${id}' (${packageDir})`)
  bootstrapPnpm()
  buildPackage(packageDir)

  const dshHome = process.env.DSH_HOME ?? WEB_HOME
  const profileDir = join(dshHome, 'profiles', 'web')
  pinProfileStore(profileDir)

  if (!existsSync(HARNESS_BIN)) {
    throw new Error(`${id}: harness CLI not built at ${HARNESS_BIN} — run "npm run setup" once`)
  }
  addDependency(dshHome, packageDir)

  if (manifest.dsh?.bundle?.patch !== undefined) {
    // A bundle patch plugin mounts itself: `dsh plugin add` reconciles it into
    // dsh.profile.bundles, and its own cordis.patch.yml insert row reaches the
    // composition as a bundle layer. A manual insert would double-mount it.
    console.log(`  ${packageName} declares dsh.bundle.patch — it mounts through its bundle layer, no cordis.patch.yml insert added`)
    console.log(`installed plugin '${id}' into ${profileDir}`)
    return
  }
  const mountId = String(manifest.dsh?.gui?.mountId ?? packageName.replace(/^dsh-/, ''))
  mountEntry(profileDir, { id: mountId, name: packageName })
  console.log(`installed plugin '${id}' into ${profileDir}`)
}
