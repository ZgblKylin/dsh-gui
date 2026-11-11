/**
 * dsh-gui — prefetch the desktop packaging chain's locked primary-runtime assets.
 *
 * `apps/desktop/scripts/prepare-runtime.ts` materializes the packaged Node,
 * Python and wheel set from `scripts/primary-runtime/lock.json`. Its downloader
 * reads whatever sits at `<cache>/<sha256>` and only reaches for the network on a
 * miss — one `fetch` per locked URL, no retry, no mirror switch and no fallback.
 * The official hosts behind those URLs (nodejs.org, the `python-build-standalone`
 * GitHub release, `files.pythonhosted.org`) are exactly the channels this host
 * loses, so a cold cache turns the packaging stage into a coin flip.
 *
 * This script prepares that cache instead: it reads the lock, downloads every
 * asset for one target, verifies the locked SHA-256 and writes the bytes under
 * the key the packaging chain reads. A prepared cache makes the stage a pure
 * local read, and a mismatch can never slip through — the product script checks
 * the same digest again when it consumes the file.
 *
 * Release assets an npm registry mirror publishes (npmmirror's
 * `/-/binary/<project>/` tree) are tried before the official URL; no mirror host
 * is hardcoded, the caller passes the tree it derived from the configured
 * registry. Wheels keep their official PyPI URL unless the caller passes an
 * explicit PyPI file mirror.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

/** Default per-attempt download budget, matching the product script's own default. */
const DEFAULT_TIMEOUT_MS = 300_000
/** Attempts per candidate URL before moving to the next candidate. */
const DEFAULT_RETRIES = 3
/** First retry delay; each further attempt doubles it up to {@link MAX_RETRY_DELAY_MS}. */
const RETRY_DELAY_MS = 1_000
const MAX_RETRY_DELAY_MS = 8_000

/**
 * Official release-asset layouts the lock records, and the mirror tree project
 * that republishes each one.
 *
 * `pattern` captures everything after the project's official prefix; that tail is
 * appended to `<mirror><project>/`. Projects without a mirror entry keep their
 * official URL only.
 */
const MIRROR_LAYOUTS = [
  { project: 'node', pattern: /^https:\/\/nodejs\.org\/dist\/(.+)$/u },
  { project: 'python-build-standalone', pattern: /^https:\/\/github\.com\/astral-sh\/python-build-standalone\/releases\/download\/(.+)$/u },
]

/** PyPI file host the lock records for wheels, rewritten only by an explicit mirror. */
const PYPI_FILE_HOST = 'files.pythonhosted.org'

/**
 * Hash bytes with SHA-256.
 * @param {Buffer} bytes - Content to digest.
 * @returns {string} Lowercase hexadecimal digest.
 */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Wait between download attempts.
 * @param {number} ms - Delay in milliseconds.
 * @returns {Promise<void>} Resolves after the delay.
 */
function sleep(ms) {
  return new Promise((done) => { setTimeout(done, ms) })
}

/**
 * Format a byte count for the build log.
 * @param {number} bytes - Byte count.
 * @returns {string} Human-readable size.
 */
function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${bytes} bytes`
}

/**
 * Resolve the locked release assets one target's payload is assembled from.
 *
 * The URL shapes mirror `scripts/primary-runtime/prepare.ts`: the node archive is
 * named from the lock's `nodeVersion` plus the target's `nodeArchive`, the Python
 * archive from the three locked version parts, and the wheels carry their URL
 * directly. Order follows the product script's download order so a partial run
 * leaves the cache in the state the next run would have reached.
 * @param {object} lock - Parsed primary-runtime lock.
 * @param {string} target - Locked target name, such as `win-x64`.
 * @returns {{ label: string, url: string, sha256: string }[] | undefined} Assets, or undefined when the lock holds no such target.
 */
export function lockedPrimaryRuntimeAssets(lock, target) {
  const artifact = lock?.targets?.[target]
  if (artifact === undefined) return undefined
  for (const field of ['nodeArchive', 'nodeSha256', 'pythonTarget', 'pythonSha256']) {
    if (typeof artifact[field] !== 'string' || artifact[field] === '') {
      throw new Error(`primary runtime download: lock target ${target} has no ${field}`)
    }
  }
  for (const field of ['nodeVersion', 'pythonVersion', 'pythonRelease']) {
    if (typeof lock[field] !== 'string' || lock[field] === '') {
      throw new Error(`primary runtime download: the lock has no ${field}`)
    }
  }
  const nodeFile = `node-v${lock.nodeVersion}-${artifact.nodeArchive}`
  const pythonFile = `cpython-${lock.pythonVersion}+${lock.pythonRelease}-${artifact.pythonTarget}-install_only_stripped.tar.gz`
  const wheels = [...(artifact.wheels ?? []), ...(lock.wheels ?? [])]
  for (const wheel of wheels) {
    if (typeof wheel?.url !== 'string' || typeof wheel?.sha256 !== 'string') {
      throw new Error(`primary runtime download: lock target ${target} has a wheel without url/sha256`)
    }
  }
  return [
    {
      label: `node ${lock.nodeVersion}`,
      url: `https://nodejs.org/dist/v${lock.nodeVersion}/${nodeFile}`,
      sha256: artifact.nodeSha256,
    },
    {
      label: `python ${lock.pythonVersion}+${lock.pythonRelease}`,
      url: `https://github.com/astral-sh/python-build-standalone/releases/download/${lock.pythonRelease}/${encodeURIComponent(pythonFile)}`,
      sha256: artifact.pythonSha256,
    },
    ...wheels.map((wheel) => ({
      label: new URL(wheel.url).pathname.split('/').pop() ?? wheel.url,
      url: wheel.url,
      sha256: wheel.sha256,
    })),
  ]
}

