/**
 * Shared fixtures for the remote-tab host tests.
 *
 * Each fixture is a temporary directory tree that resembles the facts the host
 * process has at runtime: an immutable dsh runtime (with the CLI and the in-box
 * packages the profile does not install), a plugin profile with the parent
 * composition and a user patch, and a parent Harness home with the files the
 * provider copies. The provider fake records its calls and supplies the
 * backend-specific half, so the generic core can be driven without a real
 * `ds-harness-remote` install.
 *
 * Usage: imported by `remote-tab-*.spec.ts`; not a test by itself.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RemoteTabProvider } from '../src/remote-tab/types.ts'

/** Bundles shipped inside the immutable dsh installation. */
export const RUNTIME_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/** Bundles installed into the plugin profile. */
export const PROFILE_BUNDLES = ['ds-harness-remote', 'dsh-better-sidebar']

/** One temporary runtime/profile/home fixture. */
export interface Fixture {
  readonly root: string
  readonly parentProfile: string
  readonly parentHome: string
  readonly runtimeDir: string
}

/** Write one fake package with a package.json under `nodeModules`. */
export function writePackage(nodeModules: string, name: string): void {
  const directory = join(nodeModules, ...name.split('/'))
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
}

/** Plain contents of the parent profile's user patch. */
export const PARENT_PATCH = [
  '# parent user patch',
  '- id: better-sidebar',
  '  name: dsh-better-sidebar',
  '  config:',
  '    titleBarCompat: false',
  '',
].join('\n')

/** Create one fixture. */
export function makeFixture(options: {
  withRemote?: boolean
  withCli?: boolean
  withBoot?: boolean
  withPeer?: boolean
  parentBundles?: readonly string[]
  parentPatch?: string
  /** Put the runtime at `<root>/.harness` (the runtime-root candidate) instead of `<root>/runtime`. */
  harnessRuntime?: boolean
} = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-remote-tab-fixture-'))
  const parentProfile = join(root, 'parent-profile')
  const parentHome = join(root, 'parent-home')
  const runtimeDir = options.harnessRuntime === true ? join(root, '.harness') : join(root, 'runtime')
  mkdirSync(parentProfile, { recursive: true })
  mkdirSync(parentHome, { recursive: true })
  mkdirSync(runtimeDir, { recursive: true })
  // The npm/source runtime carries the optional peer a profile install lacks.
  if (options.withPeer !== false) {
    writePackage(join(runtimeDir, 'node_modules'), '@deepseek-ai/dsh-client-connection')
  }
  const parentBundles = options.parentBundles ?? [...RUNTIME_BUNDLES, ...PROFILE_BUNDLES]
  writeFileSync(join(parentProfile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: { 'ds-harness-remote': '0.6.3', 'dsh-better-sidebar': '0.30.1' },
    dsh: { profile: { bundles: [...parentBundles] } },
  }, null, 2))
  writeFileSync(join(parentProfile, 'cordis.patch.yml'), options.parentPatch ?? PARENT_PATCH)
  // The in-box bundles exist only in the installation, like the real desktop.
  for (const bundle of RUNTIME_BUNDLES) writePackage(join(runtimeDir, 'node_modules'), bundle)
  // The dsh package manifest marks this directory as a runtime root.
  writePackage(join(runtimeDir, 'node_modules'), '@deepseek-ai/dsh')
  const profileBundles = options.withRemote === false
    ? PROFILE_BUNDLES.filter((name) => name !== 'ds-harness-remote')
    : [...PROFILE_BUNDLES]
  for (const bundle of profileBundles) writePackage(join(parentProfile, 'node_modules'), bundle)
  if (options.withBoot !== false) writePackage(join(parentProfile, 'node_modules'), 'dsh-remote-tab-boot')
  mkdirSync(join(parentProfile, 'node_modules'), { recursive: true })
  if (options.withCli !== false) {
    const cli = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
    mkdirSync(cli, { recursive: true })
    writeFileSync(join(cli, 'bin.js'), '// fake dsh cli\n')
  }
  writeFileSync(join(parentHome, 'settings.yaml'), 'model:\n  provider: fake\n')
  mkdirSync(join(parentHome, 'dsh-pet'), { recursive: true })
  writeFileSync(join(parentHome, 'dsh-pet', 'main-config.jsonc'), '// pet config\n')
  writeFileSync(join(parentHome, 'pet.json'), '{"name":"parent-pet"}\n')
  return { root, parentProfile, parentHome, runtimeDir }
}

