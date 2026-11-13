/**
 * Regression test for the two shells' shared connection UI (`src/client/ui/`).
 *
 * Both factories are plain ESM with no imports: the desktop browser half bundles
 * them, and the Tauri shell copies the very same files into `src-tauri/ui/`. The
 * DOM markers below are the contract the desktop stylesheet selects on
 * (`data-dsh-desktop-tabs-*`) and the ones the Tauri page reuses, so this test
 * pins the markers, the Chinese labels, and the interaction semantics (search
 * filter, fold, row actions, preset pick, confirm/cancel, failure messages).
 *
 * Runs under plain Node (type stripping) as one in-process script — no test
 * runner and no child processes. The DOM is a minimal fake: elements with
 * attributes, children, hidden state, value, listeners, and text content.
 *
 * Run: `node tests/shared-ui.spec.ts`
 */

import { CONNECTION_LIST_ATTR, createConnectionList } from '../src/client/ui/connection-list.js'
import { CONNECTION_SETTINGS_ATTR, createConnectionSettings } from '../src/client/ui/connection-settings.js'

let failures = 0
/** @returns whether the assertion held; counts a mismatch as a failure. */
function check(condition: unknown, label: string): void {
  if (condition) return
  failures += 1
  console.error(`FAIL: ${label}`)
}

type Listener = (event: Record<string, unknown>) => void

/** One fake DOM element carrying just the surface the two factories touch. */
class FakeElement {
  readonly tag: string
  readonly attrs = new Map<string, string>()
  readonly children: FakeElement[] = []
  readonly listeners = new Map<string, Listener[]>()
  hidden = false
  value = ''
  title = ''
  type = ''
  spellcheck = true
  placeholder = ''
  focused = false
  parent: FakeElement | undefined
  /** Own text; a real `textContent` also aggregates the children's text. */
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

  /** @returns every descendant (not this node) matching the marker selector `[name]` or `[name=value]`. */
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

/** The fake document the factories create elements through. */
class FakeDocument {
  readonly created: FakeElement[] = []
  readonly listeners = new Map<string, Listener[]>()

