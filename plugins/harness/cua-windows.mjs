#!/usr/bin/env node
/**
 * Computer Use on Windows: build the native helper and switch the official cua
 * bundle on for the selected profile.
 *
 * Computer Use is not a wrapper plugin any more: `dsh-v0.2.3-alpha.2` ships it
 * as the optional bundle `@deepseek-ai/dsh-cua-bundle`, and the plugin page's
 * "Computer Use" switch enables it by writing that name into the profile's
 * `dsh.profile.bundles`. The bundle's own patch mounts
 * `cua-provider-registry` (`@deepseek-ai/dsh-computer-use`), the platform
 * provider (`cua-windows` on this host) and `ui-cua` (tools plus the
 * `cuaAccess` service).
 *
 * The Windows provider needs a native helper, `dsh-cua-windows.exe`. The npm
 * package publishes no binary — its `files` whitelist names `native/bin`, but
 * the tarball carries no `native/` directory — so this script builds the helper
 * from the pinned submodule source with the .NET 10 SDK, keeps it under
 * `<DSH_HOME>/cua/win-<arch>`, and points the `cua-windows` row's
 * `config.helperPath` at it.
 *
 * ## Checkpoints for a harness upgrade
 *
 * Re-read these on every harness bump (the script also checks the first one at
 * run time and prints a reminder when it is satisfied):
 *
 * 1. Does the published `@deepseek-ai/dsh-cua-windows@<version>` package now
 *    carry `native/bin/win-x64/dsh-cua-windows.exe`? (`npm pack` it and look;
 *    `files` alone is not proof.)
 * 2. Does the packaged desktop app carry that helper under
 *    `resources/app.asar.unpacked/.../dsh-cua-windows/native/bin/...`?
 * 3. Does the upstream `cua-bundle` documentation or patch name a helper
 *    location, a published ZIP, or a default `helperPath`?
 *
 * When any answer is yes, drop the build half of this script and the profile's
 * `cua-windows` config override, and let the official artifact take over. The
 * runtime check below prints the same reminder as soon as the helper appears in
 * the installed package, so a silent upgrade cannot leave this build in place.
 *
 * ## Scope
 *
 * Windows only; other platforms log and return. The profile is selected by
 * `DSH_PLUGIN_PROFILE` (default `web`) and the desktop build re-runs this
 * script with `desktop`, whose profile is owned by the Electron application —
 * write there while that application is closed. Edits target
 * `$DSH_HOME/profiles/<profile>` only: the manifest's `dsh.profile.bundles` and
 * the `- id: cua-windows` entry of its `cordis.patch.yml`.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ROOT, WEB_HOME } from '../../scripts/toolchain.mjs'

/** Wrapper id: the `plugins/<id>/` directory name, used for logs and skip checks. */
const ID = 'cua-windows'

/** The optional bundle the plugin page's Computer Use switch toggles. */
const BUNDLE = '@deepseek-ai/dsh-cua-bundle'

/** Package whose native payload the bundle's Windows provider expects. */
const WINDOWS_PACKAGE = '@deepseek-ai/dsh-cua-windows'

/** Pinned harness checkout that owns the helper's C# sources. */
const SUBMODULE = join(ROOT, 'deepseek-harness')

/** The helper project, relative to the submodule. */
const PROJECT = join('packages', 'experimental', 'cua-windows', 'native', 'entry', 'CuaWindows.csproj')

/** Executable the provider looks for; the project's `AssemblyName` is already this. */
const HELPER_EXE = 'dsh-cua-windows.exe'

const PROFILE = (process.env.DSH_PLUGIN_PROFILE ?? 'web').trim() || 'web'
const PROFILE_DIR = join(WEB_HOME, 'profiles', PROFILE)
const ARCH = process.arch

