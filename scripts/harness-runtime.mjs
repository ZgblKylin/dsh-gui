/**
 * Resolve which `dsh` CLI this repository runs, and where its runtime lives.
 *
 * Two runtimes are supported. `harness.json` at the repository root selects one,
 * and environment variables override the file:
 *
 *   npm     install `@deepseek-ai/dsh@<version>` into `<root>/.harness/` and
 *           launch its `lib/bin.js`. Nothing under `deepseek-harness/` is
 *           compiled; the pinned submodule supplies the version tag (and the
 *           upstream sources to consult) instead.
 *   source  build the `deepseek-harness` submodule and launch its
 *           `apps/cli/lib/bin.js`.
 *
 * The same contract is implemented for the Rust shell in
 * `src-tauri/src/harness.rs`; the two must agree on the file, the environment
 * names, and the resolved paths.
 *
 * Overrides: `DSH_HARNESS_RUNTIME` (`npm` | `source`), `DSH_HARNESS_VERSION`
 * (exact npm version), `DSH_HARNESS_INSTALL_DIR` (relative to the repository
 * root, or absolute), `DSH_HARNESS_BIN` (absolute `bin.js` path; highest
 * precedence, the runtime still decides the working directory).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** Repository-root manifest that selects the runtime. */
export const HARNESS_CONFIG_FILE = 'harness.json'
/** The published dsh CLI package. */
export const HARNESS_NPM_PACKAGE = '@deepseek-ai/dsh'
/** Source-mode submodule directory, relative to the repository root. */
export const HARNESS_SUBMODULE = 'deepseek-harness'
/** npm-mode install directory, relative to the repository root. */
export const HARNESS_INSTALL_DIR = '.harness'
/** Pin recorded by a successful source-mode build in `<.dsh>/gui/`. */
export const HARNESS_BUILD_STATE_FILE = 'harness-build.json'

const RUNTIMES = new Set(['npm', 'source'])

/** @param {string} message @returns {never} */
function fail(message) {
  throw new Error(message)
}

/**
 * Read `harness.json`. A missing file is the source runtime with no pinned
 * version, so a checkout that predates the manifest keeps building from source.
 * @param {string} root - repository root.
 * @returns {{ runtime: 'npm' | 'source', version: string | null }}
 */
