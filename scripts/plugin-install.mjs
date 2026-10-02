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
 *  2. pin the target profile's pnpm store so plain-terminal and desktop-shell
 *     installs share `.pnpm-store`,
 *  3. `dsh plugin --profile <profile> add link:<package dir>` records the
 *     dependency (a `link:` spec, so edits to the package show up on the next
 *     boot),
 *  4. append an idempotent insert row to `<profile>/cordis.patch.yml`
 *     unless the package mounts itself through `dsh.bundle.patch`; bundle
 *     packages instead remove a matching legacy row written by older versions
 *     of this installer. Plain-package rows use the wrapper's explicit `mount`
 *     entry (id/name plus an optional `config` rendered as the row's config
 *     block) when given, else one derived from the package manifest.
 *
 * Both install functions fast-path an already-satisfied profile: an npm package
 * pinned to an exact version that is installed and mounted is left alone, and a
 * `link:` package whose dependency and mount are recorded skips only the profile
 * write (its build still runs). `npm run rebuild` (or `DSH_PLUGIN_REBUILD=1`)
 * disables both fast paths for a full reinstall.
 *
 * `DSH_PLUGIN_PROFILE` selects the profile (default `web`), and
 * `DSH_PLUGIN_DSH_CLI` replaces the repository's own CLI with a carrier that
 * owns a reserved profile — the desktop app's CLI, which refuses the
 * repository's `dsh` and ships the pnpm it needs. Wrappers stay profile-agnostic
 * and only call the exported install functions.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { requireHarnessRuntime, submoduleVersion } from './harness-runtime.mjs'
import {
  bootstrapPnpm,
  pinnedPath,
  pnpm,
  ROOT,
  run,
  STORE,
  WEB_HOME,
} from './toolchain.mjs'

/** Profile the wrappers install into; the desktop build re-runs them with `desktop`. */
const profileName = (process.env.DSH_PLUGIN_PROFILE ?? 'web').trim() || 'web'
/**
 * The `dsh` CLI carrier for `plugin` commands, or null for the repository's own.
 *
 * A reserved profile (the desktop app's) is only accepted by its own CLI, which
 * already carries the pnpm it needs: selecting it here is what makes the shared
 * pipeline profile-agnostic without teaching it about the desktop layout.
 */
const carrier = (process.env.DSH_PLUGIN_DSH_CLI ?? '').trim() || null

/**
 * Run one `dsh plugin ...` command against the selected profile.
 *
 * Without a carrier this is the repository runtime's CLI run through node, with
 * the pinned toolchain prepended to PATH: `dsh plugin` forwards to `pnpm`, so
 * the compatible pinned pnpm must win over any system install. With a carrier
 * the carrier is spawned directly and PATH is left alone — it carries its own
 * package manager and is the only CLI allowed to touch a reserved profile.
 * @param {string} dshHome - the harness home holding the profile.
 * @param {string[]} args - arguments after the CLI, e.g.
 *   `['plugin', '--profile', 'web', 'add', spec]`.
 */
function runPluginCommand(dshHome, args) {
  if (carrier !== null) {
    run(carrier, args, { env: { DSH_HOME: dshHome } })
    return
  }
  // Fails loud when the pinned dsh CLI is not installed for the configured
  // runtime (`harness.json`), with the runtime-specific remedy.
  const cli = requireHarnessRuntime(ROOT)
  run('node', [cli.bin, ...args], {
    env: {
      DSH_HOME: dshHome,
      PATH: pinnedPath(),
    },
  })
}

/**
 * The dsh version a version exemption is keyed to.
 *
 * The repository CLI reports the version it runs; a carrier ships the pinned
 * submodule's release, which is also what the desktop app was built from, so the
 * pinned submodule is the authority there and the exemption needs no repository
 * runtime install.
 * @returns {string} the exact dsh version.
 */
