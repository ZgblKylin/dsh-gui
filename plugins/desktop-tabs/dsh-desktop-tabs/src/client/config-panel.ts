/**
 * The connection settings panel: account, working directory, start command, and
 * the two built-in command presets.
 *
 * It is opened to the right of the `+` panel, either for a new connection (from
 * an SSH host or WSL distribution row) or for an existing one (the row's 编辑
 * action). The panel owns only its DOM: confirming hands the draft back to the
 * strip, which persists it and opens or reconnects the tab. A rejection keeps
 * the panel open with the reason shown, so a failed save is never silent.
 */

import { connectionTypeLabel } from './types.ts'

/** Marks the config panel element. */
export const CONFIG_PANEL_ATTR = 'data-dsh-desktop-tabs-config'

/** The values one panel session edits. */
export interface ConnectionDraft {
  /** Absent while creating a connection. */
  readonly id?: string
  /** Connection kind: `ssh` or `wsl`; the title prefix and the account hint follow it. */
  readonly kind: string
  readonly title: string
  readonly ssh?: unknown
  readonly wsl?: unknown
  /** Login account, already trimmed; empty means the channel's own default. */
  readonly account: string
  readonly workdir: string
  readonly startCommand: string
}

/** The actions the panel forwards to the strip. */
export interface ConfigPanelHandlers {
  /** Save the draft and open or reconnect its tab; a rejection is shown in the panel. */
  onConfirm(draft: ConnectionDraft): Promise<void>
  /** Dismiss the panel without saving. */
  onCancel(): void
}

/** The panel element and its transitions. */
export interface ConfigPanel {
  /** The panel to append to the document. */
  readonly element: HTMLElement
  /** @returns whether the panel is currently shown. */
  isOpen(): boolean
  /** @param draft - values to edit; `id` present means an existing connection. */
  open(draft: ConnectionDraft): void
  /** Hide the panel and clear its message. */
  close(): void
  /** Report a failure; the panel stays open so the message is readable. */
  fail(message: string): void
  /** Detach the panel and its listeners. */
  dispose(): void
}

/** Work directory placeholder, matching dsh-remote's wording. */
const WORKDIR_PLACEHOLDER = '/srv/dsh 或 $HOME/dsh'

/** Start command placeholder; empty means the connection default. */
const COMMAND_PLACEHOLDER = '留空使用默认命令'

/** Account placeholder, by channel: empty means the channel's own default login. */
const ACCOUNT_SSH_PLACEHOLDER = 'SSH 用户名（留空用 ssh config）'
const ACCOUNT_WSL_PLACEHOLDER = 'WSL 用户名（留空用默认用户）'

/** The two built-in start commands. */
const PRESETS = [`npm '@deepseek-ai/dsh' web`, 'npm run harness'] as const

const NEW_TITLE = '新建'
const EDIT_TITLE = '编辑'
const CONNECTION_SUFFIX = '连接'
const CONFIRM_LABEL = '确认'
const CANCEL_LABEL = '取消'
const PRESETS_LABEL = '预设启动命令'
const CURRENT_MARK = '✓'

/**
 * Create the config panel.
 * @param handlers - the strip's save and dismiss operations.
 * @returns the panel element and its transitions.
 */
