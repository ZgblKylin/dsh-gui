/**
 * Agent Teams wrapper: installs the official experimental Agent Teams bundle
 * and lands Team-aware copies of the shipped agent presets.
 *
 * Sources — from npm, no local package:
 *   - `@deepseek-ai/dsh-experimental-agent-team-profile`: the Team domain, its
 *     scoped model tools and the Web roster/task-board UI. Since 0.1.7-rc.2
 *     this is the ONE official bundle for Agent Teams: upstream folded the
 *     former `@deepseek-ai/dsh-experimental-agent-team-web-profile` into it and
 *     deleted that package, so this wrapper installs a single spec.
 * It declares `dsh.bundle.patch`, so `dsh plugin add` reconciles it into
 * `dsh.profile.bundles` and it mounts through its own bundle layer; this script
 * writes no `cordis.patch.yml` insert (a manual one would double-mount it).
 * This installer lives under `plugins/harness/` — the group of official
 * dsh-family plugins — and is loaded by `plugins/harness/install.mjs`; it also
 * runs standalone.
 *
 * The preset half lives in this wrapper rather than under `presets/` because
 * the derived composition is only meaningful together with that bundle.
 *
 * Declarative presets (harness >= dsh-v0.1.7-rc.2): an agent preset is an
 * `@deepseek-ai/dsh-agent-preset` row whose `config.plugins` is the Cordis
 * entry list a session mounts. The `@deepseek-ai/dsh-agent-presets` package and
 * its `.dsh/.agent-presets/<id>/` discovery are gone, so there is no directory
 * to copy into; the shipped presets now arrive as their own patch files inside
 * the `@deepseek-ai/dsh-web-app` bundle (`dsh.bundle.patch` became a list).
 * This script therefore READS those shipped declarations and writes one derived
 * declaration per qualifying preset into the profile patch, inside a
 * marker-delimited block it owns. Agent Teams is a profile-level bundle, and the
 * profile patch applies after every bundle layer, so the derived rows land last.
 *
 * The derived per-preset delta closes direct delegation for Team mode: it
 * disables the shipped delegation rows (`tool-subagent`, `tool-subagent-fork`)
 * and the global continuable-child control rows, so teammates are created
 * through `spawn_teammate` and messaging stays on the Team roster. The
 * profile-level rows the Team bundle disables cannot reach these rows: a
 * preset's `config.plugins` is mounted as its own Loader subtree, so a top-level
 * patch entry never addresses a row inside it.
 *
 * Which presets are derived is DISCOVERED, not listed: every shipped preset
 * that carries delegation rows gets a `<id>-team` sibling, so a preset added
 * upstream arrives with a Team-aware sibling on the next install and one removed
 * upstream stops being declared. A preset that mounts the Cordis toolset is
 * skipped: that toolset's inspect providers are process-global and register
 * once, so a derived copy could never be seated next to the shipped preset it
 * came from.
 *
 * Mount source: the bundle self-mounts through `dsh.bundle.patch`; derived
 * presets are declared rows in the profile patch.
 * Writes only under DSH_HOME (default `<repo>/.dsh`); never to the shipped
 * preset declarations.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { installNpmPlugin } from '../../scripts/plugin-install.mjs'
import { ROOT, WEB_HOME } from '../../scripts/toolchain.mjs'

/** Wrapper id: the `plugins/<id>/` directory name, used for logs and skip checks. */
const ID = 'agent-team'

/**
 * Pinned to the harness revision this repository builds against.
 * An exact version is required: the npm `latest` dist-tag of the dsh-family
 * experimental packages trails the released prerelease, so an unversioned
 * install would take the wrong one. It is also a prerelease, which is why the
 * Community Market cannot carry it.
 */
const TEAM_VERSION = '0.1.7-rc.2'
const TEAM_PROFILE = '@deepseek-ai/dsh-experimental-agent-team-profile'

/** The preset-declaration plugin whose rows compose one agent. */
const PRESET_PLUGIN = '@deepseek-ai/dsh-agent-preset'

