/**
 * Behaviour test of the generated child ESM loader, run against the built
 * package (`../lib/index.js`).
 *
 * Two anchors are built in a temporary directory:
 *
 * - a fake *runtime* (`node_modules/@deepseek-ai/dsh` plus a runtime-only
 *   package) — the modules that make up the framework;
 * - a fake *parent profile* (a manifest plus a profile-only package) — the
 *   plugin packages a profile installs.
 *
 * A tiny probe child is executed with `--experimental-loader <generated>` and
 * must resolve the profile-only package, that package's own import of the
 * runtime-only package, and a package that exists in both (runtime wins). The
 * probe writes its result to a file, because this sandbox refuses nested child
 * processes with piped stdio and the parent only needs the exit status.
 *
 * Usage (from the package directory): node tests/remote-tab-loader.spec.ts
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)

/** Write one ES module package with a package.json. */
function writeModulePackage(nodeModules: string, name: string, source: string): void {
  const directory = join(nodeModules, ...name.split('/'))
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'index.js' }))
  writeFileSync(join(directory, 'index.js'), source)
}

const root = mkdtempSync(join(tmpdir(), 'dsh-remote-tab-loader-'))
const runtimeDir = join(root, 'runtime')
const profileDir = join(root, 'profile')
const childHome = join(root, 'child-home')
mkdirSync(runtimeDir, { recursive: true })
mkdirSync(profileDir, { recursive: true })
mkdirSync(childHome, { recursive: true })

// The anchors themselves: a package.json inside the runtime and the profile.
writeModulePackage(join(runtimeDir, 'node_modules'), '@deepseek-ai/dsh', 'export const marker = "dsh"\n')
writeModulePackage(join(runtimeDir, 'node_modules'), '@deepseek-ai/runtime-only', 'export const marker = "runtime"\n')
writeModulePackage(join(runtimeDir, 'node_modules'), '@deepseek-ai/both', 'export const marker = "runtime-both"\n')
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'parent-profile', private: true }, null, 2))
writeModulePackage(join(profileDir, 'node_modules'), '@deepseek-ai/both', 'export const marker = "profile-both"\n')
writeModulePackage(
  join(profileDir, 'node_modules'),
  '@deepseek-ai/profile-only',
  'export { marker as coreMarker } from "@deepseek-ai/runtime-only"\nexport const marker = "profile"\n',
)

// ---------------------------------------------------------------- generated source
{
  const loader = mod.writeRemoteTabLoader({
    childHome,
    runtimeAnchor: join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    profileAnchor: join(profileDir, 'package.json'),
  })
  assert.equal(loader.path, mod.remoteTabLoaderPath(childHome), 'the loader lives at the documented path')
  assert.ok(existsSync(loader.path), 'the loader file is written')
  assert.ok(loader.source.includes(mod.LOADER_SCOPE_PREFIX), 'the loader names the dsh package scope')

  const profileOnlyLoader = mod.loaderSource({ profileAnchor: join(profileDir, 'package.json') })
  assert.ok(!profileOnlyLoader.includes('RUNTIME_ANCHOR_PATH = "'), 'a loader without a runtime anchor embeds null')
  assert.ok(profileOnlyLoader.includes('RUNTIME_ANCHOR_PATH = null'), 'a loader without a runtime anchor degrades to the profile anchor')
}

// ---------------------------------------------------------------- runtime behaviour
{
  const loader = mod.writeRemoteTabLoader({
    childHome,
    runtimeAnchor: join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    profileAnchor: join(profileDir, 'package.json'),
  })
  const probePath = join(root, 'probe.mjs')
  const resultPath = join(root, 'probe-result.json')
  writeFileSync(probePath, `// Probe: import through the loader and record what resolved.
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { sep } from 'node:path'

const result = {}
try {
  const profileOnly = await import('@deepseek-ai/profile-only')
  result.profileOnly = profileOnly.marker
  result.coreMarker = profileOnly.coreMarker
  result.profileOnlyUrl = import.meta.resolve('@deepseek-ai/profile-only')
  const both = await import('@deepseek-ai/both')
  result.both = both.marker
  result.bothUrl = import.meta.resolve('@deepseek-ai/both')
  result.sep = sep
  writeFileSync(process.argv[2], JSON.stringify(result))
} catch (error) {
  writeFileSync(process.argv[2], JSON.stringify({ error: String(error && error.stack ? error.stack : error) }))
  process.exitCode = 1
}
`)
  const child = spawnSync(process.execPath, [
    '--experimental-loader',
    pathToFileURL(loader.path).href,
    probePath,
    resultPath,
  ], { stdio: 'ignore' })
  assert.equal(child.status, 0, `the probe child exits successfully (result file exists: ${String(existsSync(resultPath))})`)
  assert.ok(existsSync(resultPath), 'the probe writes its result file')
  const result = JSON.parse(readFileSync(resultPath, 'utf8'))
  assert.equal(result.error, undefined, `the probe resolves every import (${String(result.error)})`)
  assert.equal(result.profileOnly, 'profile', 'a profile-only package resolves through the profile anchor')
  assert.equal(result.coreMarker, 'runtime', "the profile-only package's own runtime import resolves through the runtime anchor")
  assert.equal(result.both, 'runtime-both', 'a package present in both anchors resolves from the runtime first')
  assert.ok(result.profileOnlyUrl.includes('/profile/node_modules/'), 'the profile-only import URL points at the profile')
  assert.ok(result.bothUrl.includes('/runtime/node_modules/'), 'the shared import URL points at the runtime')
  assert.equal(result.sep, sep, 'non-dsh specifiers resolve normally')
}

rmSync(root, { recursive: true, force: true })
console.log('remote-tab loader tests passed')
