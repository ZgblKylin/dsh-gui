/**
 * Regression test for the two shells' shared connection UI
 * (`src/client/ui/connection-list.js` and `src/client/ui/connection-settings.js`):
 * the desktop browser half bundles them and the Tauri shell copies the same files
 * into `src-tauri/ui/`.
 *
 * The `+` panel carries a third foldable group for the WSL distributions the host
 * half reports, the same shape as the SSH host group, and a saved connection
 * reads `<kind prefix> - <title>` so `SSH - peer` and `WSL - archlinux` stay
 * distinguishable in one list. The settings panel carries the account field whose
 * placeholder and heading follow the connection kind. Both behaviours are
 * asserted here against a minimal fake DOM; the panels only need elements,
 * attributes, children, listeners, and a document that carries keydown listeners.
 *
 * Runs under plain Node (type stripping) as one in-process script — no test
 * runner and no child processes.
 *
 * Run: `node tests/panel.spec.ts`
 */

import { createConnectionList } from '../src/client/ui/connection-list.js'
import { createConnectionSettings } from '../src/client/ui/connection-settings.js'
import {
  connectionTypeLabel,
  hostOfWsl,
  wslOfDistro,
  type SavedConnection,
  type SshHost,
  type WslHost,
} from '../src/client/types.ts'

/** One saved-connection action set, as the shared list factory takes it. */
interface ConnectionListHandlers {
  onOpen(connection: SavedConnection): Promise<void> | void
  onEdit(connection: SavedConnection): void
  onDelete(connection: SavedConnection): Promise<void> | void
  onPickHost(host: SshHost): void
  onPickWslHost(host: WslHost): void
}

/** The list factory's returned transitions. */
interface ConnectionList {
  readonly element: HTMLElement
  isOpen(): boolean
  open(): void
  close(): void
  toggle(): void
  setConnections(connections: readonly SavedConnection[]): void
  setSshHosts(hosts: readonly SshHost[]): void
  setWslHosts(hosts: readonly WslHost[]): void
  fail(message: string): void
  dispose(): void
}

/** The values one settings session edits. */
interface ConnectionDraft {
  readonly id?: string
  readonly kind: string
  readonly title: string
  readonly ssh?: unknown
  readonly wsl?: unknown
  readonly account: string
  readonly workdir: string
  readonly startCommand: string
}

/** The settings factory's returned transitions. */
interface ConnectionSettings {
  readonly element: HTMLElement
  isOpen(): boolean
  open(draft: ConnectionDraft): void
  close(): void
  fail(message: string): void
  dispose(): void
}

let failures = 0
/** @returns whether the assertion held; counts a mismatch as a failure. */
function check(condition: unknown, label: string): void {
  if (condition) return
  failures += 1
  console.error(`FAIL: ${label}`)
}

/** One synthesised listener event; only the methods the panels call are provided. */
interface FakeEvent {
  readonly type: string
  stopPropagation(): void
  preventDefault(): void
}

type Listener = (event: FakeEvent) => void

/** One fake DOM element with just the surface the panels touch. */
class FakeElement {
  readonly tag: string
  readonly attrs = new Map<string, string>()
  readonly children: FakeElement[] = []
  readonly listeners = new Map<string, Listener[]>()
  parent: FakeElement | undefined
  hidden = false
  focused = false
  title = ''
  value = ''
  placeholder = ''
  type = ''
  spellcheck = true
  private text = ''

  constructor(tag: string) {
    this.tag = tag
  }

  /** Real DOM semantics: assigning replaces the element's content with that text. */
  get textContent(): string {
    return this.text
  }

  set textContent(value: string) {
    this.text = String(value)
    for (const child of this.children) child.parent = undefined
    this.children.length = 0
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value))
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name)
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.remove()
      node.parent = this
      this.children.push(node)
    }
  }

  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of this.children) child.parent = undefined
    this.children.length = 0
    this.append(...nodes)
  }

  remove(): void {
    const parent = this.parent
    if (parent === undefined) return
    const index = parent.children.indexOf(this)
    if (index >= 0) parent.children.splice(index, 1)
    this.parent = undefined
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  dispatch(type: string, extra: Record<string, unknown> = {}): void {
    const event: FakeEvent & Record<string, unknown> = {
      type,
      stopPropagation: () => {},
      preventDefault: () => {},
      ...extra,
    }
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }

  focus(): void {
    this.focused = true
  }
}