  createElement(tag: string): FakeElement {
    const element = new FakeElement(tag)
    this.created.push(element)
    return element
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

/** Let an async handler continuation run. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Read the text of the first match, or `''`. */
function textOf(root: FakeElement, selector: string): string {
  return root.find(selector)[0]?.textContent ?? ''
}

/** Assert the panel markers and Chinese copy the desktop stylesheet selects on. */
function connectionListDom(): void {
  const document = installFakeDocument()
  const list = createConnectionList({
    onOpen: async () => {},
    onEdit: () => {},
    onDelete: async () => {},
    onPickHost: () => {},
    onPickWslHost: () => {},
  })
  const element = list.element as unknown as FakeElement
  const root = document.createElement('div')
  root.append(element)
  check(element.getAttribute(CONNECTION_LIST_ATTR) !== null, 'list: panel marker')
  check(element.hidden === true, 'list: hidden until opened')
  check(element.find('[data-dsh-desktop-tabs-panel-status]').length === 1, 'list: status line marker')
  const search = element.find('[data-dsh-desktop-tabs-search]')[0]
  check(search?.placeholder === '搜索连接、SSH 或 WSL 主机', 'list: search placeholder is the Chinese copy')
  check(element.find('[data-dsh-desktop-tabs-panel-close]').length === 1, 'list: close button marker')
  check(element.find('[data-dsh-desktop-tabs-section=configured]').length === 1, 'list: configured group marker')
  check(element.find('[data-dsh-desktop-tabs-section=ssh-hosts]').length === 1, 'list: SSH host group marker')
  check(element.find('[data-dsh-desktop-tabs-section-toggle=configured]').length === 1, 'list: configured fold toggle')
  check(element.find('[data-dsh-desktop-tabs-section-body=ssh-hosts]').length === 1, 'list: SSH host group body')
  check(element.find('[data-dsh-desktop-tabs-section=wsl-hosts]').length === 1, 'list: WSL host group marker')
  check(element.find('[data-dsh-desktop-tabs-section-toggle=wsl-hosts]').length === 1, 'list: WSL host group fold toggle')
  list.dispose()
  check((document.listeners.get('keydown') ?? []).length === 0 && element.parent === undefined, 'list: dispose detaches')
}

/** Saved connections, the SSH hosts, filtering, folding, and the row actions. */
async function connectionListInteraction(): Promise<void> {
  installFakeDocument()
  const opened: string[] = []
  const edited: string[] = []
  const deleted: string[] = []
  const picked: string[] = []
  const list = createConnectionList({
    onOpen: async (connection) => { opened.push(connection.id) },
    onEdit: (connection) => { edited.push(connection.id) },
    onDelete: async (connection) => { deleted.push(connection.id) },
    onPickHost: (host) => { picked.push(host.alias) },
    onPickWslHost: () => {},
  })
  const element = list.element as unknown as FakeElement
  const configured = element.find('[data-dsh-desktop-tabs-section=configured]')[0]
  const sshHosts = element.find('[data-dsh-desktop-tabs-section=ssh-hosts]')[0]
  if (configured === undefined || sshHosts === undefined) {
    failures += 1
    console.error('FAIL: list: groups missing')
    return
  }
  const rows = (): FakeElement[] => configured.find('[data-dsh-desktop-tabs-connection]')
  const hosts = (): FakeElement[] => sshHosts.find('[data-dsh-desktop-tabs-ssh-host]')
  const empty = (group: FakeElement): string => textOf(group, '[data-dsh-desktop-tabs-empty]')
  const foldLabel = (group: FakeElement): string =>
    group.find('[data-dsh-desktop-tabs-section-toggle]')[0]?.textContent ?? ''

  list.setConnections([
    { id: 'ssh-WSL', title: 'WSL', type: 'ssh', ssh: { host: 'WSL' } },
    { id: 'ssh-orin', title: 'jetson-orin-dev', type: 'ssh', ssh: { host: 'orin' } },
  ])
  list.setSshHosts([
    { alias: 'WSL', hostName: 'wsl.local', user: 'me', port: 2222 },
    { alias: 'orin', hostName: 'jetson-orin-dev' },
  ])
  check(rows().length === 2 && hosts().length === 2, 'list: the groups render from the supplied lists')
  check(element.hidden === true, 'list: the panel stays hidden until opened')
  check(empty(configured) === '', 'list: a populated group has no empty hint')

  list.open()
  check(list.isOpen() && element.hidden === false, 'list: open() shows the panel')
  check(rows().length === 2, 'list: both saved connections render')
  check(foldLabel(configured) === '▾已配置 (2)', 'list: configured heading carries its count')
  const row = rows()[0]
  check(row?.getAttribute('data-dsh-desktop-tabs-connection') === 'ssh-WSL', 'list: connection row carries its id')
  const openButton = row?.find('[data-dsh-desktop-tabs-connection-open=ssh-WSL]')[0]
  check(openButton?.textContent === 'SSH - WSL', 'list: the row label leads with the connection kind')
  check(openButton?.title === 'SSH - WSL（主机 WSL）', 'list: the row label names the SSH host')
  const actions = row?.find('[data-dsh-desktop-tabs-row-actions]')[0]
  check(actions !== undefined, 'list: row actions are grouped')
  const edit = actions?.find('[data-dsh-desktop-tabs-connection-edit=ssh-WSL]')[0]
  const remove = actions?.find('[data-dsh-desktop-tabs-connection-delete=ssh-WSL]')[0]
  check(edit?.textContent === '✎' && edit.title === '编辑', 'list: the edit action is ✎ 编辑')
  check(remove?.textContent === '✕' && remove.title === '删除', 'list: the delete action is ✕ 删除')
  check(hosts().length === 2 && hosts()[0]?.textContent === 'WSL', 'list: SSH hosts render as alias buttons')
  check(hosts()[0]?.title === 'me@wsl.local:2222', 'list: SSH host tooltip describes the destination')
  check(hosts()[1]?.title === 'jetson-orin-dev', 'list: SSH host tooltip falls back to the alias')

  // Search filters both groups by case-insensitive subsequence.
  const search = element.find('[data-dsh-desktop-tabs-search]')[0]
  if (search !== undefined) search.value = 'wsl'
  search?.dispatch('input')
  check(rows().length === 1 && rows()[0]?.getAttribute('data-dsh-desktop-tabs-connection') === 'ssh-WSL', 'list: search filters connections')
  check(hosts().length === 1 && hosts()[0]?.getAttribute('data-dsh-desktop-tabs-ssh-host') === 'WSL', 'list: search filters SSH hosts')
  check(foldLabel(configured) === '▾已配置 (1/2)', 'list: filtered count shows shown/total')
  if (search !== undefined) search.value = 'zzz'
  search?.dispatch('input')
  check(rows().length === 0 && empty(configured) === '没有匹配项', 'list: a filtered group shows 没有匹配项')
  if (search !== undefined) search.value = ''
  search?.dispatch('input')
  check(rows().length === 2, 'list: clearing the search restores the group')

  // Fold state is per group and survives a re-render.
  const configuredToggle = configured.find('[data-dsh-desktop-tabs-section-toggle=configured]')[0]
  configuredToggle?.dispatch('click')
  const configuredBody = configured.find('[data-dsh-desktop-tabs-section-body=configured]')[0]
  check(configuredBody?.hidden === true, 'list: collapsing a group hides its body')
  check(foldLabel(configured) === '▸已配置 (2)', 'list: a collapsed group shows the collapsed arrow')
  check(configuredToggle?.getAttribute('aria-expanded') === 'false', 'list: a collapsed group reports aria-expanded=false')
  configuredToggle?.dispatch('click')
  check(configuredBody?.hidden === false, 'list: expanding a group shows its body again')

  // Row actions forward to the callbacks; a successful open closes the panel.
  rows()[0]?.find('[data-dsh-desktop-tabs-connection-open=ssh-WSL]')[0]?.dispatch('click')
  await tick()
  check(opened.length === 1 && opened[0] === 'ssh-WSL', 'list: clicking a row opens its connection')
  check(list.isOpen() === false && element.hidden === true, 'list: a successful open closes the panel')
  rows()[0]?.find('[data-dsh-desktop-tabs-connection-edit=ssh-WSL]')[0]?.dispatch('click')
  check(edited.length === 1 && edited[0] === 'ssh-WSL', 'list: ✎ forwards the edit')
  list.open()
  rows()[0]?.find('[data-dsh-desktop-tabs-connection-delete=ssh-WSL]')[0]?.dispatch('click')
  await tick()
  check(deleted.length === 1 && deleted[0] === 'ssh-WSL', 'list: ✕ forwards the delete')
  check(element.hidden === true, 'list: a successful delete closes the panel')
  list.open()
  hosts()[0]?.dispatch('click')
  check(picked.length === 1 && picked[0] === 'WSL', 'list: clicking an SSH host forwards it')
  list.dispose()
}

/** A rejected open stays visible instead of closing; `fail` keeps its message for the next open. */
async function connectionListFailures(): Promise<void> {
  const document = installFakeDocument()
  const list = createConnectionList({
    onOpen: async () => { throw new Error('连接失败') },
    onEdit: () => {},
    onDelete: async () => { throw new Error('保存失败') },
    onPickHost: () => {},
    onPickWslHost: () => {},
  })
  const element = list.element as unknown as FakeElement
  list.setConnections([{ id: 'ssh-WSL', title: 'WSL', type: 'ssh', ssh: { host: 'WSL' } }])
  const status = (): FakeElement | undefined => element.find('[data-dsh-desktop-tabs-panel-status]')[0]

  list.open()
  element.find('[data-dsh-desktop-tabs-connection-open=ssh-WSL]')[0]?.dispatch('click')
  await tick()
  check(status()?.textContent === '连接失败' && status()?.hidden === false, 'list: a failed open shows the reason')
  check(list.isOpen() === true, 'list: a failed open keeps the panel open')

  element.find('[data-dsh-desktop-tabs-connection-delete=ssh-WSL]')[0]?.dispatch('click')
  await tick()
  check(status()?.textContent === '保存失败', 'list: a failed delete replaces the message')

  list.close()
  check(element.hidden === true, 'list: close() hides the panel')
  check(status()?.textContent === '保存失败', 'list: close() keeps the last message for the next open')
  list.fail('仍是失败')
  check(status()?.textContent === '仍是失败', 'list: fail() reports while closed')
  list.open()
  check(status()?.textContent === '仍是失败' && status()?.hidden === false, 'list: a pending message is shown on the next open')

  document.dispatch('keydown', { key: 'Escape' })
  check(list.isOpen() === false, 'list: Escape closes the panel')
  list.dispose()
  check(document.listeners.get('keydown')?.length === 0, 'list: dispose removes its Escape listener')
}

/** The settings panel markers, presets, confirm/cancel, and failure handling. */
async function connectionSettings(): Promise<void> {
  const document = installFakeDocument()
  const confirmed: Record<string, unknown>[] = []
  let cancelled = 0
  let failNext = true
  const settings = createConnectionSettings({
    onConfirm: async (draft) => {
      confirmed.push(draft)
      if (failNext) throw new Error('写入失败')
    },
    onCancel: () => { cancelled += 1 },
  })
  const element = settings.element as unknown as FakeElement
  check(element.getAttribute(CONNECTION_SETTINGS_ATTR) !== null, 'settings: panel marker')
  check(element.hidden === true, 'settings: hidden until opened')
  const workdir = element.find('[data-dsh-desktop-tabs-workdir]')[0]
  const command = element.find('[data-dsh-desktop-tabs-start-command]')[0]
  check(workdir?.placeholder === '/srv/dsh 或 $HOME/dsh', 'settings: workdir placeholder')
  check(command?.placeholder === '留空使用默认命令', 'settings: start command placeholder')
  check(element.find('[data-dsh-desktop-tabs-config-field]').length === 3, 'settings: three labelled fields')
  const labels = element.find('[data-dsh-desktop-tabs-config-label]').map((label) => label.textContent)
  check(labels.join(',') === '账号,工作路径,启动命令', 'settings: the field labels are the Chinese copy')
  check(textOf(element, '[data-dsh-desktop-tabs-config-confirm]') === '确认', 'settings: confirm label')
  check(textOf(element, '[data-dsh-desktop-tabs-config-cancel]') === '取消', 'settings: cancel label')
  check(element.find('[data-dsh-desktop-tabs-presets-toggle]').length === 1, 'settings: preset toggle marker')
  check(element.find('[data-dsh-desktop-tabs-presets]')[0]?.hidden === true, 'settings: presets start folded')

  settings.open({ kind: 'ssh', title: 'WSL', ssh: { host: 'WSL' }, account: '', workdir: '', startCommand: '' })
  check(settings.isOpen() && element.hidden === false, 'settings: open() shows the panel')
  check(textOf(element, '[data-dsh-desktop-tabs-config-title]') === '新建 SSH 连接', 'settings: a new draft reads its kind')
  check(element.find('[data-dsh-desktop-tabs-account]')[0]?.focused === true, 'settings: the account takes focus')
  if (workdir !== undefined) workdir.value = '$HOME/dsh'
  if (command !== undefined) command.value = ''
  const presetToggle = element.find('[data-dsh-desktop-tabs-presets-toggle]')[0]
  presetToggle?.dispatch('click')
  const presets = element.find('[data-dsh-desktop-tabs-presets]')[0]
  check(presets?.hidden === false && presetToggle?.getAttribute('aria-expanded') === 'true', 'settings: the preset toggle expands')
  const options = (): FakeElement[] => element.find('[data-dsh-desktop-tabs-preset]')
  check(options().length === 2, 'settings: two built-in presets')
  check(options()[0]?.textContent === `npm '@deepseek-ai/dsh' web`, 'settings: the first preset is the dsh web command')
  check(options()[1]?.textContent === 'npm run harness', 'settings: the second preset is the harness command')
  options()[1]?.dispatch('click')
  check(command?.value === 'npm run harness', 'settings: picking a preset fills the command')
  check(presets?.hidden === true, 'settings: picking a preset folds the list')
  presetToggle?.dispatch('click')
  check(options()[0]?.getAttribute('aria-selected') === 'false', 'settings: the unpicked preset is not selected')
  presetToggle?.dispatch('click')

  // A rejection keeps the panel open with the reason; the draft carries trimmed values and no id.
  if (workdir !== undefined) workdir.value = '  $HOME/dsh  '
  if (command !== undefined) command.value = '  npm run harness  '
  element.find('[data-dsh-desktop-tabs-config-confirm]')[0]?.dispatch('click')
  await tick()
  check(confirmed.length === 1, 'settings: confirm hands the draft back')
  check(confirmed[0]?.workdir === '$HOME/dsh', 'settings: the draft workdir is trimmed')
  check(confirmed[0]?.startCommand === 'npm run harness', 'settings: the draft command is trimmed')
  check(confirmed[0]?.title === 'WSL' && confirmed[0]?.id === undefined, 'settings: a new draft keeps its title and no id')
  check(settings.isOpen() === true, 'settings: a failed confirm keeps the panel open')
  check(textOf(element, '[data-dsh-desktop-tabs-config-status]') === '写入失败', 'settings: a failed confirm shows the reason')

  // An existing connection edits in place; a successful confirm closes.
  failNext = false
  settings.open({ id: 'ssh-WSL', kind: 'ssh', title: 'WSL', ssh: { host: 'WSL' }, account: '', workdir: '/srv/dsh', startCommand: '' })
  check(textOf(element, '[data-dsh-desktop-tabs-config-title]') === '编辑 SSH 连接', 'settings: an existing draft reads its kind')
  check(workdir?.value === '/srv/dsh', 'settings: the workdir is prefilled')
  check(textOf(element, '[data-dsh-desktop-tabs-config-status]') === '', 'settings: opening clears the old reason')
  element.find('[data-dsh-desktop-tabs-config-confirm]')[0]?.dispatch('click')
  await tick()
  check(confirmed[1]?.id === 'ssh-WSL', 'settings: an edited draft keeps its id')
  check(settings.isOpen() === false, 'settings: a successful confirm closes the panel')

  // cancel and Escape both dismiss without saving.
  settings.open({ kind: 'ssh', title: 'orin', ssh: { host: 'orin' }, account: '', workdir: '', startCommand: '' })
  element.find('[data-dsh-desktop-tabs-config-cancel]')[0]?.dispatch('click')
  check(cancelled === 1 && settings.isOpen() === false, 'settings: cancel dismisses the panel')
  settings.open({ kind: 'ssh', title: 'orin', ssh: { host: 'orin' }, account: '', workdir: '', startCommand: '' })
  presetToggle?.dispatch('click')
  document.dispatch('keydown', { key: 'Escape' })
  check(settings.isOpen() === true, 'settings: Escape folds the presets before the panel')
  document.dispatch('keydown', { key: 'Escape' })
  check(settings.isOpen() === false, 'settings: Escape then closes the panel')

  settings.fail('打开失败')
  check(textOf(element, '[data-dsh-desktop-tabs-config-status]') === '打开失败', 'settings: fail() reports a message')
  settings.dispose()
  check(element.parent === undefined && (document.listeners.get('keydown') ?? []).length === 0, 'settings: dispose detaches')
}

connectionListDom()
await connectionListInteraction()
await connectionListFailures()
await connectionSettings()

if (failures > 0) {
  console.error(`shared-ui: ${failures} assertion(s) failed`)
  process.exitCode = 1
} else {
  console.log('shared-ui: all assertions passed')
}
