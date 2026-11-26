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
 *
 * A second question was added with the npm plugin rows (see `./plugin-specs.ts`):
 * which version the registry currently publishes for one exact package name.
 * {@link npmPackageLatest} asks the `<name>/latest` document for those rows,
 * reusing the same bounded phase. That document also carries the package's
 * `repository`, from which {@link githubReleasesUrl} builds the Releases link
 * the dialog shows.
 *
 * The registry's newest version is not necessarily one an update can install:
 * pnpm refuses a release younger than its `minimumReleaseAge` (24 h by default)
 * unless the profile overrides it, so a version published minutes ago would
 * show an update the install step silently skips. The plugin rows therefore
 * target the *installable* version: the highest version published before the
 * window closed, capped at the `latest` dist-tag. {@link npmPackageLatest} reads
 * the full packument to find it, and keeps the `<name>/latest` answer whenever
 * the packument cannot be read — a row may then overstate a young release, but
 * it never hides an older one.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { dshHomeDir, isDirectory, packageName } from './paths.ts'
import { compareVersions, isNewerVersion } from './version.ts'

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
/**
 * Accept type for the `/<pkg>/latest` document.
 *
 * That endpoint answers one full manifest. The abbreviated install type above
 * is rejected with HTTP 406 by the public npm registry on it, and the full
 * document is also the only one that carries `repository` for the row's
 * Releases link; the response stays small because it holds a single version.
 */
const LATEST_ACCEPT_HEADER = 'application/json'
const USER_AGENT = 'dsh-gui-update-check'

/**
 * Environment variable holding the publish window of a plugin row's update
 * target, in hours. Fixture tests lower it to zero to accept any release.
 */
const MIN_AGE_ENV = 'DSH_PLUGIN_MIN_AGE_HOURS'

/** Publish window used when {@link MIN_AGE_ENV} is absent or unusable. */
const DEFAULT_MIN_AGE_HOURS = 24

/** Milliseconds in one hour; the publish window is expressed in hours. */
const HOUR_MS = 3_600_000

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

/** One package's registry `latest` answer, as the npm plugin rows consume it. */
export interface PackageLatestInfo {
  /** The requested package name. */
  name: string
  /**
   * The version an update may install: the newest release already older than
   * the publish window (see {@link MIN_AGE_ENV}), never above the registry's
   * `latest` dist-tag. Absent when the request failed.
   */
  latest?: string
  /** The manifest's repository URL, when it declares one. */
  repositoryUrl?: string
  /** A readable per-package failure; the other packages are unaffected. */
  error?: string
}

/** One package's probe outcome, before it is mapped to a name. */
type LatestProbe =
  | { name: string; latest: string; repositoryUrl?: string }
  | { name: string; error: string; transport: boolean }

/** A version plus the manifest `repository` the packument records for it. */
interface ReleaseVersion {
  version: string
  repositoryUrl?: string
}

/** The packument fields the publish window reads. */
interface PackumentView {
  /** The packument's own `dist-tags.latest`. */
  latestTag: string
  /** Publication time per version (`created` and `modified` included). */
  time: Record<string, unknown>
  /** Every published version's manifest, keyed by version. */
  versions: Record<string, unknown>
}

