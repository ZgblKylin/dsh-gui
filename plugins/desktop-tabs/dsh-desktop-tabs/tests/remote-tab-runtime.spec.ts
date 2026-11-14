/**
 * Tests of the child runtime and Node selection, run against the built package
 * (`../lib/index.js`).
 *
 * Selection is a pure function over the filesystem: every case supplies an
 * `isFile` probe backed by a set of fake absolute paths, so each preference
 * order can be asserted without creating runtime trees.
 *
 * Usage (from the package directory): node tests/remote-tab-runtime.spec.ts
 */

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)

/** Normalize a fake path for the set-based existence probe. */
function key(path: string): string {
  return path.replace(/\\/gu, '/').toLowerCase()
}

/** Build an `isFile` probe over a list of fake files. */
function files(...paths: readonly string[]): (path: string) => boolean {
  const set = new Set(paths.map(key))
  return (path) => set.has(key(path))
}

/** The installed-runtime layout under a directory. */
function installedRuntime(root: string): { cli: string; anchor: string } {
  const dsh = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  return { cli: join(dsh, 'lib', 'bin.js'), anchor: join(dsh, 'package.json') }
}

/** The source-checkout layout under a directory. */
function sourceRuntime(root: string): { cli: string; anchor: string } {
  return { cli: join(root, 'apps', 'cli', 'lib', 'bin.js'), anchor: join(root, 'apps', 'cli', 'package.json') }
}

// ---------------------------------------------------------------- probe
{
  const installed = installedRuntime('C:/rt')
  assert.deepEqual(
    mod.probeChildRuntime('C:/rt', files(installed.cli, installed.anchor)),
    { cliPath: installed.cli, anchor: installed.anchor },
    'an installed runtime probes its CLI and dsh manifest',
  )
  const source = sourceRuntime('C:/src')
  assert.deepEqual(
    mod.probeChildRuntime('C:/src', files(source.cli, source.anchor)),
    { cliPath: source.cli, anchor: source.anchor },
    'a source checkout probes apps/cli',
  )
  assert.equal(mod.probeChildRuntime('C:/empty', files()), undefined, 'a directory without a dsh layout does not probe')
  assert.equal(mod.isAsarPath('C:/app/resources/app.asar/dsh'), true, 'an asar file segment is detected')
  assert.equal(mod.isAsarPath('C:/app/resources/dsh'), false, 'a normal directory is not an asar path')
}

