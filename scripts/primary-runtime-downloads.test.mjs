import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  assetCandidates,
  cachedAssetSize,
  ensurePrimaryRuntimeAsset,
  ensurePrimaryRuntimeDownloads,
  lockedPrimaryRuntimeAssets,
  mirrorAssetUrl,
  pypiMirrorAssetUrl,
} from './primary-runtime-downloads.mjs'

/** Minimal lock shaped like `scripts/primary-runtime/lock.json`. */
const LOCK = {
  nodeVersion: '24.21.0',
  pythonVersion: '3.12.14',
  pythonRelease: '20260901',
  wheels: [
    { url: 'https://files.pythonhosted.org/packages/aa/bb/shared.whl', sha256: 'b'.repeat(64) },
  ],
  targets: {
    'win-x64': {
      nodeArchive: 'win-x64.zip',
      nodeSha256: 'a'.repeat(64),
      pythonTarget: 'x86_64-pc-windows-msvc',
      pythonSha256: 'c'.repeat(64),
      wheels: [
        { url: 'https://files.pythonhosted.org/packages/cc/dd/numpy-1.0-cp312-win_amd64.whl', sha256: 'd'.repeat(64) },
      ],
    },
  },
}

/** SHA-256 of a test payload. */
function digest(text) {
  return createHash('sha256').update(Buffer.from(text)).digest('hex')
}

/** A response object with the subset the downloader reads. */
function responseFor(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => Buffer.from(body),
  }
}