/** The fake document the panels create elements in and register key handlers on. */
interface FakeDocument {
  readonly body: FakeElement
  readonly listeners: Map<string, Listener[]>
  createElement(tag: string): FakeElement
  addEventListener(type: string, listener: Listener): void
  removeEventListener(type: string, listener: Listener): void
}

/** Install a fake document; the panels never append themselves, so no body use is needed. */
function installFakeDom(): FakeDocument {
  const body = new FakeElement('body')
  const listeners = new Map<string, Listener[]>()
  const document: FakeDocument = {
    body,
    listeners,
    createElement: (tag: string): FakeElement => new FakeElement(tag),
    addEventListener: (type: string, listener: Listener): void => {
      const list = listeners.get(type) ?? []
      list.push(listener)
      listeners.set(type, list)
    },
    removeEventListener: (type: string, listener: Listener): void => {
      const list = listeners.get(type) ?? []
      listeners.set(type, list.filter((candidate) => candidate !== listener))
    },
  }
  ;(globalThis as unknown as { document: unknown }).document = document
  return document
}

/** Walk every descendant of `root`, `root` included. */
function walk(root: FakeElement, visit: (element: FakeElement) => void): void {
  visit(root)
  for (const child of root.children) walk(child, visit)
}

/** @returns every element whose marker attribute equals `value` (or is merely present). */
function marked(root: FakeElement, attr: string, value?: string): FakeElement[] {
  const found: FakeElement[] = []
  walk(root, (element) => {
    const actual = element.getAttribute(attr)
    if (actual === null) return
    if (value === undefined || actual === value) found.push(element)
  })
  return found
}

/** @returns the one foldable group's root element. */
function group(panel: ConnectionList, name: string): FakeElement {
  const root = marked(panel.element as unknown as FakeElement, 'data-dsh-desktop-tabs-section', name)[0]
  if (root === undefined) throw new Error(`missing section ${name}`)
  return root
}

/** @returns the group heading button. */
function groupToggle(panel: ConnectionList, name: string): FakeElement {
  const toggle = group(panel, name).children.find((child) => child.getAttribute('data-dsh-desktop-tabs-section-toggle') === name)
  if (toggle === undefined) throw new Error(`missing section toggle ${name}`)
  return toggle
}

/** @returns the group's rows container. */
function groupBody(panel: ConnectionList, name: string): FakeElement {
  const body = group(panel, name).children.find((child) => child.getAttribute('data-dsh-desktop-tabs-section-body') === name)
  if (body === undefined) throw new Error(`missing section body ${name}`)
  return body
}

/** @returns the search box. */
function searchBox(panel: ConnectionList): FakeElement {
  const box = marked(panel.element as unknown as FakeElement, 'data-dsh-desktop-tabs-search')[0]
  if (box === undefined) throw new Error('missing search box')
  return box
}

/** Type a query into the search box and let the panel re-render. */
function search(panel: ConnectionList, query: string): void {
  const box = searchBox(panel)
  box.value = query
  box.dispatch('input')
}

/** @returns the visible text of a group heading, e.g. `已配置 (1/2)`. */
function headingText(panel: ConnectionList, name: string): string {
  // The toggle's first child is the fold arrow, the second the label.
  return groupToggle(panel, name).children[1]?.textContent ?? ''
}

/** @returns the account input of the settings panel. */
function accountInput(panel: ConnectionSettings): FakeElement {
  const input = marked(panel.element as unknown as FakeElement, 'data-dsh-desktop-tabs-account')[0]
  if (input === undefined) throw new Error('missing account input')
  return input
}

