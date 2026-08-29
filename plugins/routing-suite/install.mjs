#!/usr/bin/env node
/**
 * install.mjs — install the dsh-routing-suite into the repo-local web profile
 * and the harness home, following the suite's own install chain.
 *
 * The upstream distribution repo (https://github.com/yjh051108/dsh-routing-suite)
 * lives in the `dsh-routing-suite` git submodule checkout beside this script.
 * Since upstream 21a7260 (flat-submodules merge) the injector/ and preset/
 * trees are plain directories in the suite repo — no nested submodules, no
 * --recursive needed. The canonical chain (suite README + install.ps1) is the
 * basis, with one dsh-gui adaptation:
 *
 *  1. injector/  dsh-super-injector (@dsh-external/dsh-super-injector):
 *     the self-contained `lib/` (host + client, tsdown) is built with the
 *     package's OWN prepare hook below, then the package goes through the
 *     SHARED installPlugin pipeline with `build: false` — `dsh plugin add
 *     link:<dir>` records the dependency and the declared `dsh.bundle.patch`
 *     makes the CLI reconcile it into `dsh.profile.bundles` (bundle layer
 *     self-mounts; no manual cordis.patch.yml insert).
 *  2. preset/   dsh-router-standard — the router-standard / router-spec agent
 *     presets are copied flat, whole-directory, from `preset/<id>` into
 *     `.dsh/.agent-presets/<id>/` (the compositions load
 *     ./router-bootstrap.mjs by relative path). Upstream fixed the preset.yml
 *     quoting, so the old re-quote patch is gone.
 *
 * Why the build is NOT the shared pipeline's default: installPlugin's default
 * build runs `pnpm install` with auto peers (fetches unpublished @deepseek-ai
 * transitives → 404), then `pnpm run build` (= bash scripts/build.sh, which
 * demands DSH_CHECKOUT + bash), and `build: false` would link a pristine
 * checkout that has no `lib/` (build output is not committed). So the wrapper
 * keeps only the small build step: junction the direct imports into the
 * checkout's gitignored node_modules (their real paths stay inside
 * `deepseek-harness`, so every transitive resolves from the harness tree,
 * mirroring upstream build.sh's DSH_CHECKOUT links) and run the upstream
 * prepare hook (tsdown), which produces the self-contained lib/ that
 * installPlugin then links. Dropped vs. the old wrapper: the `.dsh` build
 * copy, harness tsc, manual tsdown, and the standard-schema side link.
 *
 * Targets: `$DSH_HOME/profiles/web/` (plugins) and
 * `$DSH_HOME/.agent-presets/{router-standard,router-spec}` (presets).
 * `DSH_HOME` is pinned to `<repo>/.dsh` by the desktop shell; this script
 * honors an explicit `DSH_HOME` override.
 */

import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HARNESS, STORE, WEB_HOME, bootstrapPnpm, pnpm, run } from '../../scripts/toolchain.mjs'
import { installPlugin } from '../../scripts/plugin-install.mjs'

/** This plugin's wrapper directory — owns the suite submodule checkout. */
const HERE = dirname(fileURLToPath(import.meta.url))
/** The pristine suite checkout (aggregator repo; since 21a7260 the component trees are plain dirs). */
const SUITE = join(HERE, 'dsh-routing-suite')
/** The injector package inside the suite checkout (its own prepare hook builds lib/). */
const INJECTOR = join(SUITE, 'injector')
/** The router preset sources inside the suite checkout (flat dirs since upstream 21a7260). */
const PRESETS_SOURCE = join(SUITE, 'preset')
/** Preset ids installed into .dsh/.agent-presets/ (directory names upstream). */
const PRESET_IDS = ['router-standard', 'router-spec']

/** One hint covering the suite checkout (flat since upstream 21a7260; no nested submodules anymore). */
const SOURCE_HINT = 'git submodule update --init plugins/routing-suite/dsh-routing-suite'

/** The upstream self-contained host + client bundles the loader needs. */
const LIB_FILES = ['lib/index.js', 'lib/client.js']

/**
 * Direct imports the injector bundles at build time, mapped to their harness
 * checkout locations. Junctioning them keeps their real paths inside
 * `deepseek-harness`, so all transitives resolve from the harness tree.
 */
const BUILD_LINKS = [
  ['cordis', 'vendor/cordis'],
  ['cosmokit', 'vendor/cosmokit'],
  ['schemastery', 'vendor/schemastery'],
  ['@deepseek-ai/dsh-tools', 'packages/core/tools'],
  ['@deepseek-ai/dsh-llm', 'packages/llm/llm'],
  ['@deepseek-ai/dsh-system-prompt', 'packages/core/system-prompt'],
  ['@deepseek-ai/cordis-plugin-loader', 'vendor/loader'],
  ['@deepseek-ai/dsh-client-ui-slots', 'packages/client/ui-slots'],
]

