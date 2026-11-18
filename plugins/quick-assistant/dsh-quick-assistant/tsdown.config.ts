/** Build faces: the ESM Host plugin and the browser CJS closure the client loader consumes. */

import type { UserConfig } from 'tsdown'

const id = 'dsh-quick-assistant'

/** Modules the shell seeds; the client bundle must not inline them. */
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

const hostConfig = {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: { neverBundle: [/^@deepseek-ai\//, 'node:'] },
} satisfies UserConfig

const clientConfig = {
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
  inputOptions: { resolve: { conditionNames: ['browser', 'import', 'require', 'default'] } },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
} satisfies UserConfig

export default [hostConfig, clientConfig]
