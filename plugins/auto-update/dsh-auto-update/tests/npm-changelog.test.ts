/**
 * Unit tests for the npm row's release-range helpers.
 *
 * An npm row has no local commit range: its changelog is the GitHub Releases
 * between the install script's pin and the registry's latest version. The range
 * is decided by the release tags alone, so `versionFromTag` and
 * `selectNpmReleases` are pure functions that can be tested without the network.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { selectNpmReleases, versionFromTag, type NpmRelease } from '../src/changelog.ts'

test('versionFromTag drops a leading v and keeps a full semver tag', () => {
  assert.equal(versionFromTag('v0.7.1'), '0.7.1')
  assert.equal(versionFromTag('V0.7.1'), '0.7.1')
  assert.equal(versionFromTag('0.7.1'), '0.7.1')
  assert.equal(versionFromTag('v0.2.2-alpha.2'), '0.2.2-alpha.2')
  assert.equal(versionFromTag('0.2.2+build.7'), '0.2.2+build.7')
})

test('versionFromTag takes the last version-shaped substring of another tag', () => {
  assert.equal(versionFromTag('release-1.2.3'), '1.2.3')
  assert.equal(versionFromTag('release-v1.2.3'), '1.2.3')
  assert.equal(versionFromTag('dsh-auto-update@0.4.0'), '0.4.0')
  // The trailing version segment wins; a prerelease suffix stays attached to
  // the version it belongs to (`release-1.2.3-rc.1` names 1.2.3-rc.1).
  assert.equal(versionFromTag('foo 1.2.3 bar 4.5.6'), '4.5.6')
  assert.equal(versionFromTag('release-1.2.3-rc.1'), '1.2.3-rc.1')
})

test('versionFromTag returns undefined when the tag names no version', () => {
  assert.equal(versionFromTag(''), undefined)
  assert.equal(versionFromTag('   '), undefined)
  assert.equal(versionFromTag('nightly'), undefined)
  assert.equal(versionFromTag('v1.2'), undefined)
})

/** A release fixture; only the fields the range filter reads are meaningful. */
function release(tag: string, publishedAt: string): NpmRelease {
  return { tag, name: tag, url: `https://github.com/o/r/releases/tag/${tag}`, publishedAt, body: '' }
}

test('selectNpmReleases keeps the open-closed (from, to] range', () => {
  const releases = [
    release('v0.6.0', '2026-01-01T00:00:00Z'),
    release('v0.7.0', '2026-02-01T00:00:00Z'),
    release('v0.7.1', '2026-03-01T00:00:00Z'),
    release('v0.8.0', '2026-04-01T00:00:00Z'),
    release('nightly', '2026-05-01T00:00:00Z'),
  ]
  assert.deepEqual(
    selectNpmReleases(releases, '0.7.0', '0.7.1').map((row) => row.tag),
    ['v0.7.1'],
  )
  assert.deepEqual(
    selectNpmReleases(releases, '0.6.0', '0.7.1').map((row) => row.tag),
    ['v0.7.1', 'v0.7.0'],
  )
})

test('selectNpmReleases orders by publish time, not list order', () => {
  const releases = [
    release('v0.8.0', '2026-03-01T00:00:00Z'),
    release('v0.7.1', '2026-02-01T00:00:00Z'),
    release('v0.7.0', '2026-01-01T00:00:00Z'),
  ]
  assert.deepEqual(
    selectNpmReleases(releases, '0.7.0', '0.8.0').map((row) => row.tag),
    ['v0.8.0', 'v0.7.1'],
  )
})

test('selectNpmReleases ranges prereleases by semver order', () => {
  const releases = [
    release('v0.2.2-alpha.2', '2026-01-01T00:00:00Z'),
    release('v0.2.2-alpha.3', '2026-01-02T00:00:00Z'),
    release('v0.2.2', '2026-01-03T00:00:00Z'),
  ]
  assert.deepEqual(
    selectNpmReleases(releases, '0.2.2-alpha.2', '0.2.2').map((row) => row.tag),
    ['v0.2.2', 'v0.2.2-alpha.3'],
  )
})

test('selectNpmReleases is empty when nothing is in range', () => {
  const releases = [release('v0.7.0', '2026-01-01T00:00:00Z')]
  assert.deepEqual(selectNpmReleases(releases, '0.7.0', '0.7.0'), [])
  assert.deepEqual(selectNpmReleases(releases, '0.8.0', '0.9.0'), [])
  assert.deepEqual(selectNpmReleases(releases, 'not-a-version', '0.9.0'), [])
  assert.deepEqual(selectNpmReleases([], '0.7.0', '0.8.0'), [])
  assert.deepEqual(selectNpmReleases([release('nightly', '2026-01-01T00:00:00Z')], '0.7.0', '0.8.0'), [])
})
