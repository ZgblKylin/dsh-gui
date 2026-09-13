/**
 * Agent Teams wrapper: installs the two official experimental Agent Teams
 * bundles and lands Team-aware copies of the shipped agent presets.
 *
 * Sources — both from npm, no local package:
 *   - `@deepseek-ai/dsh-experimental-agent-team-profile` (Team domain, Remote
 *     methods and the nine scoped model tools)
 *   - `@deepseek-ai/dsh-experimental-agent-team-web-profile` (browser roster
 *     and task-board panel)
 * Both declare `dsh.bundle.patch`, so `dsh plugin add` reconciles them into
 * `dsh.profile.bundles` and they mount through their own bundle layers; this
 * script writes no `cordis.patch.yml` insert (a manual one would double-mount
 * them).
 *
 * The preset half lives in this wrapper rather than under `presets/` because
 * the derived composition is only meaningful together with those bundles.
 *
 * Which presets are derived is DISCOVERED, not listed: every shipped preset
 * that carries delegation rows gets a `<id>-team` sibling, so a preset added
 * upstream arrives with a Team-aware sibling on the next install and one
 * removed upstream has its sibling cleaned up.
 *
 * Why the derived preset is a generated COPY and not a `cordis:include`:
 * an include with `patches` expresses the same delta in far fewer bytes, but a
 * nested `cordis:include` row is a plain `Include`, and the Loader persists a
 * tree back to the file it read (`Include.write()` -> `this.filename`). Only
 * the preset's own tree suppresses that (`agent-presets/src/mount.ts` makes
 * `PresetTree.write()` a no-op); a nested Include would rewrite the SHIPPED
 * upstream composition with whatever the dying tree held. So each derived
 * preset is generated from the shipped file at install time — which still
 * tracks upstream tool-set additions and removals, because only four anchors
 * are rewritten — while the shipped file is never a write target.
 *
 * Mount source: both packages self-mount through `dsh.bundle.patch`.
 * Writes only under DSH_HOME (default `<repo>/.dsh`); never to the shipped
 * preset install.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installNpmPlugin } from '../../scripts/plugin-install.mjs'
import { ROOT, WEB_HOME } from '../../scripts/toolchain.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** Wrapper id: the `plugins/<id>/` directory name, used for logs and skip checks. */
const ID = 'agent-team'

/**
 * Pinned to the harness revision this repository builds against.
 * An exact version is required: the npm `latest` dist-tag of both packages
 * still points at `0.1.5-alpha.2` while the matching build is published under
 * `next`/`0.1.5-rc.2`, so an unversioned install would take the wrong one.
 * Both are prereleases, which is also why the Community Market cannot carry
 * them.
 */
const TEAM_VERSION = '0.1.5-rc.2'
const TEAM_PROFILE = '@deepseek-ai/dsh-experimental-agent-team-profile'
const TEAM_WEB_PROFILE = '@deepseek-ai/dsh-experimental-agent-team-web-profile'

/** Suffix separating a derived preset id from the shipped id it comes from. */
const DERIVED_SUFFIX = '-team'

/** Marker written into a derived `preset.yml`; only this script's output carries it. */
const GENERATED_BY = 'plugins/agent-team/install.mjs'

/** Appended to a shipped preset's own description. */
const TEAM_DESCRIPTION = 'Agent Teams 版：委派改为 one-shot，并启用具名 teammate、持久消息与共享任务板。'

/** Control rows Agent Teams replaces for Team members; disabled in every derived preset. */
const CONTROL_ROWS = [
  { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
  { id: 'tool-subagent-list-agents', name: '@deepseek-ai/dsh-tool-subagent-control/list-agents' },
]

/** The row whose presence decides whether a shipped preset has delegation at all. */
const DELEGATION_MARKER = '@deepseek-ai/dsh-tool-subagent'

const CONTINUABLE_ROW = /backgroundMode: continuable/g

/** Escape one literal for embedding in a RegExp. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Read `name`, `description`, and `order` from a shipped `preset.yml`.
 *
 * Only these three display fields exist, and a value this scanner cannot read
 * costs nothing worse than the preset picker falling back to the raw id, so a
 * line-oriented read avoids a YAML dependency in a build script. `order` is
 * shifted by ten so every derived preset sorts after the shipped set it comes
 * from instead of interleaving with it.
 * @param {string} path - the shipped preset's metadata file.
 * @returns {{ name?: string, description?: string, order?: number }} display fields.
 */
function readPresetMetadata(path) {
  const fields = {}
  if (!existsSync(path)) return fields
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^(name|description|order):[ \t]*(.*)$/.exec(line)
    if (match === null) continue
    let value = match[2].trim()
    const quoted = value.length >= 2
      && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))
    if (quoted) value = value.slice(1, -1)
    if (value !== '') fields[match[1]] = value
  }
  const order = Number(fields.order)
  return {
    ...fields.name === undefined ? {} : { name: fields.name },
    ...fields.description === undefined ? {} : { description: fields.description },
    ...Number.isSafeInteger(order) ? { order: order + 10 } : {},
  }
}

