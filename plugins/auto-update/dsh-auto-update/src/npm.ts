/**
 * Per-row npm publish state for the auto-update host half.
 *
 * One question drives this module: when a row's newest tag is about to be
 * checked out, has that tag's version already been published to npm for every
 * npm-installed package the module provides? The dialog shows the gap as a note
 * on the row; it never blocks the git update, so every failure is reported
 * inside `error` instead of failing the row.
 *
 * The package set, the registry request, the target version, and the
 * aggregation mirror `src-tauri/src/update.rs` (`npm_installs_path` /
 * `npm_install_packages` / `collect_manifest_names` / `submodule_package_names`
 * / `npm_packages_for_project` / `parse_npm_results`). The shell performs the
 * queries in one embedded node script; the host issues the same requests
 * directly here — one per package, concurrently, with the same 15 s per-request
 * budget and the same headers.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { dshHomeDir, isDirectory, packageName } from './paths.ts'

/** Registry used when no test override is set. */
const DEFAULT_REGISTRY_BASE = 'https://registry.npmjs.org'

/** Per-request budget; a slow registry must not stall the whole check. */
const REGISTRY_TIMEOUT_MS = 15_000

/** Registry request headers, identical to the shell's embedded fetch script. */
const ACCEPT_HEADER = 'application/vnd.npm.install-v1+json'
const USER_AGENT = 'dsh-gui-update-check'

/** Directories skipped while collecting package names inside a checkout. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'target', 'dist'])

/** Reported when a 2xx response body is not the registry JSON document. */
const UNPARSEABLE_RESPONSE = '无法解析 npm registry 响应'

/** npm-side publish state for one update row (mirrors the shell's `NpmUpdateInfo`). */
export interface NpmUpdateInfo {
  /** The npm-installed packages this project provides, in manifest order. */
  packages: string[]
  /** Registry `dist-tags.latest` per package (may be an empty string). */
  latest: Record<string, string>
  /** Packages whose published versions do not contain the target version. */
  missing: string[]
  /** True when every package has the target version published and no request failed. */
  complete: boolean
  /** A readable failure; absent when every request answered. */
  error?: string
}

/** One package's registry answer, before aggregation. */
type NpmProbe =
  | { name: string; latest: string; hasTarget: boolean }
  | { name: string; error: string }

/**
 * Names recorded by the install pipeline for npm-installed wrappers
 * (`<DSH_HOME>/gui/npm-installs.json`; see `scripts/plugin-install.mjs`).
 * A missing, unreadable, or malformed file is an empty set.
 * @returns the recorded names.
 */
export function npmInstalledPackages(): Set<string> {
  const home = dshHomeDir()
  if (home === undefined) return new Set()
  const content = readFileSyncSafe(join(home, 'gui', 'npm-installs.json'))
  if (content === undefined) return new Set()
  try {
    const parsed: unknown = JSON.parse(content)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((item): item is string => typeof item === 'string'))
  } catch {
    return new Set()
  }
}

/**
 * The npm package names one checkout provides: its own root `package.json`
 * name, then every manifest under `apps/` and `packages/` (recursively,
 * skipping vendored and generated directories). Order is discovery order and
 * duplicates are kept, exactly like the shell's collector.
 * @param dir - project directory.
 * @returns the package names, possibly empty.
 */
export function projectPackageNames(dir: string): string[] {
  const names: string[] = []
  const rootName = packageName(dir)
  if (rootName !== undefined) names.push(rootName)
  for (const group of ['apps', 'packages']) {
    const groupDir = join(dir, group)
    if (isDirectory(groupDir)) collectManifestNames(groupDir, names)
  }
  return names
}

/**
 * The npm-installed packages belonging to one project: the project's manifest
 * names intersected with the install-time registry.
 * @param dir - project directory.
 * @returns the matching names in manifest order.
 */
export function npmPackagesForProject(dir: string): string[] {
  const registry = npmInstalledPackages()
  if (registry.size === 0) return []
  return projectPackageNames(dir).filter((name) => registry.has(name))
}

