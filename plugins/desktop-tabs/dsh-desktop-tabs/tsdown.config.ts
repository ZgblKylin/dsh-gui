/**
 * tsdown build for dsh-desktop-tabs.
 *
 * Emits two artifacts from the source tree:
 *  - `lib/index.js`  — the host half (ESM): registers `/desktop-tabs/api/tabs`
 *    on the harness web server and answers it from
 *    `<DSH_HOME>/gui/desktop-tabs.json`.
 *  - `lib/client.js` — the browser half (CJS closure factory): the
 *    `window.__ModuleLoader__.load({ id, factory })` handoff the dsh client
 *    module table expects.
 *
 * Platform packages (`@deepseek-ai/*`, the react family) stay EXTERNAL in both
 * halves: at runtime they resolve through the profile's healed `node_modules`
 * fallback (host) or the shell's seeded module table (browser). The browser half
 * imports no runtime dependency — it only names the Cordis client-context type,
 * which is erased — so the external list is the same baseline every dynamic
 * client bundle uses.
 */
import type { UserConfig } from 'tsdown'

/** Module-table handoff id: the loader entry name (the package name). */
const id = 'dsh-desktop-tabs'

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
    // Every @deepseek-ai/* edge is a type-only or platform import: it resolves
    // at runtime through the profile's node_modules fallback.
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
      alwaysBundle: (source: string) => !CLIENT_EXTERNALS.includes(source),
    },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    inputOptions: {
      resolve: { conditionNames: ['browser', 'import', 'require', 'default'] },
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
