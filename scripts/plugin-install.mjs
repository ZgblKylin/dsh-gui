/**
 * Shared implementation behind every per-plugin install script
 * `plugins/<id>/install.mjs`.
 *
 * Each wrapper script only owns its identity (id, package directory, submodule
 * hint, and optional build opt-out); the build/install/mount pipeline lives
 * here so every plugin is handled identically:
 *
 *  1. build the package in place when it declares a `build` script (with the
 *     pinned toolchain pnpm and the repo-local store), unless the wrapper
 *     explicitly opts out with `build: false` (prebuilt distribution packages),
 *  2. pin the web profile's pnpm store so plain-terminal and desktop-shell
 *     installs share `.pnpm-store`,
 *  3. `dsh plugin --profile web add link:<package dir>` records the dependency
 *     (a `link:` spec, so edits to the package show up on the next boot),
 *  4. append an idempotent insert row to `.dsh/profiles/web/cordis.patch.yml`
 *     unless the package mounts itself through `dsh.bundle.patch`; the row is
 *     the wrapper's explicit `mount` entry when given, else derived from the
 *     package manifest.
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
  let lines = readFileSync(workspacePath, 'utf8').split(/\r?\n/)
  lines = lines.filter((line) => !/^\s*storeDir\s*:/.test(line))

  // Keep the profile's allowBuilds section (pnpm 11's build-script approval
  // list) but force-deny node-pty: its package ships prebuilt binaries under
  // prebuilds/<platform>-<arch>/, so the install script (a check-only
  // prebuild.js || node-gyp fallback) is a no-op — and pnpm's shell spawn for
  // it is blocked in the sandbox (spawn EPERM). pnpm 11 also writes a
  // placeholder value ('set this to true or false') on
  // ERR_PNPM_IGNORED_BUILDS, which is not a valid boolean and would fail
  // every subsequent install.
  const allowIndex = lines.findIndex((line) => /^\s*allowBuilds\s*:/.test(line))
  let rest = lines
  let section = []
  if (allowIndex >= 0) {
    section = lines.slice(allowIndex + 1)
    const end = section.findIndex((line) => /^\S/.test(line))
    const tail = end === -1 ? [] : section.slice(end)
    section = end === -1 ? section : section.slice(0, end)
    rest = [...lines.slice(0, allowIndex), ...tail]
  }
  section = section.filter((line) => !/^\s*node-pty\s*:/.test(line))
  section.push('  node-pty: false')
  while (rest.length > 0 && rest.at(-1) === '') rest.pop()
  rest.push('', `storeDir: '${STORE.replace(/'/g, "''")}'`, '', 'allowBuilds:', ...section, '')
  writeFileSync(workspacePath, rest.join('\n'))
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

/**
 * Extract the mount rows from a cordis patch-list text: each `- insert:` list
 * contributes its `- id:`/`name:` pairs. Comment lines are skipped and
 * indentation is free-form, so a hand-reindented file keeps matching; rows
 * outside an insert list (id-targeted config overrides) are ignored.
 * Names may be single-quoted YAML scalars (e.g. scoped package names like
 * '@linxin666/dsh-pet'); quotes are stripped and `''` escapes are
 * unescaped before the row is returned.
 * @param {string} text - patch-list file content.
 * @returns {{ id: string, name: string }[]}
 */
export function parseInsertRows(text) {
  const rows = []
  let inInsert = false
  let pendingId = null
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue
    if (/^\s*- insert:\s*$/.test(line)) {
      inInsert = true
      pendingId = null
      continue
    }
    if (!inInsert) continue
    const idMatch = /^\s*-\s*id:\s*(\S+)\s*$/.exec(line)
    // A name may be a quoted YAML scalar ('@scope/name'); match the quoted
    // form first so the quotes are not captured as part of the value.
    const nameMatch =
      /^\s*name:\s*'([^']*)'\s*$/.exec(line)
      ?? /^\s*name:\s*(\S+)\s*$/.exec(line)
    if (idMatch !== null) {
      pendingId = idMatch[1]
    } else if (nameMatch !== null && pendingId !== null) {
      rows.push({ id: pendingId, name: (nameMatch[1] ?? nameMatch[2]).replace(/''/g, "'") })
      pendingId = null
    }
  }
  return rows
}

