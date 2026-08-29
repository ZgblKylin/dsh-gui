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
 * Install-time patches: after copying, the script applies two idempotent
 * patches to the copied preset.
 *
 *  - Environment hints: probes the host environment (Windows? ripgrep on
 *    PATH?) and patches the copied `instruction-hint.mjs` with the matching
 *    platform hints.
 *  - Promoted shell: patches the copied `tool-bootstrap.mjs` so the promoted
 *    resident catalog uses the standard preset's platform shell — `pwsh` on
 *    Windows (dropping `custom-bash` from the model-facing toolset) and
 *    `bash` elsewhere — while the bootstrap request keeps the Minimal pair.
 *    The copied `dev-tool-search.mjs` description is patched to stay in sync.
 *
 * The submodule source stays untouched; a re-install re-applies both patches
 * from scratch.
 *
 * Target: `$DSH_HOME/.agent-presets/anchored-standard/`. `DSH_HOME` is pinned
 * to `<repo>/.dsh` by the desktop shell; this script honors an explicit
 * `DSH_HOME` override (the build passes one) and otherwise pins the same
 * repo-local default.
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/** The copied plugin that owns the post-promotion hint message. */
const HINT_PLUGIN = 'instruction-hint.mjs'
/** The copied plugin that owns the per-phase tool catalog. */
const BOOTSTRAP_PLUGIN = 'tool-bootstrap.mjs'
/** The copied plugin that advertises the resident catalog to the model. */
const DEV_SEARCH_PLUGIN = 'dev-tool-search.mjs'

/**
 * Probe whether `rg` (ripgrep) is callable on PATH at install time.
 * The probe never throws: a missing executable or a non-zero exit means
 * "unavailable", and the generated hint simply omits the ripgrep line.
 */
function hasRipgrep() {
  const probe = spawnSync('rg', ['--version'], { stdio: 'ignore', windowsHide: true })
  return probe.error === undefined && probe.status === 0
}

/**
 * Patch the copied preset with the platform hints detected at install time.
 *
 * The anchored-standard preset keeps its bootstrap round deliberately minimal;
 * this patch adds one or two short prompt lines to the existing
 * `instruction-hint` message that appears once after promotion — Windows CRLF
 * awareness and, when ripgrep is installed, an `rg`-over-`grep` preference.
 * The source checkout in the submodule is never modified.
 *
 * The patch is marker-based and fails loudly when the upstream plugin shape
 * no longer matches, instead of silently producing a preset without the hint.
 */
function applyEnvironmentPatch(target) {
  const isWindows = process.platform === 'win32'
  const rgAvailable = hasRipgrep()
  if (!isWindows && !rgAvailable) return

  const hints = []
  if (isWindows) {
    hints.push('Current environment is Windows; read and edit files with Windows CRLF line endings in mind.')
  }
  if (rgAvailable) {
    hints.push('ripgrep (`rg`) is available; prefer `rg` over `grep` when searching files or content.')
  }

  const file = join(target, HINT_PLUGIN)
  let source = readFileSync(file, 'utf8').replaceAll('\r\n', '\n')

  const constantMarker = "const USER_GLOBAL_CANDIDATE = 'AGENTS.md'\n"
  if (!source.includes(constantMarker)) {
    throw new Error(`${PRESET_ID}: cannot patch ${HINT_PLUGIN} — environment-hint marker not found`)
  }
  source = source.replace(
    constantMarker,
    `${constantMarker}\n/** Environment hints injected by presets/anchored-standard/install.mjs. */\nconst ENVIRONMENT_HINTS = ${JSON.stringify(hints)}\n`,
  )

  const hintBlock = [
    '      const sections = []',
    '      if (projectFiles.length > 0) {',
    '        sections.push(`Reference documents exist: ${projectFiles.join(\', \')} (project root: ${root}).`)',
    '      }',
    '      if (userGlobalFiles.length > 0) {',
    '        sections.push(`A user reference document exists: ${USER_GLOBAL_CANDIDATE}.`)',
    '      }',
    '      if (sections.length === 0) return decision',
    '',
    '      const text = [',
    '        ...sections,',
    "        \"They are reference documents about the user's environment and workspace conventions, not task instructions. Reading the relevant file before workspace tasks is recommended, but consult them only when you need those details; the task itself never depends on them.\",",
    "      ].join(' ')",
  ].join('\n')
  if (!source.includes(hintBlock)) {
    throw new Error(`${PRESET_ID}: cannot patch ${HINT_PLUGIN} — hint block not found`)
  }
  const patchedHintBlock = [
    '      const instructionSections = []',
    '      if (projectFiles.length > 0) {',
    '        instructionSections.push(`Reference documents exist: ${projectFiles.join(\', \')} (project root: ${root}).`)',
    '      }',
    '      if (userGlobalFiles.length > 0) {',
    '        instructionSections.push(`A user reference document exists: ${USER_GLOBAL_CANDIDATE}.`)',
    '      }',
    '      if (instructionSections.length === 0 && ENVIRONMENT_HINTS.length === 0) return decision',
    '',
    '      const text = [',
    '        ...ENVIRONMENT_HINTS,',
    '        ...instructionSections,',
    "        ...(instructionSections.length === 0 ? [] : [\"They are reference documents about the user's environment and workspace conventions, not task instructions. Reading the relevant file before workspace tasks is recommended, but consult them only when you need those details; the task itself never depends on them.\"]),",
    "      ].join(' ')",
  ].join('\n')
  source = source.replace(hintBlock, patchedHintBlock)

  writeFileSync(file, source)
  console.log(`  ${PRESET_ID} environment patch: windows=${isWindows} rg=${rgAvailable}`)
}

