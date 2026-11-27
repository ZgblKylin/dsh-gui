/**
 * Link-safe removal for a remote tab's child home.
 *
 * A child home holds `profiles/remote-tab/node_modules` as a junction to the
 * hosting profile's dependency tree (see `./profile.ts`). `fs.rmSync(path,
 * { recursive: true })` does not unlink a junction on Windows: it enters the
 * target and deletes its contents, keeping the target directory itself. Under
 * the Electron runtime this plugin runs in, forgetting a remote tab therefore
 * emptied the hosting profile's `node_modules` — every bundle of the parent
 * profile stopped resolving on the next start, with the directory still in place
 * and nothing in the logs.
 *
 * {@link removeTree} unlinks every link entry without visiting its target, so a
 * child home can be deleted while the parent profile it borrowed from stays
 * intact.
 *
 * @module remote-tab/remove-tree
 */

import { lstatSync, readdirSync, rmdirSync, unlinkSync, type Stats } from 'node:fs'
import { join } from 'node:path'

/**
 * Remove a file or a directory tree without following any link inside it.
 * @param path - path to remove.
 * @returns whether anything was removed; a missing path is a no-op.
 */
export function removeTree(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat === undefined) return false
  removeEntry(path, stat)
  return true
}

/**
 * Dispatch one entry by its own type.
 * @param path - entry to remove.
 * @param stat - the entry's own `lstat` result.
 */
function removeEntry(path: string, stat: Stats): void {
  if (stat.isSymbolicLink()) {
    unlinkEntry(path)
    return
  }
  if (!stat.isDirectory()) {
    unlinkSync(path)
    return
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    const childStat = lstatSync(child, { throwIfNoEntry: false })
    if (childStat === undefined) continue
    removeEntry(child, childStat)
  }
  rmdirSync(path)
}

/**
 * Unlink a link entry, falling back to `rmdir` where Windows refuses `unlink`.
 * @param path - junction or symlink to remove.
 */
function unlinkEntry(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EACCES' && code !== 'EISDIR' && code !== 'EPERM') throw error
    rmdirSync(path)
  }
}