/**
 * Fail with the submodule hint when the suite checkout is missing or
 * uninitialized (upstream 21a7260 flat: no nested component checkouts anymore).
 * @param {string} path - the missing path, used in the error message.
 */
function missing(path) {
  throw new Error(`routing-suite: ${path} not found — initialize it with: ${SOURCE_HINT}`)
}

/**
 * Create a junction/symlink at `link` pointing to `target`, replacing anything
 * already there. Both paths are resolved to absolutes first (Windows junctions
 * require absolute targets).
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
 * Build the injector's self-contained `lib/` in the suite checkout when a
 * fresh checkout has no build output. The junctions go in AFTER `pnpm install`
 * so pnpm does not prune them (they are not declared dependencies); the compile
 * itself runs through the upstream prepare hook (tsdown). `node_modules/` and
 * `lib/` are gitignored upstream, so the suite working tree stays clean.
 */
function ensureInjectorLib() {
  if (LIB_FILES.every((file) => existsSync(join(INJECTOR, file)))) return
  if (!existsSync(join(INJECTOR, 'scripts', 'prepare.mjs'))) {
    missing('plugins/routing-suite/dsh-routing-suite/injector')
  }
  console.log(`\n==> build dsh-super-injector lib (upstream prepare hook, ${INJECTOR})`)
  bootstrapPnpm()
  // --ignore-scripts keeps the package's own prepare from running before the
  // junctions exist; --ignore-workspace prevents a parent pnpm-workspace.yaml
  // from redirecting the install to the dsh-gui root instead of this package;
  // --no-lockfile keeps pnpm from writing an untracked pnpm-lock.yaml into the
  // submodule; auto-install-peers=false stops pnpm from trying to fetch the
  // unpublished @deepseek-ai peers from npm.
  pnpm(['install', '--ignore-scripts', '--ignore-workspace', '--no-lockfile', '--config.auto-install-peers=false', '--store-dir', STORE], {
    cwd: INJECTOR,
    env: { CI: 'true' },
  })

  for (const [name, rel] of BUILD_LINKS) {
    linkPackageDir(join(HARNESS, rel), join(INJECTOR, 'node_modules', name))
  }

  run('node', [join(INJECTOR, 'scripts', 'prepare.mjs')], { cwd: INJECTOR })
  for (const file of LIB_FILES) {
    if (!existsSync(join(INJECTOR, file))) {
      throw new Error(`routing-suite: injector build did not produce ${file}`)
    }
  }
}

/**
 * Install the router presets: whole-directory copies of each preset source
 * into `.dsh/.agent-presets/<id>/` (flat, matching the suite README's manual
 * step). The target is replaced and re-copied on every run, so re-installs are
 * idempotent and stale files cannot survive. Upstream v0.3.0 fixed the
 * preset.yml quoting, so no install-time re-quote patch is applied anymore.
 * @param {string} dshHome - the harness home the presets install into.
 */
function installPresets(dshHome) {
  for (const id of PRESET_IDS) {
    const source = join(PRESETS_SOURCE, id)
    if (!existsSync(join(source, 'agent.cordis.yml'))) {
      missing(`plugins/routing-suite/dsh-routing-suite/preset/${id}`)
    }
    const target = join(dshHome, '.agent-presets', id)
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
    cpSync(source, target, { recursive: true })
    console.log(`installed agent preset '${id}' (${source}) -> ${target}`)
  }
}

if (!existsSync(join(SUITE, 'README.md'))) {
  missing('plugins/routing-suite/dsh-routing-suite')
}
if (!existsSync(join(INJECTOR, 'package.json'))) {
  missing('plugins/routing-suite/dsh-routing-suite/injector')
}

const dshHome = process.env.DSH_HOME ?? WEB_HOME

// Injector: custom build (junctions + upstream prepare hook) first, then the
// shared pipeline links and mounts it (build: false — installPlugin's own build
// cannot run here; see the header).
ensureInjectorLib()
installPlugin({ id: 'dsh-super-injector', packageDir: INJECTOR, sourceHint: SOURCE_HINT, build: false })

// Legacy installs built a copy under $DSH_HOME/plugins/routing-suite/ and
// linked it; the shared add now repoints to the checkout, so drop the stale
// copy once the new spec is in place.
const legacy = join(dshHome, 'plugins', 'routing-suite')
if (existsSync(legacy)) {
  rmSync(legacy, { recursive: true, force: true })
  console.log(`  removed legacy built copy ${legacy}`)
}

installPresets(dshHome)
