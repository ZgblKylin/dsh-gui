/**
 * Test-only module resolution for the Host half.
 *
 * The plugin runs inside DSH, whose profile resolver redirects the link
 * package's peer imports to the profile installation. A bare `node --test`
 * process has no such resolver, so tests map the one runtime peer
 * (`@deepseek-ai/schemastery`) to any local DSH installation before importing
 * the plugin. Set `DSH_SCHEMASTERY_PATH` to point at a specific copy.
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `<repo>/plugins/harness/auto-review-model`. */
const PACKAGE_DIR = join(HERE, '..', '..')
/** `<runtime-root>`: the directory holding `.dsh` and `.harness`. */
const RUNTIME_ROOT = join(PACKAGE_DIR, '..', '..', '..', '..')

/**
 * Resolve one package directory from the first local DSH installation that has it.
 * @param {string} name - bare package specifier.
 * @returns {string | undefined} absolute package directory.
 */
function findPackage(name) {
  const roots = [
    process.env.DSH_SCHEMASTERY_PATH,
    join(RUNTIME_ROOT, '.dsh', 'profiles', 'web', 'node_modules'),
    join(RUNTIME_ROOT, '.harness', 'node_modules'),
  ].filter(root => typeof root === 'string' && root !== '')
  for (const root of roots) {
    const candidate = join(root, name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

const SCHEMASTERY_DIR = findPackage('@deepseek-ai/schemastery')
const SCHEMASTERY_ENTRY = SCHEMASTERY_DIR === undefined
  ? undefined
  : createRequire(join(SCHEMASTERY_DIR, 'package.json')).resolve('@deepseek-ai/schemastery')

/**
 * Synchronous resolve hook for `module.registerHooks`.
 * @param {string} specifier - requested specifier.
 * @param {object} context - resolution context.
 * @param {Function} nextResolve - default resolver.
 * @returns {object} resolution result.
 */
export function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/schemastery' && SCHEMASTERY_ENTRY !== undefined) {
    return { url: pathToFileURL(SCHEMASTERY_ENTRY).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