/** Whether the shared pipeline's skip list excludes this wrapper. */
function skipped() {
  const raw = process.env.DSH_PLUGIN_SKIP ?? ''
  return raw
    .split(/[,;]/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .includes(ID)
}

/** Locate `dotnet` on PATH without capturing a child's pipe. */
function findDotnet() {
  for (const entry of (process.env.PATH ?? '').split(';')) {
    if (entry === '') continue
    const candidate = join(entry, 'dotnet.exe')
    if (existsSync(candidate)) return candidate
  }
  return existsSync('C:\\Program Files\\dotnet\\dotnet.exe') ? 'C:\\Program Files\\dotnet\\dotnet.exe' : null
}

/**
 * Installed `dsh-cua-windows` package root, preferring the profile's own tree.
 * @returns {string | null} package directory, or null when it is not installed.
 */
function installedWindowsPackage() {
  const candidates = [
    join(PROFILE_DIR, 'node_modules', '@deepseek-ai', 'dsh-cua-windows'),
    join(dirname(WEB_HOME), '.harness', 'node_modules', '@deepseek-ai', 'dsh-cua-windows'),
  ]
  return candidates.find((candidate) => existsSync(join(candidate, 'package.json'))) ?? null
}

/**
 * The official helper binary when this harness revision publishes one.
 *
 * The npm package's `files` whitelist mentions `native/bin`, so a future tarball
 * may ship the payload; a run that finds it must not keep building a local copy.
 * @returns {string | null} absolute path of the published helper, or null.
 */
function publishedHelper(packageRoot) {
  if (packageRoot === null) return null
  const candidate = join(packageRoot, 'native', 'bin', `win-${ARCH}`, HELPER_EXE)
  return existsSync(candidate) ? candidate : null
}

/** Read the pinned submodule's HEAD; null when the checkout is unusable. */
function submoduleRevision() {
  const headFile = join(SUBMODULE, '.git')
  if (!existsSync(headFile)) return null
  const result = spawnSync('git', ['-C', SUBMODULE, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  const revision = (result.stdout ?? '').trim()
  return result.status === 0 && /^[0-9a-f]{40}$/u.test(revision) ? revision : null
}

/**
 * Build the helper when the cached one is missing or was built for another
 * submodule revision.
 * @param {object} options - build inputs.
 * @param {string} options.dotnet - absolute dotnet executable.
 * @param {string} options.revision - pinned submodule revision.
 * @returns {{ helperPath: string | null, rebuilt: boolean }} helper path, and
 *   whether this run compiled it.
 */
function ensureHelper({ dotnet, revision }) {
  const output = join(WEB_HOME, 'cua', `win-${ARCH}`)
  const helperPath = join(output, HELPER_EXE)
  const stampPath = join(output, 'build.json')
  let stamp = null
  try {
    stamp = JSON.parse(readFileSync(stampPath, 'utf8'))
  } catch {
    // A missing or unreadable stamp counts as a stale build.
  }
  if (existsSync(helperPath) && stamp?.revision === revision && stamp?.arch === ARCH) {
    return { helperPath, rebuilt: false }
  }
  const project = join(SUBMODULE, PROJECT)
  if (!existsSync(project)) return { helperPath: null, rebuilt: false }
  mkdirSync(output, { recursive: true })
  console.log(`  dotnet publish ${project} -> ${output}`)
  const result = spawnSync(dotnet, [
    'publish', project,
    '-c', 'Release',
    '-r', `win-${ARCH}`,
    '--self-contained', 'true',
    '-o', output,
    '-p:EnableWindowsTargeting=true',
  ], { stdio: 'inherit' })
  if (result.status !== 0 || !existsSync(helperPath)) return { helperPath: null, rebuilt: false }
  writeFileSync(stampPath, `${JSON.stringify({ revision, arch: ARCH, builtAt: new Date().toISOString() }, undefined, 2)}\n`)
  return { helperPath, rebuilt: true }
}

/**
 * Add the cua bundle to the profile's bundle list, keeping every other entry.
 * @returns {'added' | 'present' | 'unavailable'} what the manifest looked like.
 */
function enableBundle() {
  const manifestPath = join(PROFILE_DIR, 'package.json')
  if (!existsSync(manifestPath)) return 'unavailable'
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return 'unavailable'
  if (bundles.includes(BUNDLE)) return 'present'
  bundles.push(BUNDLE)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  return 'added'
}

/**
 * Point the `cua-windows` row's `config.helperPath` at the built helper.
 *
 * Rewrites only that key when the entry already exists (so other operator
 * settings on the row survive) and appends the whole entry otherwise.
 * @returns {'appended' | 'updated' | 'added-key'} how the patch changed.
 */
function configureHelperPath(helperPath) {
  const patchPath = join(PROFILE_DIR, 'cordis.patch.yml')
  const text = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const line = `    helperPath: '${helperPath}'`
  const lines = text.split(/\r?\n/u)
  const start = lines.findIndex((entry) => entry.trim() === '- id: cua-windows')
  if (start === -1) {
    const block = ['- id: cua-windows', '  config:', line]
    writeFileSync(patchPath, `${text.trimEnd()}${eol}${block.join(eol)}${eol}`)
    return 'appended'
  }
  let end = start + 1
  while (end < lines.length && !lines[end].startsWith('- ') && !lines[end].startsWith('#')) end += 1
  const block = lines.slice(start, end)
  const helperIndex = block.findIndex((entry) => /^\s+helperPath:/u.test(entry))
  if (helperIndex >= 0) {
    block[helperIndex] = line
    lines.splice(start, block.length, ...block)
    writeFileSync(patchPath, `${lines.join(eol)}`)
    return 'updated'
  }
  const configIndex = block.findIndex((entry) => /^\s{2}config:\s*$/u.test(entry))
  if (configIndex >= 0) {
    block.splice(configIndex + 1, 0, line)
  } else {
    block.splice(1, 0, '  config:', line)
  }
  lines.splice(start, block.length, ...block)
  writeFileSync(patchPath, `${lines.join(eol)}`)
  return 'added-key'
}

if (process.platform !== 'win32') {
  console.log(`  ${ID}: not Windows — the official cua bundle provides Computer Use on this platform`)
} else if (skipped()) {
  console.log(`  skipping '${ID}' — listed in DSH_PLUGIN_SKIP`)
} else if (!existsSync(join(PROFILE_DIR, 'package.json'))) {
  console.log(`  ${ID}: profile ${PROFILE} is not initialized at ${PROFILE_DIR} — skipping`)
} else {
  console.log(`\n==> Computer Use on Windows (${PROFILE} profile)`)
  const packageRoot = installedWindowsPackage()
  const official = publishedHelper(packageRoot)
  if (official !== null) {
    // CHECKPOINT 1 fired: the published package now carries the helper, so the
    // local build and the helperPath override are obsolete.
    console.log('  !!! 检查点：官方 npm 包已携带 dsh-cua-windows.exe —— 请更新本脚本')
    console.log(`  published helper: ${official}`)
    console.log('  remove the build half of plugins/harness/cua-windows.mjs and drop the')
    console.log('  profile\'s cua-windows helperPath override; the packaged binary is now used.')
    const bundleState = enableBundle()
    console.log(`  cua bundle: ${bundleState === 'added' ? `added ${BUNDLE}` : bundleState}`)
  } else {
    const dotnet = findDotnet()
    const revision = submoduleRevision()
    if (dotnet === null || revision === null) {
      console.log(`  ${ID}: ${dotnet === null ? 'dotnet was not found on PATH' : 'the pinned submodule is unusable'} — Computer Use stays off`)
      console.log('  install the .NET 10 SDK (or restore the submodule) and re-run this install step')
    } else {
      const { helperPath, rebuilt } = ensureHelper({ dotnet, revision })
      if (helperPath === null) {
        console.log(`  ${ID}: the helper build failed — Computer Use stays off; see the dotnet output above`)
      } else {
        const bundleState = enableBundle()
        const patchState = configureHelperPath(helperPath)
        console.log(`  helper: ${helperPath} (${rebuilt ? 'built' : 'cached'})`)
        console.log(`  cua bundle: ${bundleState === 'added' ? `added ${BUNDLE}` : bundleState}`)
        console.log(`  cua-windows helperPath: ${patchState}`)
        console.log('  restart the application for the profile change to take effect')
      }
    }
  }
}