/** Throwaway cache directory, kept until the awaited body finishes. */
async function withCacheDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-primary-runtime-test-'))
  try {
    return await run(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('the lock yields node, python and wheels in download order', () => {
  const assets = lockedPrimaryRuntimeAssets(LOCK, 'win-x64')
  assert.deepEqual(assets, [
    {
      label: 'node 24.21.0',
      url: 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip',
      sha256: 'a'.repeat(64),
    },
    {
      label: 'python 3.12.14+20260901',
      url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.12.14%2B20260901-x86_64-pc-windows-msvc-install_only_stripped.tar.gz',
      sha256: 'c'.repeat(64),
    },
    {
      label: 'numpy-1.0-cp312-win_amd64.whl',
      url: 'https://files.pythonhosted.org/packages/cc/dd/numpy-1.0-cp312-win_amd64.whl',
      sha256: 'd'.repeat(64),
    },
    {
      label: 'shared.whl',
      url: 'https://files.pythonhosted.org/packages/aa/bb/shared.whl',
      sha256: 'b'.repeat(64),
    },
  ])
})

test('a lock without the requested target yields nothing', () => {
  assert.equal(lockedPrimaryRuntimeAssets(LOCK, 'mac-arm64'), undefined)
})

test('a registry mirror serves node and python release assets', () => {
  const mirror = 'https://registry.example.test/-/binary/'
  assert.equal(
    mirrorAssetUrl('https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip', mirror),
    'https://registry.example.test/-/binary/node/v24.21.0/node-v24.21.0-win-x64.zip',
  )
  assert.equal(
    mirrorAssetUrl(
      'https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.12.14%2B20260901-x86_64-pc-windows-msvc-install_only_stripped.tar.gz',
      mirror,
    ),
    'https://registry.example.test/-/binary/python-build-standalone/20260901/cpython-3.12.14%2B20260901-x86_64-pc-windows-msvc-install_only_stripped.tar.gz',
  )
})

test('the mirror adds its trailing slash and keeps no asset on its own host', () => {
  assert.equal(
    mirrorAssetUrl('https://nodejs.org/dist/v1/node-v1-win-x64.zip', 'https://mirror.test/-/binary'),
    'https://mirror.test/-/binary/node/v1/node-v1-win-x64.zip',
  )
  assert.equal(mirrorAssetUrl('https://files.pythonhosted.org/packages/aa/x.whl', 'https://mirror.test/-/binary/'), undefined)
  assert.equal(mirrorAssetUrl('https://nodejs.org/dist/v1/node-v1-win-x64.zip', ''), undefined)
  assert.equal(mirrorAssetUrl('https://nodejs.org/dist/v1/node-v1-win-x64.zip', 'not a url'), undefined)
})

test('a configured PyPI mirror moves the pool path to its own host', () => {
  assert.equal(
    pypiMirrorAssetUrl('https://files.pythonhosted.org/packages/aa/bb/x.whl', 'https://pypi.example.test/'),
    'https://pypi.example.test/packages/aa/bb/x.whl',
  )
  assert.equal(pypiMirrorAssetUrl('https://nodejs.org/dist/v1/node-v1-win-x64.zip', 'https://pypi.example.test/'), undefined)
  assert.equal(pypiMirrorAssetUrl('https://files.pythonhosted.org/packages/aa/x.whl', undefined), undefined)
})

test('candidates put the mirror first and the official URL last', () => {
  const asset = { url: 'https://nodejs.org/dist/v1/node-v1-win-x64.zip' }
  assert.deepEqual(assetCandidates(asset, { mirror: 'https://mirror.test/-/binary/' }), [
    'https://mirror.test/-/binary/node/v1/node-v1-win-x64.zip',
    'https://nodejs.org/dist/v1/node-v1-win-x64.zip',
  ])
  const wheel = { url: 'https://files.pythonhosted.org/packages/aa/x.whl' }
  assert.deepEqual(assetCandidates(wheel, { pypiMirror: 'https://pypi.example.test/' }), [
    'https://pypi.example.test/packages/aa/x.whl',
    'https://files.pythonhosted.org/packages/aa/x.whl',
  ])
  assert.deepEqual(assetCandidates(wheel, {}), ['https://files.pythonhosted.org/packages/aa/x.whl'])
})

test('a cached asset is reused without a request', async () => {
  await withCacheDirectory(async (directory) => {
    const asset = { label: 'payload', url: 'https://a.test/payload', sha256: digest('cached payload') }
    writeFileSync(join(directory, asset.sha256), 'cached payload')
    let requests = 0
    const outcome = await ensurePrimaryRuntimeAsset(asset, {
      downloads: directory,
      fetchImpl: async () => { requests += 1; return responseFor('other') },
    })
    assert.deepEqual(outcome, { status: 'cached', bytes: 14 })
    assert.equal(requests, 0)
  })
})

test('a stale cache entry is replaced by a fresh download', async () => {
  await withCacheDirectory(async (directory) => {
    const payload = 'official payload'
    const asset = { label: 'payload', url: 'https://a.test/payload', sha256: digest(payload) }
    writeFileSync(join(directory, asset.sha256), 'stale bytes')
    const requested = []
    const outcome = await ensurePrimaryRuntimeAsset(asset, {
      downloads: directory,
      fetchImpl: async (url) => { requested.push(url); return responseFor(payload) },
    })
    assert.equal(outcome.status, 'downloaded')
    assert.equal(outcome.url, 'https://a.test/payload')
    assert.deepEqual(requested, ['https://a.test/payload'])
    assert.equal(readFileSync(join(directory, asset.sha256), 'utf8'), payload)
  })
})

test('a mirror serving other bytes falls back to the next candidate', async () => {
  await withCacheDirectory(async (directory) => {
    const payload = 'official payload'
    const official = 'https://nodejs.org/dist/v1/node-v1-win-x64.zip'
    const asset = { label: 'payload', url: official, sha256: digest(payload) }
    const requested = []
    const outcome = await ensurePrimaryRuntimeAsset(asset, {
      downloads: directory,
      mirror: 'https://mirror.test/-/binary/',
      fetchImpl: async (url) => {
        requested.push(url)
        return responseFor(url.startsWith('https://mirror.test/') ? 'mirror payload' : payload)
      },
      sleepImpl: async () => {},
    })
    assert.equal(outcome.url, official)
    assert.deepEqual(requested, [
      'https://mirror.test/-/binary/node/v1/node-v1-win-x64.zip',
      official,
    ])
  })
})

test('every candidate is retried before the asset is reported as unobtainable', async () => {
  await withCacheDirectory(async (directory) => {
    const asset = { label: 'payload', url: 'https://nodejs.org/dist/v1/node-v1-win-x64.zip', sha256: digest('payload') }
    let attempts = 0
    await assert.rejects(
      ensurePrimaryRuntimeAsset(asset, {
        downloads: directory,
        mirror: 'https://mirror.test/-/binary/',
        retries: 2,
        fetchImpl: async () => { attempts += 1; throw new Error('offline') },
        sleepImpl: async () => {},
      }),
      /could not be obtained/u,
    )
    assert.equal(attempts, 4)
  })
})

test('an HTTP failure is retried and reported with its status', async () => {
  await withCacheDirectory(async (directory) => {
    const asset = { label: 'payload', url: 'https://a.test/payload', sha256: digest('payload') }
    await assert.rejects(
      ensurePrimaryRuntimeAsset(asset, {
        downloads: directory,
        retries: 1,
        fetchImpl: async () => responseFor('missing', 404),
        sleepImpl: async () => {},
      }),
      /HTTP 404/u,
    )
  })
})

test('the download preparation summarizes what it cached', async () => {
  await withCacheDirectory(async (directory) => {
    const payloads = new Map([
      ['https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip', 'node archive'],
      ['https://files.pythonhosted.org/packages/cc/dd/numpy-1.0-cp312-win_amd64.whl', 'numpy wheel'],
    ])
    const lock = {
      ...LOCK,
      targets: {
        'win-x64': {
          ...LOCK.targets['win-x64'],
          nodeSha256: digest('node archive'),
          pythonSha256: digest('python archive'),
          wheels: [{ url: 'https://files.pythonhosted.org/packages/cc/dd/numpy-1.0-cp312-win_amd64.whl', sha256: digest('numpy wheel') }],
        },
      },
      wheels: [{ url: 'https://files.pythonhosted.org/packages/aa/bb/shared.whl', sha256: digest('shared wheel') }],
    }
    payloads.set('https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.12.14%2B20260901-x86_64-pc-windows-msvc-install_only_stripped.tar.gz', 'python archive')
    payloads.set('https://files.pythonhosted.org/packages/aa/bb/shared.whl', 'shared wheel')
    writeFileSync(join(directory, lock.wheels[0].sha256), 'shared wheel')
    const summary = await ensurePrimaryRuntimeDownloads({
      lock,
      target: 'win-x64',
      downloads: directory,
      fetchImpl: async (url) => {
        const payload = payloads.get(url)
        return payload === undefined ? responseFor('missing', 404) : responseFor(payload)
      },
    })
    assert.deepEqual(summary, { assets: 4, cached: 1, downloaded: 3, bytes: 12 + 14 + 11 + 12 })
  })
})

test('an unknown target is never silently prepared', async () => {
  await withCacheDirectory(async (directory) => {
    await assert.rejects(
      ensurePrimaryRuntimeDownloads({ lock: LOCK, target: 'mac-arm64', downloads: directory }),
      /no mac-arm64 target/u,
    )
  })
})

test('cached size is undefined for a stale or missing entry', async () => {
  await withCacheDirectory(async (directory) => {
    const destination = join(directory, 'key')
    assert.equal(cachedAssetSize(destination, digest('x')), undefined)
    writeFileSync(destination, 'y')
    assert.equal(cachedAssetSize(destination, digest('x')), undefined)
    assert.equal(cachedAssetSize(destination, digest('y')), 1)
  })
})