/** Remove a fixture. */
export function cleanup(fixture: Fixture): void {
  rmSync(fixture.root, { recursive: true, force: true })
}

/** Calls the provider fake recorded. */
export interface ProviderCalls {
  readonly identityArgs: { childHome: string; deviceName: string }[]
  readonly revoked: string[]
  readonly prepared: { parentProfileDir: string; runtimeDir?: string }[]
  readonly patchRequests: string[]
  readonly hostsRequests: number
  readonly workspaceRequests: string[]
}

/** The provider fake plus its recorded calls. */
export interface FakeProvider {
  readonly provider: RemoteTabProvider
  readonly calls: ProviderCalls
}

/**
 * A `RemoteTabProvider` fake: the backend-specific half of the feature.
 * @param overrides - fields to replace (e.g. `bundles`, `requiredBundles`).
 * @param deviceId - device id `ensureIdentity` answers.
 */
export function fakeProvider(overrides: Partial<RemoteTabProvider> = {}, deviceId = 'device-0001'): FakeProvider {
  const calls: {
    identityArgs: { childHome: string; deviceName: string }[]
    revoked: string[]
    prepared: { parentProfileDir: string; runtimeDir?: string }[]
    patchRequests: string[]
    hostsRequests: number
    workspaceRequests: string[]
  } = {
    identityArgs: [],
    revoked: [],
    prepared: [],
    patchRequests: [],
    hostsRequests: 0,
    workspaceRequests: [],
  }
  const provider: RemoteTabProvider = {
    id: 'fake-backend',
    label: 'fake backend',
    bundles: ['dsh-remote-tab-boot'],
    requiredBundles: ['ds-harness-remote'],
    readyBundle: 'dsh-remote-tab-boot',
    homeFiles: [
      { source: 'settings.yaml', target: 'settings.yaml' },
      { source: join('dsh-pet', 'main-config.jsonc'), target: join('dsh-pet', 'main-config.jsonc') },
      { source: 'pet.json', target: 'pet.json' },
    ],
    prepareParent(args) {
      calls.prepared.push({ parentProfileDir: args.parentProfileDir, ...(args.runtimeDir === undefined ? {} : { runtimeDir: args.runtimeDir }) })
    },
    renderPatch({ serverUrl }) {
      calls.patchRequests.push(serverUrl)
      return `# provider patch\n- id: ds-harness-remote\n  config:\n    enabled: true\n    serverUrl: ${JSON.stringify(serverUrl)}\n`
    },
    async ensureIdentity({ childHome, deviceName }) {
      calls.identityArgs.push({ childHome, deviceName })
      return {
        serverUrl: 'https://dsh.example.test',
        childHome,
        childDir: join(childHome, 'remote', 'servers', 'scope', 'client'),
        deviceId,
        authorization: 'minted',
      }
    },
    async revokeIdentity({ childHome }) {
      calls.revoked.push(childHome)
    },
    async listHosts() {
      calls.hostsRequests += 1
      return [
        { deviceId: 'device-1', name: 'Desktop-ZgblKylin', platform: 'linux', online: true, version: '0.1.0' },
      ]
    },
    async discoverWorkspaces(targetDeviceId) {
      calls.workspaceRequests.push(targetDeviceId)
      return {
        workspaces: [
          { workspaceId: 'ws-1', path: '/src/app', title: 'app', backend: 'harness' },
          { workspaceId: 'ws-2', path: '/src/other', title: 'other' },
        ],
        unavailable: [{ backend: 'cursor', code: 'BACKEND_UNAVAILABLE' }],
      }
    },
    ...overrides,
  }
  return { provider, calls }
}