/** Let a panel's async confirm continuation run. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const SSH_CONNECTION: SavedConnection = {
  id: 'ssh-peer',
  title: 'peer',
  type: 'ssh',
  ssh: { host: 'peer' },
  workdir: '/srv/dsh',
}

const WSL_CONNECTION: SavedConnection = {
  id: 'wsl-archlinux',
  title: 'archlinux',
  type: 'wsl',
  wsl: { distro: 'archlinux' },
  account: 'chongfei',
}

const SSH_HOSTS: SshHost[] = [
  { alias: 'peer', hostName: 'peer.example', user: 'chongfei' },
  { alias: 'jetson', hostName: 'jetson-orin-dev' },
]

const WSL_HOSTS: WslHost[] = [
  { name: 'archlinux', state: 'Running', version: 2, default: true },
  { name: 'Ubuntu', state: 'Stopped', version: 2 },
]

/** Recording handlers, so the panel's callbacks can be asserted after a click. */
function recordingHandlers(): {
  handlers: ConnectionListHandlers
  opened: string[]
  edited: string[]
  deleted: string[]
  pickedSsh: string[]
  pickedWsl: string[]
} {
  const opened: string[] = []
  const edited: string[] = []
  const deleted: string[] = []
  const pickedSsh: string[] = []
  const pickedWsl: string[] = []
  return {
    opened,
    edited,
    deleted,
    pickedSsh,
    pickedWsl,
    handlers: {
      onOpen: async (connection) => { opened.push(connection.id) },
      onEdit: (connection) => { edited.push(connection.id) },
      onDelete: async (connection) => { deleted.push(connection.id) },
      onPickHost: (host) => { pickedSsh.push(host.alias) },
      onPickWslHost: (host) => { pickedWsl.push(host.name) },
    },
  }
}

/** Saved-connection rows: kind prefix, title details, and type-prefix search. */
function configuredRows(): void {
  installFakeDom()
  const recording = recordingHandlers()
  const panel = createConnectionList(recording.handlers)
  panel.setConnections([SSH_CONNECTION, WSL_CONNECTION])
  panel.setSshHosts(SSH_HOSTS)
  panel.setWslHosts(WSL_HOSTS)
  panel.open()
  check(panel.isOpen(), 'configured: panel opens')

  const rows = marked(panel.element as unknown as FakeElement, 'data-dsh-desktop-tabs-connection')
  check(rows.length === 2, 'configured: one row per saved connection')
  const labels = marked(panel.element as unknown as FakeElement, 'data-dsh-desktop-tabs-connection-open')
  check(labels[0]?.textContent === 'SSH - peer', 'configured: ssh row reads its kind prefix and title')
  check(labels[1]?.textContent === 'WSL - archlinux', 'configured: wsl row reads its kind prefix and title')
  check(labels[0]?.title === 'SSH - peer（主机 peer）', 'configured: ssh row title carries the host')
  check(
    labels[1]?.title === 'WSL - archlinux（发行版 archlinux，账号 chongfei）',
    'configured: wsl row title carries the distribution and the account',
  )
  check(headingText(panel, 'configured') === '已配置 (2)', 'configured: heading shows shown/total')

  labels[0]?.dispatch('click')
  check(recording.opened.join(',') === 'ssh-peer', 'configured: clicking a row opens its connection')
  const editButtons = marked(panel.element as unknown as FakeElement, 'data-dsh-desktop-tabs-connection-edit', 'ssh-peer')
  editButtons[0]?.dispatch('click')
  check(recording.edited.join(',') === 'ssh-peer', 'configured: the edit glyph edits the row')
  const deleteButtons = marked(panel.element as unknown as FakeElement, 'data-dsh-desktop-tabs-connection-delete', 'wsl-archlinux')
  deleteButtons[0]?.dispatch('click')
  check(recording.deleted.join(',') === 'wsl-archlinux', 'configured: the delete glyph deletes the row')

  // The kind prefix is searchable: `ssh` keeps the SSH connection and every SSH
  // host, while `wsl` keeps the WSL connection and every WSL distribution.
  search(panel, 'ssh')
  const sshRows = marked(panel.element as unknown as FakeElement, 'data-dsh-desktop-tabs-connection')
  check(sshRows.length === 1 && sshRows[0]?.getAttribute('data-dsh-desktop-tabs-connection') === 'ssh-peer', 'configured: searching the ssh prefix keeps the ssh row')
  check(headingText(panel, 'configured') === '已配置 (1/2)', 'configured: filtered heading shows the total')
  check(marked(panel.element as unknown as FakeElement, 'data-dsh-desktop-tabs-ssh-host').length === 2, 'search: the ssh prefix keeps the ssh hosts')
  check(marked(panel.element as unknown as FakeElement, 'data-dsh-desktop-tabs-wsl-host').length === 0, 'search: the ssh prefix filters out the wsl hosts')
  check(marked(panel.element as unknown as FakeElement, 'data-dsh-desktop-tabs-empty').length === 1, 'search: the emptied wsl group shows its filtered hint')

  search(panel, 'wsl')
  const wslRows = marked(panel.element as unknown as FakeElement, 'data-dsh-desktop-tabs-connection')
  check(wslRows.length === 1 && wslRows[0]?.getAttribute('data-dsh-desktop-tabs-connection') === 'wsl-archlinux', 'configured: searching the wsl prefix keeps the wsl row')
  check(marked(panel.element as unknown as FakeElement, 'data-dsh-desktop-tabs-wsl-host').length === 2, 'search: the wsl prefix keeps every wsl distribution')
  check(marked(panel.element as unknown as FakeElement, 'data-dsh-desktop-tabs-ssh-host').length === 0, 'search: the wsl prefix filters out the ssh hosts')

  // The distribution name is searchable too.
  search(panel, 'ubuntu')
  const distroRows = marked(panel.element as unknown as FakeElement, 'data-dsh-desktop-tabs-wsl-host')
  check(distroRows.length === 1 && distroRows[0]?.textContent === 'Ubuntu', 'search: the distribution name filters the wsl group')

  panel.dispose()
}