/** Suffix separating a derived preset id from the shipped id it comes from. */
const DERIVED_SUFFIX = '-team'

/** `generatedBy` markers of the retired directory-preset mechanism this wrapper used to write. */
const LEGACY_GENERATED_BY = ['plugins/harness/agent-team.mjs', 'plugins/agent-team/install.mjs']

/** Appended to a shipped preset's own description. */
const TEAM_DESCRIPTION = 'Agent Teams 版：关闭 subagent / subagent_fork 直接委派，统一使用具名 teammate、持久消息与共享任务板。'

/** Delegation rows Agent Teams replaces for Team members; each is disabled in every derived preset. */
const TEAM_DISABLED_ROWS = [
  { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
  { id: 'tool-subagent-list-agents', name: '@deepseek-ai/dsh-tool-subagent-control/list-agents' },
  { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent' },
  { id: 'tool-subagent-fork', name: '@deepseek-ai/dsh-tool-subagent' },
]

/** The row whose presence decides whether a shipped preset has delegation at all. */
const DELEGATION_MARKER = '@deepseek-ai/dsh-tool-subagent'

/**
 * The row that makes a shipped preset unusable as a Team sibling.
 *
 * `@deepseek-ai/dsh-tool-cordis` registers four Host inspect providers
 * (`Service` / `Event` / `Builtin` / `Tool`) into `ctx.cordisInspect`, a
 * process-global registry whose ids may be registered once, and it takes no
 * configuration that would let a mount reuse an existing registration. Standing
 * preset mounts live for the whole process, so a derived copy of a preset that
 * mounts this toolset cannot be seated while the shipped preset it came from is
 * mounted — the second mount fails with
 * `Host Cordis inspect provider "Service" is already registered`.
 */
const PROCESS_GLOBAL_TOOLSET = '@deepseek-ai/dsh-tool-cordis'

/** Opening line of the marker-delimited block this script owns in the profile patch. */
const BLOCK_START = '# --- agent-team derived presets (auto-generated by plugins/harness/agent-team.mjs; do not edit) ---'

/** Closing line of the block this script owns. */
const BLOCK_END = '# --- end agent-team derived presets ---'

/** Profile patch content used when the profile has none yet. */
const PROFILE_PATCH_TEMPLATE = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '[]',
  '',
].join('\n')

/** Escape one literal for embedding in a RegExp. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Render one YAML scalar, quoting anything that is not a plain token. */
function yamlScalar(value) {
  const text = String(value)
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(text) ? text : `'${text.replace(/'/g, "''")}'`
}

/** Strip one layer of matching single or double quotes. */
function unquote(value) {
  const trimmed = value.trim()
  const quoted = trimmed.length >= 2
    && ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"')))
  return quoted ? trimmed.slice(1, -1) : trimmed
}

/**
 * Prove that one anchor exists exactly once before rewriting it. A silent
 * miss would land a preset that still carries upstream's continuable
 * delegation — the exact defect this wrapper exists to close — so an
 * unexpected upstream restructure fails the install loudly instead.
 * @param {string} text - the shipped composition.
 * @param {RegExp} pattern - the anchor, without the global flag.
 * @param {string} label - what the anchor is, for the error message.
 * @param {string} source - the shipped file the text came from.
 * @returns {RegExpMatchArray} the single match.
 */
function matchOnce(text, pattern, label, source) {
  const matches = text.match(new RegExp(pattern.source, 'gm')) ?? []
  if (matches.length !== 1) {
    throw new Error(
      `${ID}: expected exactly one ${label} in ${source}, found ${matches.length}. `
      + 'The shipped composition changed shape; update the anchors in plugins/harness/agent-team.mjs.',
    )
  }
  return new RegExp(pattern.source, 'm').exec(text)
}

/**
 * The preset declarations one bundle manifest contributes, in list order.
 * @param {string} dir - absolute bundle package directory.
 * @returns {string[]} absolute patch-file paths under the bundle's `presets/`.
 */
function presetPatchFiles(dir) {
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) return []
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    // An unreadable manifest cannot name patch files; the next candidate wins.
    return []
  }
  const patch = manifest.dsh?.bundle?.patch
  const entries = typeof patch === 'string' ? [patch] : Array.isArray(patch) ? patch : []
  return entries
    .filter((entry) => typeof entry === 'string' && entry.startsWith('./presets/'))
    .map((entry) => join(dir, entry))
    .filter((file) => existsSync(file))
}