/**
 * Query the registry for every package in one bounded phase, answering the
 * version an update may install.
 *
 * Each probe requests `<registry>/<encodeURIComponent(name)>/latest`, whose body
 * is the current version's own manifest: `version` is the release the row
 * compares against and `repository` gives the project URL the dialog links.
 * When that release is not newer than the installed version, it is already the
 * answer and the probe stops there.
 *
 * Every other package is read once more, as the full packument
 * `<registry>/<name>`: `time` carries each version's publication instant, so the
 * probe picks the highest version published at least the window's age ago and
 * never above the `dist-tags.latest` cap. A package whose every version is
 * younger than the window answers `dist-tags.latest`, so a fresh release still
 * shows up as an update; a packument that cannot be read falls back to the
 * `<name>/latest` answer for the same reason. The repository URL prefers the
 * chosen version's own manifest, then the `latest` document's.
 *
 * The phase reuses the publish-check scheduling: at most
 * {@link PROBE_CONCURRENCY} probes in flight, the first probe starts alone (a
 * registry that is down costs exactly one attempt), the first transport failure
 * trips the phase, and the whole phase stops at {@link PHASE_BUDGET_MS}. A
 * non-2xx answer or an unparseable body is a registry answer, not a transport
 * failure, and only fails that one package.
 *
 * @param names - npm package names, one probe per entry (duplicates included).
 * @param installed - version installed per package name; a package the registry
 *   already lists at that version answers without the packument request, and a
 *   name without an entry counts as not installed (any release is an update).
 * @returns one answer per requested name, in the same order.
 */
export async function npmPackageLatest(
  names: readonly string[],
  installed?: Readonly<Record<string, string>>,
): Promise<PackageLatestInfo[]> {
  if (names.length === 0) return []
  const outcomes: Array<LatestProbe | undefined> = new Array(names.length)
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
      if (index >= names.length) return
      const name = names[index]!
      const controller = new AbortController()
      controllers.add(controller)
      let outcome: LatestProbe
      try {
        outcome = await probeLatest(name, installedVersionOf(installed, name), controller)
      } finally {
        controllers.delete(controller)
      }
      if (budgetExpired) {
        outcome = { name, error: BUDGET_ERROR, transport: false }
      } else if (failure !== undefined && 'error' in outcome && outcome.transport) {
        // Aborted by the breaker: reuse the text the breaker recorded.
        outcome = { name, error: failure, transport: true }
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
    for (let launched = 1; launched < Math.min(PROBE_CONCURRENCY, names.length); launched += 1) {
      workers.push(worker())
    }
    await Promise.all(workers)
  } finally {
    clearTimeout(budget)
  }

  return names.map((name, index) => {
    const outcome = outcomes[index]
    if (outcome === undefined) {
      // The phase stopped before this probe ran: report the phase failure so the
      // row explains why it has no registry answer.
      return { name, error: failure ?? BUDGET_ERROR }
    }
    if ('error' in outcome) return { name, error: outcome.error }
    const info: PackageLatestInfo = { name, latest: outcome.latest }
    if (outcome.repositoryUrl !== undefined && outcome.repositoryUrl !== '') {
      info.repositoryUrl = outcome.repositoryUrl
    }
    return info
  })
}

/**
 * Probe one package: its `latest` document, then — when that release is newer
 * than the installed version — its packument, from which the installable
 * version is chosen.
 */
async function probeLatest(
  name: string,
  installed: string | undefined,
  controller: AbortController,
): Promise<LatestProbe> {
  const rawDocument = await fetchDocument(
    `${registryBase()}/${encodeURIComponent(name)}/latest`,
    LATEST_ACCEPT_HEADER,
    controller,
  )
  if ('error' in rawDocument) return { name, error: rawDocument.error, transport: rawDocument.transport }
  const raw = readLatestDocument(rawDocument.document)
  // Without a version there is nothing to compare, so the answer is unusable.
  if (raw === undefined) return { name, error: UNPARSEABLE_RESPONSE, transport: false }
  // The registry announces nothing newer than what is installed: the row is not
  // behind whatever the window would say, so the packument is not requested.
  if (installed !== undefined && !isNewerVersion(raw.version, installed)) {
    return latestAnswer(name, raw.version, raw.repositoryUrl)
  }
  const packument = await fetchDocument(
    `${registryBase()}/${encodeURIComponent(name)}`,
    LATEST_ACCEPT_HEADER,
    controller,
  )
  // An unreadable packument is not a failed row: the announced release is shown
  // instead, which at worst offers a version the install step will skip.
  if ('error' in packument) return latestAnswer(name, raw.version, raw.repositoryUrl)
  const installable = installableVersion(packument.document, Date.now() - minAgeHours() * HOUR_MS)
  if (installable === undefined) return latestAnswer(name, raw.version, raw.repositoryUrl)
  return latestAnswer(name, installable.version, installable.repositoryUrl ?? raw.repositoryUrl)
}

