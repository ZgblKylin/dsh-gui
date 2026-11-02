/**
 * Unit tests for the local version comparison used by npm plugin rows.
 *
 * The plugin package carries no semver dependency (it runs inside the host
 * process with only Node built-ins), so `src/version.ts` implements the subset
 * the update panel needs: numeric segments, prerelease ordering, and a strict
 * "newer" predicate that never fires on unparseable input.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { compareVersions, isNewerVersion } from '../src/version.ts'

test('stable versions compare by numeric segments', () => {
  assert.equal(compareVersions('0.7.1', '0.7.0'), 1)
  assert.equal(compareVersions('0.7.0', '0.7.1'), -1)
  assert.equal(compareVersions('0.7.0', '0.7.0'), 0)
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1)
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1)
})

test('a prerelease sorts below its release', () => {
  assert.equal(compareVersions('0.2.2-alpha.2', '0.2.2'), -1)
  assert.equal(compareVersions('0.2.2', '0.2.2-alpha.2'), 1)
  assert.equal(compareVersions('0.2.2-alpha.2', '0.2.2-alpha.3'), -1)
  assert.equal(compareVersions('0.2.2-alpha.10', '0.2.2-alpha.9'), 1)
})

test('isNewerVersion reports only a strictly newer latest', () => {
  assert.equal(isNewerVersion('0.7.1', '0.7.0'), true)
  assert.equal(isNewerVersion('0.7.0', '0.7.0'), false)
  assert.equal(isNewerVersion('0.6.9', '0.7.0'), false)
  assert.equal(isNewerVersion('0.2.2-alpha.3', '0.2.2-alpha.2'), true)
})

test('unparseable versions never count as newer', () => {
  assert.equal(isNewerVersion('not-a-version', '0.7.0'), false)
  assert.equal(isNewerVersion('0.7.1', 'nope'), false)
})