/**
 * Locate the installed `@deepseek-ai/dsh-web-app` bundle that carries the
 * shipped preset declarations.
 *
 * Requirement bases cover both installation shapes — the npm runtime install
 * (`<repo>/.harness`) and an installed profile — while the literal paths cover
 * forms where a base cannot resolve the package. The harness checkout is the
 * last resort and matches the pinned revision exactly. The first candidate that
 * actually exposes preset patch files wins.
 * @returns {string} absolute path to the bundle package directory.
 */
function webAppPackageDir() {
  const dshHome = process.env.DSH_HOME ?? WEB_HOME
  const bases = [
    join(ROOT, '.harness', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join(dshHome, 'profiles', 'web', 'package.json'),
  ]
  const literals = [
    join(ROOT, '.harness', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'package.json'),
    join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'package.json'),
    join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'package.json'),
    join(ROOT, 'deepseek-harness', 'packages', 'bundle', 'web-app', 'package.json'),
  ]
  const manifests = []
  for (const base of bases) {
    if (!existsSync(base)) continue
    try {
      manifests.push(createRequire(base).resolve('@deepseek-ai/dsh-web-app/package.json'))
    } catch {
      // This base cannot see the bundle; the literal paths below cover it.
    }
  }
  manifests.push(...literals)
  for (const manifest of manifests) {
    if (!existsSync(manifest)) continue
    const dir = dirname(manifest)
    if (presetPatchFiles(dir).length > 0) return dir
  }
  throw new Error(`${ID}: cannot locate the shipped agent preset declarations (tried: ${[...bases, ...literals].join(', ')})`)
}

/**
 * Read one shipped preset declaration out of its bundle patch file.
 *
 * The declaration is a single `@deepseek-ai/dsh-agent-preset` insert row whose
 * `plugins:` list runs to the end of the file. A shape this reader cannot follow
 * fails the install rather than silently dropping a preset.
 * @param {string} path - the bundle's preset patch file.
 * @returns {{ rowId: string, id: string, order: number | undefined,
 *   name: string | undefined, description: string | undefined,
 *   body: string[], newline: string } | undefined} the declaration, or undefined
 *   when the file declares no preset.
 */
function readPresetDeclaration(path) {
  const text = readFileSync(path, 'utf8')
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const nameIndex = lines.findIndex((line) => line.trim() === `name: '${PRESET_PLUGIN}'`)
  if (nameIndex === -1) return undefined
  const rowIndent = /^(\s*)/.exec(lines[nameIndex])[1]
  const fieldIndent = `${rowIndent}  `
  const field = (key) => {
    const pattern = new RegExp(`^${fieldIndent}${key}:\\s*(\\S.*?)\\s*$`)
    for (let index = nameIndex + 1; index < lines.length; index += 1) {
      const match = pattern.exec(lines[index])
      if (match !== null) return unquote(match[1])
    }
    return undefined
  }
  const id = field('id')
  if (id === undefined) {
    throw new Error(`${ID}: ${path} declares ${PRESET_PLUGIN} without a config.id`)
  }
  const orderText = field('order')
  const order = orderText === undefined ? undefined : Number(orderText)
  const pluginsIndex = lines.findIndex((line) => line === `${fieldIndent}plugins:`)
  if (pluginsIndex === -1) {
    throw new Error(`${ID}: ${path} declares preset '${id}' without a config.plugins list`)
  }
  const body = lines.slice(pluginsIndex + 1)
  while (body.length > 0 && body.at(-1).trim() === '') body.pop()
  let rowId
  for (let index = nameIndex - 1; index >= 0; index -= 1) {
    const match = /^(\s*)- id:\s*(\S+)\s*$/.exec(lines[index])
    if (match !== null && match[1].length < rowIndent.length) {
      rowId = match[2]
      break
    }
  }
  if (rowId === undefined) {
    throw new Error(`${ID}: ${path} declares preset '${id}' without a Loader row id`)
  }
  return {
    rowId,
    id,
    order: order !== undefined && Number.isSafeInteger(order) ? order : undefined,
    name: field('name'),
    description: field('description'),
    body,
    newline,
  }
}

