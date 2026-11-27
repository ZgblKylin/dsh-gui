/**
 * Behaviour of the link-safe removers the build and install scripts rely on.
 *
 * The cases that matter are the ones `fs.rmSync(..., { recursive: true })`
 * gets wrong: a junction inside the removed tree, and a junction as the removed
 * path. Both must leave the link's target untouched.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { hasLinkedAncestor, isLinkPath, removeLink, removeTree } from './remove-tree.mjs'

/** Junctions need the explicit type on Windows; the type is ignored elsewhere. */
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

/**
 * A temporary directory removed with the same link-safe walker on teardown.
 * @param {import('node:test').TestContext} t - the running test.
 * @returns {string} absolute fixture root.
 */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-remove-tree-'))
  t.after(() => removeTree(root, { retries: 10, retryDelayMs: 50 }))
  return root
}

/**
 * Write a file, creating its directory.
 * @param {string} path - absolute file path.
 * @param {string} text - file contents.
 */
function writeFile(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

test('removes a tree holding a junction without touching the target', (t) => {
  const root = fixture(t)
  const target = join(root, 'target')
  const host = join(root, 'host')
  writeFile(join(target, 'keep.txt'), 'keep')
  mkdirSync(host, { recursive: true })
  symlinkSync(target, join(host, 'link'), LINK_TYPE)

  assert.equal(removeTree(host), true)

  assert.equal(existsSync(host), false)
  assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'keep')
})

test('removes a junction itself and keeps the target', (t) => {
  const root = fixture(t)
  const target = join(root, 'target')
  const link = join(root, 'link')
  writeFile(join(target, 'keep.txt'), 'keep')
  symlinkSync(target, link, LINK_TYPE)

  assert.equal(removeTree(link), true)

  assert.equal(existsSync(link), false)
  assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'keep')
})

test('removes files and nested directories', (t) => {
  const root = fixture(t)
  writeFile(join(root, 'a', 'b', 'file.txt'), 'x')
  writeFile(join(root, 'top.txt'), 'y')

  assert.equal(removeTree(root), true)

  assert.equal(existsSync(root), false)
})

test('removes a read-only file inside the tree', (t) => {
  const root = fixture(t)
  const file = join(root, 'locked.txt')
  writeFileSync(file, 'x')
  chmodSync(file, 0o444)

  assert.equal(removeTree(root), true)

  assert.equal(existsSync(root), false)
})

test('treats a missing path as a no-op', (t) => {
  const root = fixture(t)

  assert.equal(removeTree(join(root, 'absent')), false)
  assert.equal(removeLink(join(root, 'absent')), false)
})

test('removeLink unlinks a junction without touching its target', (t) => {
  const root = fixture(t)
  const target = join(root, 'target')
  const link = join(root, 'link')
  writeFile(join(target, 'keep.txt'), 'keep')
  symlinkSync(target, link, LINK_TYPE)

  assert.equal(removeLink(link), true)

  assert.equal(existsSync(link), false)
  assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'keep')
})

test('removeLink refuses a regular directory', (t) => {
  const root = fixture(t)
  const directory = join(root, 'plain')
  writeFile(join(directory, 'file.txt'), 'x')

  assert.throws(() => removeLink(directory), /not a directory link/u)
  assert.equal(existsSync(join(directory, 'file.txt')), true)
})

test('isLinkPath distinguishes links from directories and missing paths', (t) => {
  const root = fixture(t)
  const target = join(root, 'target')
  const link = join(root, 'link')
  mkdirSync(target, { recursive: true })
  symlinkSync(target, link, LINK_TYPE)

  assert.equal(isLinkPath(link), true)
  assert.equal(isLinkPath(target), false)
  assert.equal(isLinkPath(join(root, 'absent')), false)
})

test('hasLinkedAncestor reports whether a delete would land in another tree', (t) => {
  const root = fixture(t)
  const target = join(root, 'target')
  mkdirSync(target, { recursive: true })
  mkdirSync(join(root, 'plain'), { recursive: true })
  symlinkSync(target, join(root, 'link'), LINK_TYPE)

  assert.equal(hasLinkedAncestor(root, join(root, 'link', 'nested')), true)
  assert.equal(hasLinkedAncestor(root, join(root, 'plain', 'nested')), false)
  assert.equal(hasLinkedAncestor(root, root), false)
  assert.throws(() => hasLinkedAncestor(root, join(root, '..', 'outside')), /not inside/u)
})
