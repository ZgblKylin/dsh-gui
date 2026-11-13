/**
 * Regression test for the remote-tab client half.
 *
 * Covers the three client-side seams:
 *  - `src/client/types.ts`: the remote shapes, their parse helpers, the stable
 *    `remote-<hash>` connection id, and the round-trip through `tabOf` /
 *    `connectionOf` / `isLocalTab`;
 *  - `src/client/ui/connection-list.js`: the fourth `+` panel group (remote hosts
 *    expand into workspaces, both levels searchable, refresh and failure copy),
 *    and the saved `远程 - <title>` row that deletes but does not edit;
 *  - `src/client/api.ts`: the remote-hosts / remote-workspaces / forget routes.
 *
 * A saved remote connection is deleted with `POST .../forget` (stop child,
 * revoke device, remove home) rather than `.../down`; this spec pins both routes
 * at the request level.
 *
 * Runs under plain Node (type stripping) as one in-process script — no test
 * runner and no child processes. The DOM is a minimal fake; `fetch` is stubbed
 * for the route assertions.
 *
 * Run: `node tests/remote-tab-client.spec.ts`
 */

import { downConnection, fetchRemoteHosts, fetchRemoteWorkspaces, forgetConnection } from '../src/client/api.ts'
import { createConnectionList } from '../src/client/ui/connection-list.js'
import {
  connectionOf,
  connectionTypeLabel,
  isLocalTab,
  isRemoteConnection,
  remoteConnectionId,
  remoteHostOf,
  remoteOf,
  remoteTabTitle,
  remoteWorkspaceOf,
  savedRemoteConnection,
  tabOf,
  type RemoteHost,
  type RemoteWorkspace,
  type SavedConnection,
} from '../src/client/types.ts'

let failures = 0
/** Record one assertion; a mismatch counts as a failure. */
function check(condition: unknown, label: string): void {
  if (condition) return
  failures += 1
  console.error(`FAIL: ${label}`)
}

type Listener = (event: Record<string, unknown>) => void

/** One fake DOM element carrying the surface the panel and the helpers touch. */
class FakeElement {
  readonly tag: string
  readonly attrs = new Map<string, string>()
  readonly children: FakeElement[] = []
  readonly listeners = new Map<string, Listener[]>()
  hidden = false
  focused = false
  title = ''
  value = ''
  placeholder = ''
  type = ''
  spellcheck = true
  parent: FakeElement | undefined
  /** Own text; the real `textContent` also aggregates the children's text. */
  private ownText = ''

  constructor(tag: string) {
    this.tag = tag
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join('')
  }

  set textContent(next: string) {
    this.ownText = next
    for (const child of [...this.children]) child.remove()
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value))
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name)
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.remove()
      node.parent = this
      this.children.push(node)
    }
  }

  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of [...this.children]) child.remove()
    this.append(...nodes)
  }

  remove(): void {
    const parent = this.parent
    if (parent === undefined) return
    parent.children.splice(parent.children.indexOf(this), 1)
    this.parent = undefined
  }

  focus(): void {
    this.focused = true
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  dispatch(type: string, extra: Record<string, unknown> = {}): void {
    const event = {
      type,
      target: this,
      stopPropagation: (): void => {},
      ...extra,
    }
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }

  /** @returns every descendant (not this node) matching `[name]` or `[name=value]`. */
  find(selector: string): FakeElement[] {
    const match = /^\[([^=\]]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/.exec(selector)
    const found: FakeElement[] = []
    const walk = (node: FakeElement): void => {
      for (const child of node.children) {
        const name = match?.[1]
        if (name !== undefined) {
          const wanted = match?.[2] ?? match?.[3] ?? match?.[4]
          const actual = child.getAttribute(name)
          if (wanted === undefined ? actual !== null : actual === wanted) found.push(child)
        }
        walk(child)
      }
    }
    walk(this)
    return found
  }
}

/** The fake document the panel creates elements in and registers key handlers on. */
class FakeDocument {
  readonly listeners = new Map<string, Listener[]>()

  createElement(tag: string): FakeElement {
    return new FakeElement(tag)
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type)
    if (list === undefined) return
    this.listeners.set(type, list.filter((candidate) => candidate !== listener))
  }

  dispatch(type: string, extra: Record<string, unknown> = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ type, ...extra })
  }
}