export function readHarnessConfig(root) {
  const path = join(root, HARNESS_CONFIG_FILE)
  if (!existsSync(path)) return { runtime: 'source', version: null }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`${HARNESS_CONFIG_FILE} is not valid JSON: ${error.message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`${HARNESS_CONFIG_FILE} must hold a JSON object`)
  }
  const runtime = parsed.runtime ?? 'source'
  if (typeof runtime !== 'string' || !RUNTIMES.has(runtime)) {
    fail(`${HARNESS_CONFIG_FILE}: "runtime" must be "npm" or "source" (got ${JSON.stringify(parsed.runtime)})`)
  }
  const version = parsed.version ?? null
  if (version !== null && (typeof version !== 'string' || version.trim() === '')) {
    fail(`${HARNESS_CONFIG_FILE}: "version" must be a non-empty string or null`)
  }
  return { runtime, version: version === null ? null : version.trim() }
}

/**
 * The dsh version the pinned `deepseek-harness` submodule records.
 *
 * Read from `apps/cli/package.json`, not from a git tag: the release contract
 * makes the repository root manifest, `apps/cli`, and every published package of
 * the `dsh` family share one version, and a checkout is pinned to a release tag
 * (`dsh-v0.1.6-alpha.1` -> `0.1.6-alpha.1`). Reading the manifest also keeps this
 * resolution free of a subprocess, which the dsh file sandbox refuses to spawn
 * with piped stdio.
 *
 * @param {string} root - repository root.
 * @returns {string | null}
 */
export function submoduleVersion(root) {
  const manifestPath = join(root, HARNESS_SUBMODULE, 'apps', 'cli', 'package.json')
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const version = parsed?.version
    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    return null
  }
}

/**
 * The commit the pinned submodule checkout records, or null.
 *
 * A detached submodule checkout stores the commit directly in its gitdir
 * `HEAD`, which the submodule's `.git` gitfile points at, so this is two reads
 * and no subprocess. A checkout on a branch (`ref: refs/...`) returns null: the
 * caller then treats the build as stale and rebuilds, which is the safe answer.
 *
 * @param {string} root - repository root.
 * @returns {string | null}
 */
export function submoduleRevision(root) {
  const gitFile = join(root, HARNESS_SUBMODULE, '.git')
  try {
    const pointer = readFileSync(gitFile, 'utf8').trim()
    const match = /^gitdir:\s*(.+)$/.exec(pointer)
    if (match === null) return null
    const gitDir = isAbsolute(match[1]) ? match[1] : resolve(dirname(gitFile), match[1])
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    return /^[0-9a-f]{40}$/i.test(head) ? head : null
  } catch {
    return null
  }
}

/**
 * Resolve the runtime the repository should use.
 *
 * `bin` may be missing (nothing installed yet); callers that need it check
 * `missing` and report `missingHint`. Configuration errors throw.
 *
 * @param {string} root - repository root.
 * @param {NodeJS.ProcessEnv} [env] - environment overrides.
 * @returns {{ runtime: 'npm' | 'source', version: string | null, bin: string,
 *   cwd: string, installDir: string, missing: boolean, missingHint: string }}
 */
export function resolveHarnessRuntime(root, env = process.env) {
  const config = readHarnessConfig(root)
  const runtime = env.DSH_HARNESS_RUNTIME?.trim() || config.runtime
  if (!RUNTIMES.has(runtime)) {
    fail(`DSH_HARNESS_RUNTIME must be "npm" or "source" (got ${JSON.stringify(env.DSH_HARNESS_RUNTIME)})`)
  }
  const installDirValue = env.DSH_HARNESS_INSTALL_DIR?.trim() || HARNESS_INSTALL_DIR
  const installDir = isAbsolute(installDirValue) ? installDirValue : resolve(root, installDirValue)

  const explicitVersion = env.DSH_HARNESS_VERSION?.trim() || config.version
  let version = null
  let bin
  let cwd
  let missingHint
  if (runtime === 'npm') {
    version = explicitVersion ?? submoduleVersion(root)
    if (version === null) {
      fail(
        `${HARNESS_CONFIG_FILE} selects the npm runtime without a version, and no release tag was found in `
        + `${HARNESS_SUBMODULE}/. Pin "version" in ${HARNESS_CONFIG_FILE}, set DSH_HARNESS_VERSION, or initialize the submodule.`,
      )
    }
    bin = join(installDir, 'node_modules', ...HARNESS_NPM_PACKAGE.split('/'), 'lib', 'bin.js')
    cwd = installDir
    missingHint = `run "npm run setup" to install ${HARNESS_NPM_PACKAGE}@${version} into ${installDir}`
  } else {
    version = explicitVersion
    bin = join(root, HARNESS_SUBMODULE, 'apps', 'cli', 'lib', 'bin.js')
    cwd = join(root, HARNESS_SUBMODULE)
    missingHint = 'run "npm run setup" to build the deepseek-harness submodule'
  }
  const override = env.DSH_HARNESS_BIN?.trim()
  if (override !== undefined && override !== '') bin = override
  const missing = !existsSync(bin)
  return { runtime, version, bin, cwd, installDir, missing, missingHint }
}

/**
 * Resolve the runtime and fail with the runtime-specific remedy when the CLI is
 * absent. Every caller that spawns or checks the CLI uses this.
 * @param {string} root - repository root.
 * @param {NodeJS.ProcessEnv} [env] - environment overrides.
 * @returns {ReturnType<typeof resolveHarnessRuntime>}
 */
export function requireHarnessRuntime(root, env = process.env) {
  const resolved = resolveHarnessRuntime(root, env)
  if (resolved.missing) fail(`${HARNESS_NPM_PACKAGE} CLI not found at ${resolved.bin} — ${resolved.missingHint}`)
  return resolved
}

/**
 * The npm install directory as a self-contained pnpm project.
 *
 * `nodeLinker: hoisted` mirrors the profile template so the installed CLI sees
 * one flat `node_modules`, and `storeDir` keeps the repo-local store shared with
 * the rest of the build.
 *
 * `allowBuilds` pins every dependency pnpm 11 would otherwise leave undecided
 * (`ERR_PNPM_IGNORED_BUILDS` writes a non-boolean placeholder and fails the
 * install). Every entry denies a lifecycle script whose payload already ships
 * prebuilt: koffi, node-pty, node-addon-require-builtin, and sharp resolve their
 * binaries from platform packages or `prebuilds/<platform>-<arch>/`, while
 * `@google/genai` and `protobufjs` ship install scripts upstream denies as well.
 * `@deepseek-ai/dsh-subprocess-local` only restores the executable bit on
 * node-pty's macOS/Linux spawn helper, which the registry tarball already
 * carries, so it is denied too — and denying it is also what keeps the install
 * runnable under the dsh file sandbox, which refuses to spawn build scripts
 * (`spawn EPERM`, the same reason the web profile denies node-pty).
 *
 * `DSH_HARNESS_ALLOW_BUILDS` (comma-separated package names) flips the named
 * entries to `true` for an environment that genuinely needs one to run; this
 * file is regenerated on every build, so the variable — not a local edit — is
 * the durable way to change a decision.
 *
 * @param {string} installDir - absolute npm-mode install directory.
 * @param {string} storeDir - absolute repo-local pnpm store.
 * @param {NodeJS.ProcessEnv} [env] - environment overrides.
 */
export function ensureHarnessProject(installDir, storeDir, env = process.env) {
  mkdirSync(installDir, { recursive: true })
  const manifestPath = join(installDir, 'package.json')
  if (!existsSync(manifestPath)) {
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        name: 'dsh-harness-runtime',
        private: true,
        type: 'module',
        description: 'npm-installed dsh CLI the desktop shell launches; generated by scripts/dsh-gui.mjs',
      }, null, 2)}\n`,
    )
  }
  const allowed = new Set(
    (env.DSH_HARNESS_ALLOW_BUILDS ?? '').split(',').map((name) => name.trim()).filter(Boolean),
  )
  const decisions = [
    'koffi',
    'node-pty',
    'node-addon-require-builtin',
    'sharp',
    '@google/genai',
    'protobufjs',
    '@deepseek-ai/dsh-subprocess-local',
  ]
  const workspacePath = join(installDir, 'pnpm-workspace.yaml')
  const body = [
    'packages:',
    '  - .',
    '',
    '# A registry install must materialize the peer edges the source workspace',
    "# satisfies with its own workspace packages (healing `Cannot find package",
    "# '@deepseek-ai/cordis-plugin-group'`); the upstream desktop seed lists every",
    '# core package explicitly instead of enabling auto-install.',
    'nodeLinker: hoisted',
    'autoInstallPeers: true',
    '',
    `storeDir: '${storeDir.replace(/'/g, "''")}'`,
    '',
    'allowBuilds:',
    '  # Every payload ships prebuilt (platform packages or prebuilds/<os>-<arch>),',
    '  # so no lifecycle script has to run. Set DSH_HARNESS_ALLOW_BUILDS=<name>',
    '  # to flip one to true for a host that really needs it.',
    ...decisions.map((name) => `  ${JSON.stringify(name)}: ${allowed.has(name) ? 'true' : 'false'}`),
    '',
  ].join('\n')
  writeFileSync(workspacePath, body)
}