/**
 * Mount a plugin entry into the web composition. The harness scans the
 * Loader's ENTRIES for `dsh.client` declarations, so a plugin stays inert
 * until a cordis.patch.yml insert turns it into an entry. Appends are
 * idempotent (existing rows are parsed back with parseInsertRows, so
 * reindented blocks still match); user content is preserved.
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
  // Match by id, not by the block's exact bytes: a second row with the same
  // id would double-mount the plugin, whatever its formatting or name.
  const existing = parseInsertRows(text).find((row) => row.id === mount.id)
  if (existing !== undefined) {
    if (existing.name !== mount.name) {
      console.warn(`  entry '${mount.id}' already mounts ${existing.name}; keeping it instead of ${mount.name}`)
    } else {
      console.log(`  already mounted as entry '${mount.id}'`)
    }
    return false
  }
  // Quote names that are not plain YAML scalars: scoped package names
  // start with '@', a YAML indicator character, and would make the written
  // row unparsable. parseInsertRows strips the quotes back off on re-read.
  const name = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(mount.name)
    ? mount.name
    : `'${mount.name.replace(/'/g, "''")}'`
  const block = `- insert:\n    - id: ${mount.id}\n      name: ${name}`
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
 * @param {{ id: string, packageDir: string, sourceHint?: string | null,
 *   mount?: { id: string, name: string } | null, build?: boolean }} options
 *   - id: the plugin id (the `plugins/<id>/` wrapper directory name).
 *   - packageDir: absolute path to the plugin package (second-level directory,
 *     or one level deeper for a multi-package distribution-repo submodule).
 *   - sourceHint: optional submodule-init hint shown when the package is missing.
 *   - mount: explicit mount entry for plain packages; overrides the entry
 *     derived from the manifest (usually owned by the wrapper's own
 *     cordis.patch.yml mount recipe).
 *   - build: whether the shared build pipeline may run (default true). Set
 *     false for packages that ship prebuilt output but still declare a
 *     `build` script for upstream development.
 */
export function installPlugin({ id, packageDir, sourceHint = null, mount = null, build = true }) {
  const manifestPath = join(packageDir, 'package.json')
  if (!existsSync(manifestPath)) {
    const hint = sourceHint === null ? '' : ` — initialize it with: ${sourceHint}`
    throw new Error(`${id}: plugin package not found at ${packageDir}${hint}`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const packageName = String(manifest.name ?? basename(packageDir))

  console.log(`\n==> install plugin '${id}' (${packageDir})`)
  bootstrapPnpm()
  if (build) {
    buildPackage(packageDir)
  } else {
    console.log(`  wrapper opted out of build — using ${basename(packageDir)} as shipped`)
  }

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
  const mountId = String(mount?.id ?? manifest.dsh?.gui?.mountId ?? packageName.replace(/^dsh-/, ''))
  const mountName = String(mount?.name ?? packageName)
  mountEntry(profileDir, { id: mountId, name: mountName })
  console.log(`installed plugin '${id}' into ${profileDir}`)
}

/**
 * Derive the bare package name from an npm install spec (e.g.
 * `dsh-better-sidebar@latest` -> `dsh-better-sidebar`,
 * `@linxin666/dsh-pet@latest` -> `@linxin666/dsh-pet`).
 * @param {string} spec - the npm package spec.
 * @returns {string} the package name.
 */
function packageNameFromSpec(spec) {
  const at = spec.lastIndexOf('@')
  return at > 0 ? spec.slice(0, at) : spec
}

/**
 * Install one plugin package from the npm registry into the repo-local web
 * profile (per plugins/README.md's 安装方式 section: plugins not marked as
 * source installs use `dsh plugin add <package>`).
 *
 * `dsh plugin add <spec>` forwards to pnpm add in the profile directory; when
 * the package declares `dsh.bundle.patch`, the CLI reconciles it into
 * `dsh.profile.bundles` automatically and the package mounts itself — no
 * manual cordis.patch.yml insert is written (that would double-mount it).
 * Without a bundle patch the entry is appended like installPlugin does
 * (explicit `mount` when given, else derived from the installed manifest).
 *
 * @param {{ id: string, packageSpec: string, mount?: { id: string, name: string } | null }} options
 *   - id: the plugin id (the `plugins/<id>/` wrapper directory name).
 *   - packageSpec: the npm install spec, e.g. `dsh-better-sidebar@latest`.
 *   - mount: explicit mount entry for packages without a bundle patch.
 */
export function installNpmPlugin({ id, packageSpec, mount = null }) {
  const dshHome = process.env.DSH_HOME ?? WEB_HOME
  const profileDir = join(dshHome, 'profiles', 'web')
  console.log(`\n==> install plugin '${id}' (${packageSpec} from npm)`)
  bootstrapPnpm()
  pinProfileStore(profileDir)
  if (!existsSync(HARNESS_BIN)) {
    throw new Error(`${id}: harness CLI not built at ${HARNESS_BIN} — run "npm run setup" once`)
  }
  run('node', [HARNESS_BIN, 'plugin', '--profile', 'web', 'add', packageSpec], {
    env: {
      DSH_HOME: dshHome,
      PATH: pinnedPath(),
    },
  })

  const name = packageNameFromSpec(packageSpec)
  const manifestPath = join(profileDir, 'node_modules', ...name.split('/'), 'package.json')
  if (!existsSync(manifestPath)) {
    console.log(`installed plugin '${id}' into ${profileDir}`)
    return
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.dsh?.bundle?.patch !== undefined) {
    // A bundle patch plugin mounts itself: `dsh plugin add` already
    // reconciled it into dsh.profile.bundles.
    console.log(`  ${name} declares dsh.bundle.patch — it mounts through its bundle layer, no cordis.patch.yml insert added`)
    console.log(`installed plugin '${id}' into ${profileDir}`)
    return
  }
  const packageName = String(manifest.name ?? name)
  const mountId = String(mount?.id ?? manifest.dsh?.gui?.mountId ?? packageName.replace(/^dsh-/, ''))
  const mountName = String(mount?.name ?? packageName)
  mountEntry(profileDir, { id: mountId, name: mountName })
  console.log(`installed plugin '${id}' into ${profileDir}`)
}