/** Install a fresh fake `document`; returns it for assertions. */
function installFakeDocument(): FakeDocument {
  const document = new FakeDocument()
  ;(globalThis as unknown as { document: unknown }).document = document
  return document
}

/** Let async handlers and their continuations run. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** One saved-connection action set, as the shared list factory takes it. */
interface ConnectionListHandlers {
  onOpen(connection: SavedConnection): Promise<void> | void
  onEdit(connection: SavedConnection): void
  onDelete(connection: SavedConnection): Promise<void> | void
  onPickHost(host: { alias: string }): void
  onPickWslHost(host: { name: string }): void
  onRemoteHost?(host: RemoteHost): Promise<readonly RemoteWorkspace[] | void> | readonly RemoteWorkspace[] | void
  onRemoteWorkspace?(host: RemoteHost, workspace: RemoteWorkspace): Promise<void> | void
  onRefreshRemote?(): Promise<void> | void
}

/** The list factory's returned transitions. */
interface ConnectionList {
  readonly element: HTMLElement
  isOpen(): boolean
  open(): void
  close(): void
  toggle(): void
  setConnections(connections: readonly SavedConnection[]): void
  setSshHosts(hosts: readonly unknown[]): void
  setWslHosts(hosts: readonly unknown[]): void
  setRemoteHosts(hosts: readonly RemoteHost[]): void
  setRemoteWorkspaces(deviceId: string, workspaces: readonly RemoteWorkspace[]): void
  setRemoteError(message: string): void
  fail(message: string): void
  dispose(): void
}

const HOSTS: RemoteHost[] = [
  { deviceId: 'dev-home', name: 'home-server', platform: 'linux', online: true, version: '0.1.0' },
  { deviceId: 'dev-office', name: 'office-pc', platform: 'win32', online: false },
]

const WORKSPACES: Record<string, RemoteWorkspace[]> = {
  'dev-home': [
    { workspaceId: 'ws-wiki', path: '/srv/wiki', title: 'Wiki', backend: 'harness' },
    { workspaceId: 'ws-dsh', path: '/srv/dsh', title: 'dsh-gui' },
  ],
  'dev-office': [],
}

/** The saved connection the remote workspace picker produces. */
const REMOTE_CONNECTION: SavedConnection = savedRemoteConnection(HOSTS[0]!, WORKSPACES['dev-home']![0]!)

/** One SSH connection, to prove the remote group does not disturb the others. */
const SSH_CONNECTION: SavedConnection = { id: 'ssh-peer', title: 'peer', type: 'ssh', ssh: { host: 'peer' } }

/** @returns the panel element as the fake element it really is. */
function panelElement(list: ConnectionList): FakeElement {
  return list.element as unknown as FakeElement
}

/** @returns the remote group's heading text, e.g. `远程主机 (2)`. */
function remoteHeading(list: ConnectionList): string {
  const toggle = panelElement(list).find('[data-dsh-desktop-tabs-section-toggle=remote-hosts]')[0]
  return toggle?.textContent ?? ''
}

/** @returns the remote group's rows container. */
function remoteBody(list: ConnectionList): FakeElement | undefined {
  return panelElement(list).find('[data-dsh-desktop-tabs-section-body=remote-hosts]')[0]
}

/** @returns the panel's status line. */
function statusLine(list: ConnectionList): FakeElement | undefined {
  return panelElement(list).find('[data-dsh-desktop-tabs-panel-status]')[0]
}

/** Types into the search box and lets the panel re-render. */
function search(list: ConnectionList, query: string): void {
  const box = panelElement(list).find('[data-dsh-desktop-tabs-search]')[0]
  if (box === undefined) return
  box.value = query
  box.dispatch('input')
}

/** @returns the remote workspace rows currently rendered. */
function workspaceRows(list: ConnectionList): FakeElement[] {
  return panelElement(list).find('[data-dsh-desktop-tabs-remote-workspace]')
}

