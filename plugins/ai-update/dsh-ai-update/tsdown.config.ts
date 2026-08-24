/**
 * tsdown build for dsh-ai-update (replaces the legacy esbuild build.mjs).
 *
 * Emits two artifacts from the source tree, same contract as before:
 *  - `lib/index.js`  — the Node/host half (ESM): an empty apply so the package
 *    is a real loader entry the client-module scan can pick up.
 *  - `lib/client.js` — the browser half (CJS closure factory): the
 *    `window.__ModuleLoader__.load({ id, factory })` handoff the dsh client
 *    module table expects, carrying the postMessage bridge.
 *
 * Everything under `@deepseek-ai/*` stays EXTERNAL: at runtime it resolves
 * through the profile's healed `node_modules` fallback (host) or the shell's
 * seeded module table (browser). The client only type-imports the platform
 * packages, so nothing else is inlined either way.
 */
import type { UserConfig } from 'tsdown'

/** Module-table handoff id: the loader entry name (the package name). */
const id = 'dsh-ai-update'

/** Browser platform modules seeded by the shell's module table (do not inline). */
const CLIENT_EXTERNALS = [
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

export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: [/^@deepseek-ai\//] },
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2020',
    dts: false,
    clean: false,
    deps: {
      neverBundle: [...CLIENT_EXTERNALS],
      alwaysBundle: (source: string) => (CLIENT_EXTERNALS.includes(source) ? false : true),
    },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
