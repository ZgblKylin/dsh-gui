/**
 * Entry of the remote-tab host module: the profile generator, the child identity
 * reflection, the child supervisor, and the discovery/connection routes. The
 * host entry (`../index.ts`) re-exports this barrel as part of the built
 * package, so the package test can drive the same functions the desktop loads.
 */

export type {
  RemoteConnectionSpec,
  RemoteHost,
  RemoteTabBridge,
  RemoteTabIdentity,
  RemoteTabRequest,
  RemoteTabStatus,
  RemoteWorkspace,
} from './types.ts'
export {
  CHILD_PROFILE_BUNDLES,
  MAX_DEVICE_NAME,
  REMOTE_TAB_PROFILE_NAME,
  absolutePath,
  expandHome,
  remoteDeviceName,
  remoteTabHome,
  remoteTabProfileDir,
  resolveChildCli,
  resolveDesktopContext,
  safeConnectionId,
  writeRemoteTabProfile,
} from './profile.ts'
export type {
  DesktopContext,
  RemoteTabProfile,
  WriteRemoteTabProfileOptions,
} from './profile.ts'
export {
  ensureRemoteTabIdentity,
  revokeRemoteTabIdentity,
  serverStorageDirectory,
} from './identity.ts'
export type {
  EnsureRemoteTabIdentityOptions,
  RemoteTabIdentityServices,
  RevokeRemoteTabIdentityOptions,
} from './identity.ts'
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
  PreparedChildProfile,
  RemoteTabSupervisorOptions,
  ResolvedChildIdentity,
} from './supervisor.ts'
export {
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  REMOTE_HOSTS_PATH,
  REMOTE_MODE_WORKSPACE_ERROR,
  REMOTE_PLUGIN_UNAVAILABLE,
  REMOTE_WORKSPACES_PATH,
  createRemoteTabBridge,
  registerRemoteTabRoutes,
} from './routes.ts'
export type { RemoteTabRegistration, RemoteTabRegistrationOptions } from './routes.ts'