/** The remote shapes, their parsers, and the stable saved-connection builder. */
function remoteTypes(): void {
  check(isLocalTab({ id: 'local', title: '本机' }), 'types: a tab with no address source is local')
  check(
    !isLocalTab({ id: 'remote-a', title: 'A', remote: { targetDeviceId: 'd', workspacePath: '/p' } }),
    'types: a remote tab is not local',
  )

  const tab = tabOf({
    id: 'remote-a',
    title: 'A',
    remote: { targetDeviceId: 'dev-home', targetName: 'home-server', workspacePath: '/srv/dsh', backend: 'harness' },
  })
  check(tab?.remote?.targetDeviceId === 'dev-home', 'types: tabOf keeps the remote device')
  check(tab?.remote?.targetName === 'home-server', 'types: tabOf keeps the remote host name')
  check(tab?.remote?.workspacePath === '/srv/dsh', 'types: tabOf keeps the workspace path')
  check(tab?.remote?.backend === 'harness', 'types: tabOf keeps the backend')
  check(tabOf({ id: 'x', title: 'X' })?.remote === undefined, 'types: a plain tab carries no remote spec')
  check(tabOf({ id: 'x', title: 'X', remote: {} })?.remote === undefined, 'types: an invalid remote spec is dropped')

  const connection = connectionOf({
    id: 'remote-a',
    title: 'A',
    type: 'remote',
    remote: { targetDeviceId: 'd', workspacePath: '/p' },
  })
  check(connection?.type === 'remote', 'types: connectionOf keeps the remote kind')
  check(connection?.remote?.targetDeviceId === 'd', 'types: connectionOf keeps the remote device')
  check(
    connectionOf({ id: 'remote-b', title: 'B', remote: { targetDeviceId: 'd', workspacePath: '/p' } })?.type === 'remote',
    'types: a remote spec defaults the kind to remote',
  )
  check(
    connectionOf({ id: 'wsl-x', title: 'X', wsl: { distro: 'archlinux' } })?.type === 'wsl',
    'types: a wsl descriptor still defaults the kind to wsl',
  )
  check(connectionOf({ id: 'ssh-x', title: 'X', ssh: { host: 'peer' } })?.type === 'ssh', 'types: an ssh connection defaults to ssh')

  check(isRemoteConnection(REMOTE_CONNECTION), 'types: a connection with a remote spec is a remote connection')
  check(
    isRemoteConnection({ id: 'remote-lost', title: 'lost', type: 'remote' }),
    'types: a remote-kind connection without its spec still counts as remote (delete must forget)',
  )
  check(!isRemoteConnection(SSH_CONNECTION), 'types: an ssh connection is not remote')
  check(
    !isRemoteConnection({ id: 'wsl-x', title: 'X', type: 'wsl', wsl: { distro: 'archlinux' } }),
    'types: a wsl connection is not remote',
  )

  check(connectionTypeLabel('remote') === '远程', 'types: the remote kind reads 远程')
  check(connectionTypeLabel('ssh') === 'SSH', 'types: ssh still reads SSH')
  check(connectionTypeLabel('wsl') === 'WSL', 'types: wsl still reads WSL')
  check(connectionTypeLabel('acp') === 'ACP', 'types: any other kind is upper-cased')

  check(remoteOf(undefined) === undefined, 'types: a missing remote spec parses as absent')
  check(remoteOf({}) === undefined, 'types: an empty remote spec parses as absent')
  check(remoteOf({ targetDeviceId: 'd' }) === undefined, 'types: a remote spec without a workspace is absent')
  check(remoteOf({ workspacePath: '/p' }) === undefined, 'types: a remote spec without a device is absent')
  check(remoteOf({ targetDeviceId: '  d  ', workspacePath: '/p' })?.targetDeviceId === 'd', 'types: the remote device is trimmed')
  check(remoteOf({ targetDeviceId: 'd', workspacePath: '/p' })?.targetName === undefined, 'types: the host name is optional')

  check(remoteHostOf({ deviceId: 'd', name: 'n', platform: 'linux', online: true, version: '1' })?.online === true, 'types: remoteHostOf keeps online')
  check(remoteHostOf({ deviceId: 'd' })?.name === 'd', 'types: a nameless host is named by its device id')
  check(remoteHostOf({ name: 'n' }) === undefined, 'types: a host without a device id is rejected')
  check(remoteHostOf({ deviceId: 'd', online: 'yes' })?.online === undefined, 'types: a non-boolean online flag is dropped')

  check(remoteWorkspaceOf({ workspaceId: 'w', path: '/p', title: 'T' })?.title === 'T', 'types: remoteWorkspaceOf keeps the title')
  check(remoteWorkspaceOf({ path: '/p' })?.workspaceId === '/p', 'types: a workspace id falls back to the path')
  check(remoteWorkspaceOf({ path: '/p' })?.title === '/p', 'types: a workspace title falls back to the path')
  check(remoteWorkspaceOf({ workspaceId: 'w' }) === undefined, 'types: a workspace without a path is rejected')
  check(remoteWorkspaceOf({ path: '/p', backend: 'harness' })?.backend === 'harness', 'types: the workspace backend is kept')

  const saved = savedRemoteConnection(HOSTS[0]!, WORKSPACES['dev-home']![0]!)
  check(saved.type === 'remote', 'types: the built connection kind is remote')
  check(saved.title === 'home-server · Wiki', 'types: the built connection is titled host · workspace')
  check(saved.remote?.targetDeviceId === 'dev-home', 'types: the built connection carries its device')
  check(saved.remote?.targetName === 'home-server', 'types: the built connection carries the host name')
  check(saved.remote?.workspacePath === '/srv/wiki', 'types: the built connection carries the workspace path')
  check(saved.remote?.backend === 'harness', 'types: the built connection carries the workspace backend')
  check(/^remote-[0-9a-f]{8}$/.test(saved.id), 'types: the connection id is remote-<hash>')
  check(saved.id === remoteConnectionId('dev-home', '/srv/wiki'), 'types: the builder uses the stable id helper')
  check(saved.id === REMOTE_CONNECTION.id, 'types: the same device + workspace yields the same id')
  check(
    remoteConnectionId('dev-home', '/srv/wiki') !== remoteConnectionId('dev-home', '/srv/dsh'),
    'types: a different workspace yields a different id',
  )
  check(
    remoteConnectionId('dev-home', '/srv/wiki') !== remoteConnectionId('dev-office', '/srv/wiki'),
    'types: a different device yields a different id',
  )
  check(
    remoteTabTitle(HOSTS[1]!, { workspaceId: 'w', path: '/p', title: '' }) === 'office-pc · /p',
    'types: an untitled workspace is titled by its path',
  )
}

