/**
 * Unit tests for the install-script scanner that feeds the npm plugin rows.
 *
 * A fixture checkout is created per case under the OS temp directory, so the
 * scanner runs against a controlled `plugins/` tree instead of this repository.
 * The scanning contract: only scripts calling `installNpmPlugin` contribute,
 * comments never contribute, official `@deepseek-ai/dsh*` packages are skipped,
 * and one package yields exactly one row.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { listPluginNpmRows } from '../src/plugin-specs.ts'

/** Create a throwaway checkout root for one case. */
function makeRoot(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-auto-update-specs-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/** Write one file under the fixture root, creating parent directories. */
function write(root: string, relative: string, content: string): void {
  const path = join(root, ...relative.split('/'))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

test('a literal packageSpec becomes one row', async (t) => {
  const root = makeRoot(t)
  write(root, 'plugins/alpha/install.mjs', [
    "import { installNpmPlugin } from '../../scripts/plugin-install.mjs'",
    "installNpmPlugin({ id: 'alpha', packageSpec: 'dsh-alpha@1.2.3' })",
    '',
  ].join('\n'))

  assert.deepEqual(await listPluginNpmRows(root), [{
    id: 'npm:dsh-alpha',
    packageName: 'dsh-alpha',
    installScript: 'plugins/alpha/install.mjs',
    wrapperId: 'alpha',
    pinnedVersion: '1.2.3',
    spec: 'dsh-alpha@1.2.3',
  }])
})

test('constant, array and scoped specs are parsed, each package once', async (t) => {
  const root = makeRoot(t)
  write(root, 'plugins/beta/install.mjs', [
    "import { installNpmPlugin } from '../../scripts/plugin-install.mjs'",
    "const PACKAGE_SPEC = 'dsh-beta@0.3.8'",
    "const SKIN_SPECS = [",
    "  '@scope/dsh-skin-a@0.1.9',",
    "  '@scope/dsh-skin-b@0.1.9',",
    ']',
    'installNpmPlugin({ id: ID, packageSpec: PACKAGE_SPEC })',
    'for (const spec of SKIN_SPECS) installNpmPlugin({ id: ID, packageSpec: spec })',
    '',
  ].join('\n'))

  const rows = await listPluginNpmRows(root)
  assert.deepEqual(rows.map((row) => row.packageName).sort(), [
    '@scope/dsh-skin-a',
    '@scope/dsh-skin-b',
    'dsh-beta',
  ])
  assert.deepEqual(rows.map((row) => row.installScript), new Array(3).fill('plugins/beta/install.mjs'))
})

test('comments and official @deepseek-ai/dsh packages are skipped', async (t) => {
  const root = makeRoot(t)
  write(root, 'plugins/gamma/install.mjs', [
    "import { installNpmPlugin } from '../../scripts/plugin-install.mjs'",
    '// Historical pin: dsh-gamma@0.0.1 must not become a row.',
    '/* Old target dsh-old@9.9.9 must not become a row. */',
    "const SPEC = 'dsh-gamma@1.0.0'",
    "const OFFICIAL = '@deepseek-ai/dsh-browser-use@0.2.2-alpha.2'",
    'installNpmPlugin({ id: ID, packageSpec: SPEC })',
    '',
  ].join('\n'))

  assert.deepEqual((await listPluginNpmRows(root)).map((row) => row.packageName), ['dsh-gamma'])
})

test('scripts without installNpmPlugin are ignored', async (t) => {
  const root = makeRoot(t)
  write(root, 'plugins/delta/install.mjs', [
    "import { installPlugin } from '../../scripts/plugin-install.mjs'",
    "installPlugin({ id: 'delta', packageDir: 'delta' })",
    '',
  ].join('\n'))
  write(root, 'plugins/delta/helper.mjs', "export const version = 'dsh-helper@1.0.0'\n")

  assert.deepEqual(await listPluginNpmRows(root), [])
})

test('rows are ordered by script path, then package name', async (t) => {
  const root = makeRoot(t)
  write(root, 'plugins/zeta/install.mjs', [
    "installNpmPlugin({ id: 'zeta', packageSpec: 'dsh-zeta-b@1.0.0' })",
    "installNpmPlugin({ id: 'zeta', packageSpec: 'dsh-zeta-a@2.0.0' })",
    '',
  ].join('\n'))
  write(root, 'plugins/alpha/install.mjs', [
    "installNpmPlugin({ id: 'alpha', packageSpec: 'dsh-alpha@1.0.0' })",
    '',
  ].join('\n'))

  const rows = await listPluginNpmRows(root)
  assert.deepEqual(rows.map((row) => row.packageName), ['dsh-alpha', 'dsh-zeta-a', 'dsh-zeta-b'])
})
