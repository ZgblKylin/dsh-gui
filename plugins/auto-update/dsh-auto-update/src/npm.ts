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

/** Per-request budget; the phase budget normally expires first. */
const REGISTRY_TIMEOUT_MS = 15_000

/** Probes running at once inside one npm phase. */
const PROBE_CONCURRENCY = 8

/** Overall budget for one npm phase; the git rows never wait longer than this. */
const PHASE_BUDGET_MS = 10_000

/** Row error written when the phase budget expires with probes still running. */
const BUDGET_ERROR = 'npm 版本核对超时（10 秒预算）'

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
  | { name: string; error: string; transport: boolean }

/** One package to probe on behalf of one row. */
interface ProbeSpec {
  /** Index into the caller's request list. */
  request: number
  name: string
  /** The tag's version, without a leading `v`. */
  target: string
}

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

/** One row's probe request: the packages it installs and the tag being checked. */
export interface NpmRequestSpec {
  packages: string[]
  tag: string
}

/**
 * Probe every requested package across all rows in one bounded phase.
 *
 * Rows are checked in a single pass so a row never waits for another row's
 * registry roundtrips: up to {@link PROBE_CONCURRENCY} probes run at once, and
 * the phase stops at {@link PHASE_BUDGET_MS} whatever the registry does.
 *
 * The phase trips on the first *transport* failure (connect, timeout, DNS):
 * that text becomes every unfinished probe's error and the remaining probes are
 * not waited for. A non-2xx answer or an unparseable body is a registry answer,
 * not a transport failure, and never trips the phase.
 *
 * @param requests - one entry per row, in row order.
 * @returns one aggregated state per request, in the same order.
 */
export async function npmUpdateChecks(requests: readonly NpmRequestSpec[]): Promise<NpmUpdateInfo[]> {
  const probes: ProbeSpec[] = []
  for (const [request, spec] of requests.entries()) {
    const target = spec.tag.startsWith('v') ? spec.tag.slice(1) : spec.tag
    for (const name of spec.packages) probes.push({ request, name, target })
  }
  if (probes.length === 0) {
    return requests.map((spec) => emptyInfo(spec.packages))
  }

  const outcomes: Array<NpmProbe | undefined> = new Array(probes.length)
  const controllers = new Set<AbortController>()
  let budgetExpired = false
  let failure: string | undefined
  let cursor = 0
  let signalFirstSettled: () => void = () => {}
  const firstSettled = new Promise<void>((resolve) => { signalFirstSettled = resolve })
  const budget = setTimeout(() => {
    budgetExpired = true
    for (const controller of controllers) controller.abort()
  }, PHASE_BUDGET_MS)

  const worker = async (): Promise<void> => {
    for (;;) {
      if (failure !== undefined || budgetExpired) return
      const index = cursor
      cursor += 1
      if (index >= probes.length) return
      const spec = probes[index]!
      const controller = new AbortController()
      controllers.add(controller)
      let outcome: NpmProbe
      try {
        outcome = await probe(spec.name, spec.target, controller)
      } finally {
        controllers.delete(controller)
      }
      if (budgetExpired) {
        outcome = { name: spec.name, error: BUDGET_ERROR, transport: false }
      } else if (failure !== undefined && 'error' in outcome && outcome.transport) {
        // Aborted by the breaker: reuse the text the breaker recorded.
        outcome = { name: spec.name, error: failure, transport: true }
      } else if ('error' in outcome && outcome.transport) {
        // The first transport failure stops the phase: no further probe starts,
        // and the probes already in flight are not waited for.
        failure = outcome.error
        for (const other of controllers) other.abort()
      }
      outcomes[index] = outcome
      if (index === 0) signalFirstSettled()
    }
  }

  try {
    // One probe starts alone: a registry that is down must cost exactly one
    // attempt, not one per package. The rest of the pool joins once that first
    // probe has settled without tripping the phase.
    const workers = [worker()]
    await firstSettled
    for (let launched = 1; launched < Math.min(PROBE_CONCURRENCY, probes.length); launched += 1) {
      workers.push(worker())
    }
    await Promise.all(workers)
  } finally {
    clearTimeout(budget)
  }

  return requests.map((spec, request) => {
    const own = probes
      .map((probeSpec, index) => ({ probeSpec, outcome: outcomes[index] }))
      .filter((entry) => entry.probeSpec.request === request)
    if (own.some((entry) => entry.outcome === undefined)) {
      // The phase stopped before this row's probes all ran: the row carries the
      // phase's failure text, never a half-built answer.
      return { packages: spec.packages, latest: {}, missing: [], complete: false, error: failure ?? BUDGET_ERROR }
    }
    return aggregate(spec.packages, own.map((entry) => entry.outcome!))
  })
}

/** A probe that never produced an answer because the phase did not run it. */
function emptyInfo(packages: string[]): NpmUpdateInfo {
  return { packages, latest: {}, missing: [], complete: true }
}

/** Fold one row's probe outcomes into its wire state, preserving package order. */
function aggregate(packages: string[], probes: readonly NpmProbe[]): NpmUpdateInfo {
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
async function probe(name: string, target: string, controller: AbortController): Promise<NpmProbe> {
  // The per-request budget; the phase's own budget aborts the same controller.
  const timeout = setTimeout(() => { controller.abort() }, REGISTRY_TIMEOUT_MS)
  try {
    const response = await fetch(`${registryBase()}/${encodeURIComponent(name)}`, {
      headers: { accept: ACCEPT_HEADER, 'user-agent': USER_AGENT },
      signal: controller.signal,
    })
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel()
      return { name, error: `HTTP ${response.status}`, transport: false }
    }
    let document: unknown
    try {
      document = await response.json()
    } catch {
      // A 2xx body that is not JSON (a proxy or gateway answering with HTML or
      // plain text) is a registry response problem, not a transport failure.
      // The body is already consumed by the failed parse, so it is not cancelled.
      return { name, error: UNPARSEABLE_RESPONSE, transport: false }
    }
    if (document === null || typeof document !== 'object') {
      return { name, error: UNPARSEABLE_RESPONSE, transport: false }
    }
    const record = document as { 'dist-tags'?: unknown; versions?: unknown }
    const distTags = record['dist-tags']
    const latest = distTags !== null && typeof distTags === 'object' && typeof (distTags as { latest?: unknown }).latest === 'string'
      ? (distTags as { latest: string }).latest
      : ''
    const versions = record.versions !== null && typeof record.versions === 'object' ? record.versions as object : {}
    return { name, latest, hasTarget: Object.prototype.hasOwnProperty.call(versions, target) }
  } catch (error: unknown) {
    return { name, error: transportErrorText(error), transport: true }
  } finally {
    clearTimeout(timeout)
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