/** The remote group: hosts, expansion, workspace pick, search, refresh, failures. */
async function remotePanel(): Promise<void> {
  installFakeDocument()
  const recorded = {
    hosts: [] as string[],
    workspaces: [] as string[],
    refreshed: 0,
  }
  // The panel calls back into the caller, which hands the refreshed list back.
  let list: ConnectionList
  const handlers: ConnectionListHandlers = {
    onOpen: async () => {},
    onEdit: () => {},
    onDelete: async (connection) => { recorded.workspaces.push(`delete:${connection.id}`) },
    onPickHost: () => {},
    onPickWslHost: () => {},
    onRemoteHost: async (host) => {
      recorded.hosts.push(host.deviceId)
      return WORKSPACES[host.deviceId] ?? []
    },
    onRemoteWorkspace: async (host, workspace) => {
      recorded.workspaces.push(`${host.deviceId}/${workspace.workspaceId}`)
    },
    onRefreshRemote: async () => {
      recorded.refreshed += 1
      list.setRemoteHosts(HOSTS)
    },
  }
  list = createConnectionList(handlers) as ConnectionList
  list.setRemoteHosts(HOSTS)
  list.setConnections([REMOTE_CONNECTION, SSH_CONNECTION])
  list.open()

  check(remoteHeading(list) === '▾远程主机 (2)', 'panel: the remote group heading carries its count')
  const hostButtons = panelElement(list).find('[data-dsh-desktop-tabs-remote-host]')
  check(hostButtons.length === 2, 'panel: one row per remote host')
  check(hostButtons[0]?.textContent.includes('home-server'), 'panel: a host row shows its name')
  check(hostButtons[0]?.textContent.includes('linux · 在线'), 'panel: a host row shows platform and online state')
  check(hostButtons[1]?.textContent.includes('win32 · 离线'), 'panel: an offline host says so')
  check(hostButtons[0]?.getAttribute('aria-expanded') === 'false', 'panel: hosts start folded')
  check(hostButtons[0]?.title === '远程主机 home-server（平台 linux，在线，版本 0.1.0）', 'panel: the host tooltip describes it')
  check(workspaceRows(list).length === 0, 'panel: a folded host shows no workspaces')

  // Expanding a host loads its workspaces once and lists them beneath it.
  hostButtons[0]?.dispatch('click')
  await tick()
  check(recorded.hosts.join(',') === 'dev-home', 'panel: expanding a host asks the caller for its workspaces')
  check(panelElement(list).find('[data-dsh-desktop-tabs-remote-host]')[0]?.getAttribute('aria-expanded') === 'true', 'panel: the expanded host reports it')
  const rows = workspaceRows(list)
  check(rows.length === 2, 'panel: the expanded host shows its workspaces')
  check(rows[0]?.getAttribute('data-dsh-desktop-tabs-remote-workspace') === 'ws-wiki', 'panel: a workspace row carries its id')
  check(rows[0]?.textContent.includes('Wiki') && rows[0]?.textContent.includes('/srv/wiki'), 'panel: a workspace row shows title and path')
  check(rows[0]?.title === 'Wiki（/srv/wiki）', 'panel: the workspace tooltip names the path')

  // Clicking a workspace forwards the pair and closes the panel.
  rows[0]?.dispatch('click')
  await tick()
  check(recorded.workspaces.join(',') === 'dev-home/ws-wiki', 'panel: a workspace click forwards host and workspace')
  check(list.isOpen() === false, 'panel: a successful workspace pick closes the panel')

  // A search filters hosts and workspaces; a matching workspace reveals its host.
  list.open()
  search(list, 'wiki')
  check(panelElement(list).find('[data-dsh-desktop-tabs-remote-host]').length === 1, 'search: only the matching workspace host stays')
  check(workspaceRows(list).length === 1, 'search: only the matching workspace stays')
  check(workspaceRows(list)[0]?.getAttribute('data-dsh-desktop-tabs-remote-workspace') === 'ws-wiki', 'search: the matching workspace is the wiki one')

  search(list, 'office')
  check(panelElement(list).find('[data-dsh-desktop-tabs-remote-host]').length === 1, 'search: a host name matches its own row')
  check(workspaceRows(list).length === 0, 'search: a folded matching host stays folded')

  search(list, 'zzz')
  check(panelElement(list).find('[data-dsh-desktop-tabs-remote-host]').length === 0, 'search: no matching hosts render')
  const body = remoteBody(list)
  check(
    (body?.find('[data-dsh-desktop-tabs-empty]')[0]?.textContent ?? '') === '没有匹配项',
    'search: a narrowed empty remote group shows the filtered hint',
  )
  search(list, '')

  // The refresh control forwards to the caller, which hands back a fresh list;
  // that resets the expansion state.
  panelElement(list).find('[data-dsh-desktop-tabs-remote-refresh]')[0]?.dispatch('click')
  await tick()
  check(recorded.refreshed === 1, 'panel: the refresh control calls the caller')
  check(panelElement(list).find('[data-dsh-desktop-tabs-remote-host]')[0]?.getAttribute('aria-expanded') === 'false', 'panel: a refreshed host list starts folded again')

  // A caller can seed one host's workspaces without expanding it; the next
  // expand then needs no round trip.
  const loadedHosts = recorded.hosts.length
  list.setRemoteWorkspaces('dev-office', [{ workspaceId: 'ws-office', path: '/w/office', title: 'Office' }])
  panelElement(list).find('[data-dsh-desktop-tabs-remote-host=dev-office]')[0]?.dispatch('click')
  await tick()
  check(recorded.hosts.length === loadedHosts, 'panel: seeded workspaces expand without another discovery call')
  check(
    workspaceRows(list).length === 1 && (workspaceRows(list)[0]?.textContent ?? '').includes('/w/office'),
    'panel: the seeded workspace renders beneath its host',
  )

  // A failed expansion shows the reason and keeps the panel open.
  const failing = createConnectionList({
    ...handlers,
    onRemoteHost: async () => {
      throw new Error('发现工作区失败')
    },
  } as ConnectionListHandlers) as ConnectionList
  failing.setRemoteHosts(HOSTS)
  failing.open()
  panelElement(failing).find('[data-dsh-desktop-tabs-remote-host]')[0]?.dispatch('click')
  await tick()
  check(statusLine(failing)?.textContent === '发现工作区失败', 'panel: a failed expansion reports the reason')
  check(failing.isOpen(), 'panel: a failed expansion keeps the panel open')
  check(workspaceRows(failing).length === 0, 'panel: a failed expansion shows no workspace rows')

  // A failed pick reports the reason and keeps the panel open.
  const failingPick = createConnectionList({
    ...handlers,
    onRemoteWorkspace: async () => {
      throw new Error('保存失败')
    },
  } as ConnectionListHandlers) as ConnectionList
  failingPick.setRemoteHosts(HOSTS)
  failingPick.open()
  panelElement(failingPick).find('[data-dsh-desktop-tabs-remote-host]')[0]?.dispatch('click')
  await tick()
  workspaceRows(failingPick)[0]?.dispatch('click')
  await tick()
  check(statusLine(failingPick)?.textContent === '保存失败', 'panel: a failed workspace pick reports the reason')
  check(failingPick.isOpen(), 'panel: a failed workspace pick keeps the panel open')

  // A remote discovery error can be pushed by the caller (mount / refresh).
  list.setRemoteError('远程主机不可用：ds-harness-remote is not installed')
  check(
    statusLine(list)?.textContent === '远程主机不可用：ds-harness-remote is not installed',
    'panel: setRemoteError shows the reason in the status line',
  )

  // Saved remote connections read `远程 - <title>` and offer delete, not edit.
  const remoteRow = panelElement(list).find('[data-dsh-desktop-tabs-connection]')
  check(remoteRow.length === 2, 'panel: saved connections render beside the remote group')
  const remoteLabel = panelElement(list).find(`[data-dsh-desktop-tabs-connection-open=${REMOTE_CONNECTION.id}]`)[0]
  check(remoteLabel?.textContent === `远程 - ${REMOTE_CONNECTION.title}`, 'panel: a remote connection row reads 远程 - title')
  check(
    remoteLabel?.title === `远程 - ${REMOTE_CONNECTION.title}（主机 home-server，工作区 /srv/wiki）`,
    'panel: the remote row tooltip names host and workspace',
  )
  check(
    panelElement(list).find(`[data-dsh-desktop-tabs-connection-edit=${REMOTE_CONNECTION.id}]`).length === 0,
    'panel: a remote connection offers no edit action',
  )
  const remoteSshEdit = panelElement(list).find('[data-dsh-desktop-tabs-connection-edit=ssh-peer]')
  check(remoteSshEdit.length === 1, 'panel: SSH connections keep their edit action')

  panelElement(list).find(`[data-dsh-desktop-tabs-connection-delete=${REMOTE_CONNECTION.id}]`)[0]?.dispatch('click')
  await tick()
  check(recorded.workspaces.join(',') === `dev-home/ws-wiki,delete:${REMOTE_CONNECTION.id}`, 'panel: deleting a remote row forwards it')

  list.dispose()
  failing.dispose()
  failingPick.dispose()
}

