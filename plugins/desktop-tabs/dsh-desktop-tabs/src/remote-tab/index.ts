/**
 * Entry of the remote-tab host module: the generic profile generator, loader
 * generator, child supervisor, discovery/connection routes, and the
 * `ds-harness-remote` provider that supplies the backend-specific half.
 *
 * The host entry (`../index.ts`) re-exports this barrel as part of the built
 * package, so the package test can drive the same functions the host loads.
 */

export type {
  RemoteConnectionSpec,
  RemoteHost,
  RemoteTabBridge,
  RemoteTabHomeFile,
  RemoteTabIdentity,
  RemoteTabParentPreparation,
  RemoteTabProvider,
  RemoteTabRequest,
  RemoteTabStatus,
  RemoteWorkspace,
  RemoteWorkspaceDiscovery,
  RemoteWorkspaceUnavailable,
} from './types.ts'
export {
  MAX_DEVICE_NAME,
  REMOTE_TAB_PROFILE_NAME,
  absolutePath,
  bundleAnchors,
  expandHome,
  remoteDeviceName,
  remoteTabHome,
  remoteTabProfileDir,
  resolveChildCli,
  resolveDesktopContext,
  resolveParentProfileDir,
  resolveRemoteTabContext,
  resolveRuntimeDir,
  safeConnectionId,
  writeRemoteTabProfile,
} from './profile.ts'
export type {
  DesktopContext,
  RemoteTabContext,
  RemoteTabProfile,
  WriteRemoteTabProfileOptions,
} from './profile.ts'
export {
  LOADER_FILE_NAME,
  LOADER_SCOPE_PREFIX,
  loaderSource,
  remoteTabLoaderPath,
  writeRemoteTabLoader,
} from './loader.ts'
export type { RemoteTabLoader, RemoteTabLoaderAnchors } from './loader.ts'
export {
  childRuntimeCandidates,
  findOnPath,
  findRuntimeNode,
  isAsarPath,
  nodeSupportsExperimentalLoader,
  probeChildRuntime,
  runtimeRootOf,
  selectChildNode,
  selectChildRuntime,
} from './runtime.ts'
export type {
  ChildNode,
  ChildNodeKind,
  ChildRuntime,
  ChildRuntimeCandidate,
  ChildRuntimeKind,
  ProbedRuntime,
  SelectChildNodeOptions,
  SelectChildRuntimeOptions,
} from './runtime.ts'
export {
  DEFAULT_READY_TIMEOUT_MS,
  DEFAULT_TERMINATE_TIMEOUT_MS,
  RemoteTabSupervisor,
  SCRUBBED_CHILD_ENV_KEYS,
  childEnvironment,
  childSpawnPlan,
  createRemoteTabSupervisor,
  isBootReadyLine,
  parseChildLaunchLine,
  redactLogLine,
  terminateChild,
  waitForChildReady,
} from './supervisor.ts'
export type {
  ChildSpawnPlan,
  ChildSpawnPlanOptions,
  ChildSpawner,
  MinimalChildProcess,
  PrepareChildProfileArgs,
  PreparedChildProfile,
  RemoteTabSupervisorOptions,
} from './supervisor.ts'
export {
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  REMOTE_HOSTS_PATH,
  REMOTE_PROVIDER_UNAVAILABLE,
  REMOTE_WORKSPACES_PATH,
  createRemoteTabBridge,
  registerRemoteTabRoutes,
} from './routes.ts'
export type { RemoteTabRegistration, RemoteTabRegistrationOptions } from './routes.ts'
export {
  DS_HARNESS_REMOTE_BOOT_BUNDLE,
  DS_HARNESS_REMOTE_ID,
  DS_HARNESS_REMOTE_LABEL,
  DS_HARNESS_REMOTE_UNAVAILABLE,
  REMOTE_MODE_WORKSPACE_ERROR,
  clientConfigPatch,
  createDsHarnessRemoteProvider,
  ensureRemotePluginPeer,
  ensureRemoteTabIdentity,
  revokeRemoteTabIdentity,
  serverStorageDirectory,
} from './providers/ds-harness-remote.ts'
export type {
  DsHarnessRemoteProviderOptions,
  EnsureRemoteTabIdentityOptions,
  RemoteTabIdentityServices,
  RevokeRemoteTabIdentityOptions,
} from './providers/ds-harness-remote.ts'
