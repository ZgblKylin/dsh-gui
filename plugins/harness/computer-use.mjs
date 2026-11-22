/**
 * Computer Use (Cua Driver native) wrapper: installs the official
 * experimental local-desktop computer-use capability into the web profile.
 *
 * Source — both from npm, no local package:
 *   - `@deepseek-ai/dsh-computer-use`: the exclusive named computer-use
 *     provider registration service (`ctx.computerUse`). Exactly one
 *     computer-use provider may be registered per deployment.
 *   - `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native`: the
 *     provider that embeds the Cua Driver native npm SDK
 *     (`@trycua/cua-driver@0.28.0`, Rust core with per-platform optional
 *     binaries including `win32-x64-msvc`) in the DSH host process, exposing
 *     Cua Driver's own tools under the `cua_driver_native__` prefix. No
 *     separate Cua Driver CLI/app install is required; the owning app must
 *     hold the desktop's permissions, and the native runtime shares the host
 *     process (a native crash can terminate it).
 *
 * Concurrent with the browser-use wrapper: computer use operates the local
 * DESKTOP (windows, apps, screenshots) where browser use operates Chromium
 * pages. This wrapper installs only the native provider; the same family's
 * installed-MCP provider (`@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp`)
 * is not installed, because both register the single `ctx.computerUse` slot
 * and only one may be active.
 *
 * Neither package declares `dsh.bundle.patch`, so `dsh plugin add` installs
 * them as plain profile dependencies. The native provider takes no
 * configuration (its Config schema is empty), so unlike the browser-use
 * provider row this script's insert rows carry only id/name — mounted through
 * the shared pipeline's explicit `mount` option.
 *
 * The versions are pinned to the harness revision this repository builds
 * against: the four packages of this group share the `0.2.3-alpha.2` release
 * and match the pinned `dsh-v0.2.3-alpha.2` runtime. This group is the one npm
 * wrapper set that keeps explicit versions instead of tracking npm `latest`:
 * the specs move in lockstep with the harness and are rewritten by the harness
 * upgrade flow. The admission gate compares every `@deepseek-ai/dsh*` peer
 * against the running version, so the native provider's exact
 * `0.2.3-alpha.2` peers admit only that runtime. The packages are
 * prereleases, which is why the Community Market cannot carry them. In
 * `0.2.3-alpha.2` the family only moves its version and adjusts its brand/error
 * dependencies: the two service packages drop the `@deepseek-ai/dsh-brand` peer
 * and rename the `./brand` export subpath to `./types`, and the native provider
 * takes `@deepseek-ai/dsh-brand` as a dependency plus an
 * `@deepseek-ai/dsh-error` peer that supplies `CuaDriverError`. Package names
 * and mounts are unchanged, and the native provider's empty Config leaves its
 * row without a `config` key.
 *
 * Mount source: explicit `mount` rows (id `computer-use` /
 * `computer-use-cua-driver-native`) via `installNpmPlugin`; neither package
 * declares `dsh.bundle.patch`. Writes only under DSH_HOME (default
 * `<runtime-root>/.dsh`); never to the shipped preset install. This installer lives
 * under `plugins/harness/` — the group of official dsh-family plugins — and
 * is loaded by `plugins/harness/install.mjs`; it also runs standalone.
 */

import { installNpmPlugin } from '../../scripts/plugin-install.mjs'

/** Wrapper id prefix: the `plugins/<id>/` directory name, used for logs and skip checks. */
const ID = 'computer-use'

const COMPUTER_USE_SPEC = '@deepseek-ai/dsh-computer-use@0.2.3-alpha.2'
const CUA_DRIVER_NATIVE_SPEC = '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native@0.2.3-alpha.2'

// The core service first: the provider injects `computerUse`.
await installNpmPlugin({
  id: ID,
  packageSpec: COMPUTER_USE_SPEC,
  mount: { id: 'computer-use', name: '@deepseek-ai/dsh-computer-use' },
})

await installNpmPlugin({
  id: `${ID}-cua-driver-native`,
  packageSpec: CUA_DRIVER_NATIVE_SPEC,
  mount: {
    id: 'computer-use-cua-driver-native',
    name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native',
  },
})
