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
 * carries its required `config` (`mode: launch`, `headless: true`). This is
 * the first wrapper to use explicit `mount`/`config` (the sibling Agent Teams
 * and Auto review packages self-mount through their own bundle layers). Only
 * the service and the Playwright MCP provider are installed; the Chrome
 * DevTools MCP and Stagehand providers of the same family are not.
 *
 * The versions are pinned to the harness revision this repository builds
 * against: `0.1.6-alpha.2` is the dsh-family prerelease whose peerDependencies
 * all point at `^0.1.6-alpha.2`, matching the pinned `dsh-v0.1.6-alpha.2`
 * runtime. It is also a prerelease, which is why the Community Market cannot
 * carry it.
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
 * Default install state: SKIPPED pending an upstream fix. The Playwright MCP
 * provider mounts a per-Session mcp-client but its tools, `mcp:playwright-mcp`
 * prompt section, and `playwright-mcp` resource server all land in DSH's
 * shared/global registration layer, so only ONE live Session per host can
 * hold the namespace; any second Session (new or resumed) throws
 * "already registered" and session create/resume rolls back. The two
 * installNpmPlugin calls carry `skip` and still record the packages for the
 * update checker. Restore when the upstream provider registers per-agent (or
 * uses a unique serverName); `DSH_PLUGIN_FORCE_INSTALL=1` overrides this
 * wrapper's default.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { installNpmPlugin, skipInstall } from '../../scripts/plugin-install.mjs'

/** Wrapper id prefix: the `plugins/<id>/` directory name, used for logs and skip checks. */
const ID = 'browser-use'

const BROWSER_USE_SPEC = '@deepseek-ai/dsh-browser-use@0.1.6-alpha.2'
const PLAYWRIGHT_MCP_SPEC = '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp@0.1.6-alpha.2'

/** Default skip reason (see the header): collides on the shared registration layer for a second live Session. */
const SKIP_REASON = 'Playwright MCP per-Session registration collides on the shared layer for a second live Session (upstream mountSessionMcp limitation); disabled until upstream fix'

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

// Resolve the Chromium path only when this wrapper actually installs. When
// skipped (the default) the shared pipeline logs the skip and records the
// packages for the update checker; DSH_PLUGIN_FORCE_INSTALL=1 overrides.
let providerConfig
if (!skipInstall(ID, SKIP_REASON)) {
  const executablePath = resolveChromiumExecutable()
  providerConfig =
    executablePath === undefined
      ? { mode: 'launch', headless: true }
      : { mode: 'launch', headless: true, executablePath }

  if (executablePath !== undefined) {
    console.log(`  browser-use: resolved Chromium executable at ${executablePath}`)
  } else {
    console.log('  browser-use: no system Chromium found — provider row omits executablePath (upstream discovery)')
  }
}

// The core service first: the provider injects `browserUse`.
installNpmPlugin({
  id: ID,
  packageSpec: BROWSER_USE_SPEC,
  mount: { id: 'browser-use', name: '@deepseek-ai/dsh-browser-use' },
  skip: SKIP_REASON,
})

installNpmPlugin({
  id: `${ID}-playwright-mcp`,
  packageSpec: PLAYWRIGHT_MCP_SPEC,
  mount: {
    id: 'browser-use-playwright-mcp',
    name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp',
    ...providerConfig === undefined ? {} : { config: providerConfig },
  },
  skip: SKIP_REASON,
})