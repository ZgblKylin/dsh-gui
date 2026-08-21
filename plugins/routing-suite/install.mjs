#!/usr/bin/env node
/**
 * install.mjs — build, install, and mount the dsh-routing-suite into the
 * repo-local web profile and the harness home.
 *
 * The upstream distribution repo (https://github.com/yjh051108/dsh-routing-suite)
 * lives in the `dsh-routing-suite` git submodule checkout beside this
 * script; its install chain (per the suite README) is:
 *
 *  - injector/   dsh-super-injector  (@dsh-external/dsh-super-injector) —
 *                runtime plugin injector (dev_* tool family, hot reload,
 *                staging-promote/uninject, plugin management UI). It declares
 *                `dsh.bundle.patch`, so `dsh plugin add` reconciles it into
 *                `dsh.profile.bundles` and its own bundle layer mounts the
 *                entry (id 'dsh-super-injector'); no manual cordis.patch.yml
 *                insert is written (that would double-mount it).
 *  - preset/     dsh-router-standard  router-standard / router-spec agent
 *                presets — the suite README's manual install step copies each
 *                preset directory flat into
 *                `.dsh/.agent-presets/<id>/` (the compositions load
 *                ./router-bootstrap-v1.mjs by relative path, so single-file
 *                copies would break them); an install-time patch re-quotes
 *                the copied preset.yml metadata (the upstream descriptions
 *                contain unquoted ': ' that js-yaml/yaml reject, which
 *                would degrade the picker to bare preset ids).
 *
 * UPSTREAM IS NEVER MODIFIED: the injector sources are copied to
 * `$DSH_HOME/plugins/routing-suite/dsh-super-injector` and built there
 * (pnpm install + junction links into the harness checkout mirroring the
 * upstream scripts/build.sh + tsc + tsdown for the self-contained
 * lib/index.js / lib/client.js release shape), then the copy is linked into
 * the web profile. The checkout is reused unchanged on re-installs; the
 * install target is replaced each run, so re-installs are idempotent and
 * stale build output cannot survive a source change.
 *
 * Targets: `$DSH_HOME/profiles/web/` (plugins) and
 * `$DSH_HOME/.agent-presets/{router-standard,router-spec}` (presets).
 * `DSH_HOME` is pinned to `<repo>/.dsh` by the desktop shell; this script
 * honors an explicit `DSH_HOME` override (the build passes one) and
 * otherwise pins the same repo-local default.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPlugin } from '../../scripts/plugin-install.mjs'
import {
  HARNESS,
  HARNESS_BIN,
  WEB_HOME,
  bootstrapPnpm,
  pnpm,
  run,
  STORE,
} from '../../scripts/toolchain.mjs'

/** This plugin's wrapper directory — owns the suite submodule checkout. */
const HERE = dirname(fileURLToPath(import.meta.url))
/** The pristine suite checkout (aggregator repo + two pinned submodules). */
const SUITE = join(HERE, 'dsh-routing-suite')
/** The injector package inside the suite checkout. */
const INJECTOR_SOURCE = join(SUITE, 'injector')
/** The router preset sources inside the suite checkout (preset submodule). */
const PRESETS_SOURCE = join(SUITE, 'preset', 'preset')
/** Preset ids installed into .dsh/.agent-presets/ (directory names upstream). */
const PRESET_IDS = ['router-standard', 'router-spec']

/** One hint covering the suite checkout and its nested submodules. */
const SOURCE_HINT = 'git submodule update --init --recursive plugins/routing-suite/dsh-routing-suite'

/**
 * Fail with the recursive-submodule hint when a suite checkout (top level or
 * one of the two component checkouts) is missing or uninitialized.
 * @param {string} path - the missing path, used in the error message.
 */
function missing(path) {
  throw new Error(
    `routing-suite: ${path} not found — initialize it with: ${SOURCE_HINT}`,
  )
}

