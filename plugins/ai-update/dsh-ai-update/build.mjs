/**
 * Build script for the dsh-ai-update plugin.
 *
 * Emits two artifacts from the source tree:
 *  - lib/index.js  — the Node/host half (ESM): an empty apply so the package
 *    is a real loader entry the client-module scan can pick up.
 *  - lib/client.js — the browser half (CJS closure): the window.__ModuleLoader__
 *    handoff the dsh client module table expects, carrying the postMessage
 *    bridge.
 *
 * Everything under @deepseek-ai/* stays EXTERNAL: at runtime it resolves
 * through the profile's healed node_modules fallback (host) or the shell's
 * seeded module table (browser). The client half only type-imports the
 * platform packages, so nothing extra is inlined either way.
 *
 * The build invokes the native esbuild binary directly (stdio inherit) rather
 * than the JS API: the JS API spawns a service process over a pipe, which the
 * development sandbox denies.
 */
import { spawnSync } from 'node:child_process'
import { globSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'

/** Browser platform modules seeded by the shell's module table (do not inline). */
const PLATFORM_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]

/** Module-table handoff id: the loader entry name (the package name). */
const PLUGIN_ID = 'dsh-ai-update'

function esbuildBinary() {
  // The native binary ships as the `esbuild` package's platform-specific
  // optional dependency `@esbuild/<platform>-<arch>` (e.g. @esbuild/win32-x64,
  // @esbuild/linux-x64). It lives at the package root on Windows
  // (esbuild.exe) and under bin/ on Unix. pnpm keeps it under
  // node_modules/.pnpm/<pkg>@<ver>/ while a bare install keeps it flat at
  // node_modules/<pkg>/ — check both layouts.
  const platformPkg = `@esbuild/${process.platform}-${process.arch}`
  const relative = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'
  // pnpm virtualizes scoped packages under .pnpm as `@scope+pkg@<ver>`
  // (e.g. @esbuild+win32-x64@0.24.2), while the inner real package keeps the
  // `@scope/pkg` path form — sanitize the pnpm directory name accordingly.
  const pnpmPkg = platformPkg.replaceAll('/', '+')
  for (const pattern of [
    `node_modules/.pnpm/${pnpmPkg}@*/node_modules/${platformPkg}/${relative}`,
    `node_modules/${platformPkg}/${relative}`,
  ]) {
    const matches = globSync(pattern)
    if (matches.length > 0) return matches[0]
  }
  throw new Error(`esbuild native binary not found — run pnpm install first (expected ${platformPkg}/${relative})`)
}

function run(args) {
  const result = spawnSync(esbuildBinary(), args, { stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

mkdirSync('lib', { recursive: true })

run([
  'src/index.ts',
  '--bundle',
  '--format=esm',
  '--platform=node',
  '--target=node22',
  '--external:@deepseek-ai/*',
  '--outfile=lib/index.js',
])

const clientTmp = 'lib/client.tmp.js'
run([
  'src/client/index.ts',
  '--bundle',
  '--format=cjs',
  '--platform=browser',
  '--target=es2020',
  ...PLATFORM_EXTERNALS.flatMap(specifier => [`--external:${specifier}`]),
  '--define:process.env.NODE_ENV="production"',
  `--outfile=${clientTmp}`,
])

const body = readFileSync(clientTmp, 'utf8')
const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {
`
  + 'var module = { exports: {} };\n'
  + 'var exports = module.exports;\n'
const footer = 'return module.exports;\n} });\n'
writeFileSync('lib/client.js', banner + body + footer)
unlinkSync(clientTmp)