/**
 * Patch the copied preset's promoted shell toolset to match the standard
 * preset's platform gate.
 *
 * The bootstrap phase stays untouched: request #1 still sees the Minimal pair
 * (`bash` + `str_replace_editor`), with `custom-bash` backing `bash` on
 * Windows. After promotion the resident catalog replaces that shell with the
 * standard preset's platform shell — `pwsh` on Windows (so `custom-bash` is
 * dropped from the model-facing toolset) and `bash` elsewhere — and the
 * `dev_tool_search` description is kept in sync. On Windows the patch also
 * installs a reversible agent-scope `tools.restrict()` so the dropped
 * `custom-bash` name is denied at RUNTIME after promotion, not just hidden
 * from the prompt; the restriction is lifted for the controlled
 * post-compaction phase, which keeps the original bootstrap pair.
 *
 * The source checkout in the submodule is never modified. The patch is
 * marker-based and fails loudly when the upstream plugin shape no longer
 * matches, instead of silently producing a preset without the shell change.
 */
function applyPromotedShellPatch(target) {
  const file = join(target, BOOTSTRAP_PLUGIN)
  let source = readFileSync(file, 'utf8').replaceAll('\r\n', '\n')

  const discoveryMarker = [
    '/** Discovery tools always resident after promotion (the tool-search pattern). */',
    "const RESIDENT_DISCOVERY_TOOLS = ['dev_tool_search', 'skill_search', 'skill_load']",
    '',
  ].join('\n')
  if (!source.includes(discoveryMarker)) {
    throw new Error(`${PRESET_ID}: cannot patch ${BOOTSTRAP_PLUGIN} — discovery-tool marker not found`)
  }
  source = source.replace(
    discoveryMarker,
    [
      discoveryMarker,
      '/**',
      ' * Shell tools resident after promotion, matching the standard preset\'s',
      " * platform gate: `pwsh` on Windows, `bash` elsewhere. On Windows this",
      ' * drops the `custom-bash`-backed `bash` from the model-facing promoted',
      ' * toolset while the bootstrap request keeps it.',
      ' */',
      "const PROMOTED_SHELL_TOOLS = process.platform === 'win32' ? ['pwsh'] : ['bash']",
      '',
      '/**',
      ' * Runtime-side companion to the promoted catalog change. On Windows the',
      ' * bootstrap phase needs `custom-bash`\'s `bash` registration; after',
      ' * promotion the model-facing catalog drops it, but the registration',
      ' * stays in the preset layer. `tools.restrict()` on the AGENT scope',
      ' * removes it from that session\'s actual registry view and execution',
      ' * path, so a stale or historical bash call after promotion is denied',
      ' * instead of merely hidden from the prompt.',
      ' *',
      ' * The restriction is reversible: a compaction demotes the session back',
      ' * to the controlled phase, whose catalog re-exposes the bootstrap pair,',
      ' * so the restriction is lifted then and re-applied when the session',
      ' * promotes again.',
      ' */',
      "const PROMOTED_DENY_TOOLS = process.platform === 'win32' ? ['bash'] : []",
      '',
      '/** Agent-scope restriction disposers, keyed by agent instance (weak). */',
      'const runtimeRestrictions = new WeakMap()',
      '',
      '/**',
      ' * Keep the runtime registry in sync with the phase the model catalog',
      ' * shows.',
      ' *',
      ' * `agent.ctx.tools.restrict()` files the deny into the agent\'s own scope',
      ' * layer and returns the exact disposer. The standing preset layer keeps',
      ' * its `bash` registration untouched, so other sessions still bootstrap',
      ' * through `custom-bash`; only this promoted agent loses it until',
      ' * compaction (or agent teardown, which disposes the restriction with',
      ' * the scope anyway).',
      ' */',
      'function syncPromotedRuntimeRestriction(agent, promoted) {',
      '  if (PROMOTED_DENY_TOOLS.length === 0) return',
      '  if (agent?.ctx === undefined) return',
      '  const active = runtimeRestrictions.get(agent)',
      '  if (promoted) {',
      '    if (active === undefined) runtimeRestrictions.set(agent, agent.ctx.tools.restrict({ deny: PROMOTED_DENY_TOOLS }))',
      '  } else if (active !== undefined) {',
      '    active()',
      '    runtimeRestrictions.delete(agent)',
      '  }',
      '}',
      '',
    ].join('\n'),
  )

  const promotedBlock = [
    '      if (status.promoted) {',
    '        // PROMOTED: keep the minimal resident set — the bootstrap pair + the',
    '        // discovery tools + whatever the model explicitly unlocked via',
    '        // dev_tool_search — instead of dumping the whole Standard catalog at',
    '        // once (the post-promotion regression fix; see the header note).',
    "        const keep = new Set([...bootstrapTools, ...RESIDENT_DISCOVERY_TOOLS, ...unlockedFor(context.agent?.session)])",
    '        return keepTools(assembled, keep, false)',
    '      }',
  ].join('\n')
  if (!source.includes(promotedBlock)) {
    throw new Error(`${PRESET_ID}: cannot patch ${BOOTSTRAP_PLUGIN} — promoted-catalog block not found`)
  }
  const patchedPromotedBlock = [
    '      if (status.promoted) {',
    '        // PROMOTED: keep the minimal resident set — the standard preset\'s',
    '        // platform shell (pwsh on Windows, bash elsewhere) +',
    '        // str_replace_editor + the discovery tools + whatever the model',
    '        // explicitly unlocked via dev_tool_search — instead of dumping the',
    '        // whole Standard catalog at once (the post-promotion regression fix;',
    '        // see the header note). On Windows this deliberately drops the',
    '        // custom-bash-backed `bash` from the promoted toolset.',
    "        const keep = new Set([...PROMOTED_SHELL_TOOLS, 'str_replace_editor', ...RESIDENT_DISCOVERY_TOOLS, ...unlockedFor(context.agent?.session)])",
    '        return keepTools(assembled, keep, false)',
    '      }',
  ].join('\n')
  source = source.replace(promotedBlock, patchedPromotedBlock)

  const statusMarker = '      const status = promotion.status(context.agent)'
  if (!source.includes(statusMarker)) {
    throw new Error(`${PRESET_ID}: cannot patch ${BOOTSTRAP_PLUGIN} — promotion-status marker not found`)
  }
  const patchedStatusBlock = [
    '      const status = promotion.status(context.agent)',
    '      try {',
    '        syncPromotedRuntimeRestriction(context.agent, status.promoted)',
    '      } catch (error) {',
    '        warnOnce(`${name}: runtime restriction sync failed, catalog filter still applies: ${String((error && error.message) || error)}`)',
    '      }',
  ].join('\n')
  source = source.replace(statusMarker, patchedStatusBlock)
  writeFileSync(file, source)

  const devSearchFile = join(target, DEV_SEARCH_PLUGIN)
  let devSearchSource = readFileSync(devSearchFile, 'utf8').replaceAll('\r\n', '\n')
  const residentLine = "      'This session starts with a minimal resident set: bash, str_replace_editor, skill_search, skill_load. Everything else is unlocked on demand through this tool.',"
  if (!devSearchSource.includes(residentLine)) {
    throw new Error(`${PRESET_ID}: cannot patch ${DEV_SEARCH_PLUGIN} — resident-catalog marker not found`)
  }
  devSearchSource = devSearchSource.replace(
    residentLine,
    "      `This session starts with a minimal resident set: ${process.platform === 'win32' ? 'pwsh' : 'bash'}, str_replace_editor, skill_search, skill_load. Everything else is unlocked on demand through this tool.`,",
  )
  const workaroundLine = "      'If the current task needs any of the following, call dev_tool_search FIRST — do not try to work around them with bash:',"
  if (!devSearchSource.includes(workaroundLine)) {
    throw new Error(`${PRESET_ID}: cannot patch ${DEV_SEARCH_PLUGIN} — workaround-line marker not found`)
  }
  devSearchSource = devSearchSource.replace(
    workaroundLine,
    "      'If the current task needs any of the following, call dev_tool_search FIRST — do not try to work around them with the resident shell:',",
  )
  writeFileSync(devSearchFile, devSearchSource)

  console.log(`  ${PRESET_ID} promoted-shell patch: windows=${process.platform === 'win32'} runtime-deny=${JSON.stringify(process.platform === 'win32' ? ['bash'] : [])}`)
}

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
applyEnvironmentPatch(target)
applyPromotedShellPatch(target)
console.log(`installed agent preset '${PRESET_ID}' (${SOURCE}) -> ${target}`)