function profileDshVersion() {
  if (carrier === null) return requireHarnessRuntime(ROOT).version
  const version = submoduleVersion(ROOT)
  if (version === null) throw new Error(`cannot read the dsh version from the pinned submodule at ${ROOT}`)
  return version
}

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
 * other with ERR_PNPM_UNEXPECTED_STORE. Exported so wrappers that add a package
 * through a direct `dsh plugin add` call (instead of installPlugin) keep the
 * same store/nodeLinker/allowBuilds guarantees.
 *
 * A carrier (the desktop app's CLI) is the exception: every install into its
 * reserved profile runs through that same carrier, its app already linked the
 * profile's `node_modules` from the store its own environment resolves
 * (`<project drive>/.pnpm-store` when its home sits on another drive), and
 * pinning the repository store instead makes pnpm refuse the profile with
 * ERR_PNPM_UNEXPECTED_STORE. The store line is therefore written only for
 * installs that run the repository's own CLI.
 * @param {string} profileDir - absolute path to the profile directory.
 */
export function pinProfileStore(profileDir) {
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
  // The whole section is re-emitted on every install, so its trailing blank
  // lines have to go: keeping them grows the file by one line per install.
  while (section.length > 0 && section.at(-1) === '') section.pop()
  section.push('  node-pty: false')
  while (rest.length > 0 && rest.at(-1) === '') rest.pop()
  if (carrier === null) rest.push('', `storeDir: '${STORE.replace(/'/g, "''")}'`)
  rest.push('', 'allowBuilds:', ...section, '')
  writeFileSync(workspacePath, rest.join('\n'))
}

/**
 * Record the plugin as a `link:` dependency of the selected profile.
 * `dsh plugin add` only writes the dependency; mounting happens separately
 * (or through the package's own bundle layer).
 * @param {string} dshHome - the harness home to install into.
 * @param {string} packageDir - absolute path to the plugin package.
 */
function addDependency(dshHome, packageDir) {
  runPluginCommand(dshHome, ['plugin', '--profile', profileName, 'add', `link:${packageDir}`])
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
 * Remove legacy insert blocks emitted by mountEntry when a package has since
 * migrated to `dsh.bundle.patch`. Matching both id and package name keeps
 * arbitrary user-authored patch entries untouched. The formatter and all
 * unrelated content are preserved byte-for-byte apart from removed blocks.
 *
 * A row may carry a `config:` block (mountEntry renders per-row settings such as
 * a browser-use provider config as deeper-indented lines). Those lines belong to
 * the row: dropping only the three header lines would orphan the block and make
 * the whole patch unparsable. Continuation lines are exactly the non-empty lines
 * indented deeper than the row's own `- id:` marker, which also stops at a
 * sibling row (same indent) and at the blank line between blocks.
 *
 * @param {string} text - patch-list file content.
 * @param {{ id: string, name: string }} mount - the obsolete manual mount.
 * @returns {{ text: string, removed: number }} rewritten text and match count.
 */
export function removeLegacyInsertBlocks(text, mount) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const trailingNewline = /\r?\n$/.test(text)
  const lines = text.split(/\r?\n/)
  const indentOf = (line) => /^[ \t]*/.exec(line)[0].length
  let removed = 0

  for (let index = 0; index + 2 < lines.length;) {
    const insert = /^\s*- insert:\s*$/.test(lines[index])
    const idLine = /^([ \t]*)-[ \t]*id:\s*(\S+)\s*$/.exec(lines[index + 1])
    const quotedName = /^\s*name:\s*'([^']*)'\s*$/.exec(lines[index + 2])?.[1]
    const plainName = /^\s*name:\s*(\S+)\s*$/.exec(lines[index + 2])?.[1]
    const name = (quotedName ?? plainName)?.replace(/''/g, "'")
    if (insert && idLine?.[2] === mount.id && name === mount.name) {
      const rowIndent = idLine[1].length
      let end = index + 3
      while (end < lines.length && lines[end].trim() !== '' && indentOf(lines[end]) > rowIndent) end += 1
      lines.splice(index, end - index)
      removed += 1
      continue
    }
    index += 1
  }

  if (removed === 0) return { text, removed }

  const payload = lines.filter((line) => !/^\s*(?:#.*)?$/.test(line))
  if (payload.length === 0) {
    while (lines.at(-1) === '') lines.pop()
    lines.push('[]')
    if (trailingNewline) lines.push('')
  }
  return { text: lines.join(newline), removed }
}

/** Remove an obsolete installer-owned manual mount from the profile patch. */
function unmountLegacyEntry(profileDir, mount) {
  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) return false
  const result = removeLegacyInsertBlocks(readFileSync(patchPath, 'utf8'), mount)
  if (result.removed === 0) return false
  writeFileSync(patchPath, result.text)
  console.log(`  removed ${result.removed} legacy manual mount for bundle entry '${mount.id}'`)
  return true
}

