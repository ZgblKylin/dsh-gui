/**
 * Reaping remote processes left behind by an abrupt application exit.
 *
 * A record only ever names a process group this plugin started, and the remote
 * check verifies both that the group still exists and that its command line looks
 * like one of ours before signalling it. A recycled pgid therefore costs nothing:
 * the mismatch is reported and the record is dropped without touching the process.
 * Nothing here ever enumerates or kills `bin.js web` in general — a user may be
 * running their own instances on the same host.
 */

import { quotePosix, runSsh } from './ssh.ts'
import { readRemoteRecords, writeRemoteRecords, type RemoteProcessRecord } from './records.ts'
import type { RemoteLogger } from './types.ts'

/** Wall-clock budget of one reap command; the remote side sleeps 1s before `SIGKILL`. */
const REAP_TIMEOUT_MS = 15000

/** Prefix of the single machine-readable line the reap script prints. */
export const REAP_MARKER = 'TABS_REAP='

/** Outcome of one reap attempt. */
export type ReapOutcome = 'killed' | 'absent' | 'foreign' | 'invalid' | 'failed'

/**
 * Build the remote script that reaps one recorded group.
 *
 * `bin.js web` and `harness` are the two command families a launch can end up as
 * (the built-in command runs the CLI directly; the `npm run harness` preset runs
 * the repository script), so matching them keeps a recycled pgid safe.
 * @param pgid - recorded remote process group.
 * @returns the remote shell script.
 */
export function reapScript(pgid: number): string {
  return [
    `tabs_g=${quotePosix(String(pgid))}`,
    'if [ "$tabs_g" -gt 1 ] 2>/dev/null; then :; else printf "' + REAP_MARKER + 'invalid\\n"; exit 0; fi',
    'tabs_alive=$(ps -eo pgid=,args= 2>/dev/null | awk -v g="$tabs_g" \'$1==g\')',
    'if [ -z "$tabs_alive" ]; then printf "' + REAP_MARKER + 'absent\\n"; exit 0; fi',
    'case "$tabs_alive" in *"bin.js web"*|*harness*) ;; *) printf "' + REAP_MARKER + 'foreign\\n"; exit 0 ;; esac',
    'kill -TERM -$tabs_g 2>/dev/null',
    'sleep 1',
    'if kill -0 -$tabs_g 2>/dev/null; then kill -KILL -$tabs_g 2>/dev/null; fi',
    'printf "' + REAP_MARKER + 'killed\\n"',
  ].join('\n')
}

/**
 * Reap one recorded group on its host.
 * @param record - the recorded process.
 * @param logger - optional sink for diagnostics.
 * @returns the outcome; `failed` means the check could not run (the record is still dropped by the caller).
 */
export async function reapRemoteProcess(record: RemoteProcessRecord, logger?: RemoteLogger): Promise<ReapOutcome> {
  try {
    const run = runSsh(record.host, reapScript(record.pgid), { timeoutMs: REAP_TIMEOUT_MS })
    const { stdout } = await run.done
    const match = /TABS_REAP=(\w+)/.exec(stdout)
    const outcome = match?.[1]
    if (outcome === 'killed' || outcome === 'absent' || outcome === 'foreign' || outcome === 'invalid') return outcome
    logger?.warn(`[dsh-desktop-tabs] could not read the reap result for pgid ${record.pgid} on ${record.host}`)
    return 'failed'
  } catch (error: unknown) {
    logger?.warn(`[dsh-desktop-tabs] reaping pgid ${record.pgid} on ${record.host} failed: ${error instanceof Error ? error.message : String(error)}`)
    return 'failed'
  }
}

/**
 * Reap every recorded group and drop the records. Called once when the routes are
 * registered, so leftovers from a previous run are cleaned before the user opens a
 * tab. Records written meanwhile (a connection started during the sweep) survive,
 * because the file is re-read before the survivors are written back.
 * @param dshHome - harness home.
 * @param logger - optional sink for diagnostics.
 */
export async function reapStaleRemoteProcesses(dshHome: string, logger?: RemoteLogger): Promise<void> {
  const records = readRemoteRecords(dshHome)
  const ids = Object.keys(records)
  if (ids.length === 0) return
  for (const id of ids) {
    const record = records[id]
    if (record === undefined) continue
    const outcome = await reapRemoteProcess(record, logger)
    logger?.info(`[dsh-desktop-tabs] stale remote '${id}' on ${record.host}: ${outcome}`)
  }
  const current = readRemoteRecords(dshHome)
  for (const id of ids) delete current[id]
  writeRemoteRecords(dshHome, current)
}