/** One stubbed HTTP answer. */
interface StubAnswer {
  readonly status?: number
  readonly body?: unknown
}

/** Install a `fetch` stub; returns the recorded calls and a restore function. */
function stubFetch(answer: (url: string, init: RequestInit | undefined) => StubAnswer): {
  calls: { url: string; init: RequestInit | undefined }[]
  restore: () => void
} {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const original = globalThis.fetch
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (input: string | URL | Request, init?: RequestInit): Promise<unknown> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, init })
    const { status = 200, body } = answer(url, init)
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }
  }
  return {
    calls,
    restore: () => {
      ;(globalThis as unknown as { fetch: unknown }).fetch = original
    },
  }
}

/** The remote routes: hosts, workspaces, forget, and the failure copy. */
async function remoteApi(): Promise<void> {
  // Hosts: valid rows parse, invalid rows drop, the error rides along.
  let stub = stubFetch(() => ({
    body: {
      hosts: [
        { deviceId: 'dev-home', name: 'home-server', platform: 'linux', online: true },
        { name: 'no-device' },
      ],
      error: 'ds-harness-remote is not installed/enabled',
    },
  }))
  const hostsAnswer = await fetchRemoteHosts()
  check(hostsAnswer.hosts.length === 1, 'api: fetchRemoteHosts drops host rows without a device id')
  check(hostsAnswer.hosts[0]?.name === 'home-server', 'api: fetchRemoteHosts parses the host')
  check(hostsAnswer.error === 'ds-harness-remote is not installed/enabled', 'api: fetchRemoteHosts surfaces the non-fatal reason')
  check(stub.calls[0]?.url === '/desktop-tabs/api/remote-hosts', 'api: fetchRemoteHosts calls the remote-hosts route')
  stub.restore()

  // Workspaces: the query carries the encoded device id.
  stub = stubFetch(() => ({
    body: {
      workspaces: [
        { workspaceId: 'ws-wiki', path: '/srv/wiki', title: 'Wiki', backend: 'harness' },
        { workspaceId: 'ws-bad' },
      ],
      unavailable: [{ backend: 'codex', code: 'not-installed' }],
      error: '主界面处于远程模式',
    },
  }))
  const workspacesAnswer = await fetchRemoteWorkspaces('dev home')
  check(workspacesAnswer.workspaces.length === 1, 'api: fetchRemoteWorkspaces drops rows without a path')
  check(workspacesAnswer.workspaces[0]?.title === 'Wiki', 'api: fetchRemoteWorkspaces parses the workspace')
  check(workspacesAnswer.error === '主界面处于远程模式', 'api: fetchRemoteWorkspaces surfaces the reason')
  check(
    stub.calls[0]?.url === '/desktop-tabs/api/remote-workspaces?targetDeviceId=dev%20home',
    'api: fetchRemoteWorkspaces encodes the target device id',
  )
  stub.restore()

  // A rejected request reports the host's own error text.
  stub = stubFetch(() => ({ status: 400, body: { error: 'invalid targetDeviceId' } }))
  const rejectedWorkspaces = await fetchRemoteWorkspaces('d').then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
  check(rejectedWorkspaces === 'invalid targetDeviceId', 'api: a rejected workspaces request carries the host reason')
  stub.restore()

  // A malformed 200 answer is a protocol failure, not an empty list.
  stub = stubFetch(() => ({ body: { hosts: 'nope' } }))
  const malformedHosts = await fetchRemoteHosts().then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
  check(malformedHosts?.includes('did not return a hosts array') === true, 'api: a malformed hosts answer rejects')
  stub.restore()

  // Forget is a POST to the connection's forget route; down stays a POST too.
  stub = stubFetch(() => ({ body: {} }))
  await forgetConnection('remote-abc')
  check(stub.calls.length === 1, 'api: forgetConnection makes one request')
  check(stub.calls[0]?.url === '/desktop-tabs/api/connections/remote-abc/forget', 'api: forgetConnection calls the forget route')
  check(stub.calls[0]?.init?.method === 'POST', 'api: forgetConnection posts')
  stub.restore()

  stub = stubFetch(() => ({ body: {} }))
  await downConnection('remote-abc')
  check(stub.calls[0]?.url === '/desktop-tabs/api/connections/remote-abc/down', 'api: a remote tab close still calls down')
  check(stub.calls[0]?.init?.method === 'POST', 'api: downConnection posts')
  stub.restore()

  stub = stubFetch(() => ({ status: 500, body: { error: 'forget failed' } }))
  const forgetFailure = await forgetConnection('remote-abc').then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
  check(forgetFailure === 'forget failed', 'api: a failed forget reports the host reason')
  stub.restore()
}

remoteTypes()
await remotePanel()
await remoteApi()

if (failures > 0) {
  console.error(`remote-tab-client: ${failures} assertion(s) failed`)
  process.exitCode = 1
} else {
  console.log('remote-tab-client: all assertions passed')
}
