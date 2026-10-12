/**
 * tsdown build for dsh-opencode-session — a host-only ESM plugin.
 *
 * Emits `lib/index.js` from `src/index.ts`. Everything under `@deepseek-ai/*`
 * stays EXTERNAL: at runtime it resolves through the profile's healed
 * `node_modules` fallback, and `node:crypto` is a Node builtin left external by
 * the node platform. The Loader consumes the package through its `exports` map.
 */
import type { UserConfig } from 'tsdown'

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
] satisfies UserConfig[]