export function createConfigPanel(handlers: ConfigPanelHandlers): ConfigPanel {
  const element = document.createElement('div')
  element.setAttribute(CONFIG_PANEL_ATTR, '')
  element.hidden = true

  const heading = document.createElement('p')
  heading.setAttribute('data-dsh-desktop-tabs-config-title', '')

  const account = textInput('data-dsh-desktop-tabs-account', ACCOUNT_SSH_PLACEHOLDER)
  const workdir = textInput('data-dsh-desktop-tabs-workdir', WORKDIR_PLACEHOLDER)
  const command = textInput('data-dsh-desktop-tabs-start-command', COMMAND_PLACEHOLDER)
  const presetsToggle = document.createElement('button')
  presetsToggle.type = 'button'
  presetsToggle.textContent = '▾'
  presetsToggle.title = PRESETS_LABEL
  presetsToggle.setAttribute('aria-label', PRESETS_LABEL)
  presetsToggle.setAttribute('aria-haspopup', 'listbox')
  presetsToggle.setAttribute('aria-expanded', 'false')
  presetsToggle.setAttribute('data-dsh-desktop-tabs-presets-toggle', '')

  const presets = document.createElement('div')
  presets.setAttribute('data-dsh-desktop-tabs-presets', '')
  presets.setAttribute('role', 'listbox')
  presets.hidden = true

  const status = document.createElement('p')
  status.setAttribute('data-dsh-desktop-tabs-config-status', '')
  status.hidden = true

  const confirm = actionButton(CONFIRM_LABEL, 'data-dsh-desktop-tabs-config-confirm')
  const cancel = actionButton(CANCEL_LABEL, 'data-dsh-desktop-tabs-config-cancel')

  const commandRow = document.createElement('div')
  commandRow.setAttribute('data-dsh-desktop-tabs-command-row', '')
  commandRow.append(command, presetsToggle)

  const actions = document.createElement('div')
  actions.setAttribute('data-dsh-desktop-tabs-config-actions', '')
  actions.append(confirm, cancel)

  element.append(
    heading,
    field('账号', account),
    field('工作路径', workdir),
    field('启动命令', commandRow),
    presets,
    status,
    actions,
  )

  let open = false
  let draft: ConnectionDraft | undefined

  const showStatus = (text: string | undefined): void => {
    status.textContent = text ?? ''
    status.hidden = text === undefined
  }

  /** Rebuild the preset list so the current command carries the `✓` marker. */
  const renderPresets = (): void => {
    const current = command.value.trim()
    presets.replaceChildren(...PRESETS.map((preset) => {
      const option = document.createElement('button')
      option.type = 'button'
      option.setAttribute('role', 'option')
      option.setAttribute('data-dsh-desktop-tabs-preset', preset)
      const selected = current === preset
      option.setAttribute('aria-selected', String(selected))
      option.textContent = selected ? `${preset} ${CURRENT_MARK}` : preset
      option.addEventListener('click', () => {
        command.value = preset
        renderPresets()
        togglePresets(false)
      })
      return option
    }))
  }

  const togglePresets = (next: boolean): void => {
    presets.hidden = !next
    presetsToggle.setAttribute('aria-expanded', String(next))
    if (next) renderPresets()
  }

  /**
   * Hide the panel. Named rather than `close`, because the unqualified `close`
   * name is the browser's `window.close` in this document.
   */
  const closePanel = (): void => {
    open = false
    element.hidden = true
    togglePresets(false)
    showStatus(undefined)
    document.removeEventListener('keydown', onKeydown, true)
  }

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    if (!presets.hidden) {
      togglePresets(false)
      return
    }
    closePanel()
  }

  const submit = async (): Promise<void> => {
    if (draft === undefined) return
    const next: ConnectionDraft = {
      ...(draft.id === undefined ? {} : { id: draft.id }),
      kind: draft.kind,
      title: draft.title,
      ...(draft.ssh === undefined ? {} : { ssh: draft.ssh }),
      ...(draft.wsl === undefined ? {} : { wsl: draft.wsl }),
      account: account.value.trim(),
      workdir: workdir.value.trim(),
      startCommand: command.value.trim(),
    }
    try {
      await handlers.onConfirm(next)
    } catch (error: unknown) {
      showStatus(error instanceof Error ? error.message : String(error))
      return
    }
    closePanel()
  }

  presetsToggle.addEventListener('click', () => { togglePresets(presets.hidden) })
  command.addEventListener('input', renderPresets)
  confirm.addEventListener('click', () => { void submit() })
  cancel.addEventListener('click', () => { handlers.onCancel(); closePanel() })

  return {
    element,
    isOpen: () => open,
    open: (next) => {
      draft = next
      const kindLabel = connectionTypeLabel(next.kind)
      heading.textContent = `${next.id === undefined ? NEW_TITLE : EDIT_TITLE} ${kindLabel} ${CONNECTION_SUFFIX}`
      const hint = accountHint(next.kind)
      account.placeholder = hint
      account.setAttribute('aria-label', hint)
      account.value = next.account
      workdir.value = next.workdir
      command.value = next.startCommand
      renderPresets()
      togglePresets(false)
      showStatus(undefined)
      open = true
      element.hidden = false
      document.addEventListener('keydown', onKeydown, true)
      account.focus()
    },
    close: closePanel,
    fail: (text) => { showStatus(text) },
    dispose: () => {
      document.removeEventListener('keydown', onKeydown, true)
      element.remove()
    },
  }
}

/** One labelled field wrapper. */
function field(label: string, control: HTMLElement): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.setAttribute('data-dsh-desktop-tabs-config-field', '')
  const heading = document.createElement('p')
  heading.setAttribute('data-dsh-desktop-tabs-config-label', '')
  heading.textContent = label
  wrapper.append(heading, control)
  return wrapper
}

/** A text input with its marker attribute. */
function textInput(attr: string, placeholder: string): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'text'
  input.spellcheck = false
  input.placeholder = placeholder
  input.setAttribute(attr, '')
  input.setAttribute('aria-label', placeholder)
  return input
}

/** @returns the account placeholder for a connection kind; an unknown kind reads as a channel-neutral default. */
function accountHint(kind: string): string {
  return kind.toLowerCase() === 'wsl' ? ACCOUNT_WSL_PLACEHOLDER : ACCOUNT_SSH_PLACEHOLDER
}

/** A plain panel button with its marker attribute. */
function actionButton(label: string, attr: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.setAttribute(attr, '')
  return button
}
