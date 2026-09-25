/**
 * Browser Use wrapper: installs the official experimental Playwright MCP
 * browser provider into the web profile.
 *
 * Source — both from npm, no local package:
 *   - `@deepseek-ai/dsh-browser-use`: the exclusive named browser-use provider
 *     registration service (`ctx.browserUse`). Exactly one browser provider
 *     may be registered per deployment.
 *   - `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp`: the
 *     per-Session Chromium browser tools through `@playwright/mcp`. Tools
 *     surface as `mcp__playwright-mcp__<tool>`.
 *
 * Neither package declares `dsh.bundle.patch`, so `dsh plugin add` installs
 * them as plain profile dependencies and this script supplies the insert rows
 * through the shared pipeline's explicit `mount` option — the provider row
 * carries its required `config` (`mode: launch`, `headless: true`). Only the
 * service and the Playwright MCP provider are installed; the Chrome DevTools
 * MCP and Stagehand providers of the same family are not.
 *
 * The versions are pinned to the harness revision this repository builds
 * against: `0.1.7-rc.2` is the dsh-family prerelease whose peers pin the same
 * 0.1.7 family (the browser packages declare exact `0.1.7-rc.2` peers),
 * matching the pinned `dsh-v0.1.7-rc.2` runtime. It is also a prerelease, which
 * is why the Community Market cannot carry it.
 *
 * The provider launches a Chromium binary. The wrapper resolves one at
 * install time from the standard Windows locations (honoring an explicit
 * `DSH_BROWSER_EXECUTABLE` override) and bakes it into the row's
 * `config.executablePath`; when none is found the field is omitted and the
 * provider falls back to upstream browser discovery. `mode: attach` with an
 * `endpoint` is left as a documented edit to the generated row.
 *
 * Mount source: explicit `mount` rows (id `browser-use` /
 * `browser-use-playwright-mcp` with the provider's `config`) via
 * `installNpmPlugin`; neither package declares `dsh.bundle.patch`.
 * Writes only under DSH_HOME (default `<repo>/.dsh`); never to the shipped
 * preset install. This installer lives under `plugins/harness/` — the group
 * of official dsh-family plugins — and is loaded by
 * `plugins/harness/install.mjs`; it also runs standalone.
 *
 * Per-Session browser clients. Until 0.1.6-alpha.2 this wrapper was masked:
 * the provider registered its MCP tools in DSH's shared/global layer, so only
 * ONE live Session per host could hold the namespace and every later Session
 * failed to create. The cause was a second `@deepseek-ai/dsh-scope` module
 * instance in the profile (upstream issue #4573), whose per-module scope tag no
 * host registry recognized. `dsh-scope` became a peer between 0.1.6-alpha.2 and
 * 0.1.7-alpha.1, and the provider now keeps one `SessionResources` entry per
 * live Agent and mounts its MCP client inside that Agent's scope, so each
 * Session gets its own browser client. `mode: launch` is non-exclusive; only
 * `mode: attach` reserves one browser across Sessions, and a Session that
 * cannot have it runs without browser tools instead of failing to open.
 *
 * One contract this wrapper accepts with the unmask: the provider starts the
 * MCP server with `failOnStartupError`, and `agent/created` is a serial event
 * whose listener failure rejects agent creation. A browser that cannot start
 * (no Chromium, a blocked spawn, a broken package) therefore fails that one
 * Session's creation rather than degrading it.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { installNpmPlugin } from '../../scripts/plugin-install.mjs'

/** Wrapper id prefix: the `plugins/<id>/` directory name, used for logs and skip checks. */
const ID = 'browser-use'

const BROWSER_USE_SPEC = '@deepseek-ai/dsh-browser-use@0.1.7-rc.2'
const PLAYWRIGHT_MCP_SPEC = '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp@0.1.7-rc.2'

/**
 * Resolve a Chromium-family executable for the provider's `mode: launch`.
 * Honors `DSH_BROWSER_EXECUTABLE`, else the standard (x64/x86) Chrome and Edge
 * install locations. Returns undefined when nothing is found, so the row omits
 * `executablePath` and the provider uses upstream browser discovery.
 * @returns {string | undefined}
 */
function resolveChromiumExecutable() {
  const override = process.env.DSH_BROWSER_EXECUTABLE
  if (override !== undefined && override !== '') return override
  const programFiles = process.env.ProgramFiles
  const programFilesX86 = process.env['ProgramFiles(x86)']
  const localAppData = process.env.LOCALAPPDATA
  const candidates = []
  for (const root of [programFiles, programFilesX86, localAppData, join(localAppData ?? '', '..', 'Local')]) {
    if (root === undefined || root === '') continue
    candidates.push(join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    candidates.push(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  }
  return candidates.find((candidate) => existsSync(candidate))
}

const executablePath = resolveChromiumExecutable()
const providerConfig =
  executablePath === undefined
    ? { mode: 'launch', headless: true }
    : { mode: 'launch', headless: true, executablePath }

if (executablePath !== undefined) {
  console.log(`  browser-use: resolved Chromium executable at ${executablePath}`)
} else {
  console.log('  browser-use: no system Chromium found — provider row omits executablePath (upstream discovery)')
}

// The core service first: the provider injects `browserUse`.
installNpmPlugin({
  id: ID,
  packageSpec: BROWSER_USE_SPEC,
  mount: { id: 'browser-use', name: '@deepseek-ai/dsh-browser-use' },
})

installNpmPlugin({
  id: `${ID}-playwright-mcp`,
  packageSpec: PLAYWRIGHT_MCP_SPEC,
  mount: {
    id: 'browser-use-playwright-mcp',
    name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp',
    config: providerConfig,
  },
})