/** The WSL host group: rendering, hover text, click callback, and both empty states. */
function wslHosts(): void {
  installFakeDom()
  const recording = recordingHandlers()
  const panel = createConnectionList(recording.handlers)
  panel.setWslHosts(WSL_HOSTS)
  panel.open()

  check(headingText(panel, 'wsl-hosts') === 'WSL 主机 (2)', 'wsl group: heading shows the count')
  const rows = marked(panel.element as unknown as FakeElement, 'data-dsh-desktop-tabs-wsl-host')
  check(rows.length === 2, 'wsl group: one row per distribution')
  check(rows[0]?.textContent === 'archlinux' && rows[1]?.textContent === 'Ubuntu', 'wsl group: rows read the distribution name')
  check(
    rows[0]?.title === 'WSL 发行版 archlinux（运行中，版本 2，默认）',
    'wsl group: default distribution title carries state, version, and default mark',
  )
  check(
    rows[1]?.title === 'WSL 发行版 Ubuntu（已停止，版本 2）',
    'wsl group: non-default distribution title omits the default mark',
  )

  rows[0]?.dispatch('click')
  check(recording.pickedWsl.join(',') === 'archlinux', 'wsl group: clicking a row configures that distribution')

  // No distribution at all is the group's own empty state, distinct from the
  // filtered one.
  panel.setWslHosts([])
  const emptyHints = marked(panel.element as unknown as FakeElement, 'data-dsh-desktop-tabs-empty')
    .filter((hint) => hint.textContent === '没有可用的 WSL 发行版')
  check(emptyHints.length === 1, 'wsl group: an empty list says there is no available distribution')
  check(headingText(panel, 'wsl-hosts') === 'WSL 主机 (0)', 'wsl group: an empty heading shows zero')

  panel.setWslHosts(WSL_HOSTS)
  search(panel, 'zzz')
  // With nothing matching, all three groups fall back to the filtered hint.
  const filteredHints = marked(panel.element as unknown as FakeElement, 'data-dsh-desktop-tabs-empty')
    .filter((hint) => hint.textContent === '没有匹配项')
  check(filteredHints.length === 3, 'wsl group: a narrowing search shows the filtered hint, not the empty hint')

  panel.dispose()
}