/**
 * Create a junction/symlink at `link` pointing to `target`, replacing
 * anything already there. Both paths are resolved to absolutes first
 * (Windows junctions require absolute targets).
 * @param {string} target - the directory to link to.
 * @param {string} link - the link path to create.
 */
function linkPackageDir(target, link) {
  if (!existsSync(target)) missing(target)
  rmSync(link, { recursive: true, force: true })
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(resolve(target), resolve(link), process.platform === 'win32' ? 'junction' : 'dir')
}

/**
 * Link @standard-schema/spec from the harness's pnpm store when present;
 * upstream's build.sh does the same and skips it otherwise (tsconfig has
 * skipLibCheck).
 * @param {string} packageDir - the injector build directory.
 */
function linkStandardSchema(packageDir) {
  const pnpmDir = join(HARNESS, 'node_modules', '.pnpm')
  if (!existsSync(pnpmDir)) return
  const candidates = readdirSync(pnpmDir)
    .filter((name) => /^@standard-schema\+spec@/.test(name))
    .map((name) => join(pnpmDir, name, 'node_modules', '@standard-schema', 'spec'))
    .filter((path) => existsSync(path))
  if (candidates.length > 0) {
    linkPackageDir(candidates[0], join(packageDir, 'node_modules', '@standard-schema', 'spec'))
  }
}

/**
 * Build the injector from the pristine checkout into a fresh copy under
 * `$DSH_HOME/plugins/routing-suite/dsh-super-injector`, mirroring the
 * upstream `scripts/build.sh` (junction links into the harness checkout +
 * tsc) and then running the upstream tsdown config
 * (`pnpm run build:client`) so `lib/index.js` is self-contained: official
 * assembly of a `link:` directory does not install peer dependencies, and a
 * non-bundled build would resolve cordis/@deepseek-ai/dsh-tools from the
 * checkout's own node_modules junctions.
 * @param {string} dshHome - the harness home the build copy lives under.
 * @returns {string} the built package directory to link into the profile.
 */
function buildInjector(dshHome) {
  if (!existsSync(join(INJECTOR_SOURCE, 'package.json'))) {
    missing('plugins/routing-suite/dsh-routing-suite/injector')
  }
  if (!existsSync(HARNESS_BIN)) {
    throw new Error('routing-suite: harness CLI not built at ' + HARNESS_BIN + ' — run "npm run setup" once')
  }

  const packageDir = join(dshHome, 'plugins', 'routing-suite', 'dsh-super-injector')
  rmSync(packageDir, { recursive: true, force: true })
  mkdirSync(packageDir, { recursive: true })
  cpSync(INJECTOR_SOURCE, packageDir, {
    recursive: true,
    filter: (src) => !/(\\|\/)(node_modules|\.git)(\\|\/|$)/.test(src.slice(INJECTOR_SOURCE.length + 1)),
  })

  bootstrapPnpm()
  console.log(`\n==> build dsh-super-injector (${packageDir})`)
  // Peers are provided by the harness checkout links below, not the
  // registry: keep auto-install-peers off so pnpm does not try to fetch the
  // unpublished @deepseek-ai workspace packages from npm.
  pnpm(['install', '--store-dir', STORE, '--config.auto-install-peers=false'], {
    cwd: packageDir,
    env: { CI: 'true' },
  })

  // Mirror upstream scripts/build.sh: link the harness checkout's copies of
  // the packages the sources import, then compile with the harness's tsc.
  for (const [name, rel] of [
    ['cordis', 'vendor/cordis'],
    ['cosmokit', 'vendor/cosmokit'],
    ['schemastery', 'vendor/schemastery'],
    ['@deepseek-ai/dsh-tools', 'packages/core/tools'],
    ['@deepseek-ai/dsh-system-prompt', 'packages/core/system-prompt'],
    ['@deepseek-ai/cordis-plugin-loader', 'vendor/loader'],
  ]) {
    linkPackageDir(join(HARNESS, rel), join(packageDir, 'node_modules', name))
  }
  linkStandardSchema(packageDir)

  const tsc = join(HARNESS, 'node_modules', 'typescript', 'bin', 'tsc')
  if (!existsSync(tsc)) {
    throw new Error('routing-suite: typescript not found in the harness checkout — run "npm run setup" once')
  }
  console.log('  compiling src -> lib (harness typescript)')
  run('node', [tsc, '-p', 'tsconfig.json'], { cwd: packageDir })

  console.log('  bundling self-contained lib/index.js + lib/client.js (tsdown)')
  pnpm(['run', 'build:client'], {
    cwd: packageDir,
    env: { CI: 'true', pnpm_config_verify_deps_before_run: 'false' },
  })

  for (const file of ['lib/index.js', 'lib/client.js']) {
    if (!existsSync(join(packageDir, file))) {
      throw new Error(`routing-suite: injector build did not produce ${file}`)
    }
  }
  return packageDir
}