// ---------------------------------------------------------------- runtime order
{
  const runtimeRoot = 'C:/runtime-root'
  const dshHome = join(runtimeRoot, 'home')
  const harness = installedRuntime(join(runtimeRoot, '.harness'))
  const source = sourceRuntime(join(runtimeRoot, '.desktop', 'source'))
  const parent = installedRuntime('C:/parent-runtime')
  const asarParent = 'C:/app/resources/app.asar/dsh'
  const asar = installedRuntime(asarParent)
  const envRuntime = installedRuntime('C:/env-runtime')
  const repo = 'C:/repo'
  const repoSource = sourceRuntime(join(repo, 'deepseek-harness'))

  // Highest priority: the explicit environment override.
  {
    const selected = mod.selectChildRuntime({
      env: { DSH_REMOTE_TAB_RUNTIME: 'C:/env-runtime' },
      dshHome,
      parentRuntimeDir: 'C:/parent-runtime',
      isFile: files(envRuntime.cli, envRuntime.anchor, harness.cli, harness.anchor),
    })
    assert.equal(selected.kind, 'env', 'the explicit runtime wins')
    assert.equal(selected.runtimeDir, 'C:/env-runtime')
    assert.equal(selected.cliPath, envRuntime.cli)
    assert.equal(selected.anchor, envRuntime.anchor)
  }
  // Invalid explicit value is a configuration error, not a silent fallback.
  assert.throws(
    () => mod.selectChildRuntime({ env: { DSH_REMOTE_TAB_RUNTIME: 'C:/broken' }, dshHome, isFile: files() }),
    /DSH_REMOTE_TAB_RUNTIME/u,
    'an invalid explicit runtime is reported',
  )

  // `<runtimeRoot>/.harness` beats the source checkout and the parent runtime.
  {
    const selected = mod.selectChildRuntime({
      env: {},
      dshHome,
      parentRuntimeDir: 'C:/parent-runtime',
      isFile: files(harness.cli, harness.anchor, source.cli, source.anchor, parent.cli, parent.anchor),
    })
    assert.equal(selected.kind, 'harness', 'the npm runtime under the runtime root is preferred over source/parent')
    assert.equal(selected.runtimeDir, join(runtimeRoot, '.harness'))
    assert.equal(selected.anchor, harness.anchor)
  }
  // Source checkout beats the parent runtime.
  {
    const selected = mod.selectChildRuntime({
      env: {},
      dshHome,
      parentRuntimeDir: 'C:/parent-runtime',
      isFile: files(source.cli, source.anchor, parent.cli, parent.anchor),
    })
    assert.equal(selected.kind, 'source', 'a source checkout build is preferred over the parent runtime')
    assert.equal(selected.cliPath, source.cli, 'the source layout CLI is used')
    assert.equal(selected.anchor, source.anchor, 'the source layout dsh manifest is the loader anchor')
  }
  // The repository checkout build is the second source candidate.
  {
    const selected = mod.selectChildRuntime({
      env: { DSH_GUI_ROOT: repo },
      dshHome,
      parentRuntimeDir: 'C:/parent-runtime',
      isFile: files(repoSource.cli, repoSource.anchor, parent.cli, parent.anchor),
    })
    assert.equal(selected.kind, 'source')
    assert.equal(selected.runtimeDir, join(repo, 'deepseek-harness'))
  }
  // A real parent runtime is preferred over the asar fallback.
  {
    const selected = mod.selectChildRuntime({
      env: {},
      dshHome,
      parentRuntimeDir: 'C:/parent-runtime',
      isFile: files(parent.cli, parent.anchor, asar.cli, asar.anchor),
    })
    assert.equal(selected.kind, 'parent-real', 'a real parent runtime is preferred over asar')
  }
  // The asar runtime is the last fallback.
  {
    const selected = mod.selectChildRuntime({
      env: {},
      dshHome,
      parentRuntimeDir: asarParent,
      isFile: files(asar.cli, asar.anchor),
    })
    assert.equal(selected.kind, 'parent-asar', 'the packaged asar runtime is the last fallback')
    assert.equal(selected.runtimeDir, asarParent)
  }
  // Nothing usable at all.
  assert.throws(
    () => mod.selectChildRuntime({ env: {}, dshHome, isFile: files() }),
    /未找到可用于子后端的真实 dsh 运行时/u,
    'no candidate reports an actionable error',
  )
}