/**
 * The version an update may install, from a packument: the newest version
 * published before `cutoff` and not above the `latest` dist-tag. A package whose
 * every version is younger than the window answers `dist-tags.latest`, so a
 * fresh release still shows up as an update.
 *
 * @param document - the packument body.
 * @param cutoff - latest acceptable publication instant, epoch milliseconds.
 * @returns the version, `undefined` when the body carries no usable
 *   `dist-tags.latest`.
 */
function installableVersion(document: unknown, cutoff: number): ReleaseVersion | undefined {
  const view = readPackument(document)
  if (view === undefined) return undefined
  let newest: string | undefined
  for (const [version, published] of Object.entries(view.time)) {
    const at = typeof published === 'string' ? Date.parse(published) : Number.NaN
    if (!Number.isFinite(at) || at > cutoff) continue
    const order = compareVersions(version, view.latestTag)
    // `created`, `modified`, and any other non-version key fail to parse; a
    // version above the `latest` dist-tag is not an install target either.
    if (Number.isNaN(order) || order > 0) continue
    if (newest !== undefined && compareVersions(version, newest) <= 0) continue
    newest = version
  }
  const version = newest ?? view.latestTag
  const manifest = view.versions[version]
  const repositoryUrl = manifest === null || typeof manifest !== 'object'
    ? undefined
    : repositoryUrlOf((manifest as { repository?: unknown }).repository)
  return repositoryUrl === undefined ? { version } : { version, repositoryUrl }
}

/**
 * Read the version and repository out of one `/<pkg>/latest` document.
 * @returns the answer, or `undefined` when the body carries no version.
 */
function readLatestDocument(document: unknown): ReleaseVersion | undefined {
  const record = objectRecord(document)
  if (record === undefined) return undefined
  const version = typeof record.version === 'string' ? record.version.trim() : ''
  if (version === '') return undefined
  const repositoryUrl = repositoryUrlOf(record.repository)
  return repositoryUrl === undefined ? { version } : { version, repositoryUrl }
}

/**
 * Read a packument's `dist-tags.latest`, `time`, and `versions`.
 * @returns the view, or `undefined` when the body names no `latest` tag.
 */
function readPackument(document: unknown): PackumentView | undefined {
  const record = objectRecord(document)
  if (record === undefined) return undefined
  const latest = objectRecord(record['dist-tags'])?.latest
  const latestTag = typeof latest === 'string' ? latest.trim() : ''
  if (latestTag === '') return undefined
  return {
    latestTag,
    time: objectRecord(record.time) ?? {},
    versions: objectRecord(record.versions) ?? {},
  }
}

/** A plain-object view of `value`; `undefined` for null, arrays, and scalars. */
function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** Build one successful probe answer, omitting a missing repository URL. */
function latestAnswer(name: string, latest: string, repositoryUrl: string | undefined): LatestProbe {
  return repositoryUrl === undefined || repositoryUrl === ''
    ? { name, latest }
    : { name, latest, repositoryUrl }
}

/**
 * The publish window in hours: {@link MIN_AGE_ENV} when it holds a non-negative
 * finite number, else {@link DEFAULT_MIN_AGE_HOURS}.
 */
function minAgeHours(): number {
  const raw = process.env[MIN_AGE_ENV]?.trim() ?? ''
  if (raw === '') return DEFAULT_MIN_AGE_HOURS
  const hours = Number(raw)
  return Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_MIN_AGE_HOURS
}