/** Render a single YAML scalar (string, number, boolean, null). */
function yamlScalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  const text = String(value)
  // Quote strings that aren't plain alphanumeric/dot/underscore tokens: e.g.
  // scoped package names ('@scope/name') and Windows paths need quoting.
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(text) ? text : `'${text.replace(/'/g, "''")}'`
}

/** Render a config object as indented YAML lines under the row's `config:`. */
function yamlObjectLines(object, indent) {
  const lines = []
  for (const [key, value] of Object.entries(object)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      lines.push(`${' '.repeat(indent)}${key}:`)
      lines.push(...yamlObjectLines(value, indent + 2))
    } else {
      lines.push(`${' '.repeat(indent)}${key}: ${yamlScalar(value)}`)
    }
  }
  return lines
}

/**
 * Mount a plugin entry into the web composition. The harness scans the
 * Loader's ENTRIES for `dsh.client` declarations, so a plugin stays inert
 * until a cordis.patch.yml insert turns it into an entry. Appends are
 * idempotent (existing rows are parsed back with parseInsertRows, so
 * reindented blocks still match); user content is preserved.
 * @param {string} profileDir - absolute path to the profile directory.
 * @param {{ id: string, name: string, config?: object | null }} mount - the loader
 *   entry to insert; `config` becomes the row's `config:` block (a plain
 *   package whose entry needs per-row settings, e.g. a browser-use provider).
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
  let block = `- insert:\n    - id: ${mount.id}\n      name: ${name}`
  if (mount.config !== undefined && mount.config !== null) {
    block += `\n      config:\n${yamlObjectLines(mount.config, 8).join('\n')}`
  }
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
 * Install one plugin package into the runtime-root profile selected by
 * `DSH_PLUGIN_PROFILE`.
 *
 * The package is always built (it is a `link:` install, so its sources decide
 * what is current); the profile dependency write is skipped when the profile
 * already links this exact directory and the mount state is intact. `npm run
 * rebuild` (`DSH_PLUGIN_REBUILD=1`) disables that fast path.
 *
 * @param {{ id: string, packageDir: string, sourceHint?: string | null,
 *   mount?: { id: string, name: string, config?: object | null } | null,
 *   build?: boolean }} options
 *   - id: the plugin id (the `plugins/<id>/` wrapper directory name).
 *   - packageDir: absolute path to the plugin package (second-level directory,
 *     or one level deeper for a multi-package distribution-repo submodule).
 *   - sourceHint: optional submodule-init hint shown when the package is missing.
 *   - mount: explicit mount entry for plain packages; overrides the entry
 *     derived from the manifest (usually owned by the wrapper's own
 *     cordis.patch.yml mount recipe). `config` becomes the row's `config:`
 *     block (e.g. a browser-use provider's per-row settings).
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
  const profileDir = pluginProfileDir(dshHome)
  pinProfileStore(profileDir)

  // Fails loud when the pinned dsh CLI is not installed for the configured
  // runtime (`harness.json`), with the runtime-specific remedy. A carrier
  // replaces that CLI, so it is not required then.
  if (carrier === null) requireHarnessRuntime(ROOT)

  // The package is built above either way: a `link:` install has no version to
  // compare, so only the build proves its sources current. What can be skipped
  // is the profile dependency write, which pnpm would re-resolve for nothing.
  if (!reinstallRequested() && linkDependencyUpToDate(profileDir, packageDir, packageName, manifest, mount)) {
    console.log(`  profile already links ${packageName} at this directory — skipping "dsh plugin add"`)
    console.log('  reinstall every plugin with "npm run rebuild" (or DSH_PLUGIN_REBUILD=1)')
    console.log(`installed plugin '${id}' into ${profileDir}`)
    return
  }
  addDependency(dshHome, packageDir)

  if (manifest.dsh?.bundle?.patch !== undefined) {
    // A bundle patch plugin mounts itself: `dsh plugin add` reconciles it into
    // dsh.profile.bundles, and its own cordis.patch.yml insert row reaches the
    // composition as a bundle layer. A manual insert would double-mount it.
    const mountId = String(mount?.id ?? manifest.dsh?.gui?.mountId ?? packageName.replace(/^dsh-/, ''))
    const mountName = String(mount?.name ?? packageName)
    unmountLegacyEntry(profileDir, { id: mountId, name: mountName })
    console.log(`  ${packageName} declares dsh.bundle.patch — it mounts through its bundle layer, no cordis.patch.yml insert added`)
    console.log(`installed plugin '${id}' into ${profileDir}`)
    return
  }
  const mountId = String(mount?.id ?? manifest.dsh?.gui?.mountId ?? packageName.replace(/^dsh-/, ''))
  const mountName = String(mount?.name ?? packageName)
  mountEntry(profileDir, { id: mountId, name: mountName, config: mount?.config ?? null })
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

/** Read and parse a JSON file; null when it is missing or unparsable. */
function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * The exact version of an npm spec (`name@1.2.3`, `name@1.2.3-rc.1`), or null
 * when the spec is a tag, range, URL, or git reference.
 *
 * Only an exact pin can be verified against the installed tree; anything else
 * has to go through the resolver, so it is never skipped.
 * @param {string} spec - the npm package spec.
 * @returns {string | null}
 */