/**
 * Locate the shipped `presets/` directory of `@deepseek-ai/dsh-agent-presets`.
 *
 * Two require bases cover both installation shapes — a source checkout
 * (`packages/bundle/web-app` sees the workspace dependency) and an installed
 * profile — and two literal paths cover forms where neither base resolves the
 * package. The first manifest whose sibling `presets/` directory exists wins.
 * @returns {string} absolute path to the shipped preset root.
 */
function shippedPresetsDir() {
  const dshHome = process.env.DSH_HOME ?? WEB_HOME
  const manifests = []
  for (const base of [
    join(ROOT, 'deepseek-harness', 'packages', 'bundle', 'web-app', 'package.json'),
    join(dshHome, 'profiles', 'web', 'package.json'),
  ]) {
    try {
      manifests.push(createRequire(base).resolve('@deepseek-ai/dsh-agent-presets/package.json'))
    } catch {
      // This base cannot see the preset package; the literal paths below cover it.
    }
  }
  manifests.push(join(ROOT, 'deepseek-harness', 'packages', 'preset', 'agent-presets', 'package.json'))
  manifests.push(join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'package.json'))
  for (const manifest of manifests) {
    const dir = join(dirname(manifest), 'presets')
    if (existsSync(dir)) return dir
  }
  throw new Error(`${ID}: cannot locate the shipped agent presets (tried: ${manifests.join(', ')})`)
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
      + 'The shipped composition changed shape; update the anchors in plugins/agent-team/install.mjs.',
    )
  }
  return new RegExp(pattern.source, 'm').exec(text)
}

/**
 * Build one Team-aware composition from a shipped one.
 *
 * The delta is deliberately minimal so every other upstream row — including
 * ones added after this wrapper was written — travels through untouched:
 *   - the two global continuable-child control rows are disabled, because
 *     Agent Teams owns `send_message`, `list_agents` and `interrupt_agent` for
 *     Team members;
 *   - both delegation tools switch to `backgroundMode: one-shot`, because a
 *     continuable child cannot be addressed through the Team mailbox
 *     (`send_message` resolves targets against the Team roster by name, and a
 *     plain provider-managed subagent is not a member).
 * @param {string} text - the shipped composition text.
 * @param {string} source - absolute path of the shipped composition.
 * @param {string} sourceId - the shipped preset id.
 * @returns {string} the derived composition text.
 */
function deriveComposition(text, source, sourceId) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  let derived = text
  for (const row of CONTROL_ROWS) {
    const pattern = new RegExp(
      `^([ \\t]*)- id: ${escapeRegExp(row.id)}\\r?\\n([ \\t]*)name: '${escapeRegExp(row.name)}'[ \\t]*\\r?\\n`,
    )
    const match = matchOnce(derived, pattern, `control row '${row.id}'`, source)
    const [block, , nameIndent] = match
    derived = derived.replace(block, `${block}${nameIndent}disabled: true${newline}`)
  }
  const continuableRows = derived.match(new RegExp(CONTINUABLE_ROW.source, 'gm')) ?? []
  if (continuableRows.length !== 2) {
    throw new Error(
      `${ID}: expected exactly two "backgroundMode: continuable" rows in ${source}, found ${continuableRows.length}. `
      + 'The shipped delegation rows changed shape; update plugins/agent-team/install.mjs.',
    )
  }
  derived = derived.replace(new RegExp(CONTINUABLE_ROW.source, 'g'), 'backgroundMode: one-shot')

  const header = [
    `# GENERATED by plugins/agent-team/install.mjs from the shipped '${sourceId}' composition.`,
    '# Do not edit: re-run "npm run install:plugins" (or "npm run build") to regenerate.',
    '#',
    '# Delta from the shipped composition:',
    '#   - tool-subagent-control / tool-subagent-list-agents disabled: Agent Teams',
    '#     owns send_message / list_agents / interrupt_agent for Team members.',
    '#   - tool-subagent / tool-subagent-fork switched to backgroundMode: one-shot:',
    '#     a continuable child cannot be addressed through the Team mailbox.',
    '#',
    "# Upstream's own comments below describe the SHIPPED composition, so any comment",
    '# that states a delegation mode (for example "keeps fork continuable") describes',
    '# the behavior before this delta.',
  ].join(newline)
  return `${header}${newline}${newline}${derived}`
}

