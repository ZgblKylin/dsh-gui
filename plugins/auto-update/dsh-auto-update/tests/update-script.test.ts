/**
 * Unit tests for the install-script rewrite used by an npm plugin row update.
 *
 * The update action persists the new version by rewriting the pinned
 * `pkg@version` literal inside the wrapper script, then re-running that script.
 * The rewrite is a pure function so the replacement (including repeated
 * occurrences of the same pin) is covered without touching a checkout.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { replacePinnedVersion } from '../src/update.ts'

test('rewrites the pinned spec everywhere it occurs', () => {
  const text = [
    "// Historical pin: dsh-pet@0.3.8",
    "const PACKAGE_SPEC = 'dsh-pet@0.3.8'",
    "installNpmPlugin({ id: 'dsh-pet', packageSpec: PACKAGE_SPEC })",
    '',
  ].join('\n')

  const next = replacePinnedVersion(text, 'dsh-pet@0.3.8', 'dsh-pet@0.3.9')

  assert.equal(next, [
    '// Historical pin: dsh-pet@0.3.9',
    "const PACKAGE_SPEC = 'dsh-pet@0.3.9'",
    "installNpmPlugin({ id: 'dsh-pet', packageSpec: PACKAGE_SPEC })",
    '',
  ].join('\n'))
})

test('a script without the pinned spec refuses the rewrite', () => {
  const text = "const PACKAGE_SPEC = 'dsh-pet@0.3.7'\n"
  // The row was resolved against the pin the script carried; a script that no
  // longer contains it changed under the dialog, so the write must fail loud
  // instead of silently reporting an update that never landed.
  assert.throws(
    () => replacePinnedVersion(text, 'dsh-pet@0.3.8', 'dsh-pet@0.3.9'),
    /dsh-pet@0\.3\.8/,
  )
})

test('a scoped spec is rewritten with its scope intact', () => {
  const text = "installNpmPlugin({ id: 'center', packageSpec: '@max-null/dsh-skill-mcp-center@0.7.0' })\n"
  const next = replacePinnedVersion(text, '@max-null/dsh-skill-mcp-center@0.7.0', '@max-null/dsh-skill-mcp-center@0.7.1')
  assert.equal(next, "installNpmPlugin({ id: 'center', packageSpec: '@max-null/dsh-skill-mcp-center@0.7.1' })\n")
})