function exactSpecVersion(spec) {
  const name = packageNameFromSpec(spec)
  if (!spec.startsWith(`${name}@`)) return null
  const version = spec.slice(name.length + 1)
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version) ? version : null
}

/**
 * Grant one plugin version the profile's exact-version compatibility exemption.
 *
 * Since harness dsh-v0.2.0-rc.2 the app-boot admission gate compares every
 * `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer with the running dsh version:
 * a package whose range predates that version is refused by `dsh plugin add`
 * (exit 1) and its bundle layer is skipped at boot. The exemption is the only
 * way to keep such a package mounted. It is keyed by exact package version and
 * exact runtime version, so a later harness upgrade invalidates it instead of
 * carrying the accepted risk forward. `--accept-risk` is the CLI contract for
 * that acknowledgement.
 * @param {string} dshHome - the harness home whose profile is written.
 * @param {string} profileDir - absolute profile directory.
 * @param {string} packageSpec - exact npm spec, e.g. `dsh-sidebar-qa@1.1.0`.
 * @param {string} reason - why this version is accepted despite its peers.
 */
function grantVersionExemption(dshHome, profileDir, packageSpec, reason) {
  if (exactSpecVersion(packageSpec) === null) {
    throw new Error(`a version exemption needs an exact version, got ${packageSpec}`)
  }
  const version = profileDshVersion()
  pinProfileStore(profileDir)
  console.log(`\n==> accept the compatibility risk for ${packageSpec} on dsh ${version}`)
  console.log(`  ${reason}`)
  runPluginCommand(dshHome, ['plugin', '--profile', profileName, 'allow-version', packageSpec, '--dsh-version', version, '--accept-risk'])
}

