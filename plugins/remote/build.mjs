/**
 * Build script for the dsh-remote plugin.
 *
 * Emits two artifacts from the source tree:
 *  - `lib/index.js`  — the Node/host half (ESM): registers `/remote-api/*`
 *    HTTP routes on the harness web server and owns local backend spawns,
 *    the credential store, and SSH deployment.
 *  - `lib/client.js` — the browser half (CJS closure): the `window.__ModuleLoader__`
 *    handoff the dsh client module table expects.
 *
 * Everything under `@deepseek-ai/*`, the react family, and node-only runtime
 * packages stays EXTERNAL: at runtime they resolve through the profile's healed
 * `node_modules` fallback (host) or the shell's seeded module table (browser).
 * The host half uses only node: builtins, so nothing extra is inlined.
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

const PLUGIN_ID = 'dsh-remote'

function esbuildBinary() {
  const matches = globSync('node_modules/.pnpm/@esbuild+win32-x64@*/node_modules/@esbuild/win32-x64/esbuild.exe')
  if (matches.length > 0) return matches[0]
  const fallback = globSync('node_modules/@esbuild/win32-x64/esbuild.exe')
  if (fallback.length > 0) return fallback[0]
  throw new Error('esbuild native binary not found — run `pnpm install` first')
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
  '--jsx=automatic',
  ...PLATFORM_EXTERNALS.flatMap(specifier => [`--external:${specifier}`]),
  '--define:process.env.NODE_ENV="production"',
  '--loader:.css=text',
  `--outfile=${clientTmp}`,
])

const body = readFileSync(clientTmp, 'utf8')
const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {\n`
  + 'var module = { exports: {} };\n'
  + 'var exports = module.exports;\n'
const footer = 'return module.exports;\n} });\n'
writeFileSync('lib/client.js', banner + body + footer)
unlinkSync(clientTmp)