/**
 * The installed version of one package. The lookup reads own properties only,
 * so a package named like an `Object` member has no inherited version.
 * @param installed - installed version per package name.
 * @param name - the package name.
 * @returns the version, or `undefined` when the name has no usable entry.
 */
function installedVersionOf(
  installed: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  if (installed === undefined || !Object.prototype.hasOwnProperty.call(installed, name)) return undefined
  const value: unknown = installed[name]
  const version = typeof value === 'string' ? value.trim() : ''
  return version === '' ? undefined : version
}

/** One registry request's outcome: the parsed body, or a readable failure. */
type DocumentResult =
  | { document: unknown }
  | { error: string; transport: boolean }

/**
 * Request one registry JSON document.
 *
 * The per-request budget aborts the same controller the phase aborts, so either
 * budget ends the request. A non-2xx answer or an unparseable body is a registry
 * answer, not a transport failure.
 */
async function fetchDocument(url: string, accept: string, controller: AbortController): Promise<DocumentResult> {
  const timeout = setTimeout(() => { controller.abort() }, REGISTRY_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: { accept, 'user-agent': USER_AGENT },
      signal: controller.signal,
    })
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel()
      return { error: `HTTP ${response.status}`, transport: false }
    }
    try {
      return { document: await response.json() }
    } catch {
      // A 2xx body that is not JSON is a registry response problem, not a
      // transport failure. The failed parse already consumed the body.
      return { error: UNPARSEABLE_RESPONSE, transport: false }
    }
  } catch (error: unknown) {
    return { error: transportErrorText(error), transport: true }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Read a manifest's `repository` field: npm allows a bare URL string or an
 * object with a `url` member (plus optional `type`/`directory`).
 * @returns the trimmed URL, or `undefined` when the field is absent/malformed.
 */
function repositoryUrlOf(field: unknown): string | undefined {
  if (typeof field === 'string') {
    const value = field.trim()
    return value === '' ? undefined : value
  }
  if (field !== null && typeof field === 'object') {
    const url = (field as { url?: unknown }).url
    if (typeof url === 'string') {
      const value = url.trim()
      return value === '' ? undefined : value
    }
  }
  return undefined
}

/**
 * The GitHub Releases **list** page for an npm manifest's `repository` URL.
 *
 * npm records the field in several forms — `git+https://github.com/o/r.git`,
 * `https://github.com/o/r`, `git@github.com:o/r` — and the dialog links the row
 * name to the list the reader can pick a version from. A non-GitHub repository
 * yields `undefined` so the row renders without an external link.
 *
 * @param repositoryUrl - the manifest's repository URL, when it declares one.
 * @returns the Releases list URL, or `undefined` for a missing/non-GitHub URL.
 */
export function githubReleasesUrl(repositoryUrl: string | undefined): string | undefined {
  const value = repositoryUrl?.trim()
  if (value === undefined || value === '') return undefined
  // npm prefixes a git-transport marker (`git+https://…`, `git+ssh://…`).
  let rest = value.startsWith('git+') ? value.slice('git+'.length) : value
  if (rest.startsWith('https://github.com/')) rest = rest.slice('https://github.com/'.length)
  else if (rest.startsWith('http://github.com/')) rest = rest.slice('http://github.com/'.length)
  else if (rest.startsWith('ssh://git@github.com/')) rest = rest.slice('ssh://git@github.com/'.length)
  else if (rest.startsWith('git@github.com:')) rest = rest.slice('git@github.com:'.length)
  else if (rest.startsWith('git://github.com/')) rest = rest.slice('git://github.com/'.length)
  else return undefined
  if (rest.endsWith('.git')) rest = rest.slice(0, -'.git'.length)
  const parts = rest.split('/').filter((part) => part !== '')
  const owner = parts[0]
  const repo = parts[1]
  if (owner === undefined || repo === undefined || owner === '' || repo === '') return undefined
  return `https://github.com/${owner}/${repo}/releases`
}