/**
 * Query the registry for `packages` at the version `tag` denotes.
 * @param packages - package names to probe (non-empty).
 * @param tag - the update target tag; a leading `v` is stripped for comparison.
 * @returns the aggregated state; transport failures land in `error`.
 */
export async function npmUpdateCheck(packages: string[], tag: string): Promise<NpmUpdateInfo> {
  const target = tag.startsWith('v') ? tag.slice(1) : tag
  const probes = await Promise.all(packages.map(async (name) => await probe(name, target)))
  const latest: Record<string, string> = {}
  const missing: string[] = []
  let error: string | undefined
  for (const probe of probes) {
    // The shell keeps the last failing package's message in manifest order.
    if ('error' in probe) {
      error = probe.error
      continue
    }
    latest[probe.name] = probe.latest
    if (!probe.hasTarget) missing.push(probe.name)
  }
  const info: NpmUpdateInfo = {
    packages,
    latest,
    missing,
    complete: missing.length === 0 && error === undefined,
  }
  if (error !== undefined) info.error = error
  return info
}

/** Probe one package's registry document. */
async function probe(name: string, target: string): Promise<NpmProbe> {
  try {
    const response = await fetch(`${registryBase()}/${encodeURIComponent(name)}`, {
      headers: { accept: ACCEPT_HEADER, 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    })
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel()
      return { name, error: `HTTP ${response.status}` }
    }
    let document: unknown
    try {
      document = await response.json()
    } catch {
      // A 2xx body that is not JSON (a proxy or gateway answering with HTML or
      // plain text) is a registry response problem, not a transport failure.
      // The body is already consumed by the failed parse, so it is not cancelled.
      return { name, error: UNPARSEABLE_RESPONSE }
    }
    if (document === null || typeof document !== 'object') {
      return { name, error: UNPARSEABLE_RESPONSE }
    }
    const record = document as { 'dist-tags'?: unknown; versions?: unknown }
    const distTags = record['dist-tags']
    const latest = distTags !== null && typeof distTags === 'object' && typeof (distTags as { latest?: unknown }).latest === 'string'
      ? (distTags as { latest: string }).latest
      : ''
    const versions = record.versions !== null && typeof record.versions === 'object' ? record.versions as object : {}
    return { name, latest, hasTarget: Object.prototype.hasOwnProperty.call(versions, target) }
  } catch (error: unknown) {
    return { name, error: transportErrorText(error) }
  }
}

/**
 * The registry base URL. `DSH_AUTO_UPDATE_NPM_REGISTRY_BASE` overrides it so
 * fixture tests can point at a local stub instead of the public registry.
 */
function registryBase(): string {
  const override = process.env.DSH_AUTO_UPDATE_NPM_REGISTRY_BASE?.trim() ?? ''
  const base = override === '' ? DEFAULT_REGISTRY_BASE : override
  return base.endsWith('/') ? base.slice(0, -1) : base
}

/** Collect `package.json` names under `dir`, skipping vendored/generated trees. */
function collectManifestNames(dir: string, names: string[]): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue
      collectManifestNames(path, names)
    } else if (entry.name === 'package.json') {
      const name = manifestName(path)
      if (name !== undefined) names.push(name)
    }
  }
}

/** Read one `package.json` file's `name`. */
function manifestName(path: string): string | undefined {
  const content = readFileSyncSafe(path)
  if (content === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(content)
    if (parsed === null || typeof parsed !== 'object') return undefined
    const value = (parsed as { name?: unknown }).name
    if (typeof value !== 'string') return undefined
    const name = value.trim()
    return name === '' ? undefined : name
  } catch {
    return undefined
  }
}

/** Read a text file, or `undefined` when it is missing/unreadable. */
function readFileSyncSafe(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** A readable network failure: the thrown message plus its underlying cause. */
function transportErrorText(error: unknown): string {
  const base = error instanceof Error ? error.message : String(error)
  const cause = error instanceof Error && error.cause !== undefined
    ? (error.cause instanceof Error ? error.cause.message : String(error.cause))
    : undefined
  return cause !== undefined && cause !== '' && !base.includes(cause) ? `${base}（${cause}）` : base
}