/**
 * Build one Team-aware declaration from a shipped one.
 *
 * The delta is deliberately minimal so every other upstream row — including
 * ones added after this wrapper was written — travels through untouched:
 *   - the two global continuable-child control rows are disabled, because
 *     Agent Teams owns `send_message`, `list_agents` and `interrupt_agent` for
 *     Team members;
 *   - the two direct delegation tools are disabled, because Team mode delegates
 *     through `spawn_teammate` only; the model keeps no
 *     `subagent`/`subagent_fork` route that could create continuable children
 *     outside the Team roster.
 * @param {{ rowId: string, id: string, order: number | undefined,
 *   name: string | undefined, description: string | undefined,
 *   body: string[], newline: string }} source - the shipped declaration.
 * @param {string} path - the shipped declaration's file, for diagnostics.
 * @returns {{ id: string, rowId: string, text: string }} the derived declaration.
 */
function deriveDeclaration(source, path) {
  const id = `${source.id}${DERIVED_SUFFIX}`
  const rowId = `${source.rowId}${DERIVED_SUFFIX}`
  let body = source.body.join(source.newline)
  for (const row of TEAM_DISABLED_ROWS) {
    const pattern = new RegExp(
      `^([ \\t]*)- id: ${escapeRegExp(row.id)}\\r?\\n([ \\t]*)name: '${escapeRegExp(row.name)}'[ \\t]*\\r?\\n`,
    )
    const match = matchOnce(body, pattern, `delegation row '${row.id}'`, path)
    body = body.replace(match[0], `${match[0]}${match[2]}disabled: true${source.newline}`)
  }
  const displayName = source.name === undefined ? id : `${source.name} + Agent Teams`
  const description = source.description === undefined
    ? TEAM_DESCRIPTION
    : `${source.description} ${TEAM_DESCRIPTION}`
  const lines = [
    `    - id: ${rowId}`,
    `      name: '${PRESET_PLUGIN}'`,
    '      config:',
    `        id: ${id}`,
    ...source.order === undefined ? [] : [`        order: ${source.order + 10}`],
    `        name: ${yamlScalar(displayName)}`,
    `        description: ${yamlScalar(description)}`,
    '        plugins:',
  ]
  return { id, rowId, text: [...lines, body].join(source.newline) }
}

/**
 * Rewrite the marker-delimited block this script owns in the profile patch.
 *
 * The block is replaced whole, so a preset that stops qualifying this run also
 * stops being declared. User content outside the markers is preserved
 * byte-for-byte; the empty `[]` default is dropped once real entries exist,
 * exactly as the shared installer's insert path does.
 * @param {string} profileDir - absolute profile directory.
 * @param {{ id: string, rowId: string, text: string }[]} declarations - derived declarations.
 */