/**
 * Remove a derived preset whose shipped source no longer exists.
 *
 * Only directories carrying this script's marker are candidates, so a
 * hand-authored preset that happens to end in the suffix is never touched.
 * @param {string} userRoot - the harness home's `.agent-presets` directory.
 * @param {Set<string>} expected - derived ids this run produced.
 */
function removeStaleDerivedPresets(userRoot, expected) {
  if (!existsSync(userRoot)) return
  for (const entry of readdirSync(userRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || expected.has(entry.name)) continue
    const metadataPath = join(userRoot, entry.name, 'preset.yml')
    if (!existsSync(metadataPath)) continue
    if (!readFileSync(metadataPath, 'utf8').includes(`generatedBy: ${GENERATED_BY}`)) continue
    rmSync(join(userRoot, entry.name), { recursive: true, force: true })
    console.log(`  removed stale derived preset '${entry.name}' — its shipped source is gone`)
  }
}

/** Generate and land a Team-aware sibling for every shipped delegation preset. */
function landDerivedPresets() {
  const dshHome = process.env.DSH_HOME ?? WEB_HOME
  const presetsDir = shippedPresetsDir()
  const userRoot = join(dshHome, '.agent-presets')
  console.log(`\n==> land Team-aware agent presets (shipped root: ${presetsDir})`)
  const landed = new Set()
  for (const entry of readdirSync(presetsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const sourceId = entry.name
    if (sourceId.endsWith(DERIVED_SUFFIX)) {
      console.warn(`  ${sourceId}: shipped id already carries '${DERIVED_SUFFIX}' — skipping to avoid a doubled suffix`)
      continue
    }
    const source = join(presetsDir, sourceId, 'agent.cordis.yml')
    if (!existsSync(source)) continue
    const text = readFileSync(source, 'utf8')
    // Presets without delegation rows (`minimal`) have nothing to patch; adding
    // a subagent tool there would add capability the composition omits.
    if (!text.includes(DELEGATION_MARKER)) {
      console.log(`  ${sourceId}: no delegation rows — skipping`)
      continue
    }
    const id = `${sourceId}${DERIVED_SUFFIX}`
    const metadata = readPresetMetadata(join(presetsDir, sourceId, 'preset.yml'))
    const name = metadata.name === undefined ? id : `${metadata.name} + Agent Teams`
    const description = metadata.description === undefined
      ? TEAM_DESCRIPTION
      : `${metadata.description} ${TEAM_DESCRIPTION}`
    const orderLine = metadata.order === undefined ? [] : [`order: ${metadata.order}`]
    const dir = join(userRoot, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'agent.cordis.yml'), deriveComposition(text, source, sourceId))
    writeFileSync(join(dir, 'preset.yml'), [
      `name: ${name}`,
      `description: ${description}`,
      ...orderLine,
      `generatedBy: ${GENERATED_BY}`,
      '',
    ].join('\n'))
    landed.add(id)
    console.log(`  landed agent preset '${id}' -> ${dir}`)
  }
  // Guarded by a non-empty result: a failed lookup must not empty the roster.
  if (landed.size > 0) removeStaleDerivedPresets(userRoot, landed)
}

installNpmPlugin({ id: ID, packageSpec: `${TEAM_PROFILE}@${TEAM_VERSION}` })
installNpmPlugin({ id: ID, packageSpec: `${TEAM_WEB_PROFILE}@${TEAM_VERSION}` })
landDerivedPresets()