/** The selected profile directory inside one harness home. */
function pluginProfileDir(dshHome) {
  return join(dshHome, 'profiles', profileName)
}

/** Whether two paths name the same directory (resolving links/junctions). */
function sameDirectory(left, right) {
  try {
    const a = realpathSync(left)
    const b = realpathSync(right)
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  } catch {
    return false
  }
}

/**
 * Whether a full reinstall was requested, disabling the up-to-date skip so every
 * package is installed again (`npm run rebuild`, `DSH_PLUGIN_REBUILD=1`).
 *
 * `DSH_PLUGIN_FORCE_INSTALL=1` counts too: it already means "install this even
 * though the pipeline would not", and it must not leave a stale package behind.
 * Note the reverse is not true — this switch never overrides a wrapper-declared
 * mask, which only `DSH_PLUGIN_FORCE_INSTALL=1` does (see skipInstall()).
 * @returns {boolean}
 */
export function reinstallRequested() {
  return process.env.DSH_PLUGIN_REBUILD === '1' || process.env.DSH_PLUGIN_FORCE_INSTALL === '1'
}

/**
 * Whether the mount (or bundle) state of an installed package is intact, derived
 * exactly like the install path derives it: a `dsh.bundle.patch` package must be
 * listed in the profile's `dsh.profile.bundles` and must not carry an
 * installer-owned legacy insert that the install path would drop (it would be a
 * duplicate loader entry id); any other package must have the insert row that
 * `mountEntry` looks for.
 *
 * `mountEntry`/`unmountLegacyEntry` treat an existing row as final, so checking
 * for the row here cannot lose an update the install path would have applied.
 * @param {string} profileDir - absolute path to the profile directory.
 * @param {object | null} profile - parsed profile `package.json`.
 * @param {string} installedName - package name as recorded in the profile.
 * @param {object} manifest - the installed package's manifest.
 * @param {{ id?: string, name?: string } | null} mount - explicit mount override.
 * @returns {boolean}
 */
function mountStateCurrent(profileDir, profile, installedName, manifest, mount) {
  const mountId = String(mount?.id ?? manifest?.dsh?.gui?.mountId ?? installedName.replace(/^dsh-/, ''))
  const mountName = String(mount?.name ?? manifest?.name ?? installedName)
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const text = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  if (manifest?.dsh?.bundle?.patch !== undefined) {
    const bundles = profile?.dsh?.profile?.bundles
    if (!Array.isArray(bundles) || !bundles.includes(installedName)) return false
    // Only a row `unmountLegacyEntry` would actually drop is a reason to install:
    // any other row shape (a hand-authored top-level entry, for instance) is left
    // alone by the install path, so it must not disable the fast path.
    return removeLegacyInsertBlocks(text, { id: mountId, name: mountName }).removed === 0
  }
  // Same predicate `mountEntry` uses to decide the row is already there.
  return parseInsertRows(text).some((row) => row.id === mountId)
}

/**
 * Whether the profile already holds the requested npm package at exactly this
 * version, so `dsh plugin add <spec>` would change nothing.
 *
 * Every part of the install that can go stale is re-checked, because the install
 * is what repairs it:
 *  - the recorded dependency must still be this exact version (a re-pin or a
 *    hand-edited profile installs again);
 *  - the installed manifest must be present at that version;
 *  - a foreign nested `node_modules` inside the package must be gone (the install
 *    path removes it — left in place, Node resolves stale peers from it);
 *  - the mount/bundle state must be intact (see mountStateCurrent()).
 *
 * Exported for the wrapper-level checks and ad-hoc verification.
 * @param {string} profileDir - absolute path to the profile directory.
 * @param {string} spec - the npm install spec used by the wrapper.
 * @param {{ id?: string, name?: string } | null} [mount] - explicit mount override.
 * @returns {boolean}
 */
