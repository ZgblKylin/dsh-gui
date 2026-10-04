/**
 * Normalisation of the callback rows the manager resolves by id.
 *
 * The callback may answer with a plain tab array or with the host half's
 * `{ tabs, connections }` pair; both become one row per id here, so the manager
 * reads a single list regardless of which shape the host half injects.
 */

import type { SshSpec } from './config.ts'
import type { RemoteTab, RemoteTargetPair, RemoteTargetSource } from './types.ts'

/**
 * Flatten a callback result into one row per id.
 *
 * A plain array is taken as-is. In the `{ tabs, connections }` form both lists are
 * merged per field with the `connections` row winning, so a saved connection
 * cannot be hidden by a tab row that only carries a resolved `url`.
 * @param source - callback result.
 * @returns the rows to resolve by id, in first-appearance order.
 */
export function mergeTargetRows(source: RemoteTargetSource): RemoteTab[] {
  const byId = new Map<string, RemoteTab>()
  for (const row of sourceRows(source)) {
    const id = row.id.trim()
    if (id === '') continue
    const previous = byId.get(id)
    byId.set(id, previous === undefined ? { ...row, id } : { ...previous, ...definedFields(row) })
  }
  return [...byId.values()]
}

/** The rows of a callback result, whichever accepted form it used. */
function sourceRows(source: RemoteTargetSource): readonly RemoteTab[] {
  if (isTargetPair(source)) return [...(source.tabs ?? []), ...(source.connections ?? [])]
  return source
}

/** Whether the callback answered with the `{ tabs, connections }` pair. */
function isTargetPair(source: RemoteTargetSource): source is RemoteTargetPair {
  return !Array.isArray(source)
}

/** The launch fields of one row that are actually present, for the per-field merge. */
function definedFields(row: RemoteTab): Partial<RemoteTab> {
  const out: {
    title?: string
    url?: string
    ssh?: SshSpec
    workdir?: string
    startCommand?: string
  } = {}
  if (row.title !== undefined) out.title = row.title
  if (row.url !== undefined) out.url = row.url
  if (row.ssh !== undefined) out.ssh = row.ssh
  if (row.workdir !== undefined) out.workdir = row.workdir
  if (row.startCommand !== undefined) out.startCommand = row.startCommand
  return out
}