function writeDerivedDeclarations(profileDir, declarations) {
  mkdirSync(profileDir, { recursive: true })
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const original = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : PROFILE_PATCH_TEMPLATE
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  const lines = original.split(/\r?\n/)
  const start = lines.findIndex((line) => line === BLOCK_START)
  if (start !== -1) {
    const end = lines.findIndex((line, index) => index >= start && line === BLOCK_END)
    lines.splice(start, end === -1 ? lines.length - start : end + 1 - start)
  }
  const head = lines.filter((line) => line.trim() !== '[]')
  while (head.length > 0 && head.at(-1).trim() === '') head.pop()
  const kept = []
  for (const declaration of declarations) {
    if (head.some((line) => line.trim() === `- id: ${declaration.rowId}`)) {
      console.warn(`  entry '${declaration.rowId}' is already declared by hand; keeping it instead of the derived preset`)
      continue
    }
    kept.push(declaration)
  }
  const prefix = head.join(newline)
  if (kept.length === 0) {
    writeFileSync(patchPath, `${prefix}${newline}`)
    return
  }
  const block = [BLOCK_START, '- insert:', ...kept.map((declaration) => declaration.text), BLOCK_END]
  writeFileSync(patchPath, `${prefix}${newline}${newline}${block.join(newline)}${newline}`)
}

/** Generate and land a Team-aware declaration for every shipped delegation preset that can carry one. */
function landDerivedPresets() {
  const dshHome = process.env.DSH_HOME ?? WEB_HOME
  const profileDir = join(dshHome, 'profiles', 'web')
  const bundleDir = webAppPackageDir()
  const files = presetPatchFiles(bundleDir)
  console.log(`\n==> land Team-aware agent presets (shipped declarations: ${bundleDir})`)
  const declarations = []
  for (const file of files) {
    const source = readPresetDeclaration(file)
    if (source === undefined) continue
    const shipped = source.body.join('\n')
    // Presets without delegation rows have nothing to patch; adding a subagent
    // tool there would add capability the composition omits.
    if (!shipped.includes(DELEGATION_MARKER)) {
      console.log(`  ${source.id}: no delegation rows — skipping`)
      continue
    }
    // A derived sibling of a preset that mounts a process-global toolset can
    // never be seated next to that preset; deriving it would offer a preset the
    // host then refuses to mount.
    if (shipped.includes(PROCESS_GLOBAL_TOOLSET)) {
      console.log(`  ${source.id}: mounts ${PROCESS_GLOBAL_TOOLSET} — skipping; one mount per process, so a sibling cannot coexist with the shipped preset`)
      continue
    }
    const declaration = deriveDeclaration(source, file)
    declarations.push(declaration)
    console.log(`  derived agent preset '${declaration.id}'`)
  }
  writeDerivedDeclarations(profileDir, declarations)
  console.log(`  ${declarations.length} derived preset declaration(s) in ${join(profileDir, 'cordis.patch.yml')}`)
}

/**
 * Remove derived preset directories written by the retired directory-preset
 * mechanism, and report any directory preset the running harness can no longer
 * discover. Only directories carrying this wrapper's own `generatedBy` marker
 * are deleted, so a hand-authored preset is never touched.
 * @param {string} dshHome - the harness home whose `.agent-presets` is inspected.
 */
function cleanLegacyDerivedPresets(dshHome) {
  const userRoot = join(dshHome, '.agent-presets')
  if (!existsSync(userRoot)) return
  const orphans = []
  for (const entry of readdirSync(userRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const metadataPath = join(userRoot, entry.name, 'preset.yml')
    const metadata = existsSync(metadataPath) ? readFileSync(metadataPath, 'utf8') : undefined
    if (metadata === undefined || !LEGACY_GENERATED_BY.some((marker) => metadata.includes(`generatedBy: ${marker}`))) {
      orphans.push(entry.name)
      continue
    }
    rmSync(join(userRoot, entry.name), { recursive: true, force: true })
    console.log(`  removed retired directory preset '${entry.name}' — harness >= dsh-v0.1.7-rc.2 discovers declarative presets only`)
  }
  if (orphans.length > 0) {
    console.warn(
      `  WARNING: ${userRoot} still holds ${orphans.length} preset directory(ies) the harness no longer discovers `
      + `(${orphans.join(', ')}); re-declare them as '${PRESET_PLUGIN}' rows in the profile patch`,
    )
  }
}

installNpmPlugin({ id: ID, packageSpec: `${TEAM_PROFILE}@${TEAM_VERSION}` })
landDerivedPresets()
cleanLegacyDerivedPresets(process.env.DSH_HOME ?? WEB_HOME)