export function npmPluginUpToDate(profileDir, spec, mount = null) {
  const version = exactSpecVersion(spec)
  if (version === null) return false
  const name = packageNameFromSpec(spec)
  const profile = readJsonFile(join(profileDir, 'package.json'))
  if (profile?.dependencies?.[name] !== version) return false
  const packageDir = join(profileDir, 'node_modules', ...name.split('/'))
  const installed = readJsonFile(join(packageDir, 'package.json'))
  if (installed === null || installed.version !== version) return false
  if (existsSync(join(packageDir, 'node_modules'))) return false
  return mountStateCurrent(profileDir, profile, name, installed, mount)
}

/**
 * Whether the profile already records `link:<packageDir>` for this package and
 * the link resolves to that directory, so the `dsh plugin add` step would change
 * nothing. The package itself is still built by installPlugin: its sources are
 * not versioned by a spec, so only a rebuild proves them current.
 *
 * Exported alongside npmPluginUpToDate() so the wrapper-level checks and the
 * test suite can exercise both predicates.
 * @param {string} profileDir - absolute path to the profile directory.
 * @param {string} packageDir - absolute path to the plugin package.
 * @param {string} packageName - the package's manifest name.
 * @param {object} manifest - the package's manifest.
 * @param {{ id?: string, name?: string } | null} mount - explicit mount override.
 * @returns {boolean}
 */
export function linkDependencyUpToDate(profileDir, packageDir, packageName, manifest, mount) {
  const profile = readJsonFile(join(profileDir, 'package.json'))
  if (profile?.dependencies?.[packageName] !== `link:${packageDir}`) return false
  // A checkout that moved leaves the previous location in the link: the resolve
  // check keeps `dsh plugin add` running until the link points here.
  if (!sameDirectory(join(profileDir, 'node_modules', ...packageName.split('/')), packageDir)) return false
  return mountStateCurrent(profileDir, profile, packageName, manifest, mount)
}

/**
 * Registry of npm package names declared by the per-plugin install wrappers.
 * Written to `<DSH_HOME>/gui/npm-installs.json` — the desktop-shell update
 * checker (`src-tauri/src/update.rs`) reads it to tell npm-installed wrappers
 * apart from source/link installs and to verify that a new upstream tag
 * already has a matching npm publish before the dialog announces it.
 */
function npmInstallsPath(dshHome) {
  return join(dshHome, 'gui', 'npm-installs.json')
}

/**
 * Record one npm package name (best-effort; the registry is a runtime cache).
 *
 * Exported because the dsh runtime install (`harness.json` runtime `npm`) also
 * records the CLI package here: the desktop-shell update checker reads this file
 * to tell npm installs apart from source ones and to verify a new upstream tag
 * already has a matching npm publish.
 *
 * @param {string} dshHome - the harness home whose `gui/` holds the registry.
 * @param {string} packageName - the npm package name.
 */
export function recordNpmInstall(dshHome, packageName) {
  try {
    const path = npmInstallsPath(dshHome)
    let packages = []
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (Array.isArray(parsed)) packages = parsed
    } catch {
      // missing or unparsable -> start fresh
    }
    if (!packages.includes(packageName)) {
      packages.push(packageName)
      packages.sort()
      mkdirSync(join(dshHome, 'gui'), { recursive: true })
      writeFileSync(path, JSON.stringify(packages, null, 2) + '\n')
    }
  } catch (error) {
    console.warn(`  could not record npm package '${packageName}' for the update checker: ${error.message}`)
  }
}

