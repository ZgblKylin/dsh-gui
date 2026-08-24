#!/usr/bin/env node
/**
 * harness — run the built dsh CLI directly against the repo-local home,
 * without the desktop shell or the web UI. The GUI (`dsh-gui.exe` / `npm
 * start`) boots the harness `web` profile inside its own window; this script
 * instead drives the same CLI entry (`deepseek-harness/apps/cli/lib/bin.js`)
 * with `DSH_HOME` pinned to the repo's `.dsh`, so nothing listens on a port
 * and no browser window opens.
 *
 * Arguments are forwarded verbatim to the CLI from the repository root (the
 * agent's working directory), so:
 *
 *   npm run harness -- "run the tests"                 one-shot headless task
 *   npm run harness -- --profile headless "ask X"      explicit profile form
 *   npm run harness -- plugin --profile web add <pkg>  manage plugins (no UI)
 *   npm run harness -- --profile web --dump-config     inspect the composed tree
 *
 * With no arguments it boots the headless app's own help so the command never
 * silently starts anything.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { HARNESS, ROOT, WEB_HOME } from './toolchain.mjs'

const bin = join(HARNESS, 'apps', 'cli', 'lib', 'bin.js')
if (!existsSync(bin)) {
  console.error(`harness is not built: ${bin} is missing — run "npm run setup" first`)
  process.exit(1)
}

const argv = process.argv.slice(2)
const args = argv.length > 0 ? argv : ['--profile', 'headless', '--help']

const result = spawnSync('node', [bin, ...args], {
  cwd: ROOT,
  env: { ...process.env, DSH_HOME: WEB_HOME },
  stdio: 'inherit',
})
if (result.error) {
  console.error(`failed to spawn harness: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