// ---------------------------------------------------------------- node order
{
  const hostExecPath = 'C:/app/DeepSeek Harness.exe'
  // The hosting process is a real Node: it is used directly.
  {
    const node = mod.selectChildNode({ env: {}, dshHome: 'C:/root/home', hostExecPath: 'C:/node/node.exe', hostElectron: false })
    assert.deepEqual(
      { command: node.command, electron: node.electron, kind: node.kind },
      { command: 'C:/node/node.exe', electron: false, kind: 'host-node' },
      'a non-Electron host uses its own executable',
    )
    const withEnv = mod.selectChildNode({
      env: { DSH_REMOTE_TAB_NODE: 'C:/custom/node.exe' },
      dshHome: 'C:/root/home',
      hostExecPath: 'C:/node/node.exe',
      hostElectron: false,
    })
    assert.equal(withEnv.kind, 'host-node', 'a real Node host needs no override')
  }
  // The explicit environment override wins (Electron host).
  {
    const node = mod.selectChildNode({
      env: { DSH_REMOTE_TAB_NODE: 'C:/custom/node.exe' },
      dshHome: 'C:/root/home',
      hostExecPath,
      hostElectron: true,
      isFile: files('C:/custom/node.exe'),
    })
    assert.equal(node.kind, 'env')
    assert.equal(node.command, 'C:/custom/node.exe')
    assert.equal(node.electron, false)
    assert.throws(
      () => mod.selectChildNode({ env: { DSH_REMOTE_TAB_NODE: 'C:/missing/node.exe' }, dshHome: 'C:/root/home', hostExecPath, hostElectron: true, isFile: files() }),
      /DSH_REMOTE_TAB_NODE/u,
      'an invalid explicit Node is reported',
    )
  }
  // npm's node path, when it is not Electron.
  {
    const node = mod.selectChildNode({
      env: { npm_node_execpath: 'C:/program files/nodejs/node.exe' },
      dshHome: 'C:/root/home',
      hostExecPath,
      hostElectron: true,
      isFile: files('C:/program files/nodejs/node.exe'),
    })
    assert.equal(node.kind, 'npm-node', 'npm_node_execpath is used when it is a real Node')
    assert.equal(node.electron, false)
  }
  // A Node on PATH.
  {
    const node = mod.selectChildNode({
      env: { PATH: 'C:/Windows/system32;C:/Program Files/nodejs' },
      dshHome: 'C:/root/home',
      hostExecPath,
      hostElectron: true,
      platform: 'win32',
      isFile: files('C:/Program Files/nodejs/node.exe'),
    })
    assert.equal(node.kind, 'path-node', 'a Node on PATH is used')
    assert.equal(node.command, join('C:/Program Files/nodejs', 'node.exe'))
  }
  // The primary runtime's bundled Node.
  {
    const runtimeRoot = 'C:/root'
    const bundled = join(runtimeRoot, 'desktop', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe')
    const node = mod.selectChildNode({
      env: {},
      dshHome: join(runtimeRoot, 'home'),
      hostExecPath,
      hostElectron: true,
      platform: 'win32',
      isFile: files(bundled),
    })
    assert.equal(node.kind, 'runtime-node', 'the bundled runtime Node is used as a fallback')
    assert.equal(node.command, bundled)
  }
  // The packaged application's own Node, beside its asar archive.
  {
    const parentRuntimeDir = 'C:/app/resources/app.asar/dsh'
    const resources = 'C:/app/resources'
    const bundled = join(resources, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe')
    const node = mod.selectChildNode({
      env: {},
      dshHome: 'C:/users/me/.dsh',
      parentRuntimeDir,
      hostExecPath,
      hostElectron: true,
      platform: 'win32',
      isFile: files(bundled),
    })
    assert.equal(node.kind, 'runtime-node', "the packaged application's bundled Node is found beside app.asar")
    assert.equal(node.command, bundled)
  }
  // Last resort: Electron, with a warning.
  {
    const node = mod.selectChildNode({
      env: { PATH: 'C:/nothing' },
      dshHome: 'C:/root/home',
      hostExecPath,
      hostElectron: true,
      platform: 'win32',
      isFile: files(),
    })
    assert.equal(node.kind, 'electron-fallback', 'Electron is the last fallback')
    assert.equal(node.command, hostExecPath)
    assert.equal(node.electron, true, 'the Electron fallback needs Node mode')
    assert.match(node.warning ?? '', /asar/u, 'the fallback warning names the asar limitation')
    assert.match(node.warning ?? '', /DSH_REMOTE_TAB_NODE/u, 'the fallback warning names the override')
  }
  // PATH scanning honours the platform separator.
  assert.equal(
    mod.findOnPath('/usr/bin:/opt/node/bin', 'linux', files('/opt/node/bin/node')),
    join('/opt/node/bin', 'node'),
    'a POSIX PATH is scanned with colons',
  )
  assert.equal(mod.findOnPath('C:/a;C:/b', 'win32', files('C:/a/node.exe')), join('C:/a', 'node.exe'))
  assert.equal(mod.findOnPath('C:/a', 'win32', files()), undefined)
}

// ---------------------------------------------------------------- loader support
assert.equal(mod.nodeSupportsExperimentalLoader('24.19.0'), true, 'modern Node supports the loader')
assert.equal(mod.nodeSupportsExperimentalLoader('22.0.0'), true)
assert.equal(mod.nodeSupportsExperimentalLoader('18.19.0'), true)
assert.equal(mod.nodeSupportsExperimentalLoader('16.20.0'), false, 'old Node does not support the loader flag')
assert.equal(mod.nodeSupportsExperimentalLoader(undefined), false, 'an unknown version is not assumed to support it')

console.log('remote-tab runtime tests passed')