/**
 * Remove a foreign nested `node_modules` inside an installed npm package
 * directory. The published tarball never carries node_modules (npm excludes
 * it regardless of `files`), and the pinned hoisted linker does not create
 * nested virtual stores, so a `node_modules/` next to the package's own
 * `lib/` is always a stale leftover — e.g. a package that used to be a
 * `link:` source install whose submodule's dev `node_modules` (holding an
 * old private copy such as `@deepseek-ai/dsh-session@0.1.1-rc.1`) was copied
 * along. Left in place, Node resolves that stale copy ahead of the profile's
 * hoisted peers and the Loader fails at boot (`The requested module ... does
 * not provide an export named ...`). Removing it lets the package resolve the
 * profile's hoisted dependencies instead.
 * @param {string} profileDir - absolute path to the profile directory.
 * @param {string} packageName - the npm package name (may be scoped).
 */
function removeForeignNestedNodeModules(profileDir, packageName) {
  const nested = join(profileDir, 'node_modules', ...packageName.split('/'), 'node_modules')
  if (!existsSync(nested)) return
  console.log(`  removing foreign nested node_modules in '${packageName}' (stale from a previous install)`)
  rmSync(nested, { recursive: true, force: true })
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
 * When the exact pinned version is already installed and mounted, the whole
 * `dsh plugin add` is skipped: pnpm would re-resolve the profile graph for
 * nothing, which is what makes `npm run build` slow on an unchanged checkout.
 * `npm run rebuild` (`DSH_PLUGIN_REBUILD=1`) disables the fast path; so does
 * `DSH_PLUGIN_FORCE_INSTALL=1`. See npmPluginUpToDate().
 *
 * @param {{ id: string, packageSpec: string,
 *   mount?: { id: string, name: string, config?: object | null } | null,
 *   skip?: boolean | string | null,
 *   exempt?: string | null }} options
 *   - id: the plugin id (the `plugins/<id>/` wrapper directory name).
 *   - packageSpec: the npm install spec, e.g. `dsh-better-sidebar@0.19.1`.
 *   - mount: explicit mount entry for packages without a bundle patch;
 *     `config` becomes the row's `config:` block (e.g. a browser-use
 *     provider's per-row settings).
 *   - exempt: the reason an incompatible exact version is accepted for this
 *     package. When given, its exact-version exemption is granted in the
 *     profile before the install (see grantVersionExemption), which is what
 *     lets the admission gate accept a package whose `@deepseek-ai/dsh*`
 *     peers predate the pinned runtime; the reason is echoed in the log.
 *   - skip: wrapper-declared default skip — `true` (unversioned skip) or a
 *     string reason. The wrapper owns WHAT is being skipped and WHY (e.g. a
 *     version incompatible with the pinned harness); the shared pipeline only
 *     enforces the mechanism: it still records the package for the update
 *     checker, honors `DSH_PLUGIN_SKIP` additions, and lets
 *     `DSH_PLUGIN_FORCE_INSTALL=1` override. See skipInstall().
 */
export function installNpmPlugin({ id, packageSpec, mount = null, skip = null, exempt = null }) {
  const dshHome = process.env.DSH_HOME ?? WEB_HOME
  const name = packageNameFromSpec(packageSpec)
  // Record before the skip check: even a currently skipped package belongs to
  // this wrapper's npm set, so the update checker can notice when the tag's
  // npm publish finally lands (see skipInstall()).
  recordNpmInstall(dshHome, name)
  if (skipInstall(id, skip)) {
    const reason = typeof skip === 'string' ? skip : 'skipped by default from the wrapper'
    console.log(`  skipping '${id}' (${packageSpec}) — ${reason}; set DSH_PLUGIN_FORCE_INSTALL=1 to override`)
    return
  }
  const profileDir = pluginProfileDir(dshHome)
  if (exempt !== null) grantVersionExemption(dshHome, profileDir, packageSpec, exempt)
  // Up-to-date fast path: `dsh plugin add` re-resolves the whole profile graph
  // (its own node + pnpm spawn) even when the exact version is already there, so
  // a `npm run build` over an unchanged profile pays tens of seconds for nothing.
  if (!reinstallRequested() && npmPluginUpToDate(profileDir, packageSpec, mount)) {
    console.log(`\n==> plugin '${id}' (${packageSpec}) is already installed at this version — skipping install`)
    console.log('  reinstall every plugin with "npm run rebuild" (or DSH_PLUGIN_REBUILD=1)')
    // Still (re)pin the store: the profile state itself is reused as-is.
    pinProfileStore(profileDir)
    return
  }
  console.log(`\n==> install plugin '${id}' (${packageSpec} from npm)`)
  bootstrapPnpm()
  pinProfileStore(profileDir)
  runPluginCommand(dshHome, ['plugin', '--profile', profileName, 'add', packageSpec])
  removeForeignNestedNodeModules(profileDir, name)

  const manifestPath = join(profileDir, 'node_modules', ...name.split('/'), 'package.json')
  if (!existsSync(manifestPath)) {
    console.log(`installed plugin '${id}' into ${profileDir}`)
    return
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.dsh?.bundle?.patch !== undefined) {
    // A bundle patch plugin mounts itself: `dsh plugin add` already
    // reconciled it into dsh.profile.bundles.
    const mountId = String(mount?.id ?? manifest.dsh?.gui?.mountId ?? name.replace(/^dsh-/, ''))
    const mountName = String(mount?.name ?? manifest.name ?? name)
    unmountLegacyEntry(profileDir, { id: mountId, name: mountName })
    console.log(`  ${name} declares dsh.bundle.patch — it mounts through its bundle layer, no cordis.patch.yml insert added`)
    console.log(`installed plugin '${id}' into ${profileDir}`)
    return
  }
  const packageName = String(manifest.name ?? name)
  const mountId = String(mount?.id ?? manifest.dsh?.gui?.mountId ?? packageName.replace(/^dsh-/, ''))
  const mountName = String(mount?.name ?? packageName)
  mountEntry(profileDir, { id: mountId, name: mountName, config: mount?.config ?? null })
  console.log(`installed plugin '${id}' into ${profileDir}`)
}

/**
 * Install skip switch. The shared pipeline no longer hard-codes WHICH plugins
 * are skipped — each wrapper owns that decision and passes it as the `skip`
 * option to installNpmPlugin() (or installPlugin() when it gains the option):
 * adding a plugin id to a skipped set used to live here, which forced a
 * shared-file edit to mask or unmask any single plugin. The wrapper's `skip`
 * declares the default; this function only layers the generic overrides on
 * top:
 *
 *  - `DSH_PLUGIN_FORCE_INSTALL=1` always wins (forces even a defaulted skip,
 *    the documented restore path for an upstream that has since adapted);
 *  - otherwise the wrapper-declared default skip wins;
 *  - `DSH_PLUGIN_SKIP` (comma-separated plugin ids) additionally skips any
 *    listed id, whatever its wrapper declared.
 *
 * Keeps a version-incompatible plugin out of the profile without touching
 * shared code. The skip reason shown in installNpmPlugin() output comes from
 * the wrapper's `skip` string when given (see
 * docs/dsh-gui/harness-upgrade-build-failure.md).
 *
 * @param {string} id - the plugin wrapper id ('sidebar-qa', 'dsh-pet', ...).
 * @param {boolean | string | null} defaultSkip - the wrapper-declared default
 *   skip: `true` skips for an unversioned reason; a string is a truthy skip
 *   whose value is used as the human-readable reason.
 * @returns {boolean} whether the install should be skipped.
 */
export function skipInstall(id, defaultSkip = null) {
  if (process.env.DSH_PLUGIN_FORCE_INSTALL === '1') return false
  if (defaultSkip) return true
  // No wrapper-declared default: leave the decision to DSH_PLUGIN_SKIP alone
  // (a general opt-out for one-off installs / CI).
  const skipped = (process.env.DSH_PLUGIN_SKIP ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return skipped.includes(id)
}