/** The settings panel: account placeholder, backfill, heading, and the confirmed draft. */
async function configPanel(): Promise<void> {
  installFakeDom()
  const drafts: ConnectionDraft[] = []
  const panel = createConnectionSettings({
    onConfirm: async (draft) => { drafts.push(draft) },
    onCancel: () => {},
  })

  // Editing an SSH connection backfills every field, including the account.
  panel.open({
    id: 'ssh-peer',
    kind: 'ssh',
    title: 'peer',
    ssh: { host: 'peer' },
    account: 'chongfei',
    workdir: '/srv/dsh',
    startCommand: 'npm run harness',
  })
  const title = marked(panel.element as unknown as FakeElement, 'data-dsh-desktop-tabs-config-title')[0]
  check(title?.textContent === '编辑 SSH 连接', 'config: the heading names the kind being edited')
  const fields = marked(panel.element as unknown as FakeElement, 'data-dsh-desktop-tabs-config-field')
  check(fields[0]?.children[0]?.textContent === '账号', 'config: the account field leads the form')
  const account = accountInput(panel)
  check(account.placeholder === 'SSH 用户名（留空用 ssh config）', 'config: the ssh account placeholder mentions ssh config')
  check(account.getAttribute('aria-label') === account.placeholder, 'config: the account hint is announced too')
  check(account.value === 'chongfei', 'config: editing backfills the account')

  // A new WSL connection starts empty, with the WSL account wording and heading.
  panel.open({ kind: 'wsl', title: 'archlinux', wsl: wslOfDistro('archlinux'), account: '', workdir: '', startCommand: '' })
  check(title?.textContent === '新建 WSL 连接', 'config: the heading names a new WSL connection')
  check(accountInput(panel).placeholder === 'WSL 用户名（留空用默认用户）', 'config: the wsl account placeholder mentions the default user')
  check(accountInput(panel).value === '', 'config: a new connection starts without an account')

  accountInput(panel).value = '  chongfei  '
  const workdir = marked(panel.element as unknown as FakeElement, 'data-dsh-desktop-tabs-workdir')[0]
  const command = marked(panel.element as unknown as FakeElement, 'data-dsh-desktop-tabs-start-command')[0]
  if (workdir === undefined || command === undefined) throw new Error('missing fields')
  workdir.value = ' /home/chongfei/dsh '
  command.value = ' npm run harness '
  const confirm = marked(panel.element as unknown as FakeElement, 'data-dsh-desktop-tabs-config-confirm')[0]
  confirm?.dispatch('click')
  await tick()

  const confirmed = drafts[0]
  check(confirmed?.kind === 'wsl', 'config: the confirmed draft carries the connection kind')
  check(hostOfWsl(confirmed?.wsl) === 'archlinux', 'config: the confirmed draft carries the distribution')
  check(confirmed?.account === 'chongfei', 'config: the confirmed draft carries the trimmed account')
  check(confirmed?.workdir === '/home/chongfei/dsh', 'config: the confirmed draft carries the trimmed workdir')
  check(confirmed?.startCommand === 'npm run harness', 'config: the confirmed draft carries the trimmed command')
  check(confirmed?.id === undefined, 'config: a new connection confirms without an id')
  check(panel.isOpen() === false, 'config: a successful confirm closes the panel')

  // Re-editing keeps the id, so the strip updates the connection instead of adding one.
  panel.open({ id: 'wsl-archlinux', kind: 'wsl', title: 'archlinux', wsl: wslOfDistro('archlinux'), account: 'chongfei', workdir: '', startCommand: '' })
  marked(panel.element as unknown as FakeElement, 'data-dsh-desktop-tabs-config-confirm')[0]?.dispatch('click')
  await tick()
  check(drafts[1]?.id === 'wsl-archlinux', 'config: editing confirms the existing id')

  panel.dispose()
}

/** The new type helpers: kind labels and the opaque WSL descriptor's distro read. */
function typeHelpers(): void {
  check(connectionTypeLabel('ssh') === 'SSH', 'types: ssh reads SSH')
  check(connectionTypeLabel('wsl') === 'WSL', 'types: wsl reads WSL')
  check(connectionTypeLabel('acp') === 'ACP', 'types: any other kind is upper-cased')
  check(hostOfWsl(wslOfDistro('archlinux')) === 'archlinux', 'types: wslOfDistro round-trips through hostOfWsl')
  check(hostOfWsl({ distro: '' }) === undefined, 'types: the default distribution names no host')
  check(hostOfWsl(undefined) === undefined, 'types: a missing descriptor names no host')
}

configuredRows()
wslHosts()
await configPanel()
typeHelpers()

if (failures > 0) {
  console.error(`panel: ${failures} assertion(s) failed`)
  process.exitCode = 1
} else {
  console.log('panel: all assertions passed')
}
