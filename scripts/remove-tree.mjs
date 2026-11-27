/**
 * Link-safe removal for the directory trees this repository owns.
 *
 * `fs.rmSync(path, { recursive: true })` follows a directory link — a Windows
 * junction, or a POSIX directory symlink — when the link is the removed path or
 * sits inside the removed tree. The link's target keeps its directory but loses
 * everything inside it, and nothing later repairs that state.
 *
 * Which targets are at risk here: profiles under `.dsh/profiles/<name>` hold
 * every in-tree plugin as a `link:` dependency, i.e. as a junction into
 * `plugins/<id>/<package>`, so a recursive delete that follows one empties the
 * source package while leaving its directory in place. The reverse direction is
 * the same hazard: the staging worktree under `.staging/` keeps its own runtime
 * home whose profile links back into the main checkout.
 *
 * Every recursive delete in `scripts/` and in the plugin wrappers therefore goes
 * through {@link removeTree}: it unlinks each link entry without visiting its
 * target, and it removes regular directories only after their contents.
 *
 * @module remove-tree
 */

import { chmodSync, lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Errors a scanner, an open handle, or an antivirus filter can produce transiently. */
const TRANSIENT_CODES = new Set(['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM'])

/** Retry attempts used by {@link removeLink}, which callers rarely tune. */
const LINK_RETRIES = 10

/**
 * @typedef {object} RemoveOptions
 * @property {number} [retries] Attempts per entry after the first failure.
 * @property {number} [retryDelayMs] Delay between attempts, in milliseconds.
 */

/**
 * Whether a path names a directory link.
 *
 * Windows reports junctions as symbolic links, so this covers both a junction
 * and a real symlink.
 * @param {string} path - absolute or relative path to inspect.
 * @returns {boolean} true for a junction or symlink, false for a missing path.
 */
export function isLinkPath(path) {
  return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false
}

/**
 * Remove one directory link without visiting what it points at.
 *
 * Use this where the intent is "drop the link": for a `link:` package inside a
 * profile, or for a stale projection a previous install left behind.
 * @param {string} path - path of the link itself.
 * @returns {boolean} whether a link was removed.
 * @throws {Error} when the path exists and is not a link, so a caller that
 *   expected a link never deletes real data.
 */
export function removeLink(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat === undefined) return false
  if (!stat.isSymbolicLink()) {
    throw new Error(`remove-tree: ${path} is not a directory link`)
  }
  unlinkEntry(path, LINK_RETRIES, 50)
  return true
}

/**
 * Remove a file or a directory tree without following any link inside it.
 *
 * A missing path is a no-op, matching `fs.rmSync(..., { force: true })`.
 * @param {string} path - path to remove.
 * @param {RemoveOptions} [options] - retry policy for transient Windows errors.
 * @returns {boolean} whether anything was removed.
 */
export function removeTree(path, options = {}) {
  const { retries = 0, retryDelayMs = 100 } = options
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat === undefined) return false
  removeEntry(path, stat, retries, retryDelayMs)
  return true
}

/**
 * Whether a path is reached through a directory link.
 *
 * A delete below such a path lands in the link's target tree. Callers that
 * remove a path relative to an owned root use this to refuse the operation
 * instead of guessing.
 * @param {string} root - start of the owned tree.
 * @param {string} target - path to check; must lie below `root`.
 * @returns {boolean} true when a component strictly between `root` and `target`
 *   is a link.
 * @throws {Error} when `target` is not inside `root`.
 */
export function hasLinkedAncestor(root, target) {
  const rootPath = resolve(root)
  const targetPath = resolve(target)
  const rest = relative(rootPath, targetPath)
  if (rest === '..' || rest.startsWith(`..${sep}`) || isAbsolute(rest)) {
    throw new Error(`remove-tree: ${targetPath} is not inside ${rootPath}`)
  }
  let current = rootPath
  const parts = rest === '' ? [] : rest.split(sep)
  for (const part of parts.slice(0, -1)) {
    current = join(current, part)
    if (isLinkPath(current)) return true
  }
  return false
}

/**
 * Dispatch one entry by its own type.
 * @param {string} path - entry to remove.
 * @param {import('node:fs').Stats} stat - the entry's own lstat result.
 * @param {number} retries - attempts per entry.
 * @param {number} retryDelayMs - delay between attempts.
 */
function removeEntry(path, stat, retries, retryDelayMs) {
  if (stat.isSymbolicLink()) {
    unlinkEntry(path, retries, retryDelayMs)
    return
  }
  if (!stat.isDirectory()) {
    unlinkFile(path, retries, retryDelayMs)
    return
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    // A Dirent from a network or filter-backed filesystem can misreport links,
    // so the decision is made from a fresh lstat instead of the entry type.
    const childStat = lstatSync(child, { throwIfNoEntry: false })
    if (childStat === undefined) continue
    removeEntry(child, childStat, retries, retryDelayMs)
  }
  attempt(() => rmdirSync(path), retries, retryDelayMs)
}

/**
 * Unlink a link entry, falling back to `rmdir` where Windows refuses `unlink`.
 * @param {string} path - link to remove.
 * @param {number} retries - attempts.
 * @param {number} retryDelayMs - delay between attempts.
 */
function unlinkEntry(path, retries, retryDelayMs) {
  attempt(() => {
    try {
      unlinkSync(path)
    } catch (error) {
      // A junction answers EPERM/EISDIR on unlink in some Node versions; rmdir
      // removes the link itself and never the directory it points at.
      if (error !== null && typeof error === 'object' && ['EACCES', 'EISDIR', 'EPERM'].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? '')) {
        rmdirSync(path)
        return
      }
      throw error
    }
  }, retries, retryDelayMs)
}

/**
 * Unlink a file, clearing the read-only attribute Windows refuses to delete.
 * `fs.rmSync` performs the same fallback, so a tree cleaned by this module stays
 * removable exactly where the standard call removed it.
 * @param {string} path - file to remove.
 * @param {number} retries - attempts.
 * @param {number} retryDelayMs - delay between attempts.
 */
function unlinkFile(path, retries, retryDelayMs) {
  attempt(() => {
    try {
      unlinkSync(path)
    } catch (error) {
      const code = error !== null && typeof error === 'object'
        ? /** @type {NodeJS.ErrnoException} */ (error).code
        : undefined
      if (code !== 'EACCES' && code !== 'EPERM') throw error
      chmodSync(path, 0o666)
      unlinkSync(path)
    }
  }, retries, retryDelayMs)
}

/**
 * Run one filesystem call, retrying the transient failures a scanner or an
 * antivirus filter produces on Windows.
 * @template T
 * @param {() => T} action - the call to attempt.
 * @param {number} retries - attempts after the first failure.
 * @param {number} retryDelayMs - delay between attempts.
 * @returns {T} the call's result.
 */
function attempt(action, retries, retryDelayMs) {
  /** @type {unknown} */
  let lastError
  for (let index = 0; index <= retries; index += 1) {
    try {
      return action()
    } catch (error) {
      lastError = error
      const code = error !== null && typeof error === 'object'
        ? /** @type {NodeJS.ErrnoException} */ (error).code
        : undefined
      if (index === retries || code === undefined || !TRANSIENT_CODES.has(code)) break
      pause(retryDelayMs)
    }
  }
  throw lastError
}

/**
 * Block the current thread, the only wait available to a synchronous remover.
 * @param {number} ms - milliseconds to wait.
 */
function pause(ms) {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