/**
 * Re-emit the copied preset's preset.yml as quoted YAML.
 *
 * The upstream display descriptions contain unquoted `: ` (e.g.
 * "RL-interface restoration: one-sentence persona..."), which both js-yaml
 * and yaml@2 reject — the harness then degrades the picker to the bare
 * preset id instead of "Router Standard (experimental)". The patch keeps
 * the text verbatim but writes both fields as single-quoted scalars, so the
 * metadata parses; re-running it on already-quoted output is a no-op. The
 * submodule source stays untouched.
 * @param {string} target - the installed preset directory.
 */
function patchPresetMetadata(target) {
  const file = join(target, 'preset.yml')
  const raw = readFileSync(file, 'utf8').replaceAll('\r\n', '\n')
  const nameMatch = /^name:\s*(.*)$/m.exec(raw)
  const descriptionMatch = /^description:\s*(.*)$/m.exec(raw)
  if (nameMatch === null || descriptionMatch === null) return
  /** Strip one layer of single quotes (+ '' escapes) so re-patching is a no-op. */
  const unquote = (value) => {
    const trimmed = value.trim()
    return trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2
      ? trimmed.slice(1, -1).replace(/''/g, "'")
      : value
  }
  const quote = (value) => `'${value.replace(/'/g, "''")}'`
  writeFileSync(file, `name: ${quote(unquote(nameMatch[1]))}\ndescription: ${quote(unquote(descriptionMatch[1]))}\n`)
  console.log(`  patched ${file} (quoted preset metadata)`)
}

/**
 * Install the router presets: whole-directory copies of each preset source
 * into `.dsh/.agent-presets/<id>/` (flat, matching the suite README's manual
 * step), then the preset.yml quoting patch. The target is replaced and
 * re-copied on every run, so re-installs are idempotent and stale files
 * cannot survive.
 * @param {string} dshHome - the harness home the presets install into.
 */
function installPresets(dshHome) {
  for (const id of PRESET_IDS) {
    const source = join(PRESETS_SOURCE, id)
    if (!existsSync(join(source, 'agent.cordis.yml'))) {
      missing(`plugins/routing-suite/dsh-routing-suite/preset/preset/${id}`)
    }
    const target = join(dshHome, '.agent-presets', id)
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
    cpSync(source, target, { recursive: true })
    patchPresetMetadata(target)
    console.log(`installed agent preset '${id}' (${source}) -> ${target}`)
  }
}

if (!existsSync(join(SUITE, 'README.md'))) {
  missing('plugins/routing-suite/dsh-routing-suite')
}

const dshHome = process.env.DSH_HOME ?? WEB_HOME
const injectorPackage = buildInjector(dshHome)
installPlugin({
  id: 'dsh-super-injector',
  packageDir: injectorPackage,
  sourceHint: SOURCE_HINT,
  build: false,
})
installPresets(dshHome)
