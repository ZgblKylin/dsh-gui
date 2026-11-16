/**
 * tsdown build for dsh-auto-review-model: the browser half only.
 *
 * The Host half stays the hand-written ESM `index.js` at the package root; this
 * build emits `lib/client.js`, the CJS closure factory the dsh client module
 * table expects. Platform modules stay external and resolve through the shell's
 * seeded module table; the plugin's own sources are bundled in.
 */
import type { UserConfig } from 'tsdown'

/** Module-table handoff id: the loader entry name (the package name). */
const id = 'dsh-auto-review-model'

/** Browser platform modules seeded by the shell's module table (do not inline). */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]

export default {
  entry: { client: 'src/client/index.tsx' },
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
} satisfies UserConfig
