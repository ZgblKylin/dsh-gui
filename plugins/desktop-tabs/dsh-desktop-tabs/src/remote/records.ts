/**
 * Durable record of the remote processes this plugin started.
 *
 * A connection normally ends in `down`, which stops the remote process group and
 * forgets it. When the desktop application is killed instead, nothing runs: the
 * remote `dsh web` keeps running and its port stays occupied. The record file is
 * what makes those leftovers recoverable — the next start reads it and reaps the
 * groups that are still alive (see `./reap.ts`).
 *
 * The file lives beside the tab list in `<DSH_HOME>/gui/desktop-tabs-remote.json`
 * and is written atomically; a malformed file degrades to "no records" because
 * losing the record must never break a connection.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** One remote process group this plugin owns. */
export interface RemoteProcessRecord {
  /** SSH destination the process runs behind. */
  readonly host: string
  /** Remote leader pid of the started command. */
  readonly pid: number
  /** Remote process group to signal; always greater than 1. */
  readonly pgid: number
  /** ISO timestamp of the launch, kept for diagnostics. */
  readonly at: string
}

/** Recorded processes keyed by connection id. */
export type RemoteProcessRecords = Record<string, RemoteProcessRecord>

/** @param dshHome - harness home. @returns the record file path. */
export function remoteRecordsPath(dshHome: string): string {
  return join(dshHome, 'gui', 'desktop-tabs-remote.json')
}

/** @returns whether the value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @returns a positive integer, or undefined when the value is not one. */
function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * Read the recorded processes.
 * @param dshHome - harness home.
 * @returns the valid records; a missing, malformed, or half-written file yields `{}`.
 */
export function readRemoteRecords(dshHome: string): RemoteProcessRecords {
  try {
    const parsed: unknown = JSON.parse(readFileSync(remoteRecordsPath(dshHome), 'utf8'))
    const rows = isRecord(parsed) ? parsed.records : undefined
    if (!isRecord(rows)) return {}
    const records: RemoteProcessRecords = {}
    for (const [id, row] of Object.entries(rows)) {
      if (!isRecord(row)) continue
      const host = typeof row.host === 'string' ? row.host.trim() : ''
      const pid = positiveInteger(row.pid)
      const pgid = positiveInteger(row.pgid)
      // A record without a usable group can never be reaped, so it is dropped here.
      if (host === '' || pid === undefined || pgid === undefined || pgid <= 1) continue
      records[id] = { host, pid, pgid, at: typeof row.at === 'string' ? row.at : '' }
    }
    return records
  } catch {
    return {}
  }
}

/**
 * Replace the record file atomically. Failures are swallowed: record keeping is
 * bookkeeping, and a connection must still succeed when the home is not writable.
 * @param dshHome - harness home.
 * @param records - the complete set to persist.
 */
export function writeRemoteRecords(dshHome: string, records: RemoteProcessRecords): void {
  try {
    const path = remoteRecordsPath(dshHome)
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ records }, null, 2)}\n`, 'utf8')
    renameSync(temporary, path)
  } catch {
    // Intentionally ignored; see the function contract.
  }
}

/**
 * Record one launched remote process, keeping every other record.
 * @param dshHome - harness home.
 * @param id - connection id.
 * @param record - the launched process.
 */
export function rememberRemoteProcess(dshHome: string, id: string, record: RemoteProcessRecord): void {
  writeRemoteRecords(dshHome, { ...readRemoteRecords(dshHome), [id]: record })
}

/**
 * Drop one connection's record after its process group was stopped.
 * @param dshHome - harness home.
 * @param id - connection id.
 */
export function forgetRemoteProcess(dshHome: string, id: string): void {
  const records = readRemoteRecords(dshHome)
  if (records[id] === undefined) return
  delete records[id]
  writeRemoteRecords(dshHome, records)
}