/**
 * Rewrite one official locked URL onto the release-asset mirror that serves it.
 * @param {string} officialUrl - URL recorded by the lock's derivation.
 * @param {string | undefined} mirrorBase - Mirror tree base, such as `https://registry.npmmirror.com/-/binary/`.
 * @returns {string | undefined} Mirror URL, or undefined when the mirror does not serve this asset.
 */
export function mirrorAssetUrl(officialUrl, mirrorBase) {
  if (mirrorBase === undefined || mirrorBase.trim() === '') return undefined
  let base
  try {
    base = new URL(mirrorBase.trim())
  } catch {
    return undefined
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  for (const layout of MIRROR_LAYOUTS) {
    const match = layout.pattern.exec(officialUrl)
    if (match === null) continue
    // Percent-encode every segment: lock file names carry `+` (and may carry spaces).
    // Segments the lock already encoded are decoded first, so `%2B` never becomes `%252B`.
    const tail = match[1].split('/').map((segment) => encodeURIComponent(decodeSegment(segment))).join('/')
    return new URL(`${layout.project}/${tail}`, base).toString()
  }
  return undefined
}

/**
 * Decode one URL path segment, keeping it verbatim when it is not valid encoding.
 * @param {string} segment - Raw path segment.
 * @returns {string} Decoded segment.
 */
function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * Rewrite one PyPI file URL onto an explicitly configured PyPI file mirror.
 *
 * PyPI mirrors keep the pool path (`/packages/<xx>/<yy>/<digest>/<file>`), so the
 * rewrite only moves the origin. The product lock has no registry-derived mirror
 * for this host, which is why the caller has to name one to enable it.
 * @param {string} officialUrl - Locked URL.
 * @param {string | undefined} pypiMirrorBase - PyPI file mirror base.
 * @returns {string | undefined} Mirror URL, or undefined when the asset is not a PyPI file.
 */
export function pypiMirrorAssetUrl(officialUrl, pypiMirrorBase) {
  if (pypiMirrorBase === undefined || pypiMirrorBase.trim() === '') return undefined
  let base
  let official
  try {
    base = new URL(pypiMirrorBase.trim())
    official = new URL(officialUrl)
  } catch {
    return undefined
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  if (official.hostname !== PYPI_FILE_HOST) return undefined
  return new URL(official.pathname.replace(/^\//u, ''), base).toString()
}

/**
 * List every URL worth trying for one asset, best first and free of duplicates.
 * @param {{ url: string }} asset - Locked asset.
 * @param {{ mirror?: string, pypiMirror?: string }} options - Configured mirror trees.
 * @returns {string[]} Candidate URLs; the official URL is always last.
 */
export function assetCandidates(asset, options = {}) {
  const candidates = [
    mirrorAssetUrl(asset.url, options.mirror),
    pypiMirrorAssetUrl(asset.url, options.pypiMirror),
    asset.url,
  ]
  return [...new Set(candidates.filter((candidate) => candidate !== undefined))]
}

/**
 * Read a cached asset when its bytes still match the locked digest.
 * @param {string} destination - Cache file keyed by SHA-256.
 * @param {string} expected - Locked lowercase hexadecimal digest.
 * @returns {number | undefined} Cached byte length, or undefined when the file is absent or stale.
 */
export function cachedAssetSize(destination, expected) {
  let bytes
  try {
    bytes = readFileSync(destination)
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  return sha256(bytes) === expected ? bytes.length : undefined
}

/**
 * Write verified bytes to the cache key atomically.
 *
 * A directly written cache file is indistinguishable from a verified one to the
 * product script only after it is complete, so the bytes land under a unique
 * temporary name and replace the key with one rename.
 * @param {string} destination - Cache file keyed by SHA-256.
 * @param {Buffer} bytes - Verified content.
 */
function writeCacheFile(destination, bytes) {
  const temporary = join(dirname(destination), `.${randomUUID()}`)
  try {
    writeFileSync(temporary, bytes)
    renameSync(temporary, destination)
  } finally {
    rmSync(temporary, { force: true })
  }
}

/** A candidate that served bytes the lock does not describe; retrying it cannot help. */
class ChecksumMismatchError extends Error {}

/** Filesystem failures no retry can clear: the cache directory itself is unusable. */
const FATAL_CACHE_CODES = new Set(['EPERM', 'EACCES', 'ENOSPC', 'EROFS', 'EISDIR', 'ENOTDIR'])

/**
 * Download one asset into the SHA-256 cache, verifying every candidate's bytes.
 *
 * Candidates are tried in order and each gets {@link DEFAULT_RETRIES} attempts
 * with a doubling delay, so a flaky channel is retried while a mirror serving a
 * different revision is skipped by the digest check instead of poisoning the
 * cache. A checksum mismatch moves on to the next candidate at once. A cached
 * asset whose bytes no longer match is dropped and fetched again.
 * @param {{ label: string, url: string, sha256: string }} asset - Locked asset.
 * @param {{ downloads: string, mirror?: string, pypiMirror?: string, fetchImpl?: typeof fetch,
 *   retries?: number, timeoutMs?: number, sleepImpl?: (ms: number) => Promise<void> }} options -
 *   Cache directory, mirror trees and injectable transport for tests.
 * @returns {Promise<{ status: 'cached' | 'downloaded', bytes: number, url?: string }>} Outcome.
 */
export async function ensurePrimaryRuntimeAsset(asset, options) {
  const {
    downloads,
    fetchImpl = globalThis.fetch,
    retries = DEFAULT_RETRIES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sleepImpl = sleep,
  } = options
  mkdirSync(downloads, { recursive: true })
  const destination = join(downloads, asset.sha256)
  const cached = cachedAssetSize(destination, asset.sha256)
  if (cached !== undefined) {
    console.log(`  cached     ${asset.label} (${formatBytes(cached)})`)
    return { status: 'cached', bytes: cached }
  }
  // A stale file would make the product script fail its own check, so drop it.
  rmSync(destination, { force: true })
  const failures = []
  for (const candidate of assetCandidates(asset, options)) {
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        const response = await fetchImpl(candidate, { signal: AbortSignal.timeout(timeoutMs) })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const bytes = Buffer.from(await response.arrayBuffer())
        const digest = sha256(bytes)
        if (digest !== asset.sha256) throw new ChecksumMismatchError(`SHA-256 mismatch: ${digest}`)
        writeCacheFile(destination, bytes)
        console.log(`  downloaded ${asset.label} (${formatBytes(bytes.length)}) <- ${candidate}`)
        return { status: 'downloaded', bytes: bytes.length, url: candidate }
      } catch (error) {
        failures.push(`${candidate} (attempt ${attempt}/${retries}): ${error.cause?.message ?? error.message}`)
        // A rejected write and a deliberately different revision both stay wrong on retry.
        if (error instanceof ChecksumMismatchError) break
        if (FATAL_CACHE_CODES.has(error.code)) {
          throw new Error(`primary runtime download: cannot write ${destination}: ${error.message}`, { cause: error })
        }
        if (attempt < retries) await sleepImpl(Math.min(RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS))
      }
    }
  }
  throw new Error(`primary runtime download: ${asset.label} could not be obtained\n  ${failures.join('\n  ')}`)
}

/**
 * Prepare every locked asset for one target.
 * @param {{ lock: object, target: string, downloads: string, mirror?: string, pypiMirror?: string,
 *   fetchImpl?: typeof fetch, retries?: number, timeoutMs?: number,
 *   sleepImpl?: (ms: number) => Promise<void> }} options - Lock, target and cache location.
 * @returns {Promise<{ assets: number, cached: number, downloaded: number, bytes: number }>} Summary.
 */
export async function ensurePrimaryRuntimeDownloads(options) {
  const assets = lockedPrimaryRuntimeAssets(options.lock, options.target)
  if (assets === undefined) {
    throw new Error(`primary runtime download: the lock holds no ${options.target} target`)
  }
  console.log(`  cache      ${options.downloads}`)
  const summary = { assets: assets.length, cached: 0, downloaded: 0, bytes: 0 }
  for (const asset of assets) {
    const outcome = await ensurePrimaryRuntimeAsset(asset, options)
    summary[outcome.status] += 1
    summary.bytes += outcome.bytes
  }
  return summary
}

/**
 * Load the packaging chain's own path derivation, so the cache this script fills
 * is the directory that chain reads.
 * @param {string} source - Desktop source checkout.
 * @returns {Promise<{ desktopTargetBuildPaths: (target: string) => { downloads: string } }>} Upstream path module.
 */
async function loadBuildPaths(source) {
  const modulePath = join(source, 'apps', 'desktop', 'scripts', 'desktop-build-paths.mjs')
  let module
  try {
    module = await import(pathToFileURL(modulePath).href)
  } catch (error) {
    throw new Error(`primary runtime download: cannot load the packaging chain's build paths from ${modulePath}: ${error.message}`, { cause: error })
  }
  if (typeof module.desktopTargetBuildPaths !== 'function') {
    throw new Error(`primary runtime download: ${modulePath} no longer exports desktopTargetBuildPaths`)
  }
  return module
}

/**
 * Print the assets and the URL each would start from, without touching the cache.
 * @param {{ label: string, url: string }[]} assets - Locked assets.
 * @param {{ mirror?: string, pypiMirror?: string }} options - Configured mirrors.
 */
function printPlan(assets, options) {
  for (const asset of assets) {
    const [first] = assetCandidates(asset, options)
    console.log(`  ${asset.label} <- ${first ?? asset.url}`)
  }
}

/**
 * Run the prefetch from the command line.
 * @param {string[]} argv - Arguments after the script path.
 * @returns {Promise<void>} Resolves after every asset is cached.
 */
export async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      source: { type: 'string' },
      target: { type: 'string' },
      mirror: { type: 'string' },
      'pypi-mirror': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  })
  if (values.source === undefined) throw new Error('usage: primary-runtime-downloads.mjs --source <desktop source checkout> [--target <name>] [--mirror <base>] [--pypi-mirror <base>] [--dry-run]')
  const source = resolve(values.source)
  const buildPaths = await loadBuildPaths(source)
  const target = values.target ?? buildPaths.resolveDesktopBuildTarget?.()
  if (target === undefined) throw new Error('primary runtime download: no target given and the packaging chain does not export resolveDesktopBuildTarget')
  const lockPath = join(source, 'scripts', 'primary-runtime', 'lock.json')
  let lock
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    // A revision without the lock has no primary-runtime payload to prepare.
    console.log(`primary runtime downloads: no ${lockPath} — skipping`)
    return
  }
  const assets = lockedPrimaryRuntimeAssets(lock, target)
  if (assets === undefined) {
    console.log(`primary runtime downloads: the lock holds no ${target} target — skipping`)
    return
  }
  const { downloads } = buildPaths.desktopTargetBuildPaths(target)
  const options = {
    mirror: values.mirror,
    pypiMirror: values['pypi-mirror'],
  }
  console.log(`primary runtime downloads: ${assets.length} locked asset(s) for ${target}`)
  if (values['dry-run']) {
    console.log(`  cache      ${downloads}`)
    printPlan(assets, options)
    return
  }
  const summary = await ensurePrimaryRuntimeDownloads({ lock, target, downloads, ...options })
  console.log(`primary runtime downloads: ${summary.downloaded} downloaded, ${summary.cached} cached (${formatBytes(summary.bytes)})`)
}

/**
 * Whether this module is the process entry point, so importing it for its
 * helpers never runs the CLI.
 * @returns {boolean}
 */
function invokedDirectly() {
  const entry = process.argv[1]
  if (entry === undefined) return false
  const self = fileURLToPath(import.meta.url)
  const normalize = (path) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path))
  return normalize(entry) === normalize(self)
}

if (invokedDirectly()) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(`\n[error] ${error.message}`)
    process.exitCode = 1
  }
}
