/**
 * The connection settings panel, as a dependency-free DOM factory shared by both
 * shells: account, working directory, start command, and the two built-in
 * command presets.
 *
 * The caller opens it either for a new connection (from an SSH host or WSL
 * distribution row) or for an existing one (the row's 编辑 action), and positions
 * it itself. The panel owns only its DOM: confirming hands the draft back to the
 * caller, which persists it and opens or reconnects the tab. A rejection keeps
 * the panel open with the reason shown, so a failed save is never silent.
 *
 * This file must stay import-free plain ESM: the desktop shell bundles it into
 * its browser half, and the Tauri shell copies it verbatim into `src-tauri/ui/`.
 *
 * @typedef {object} ConnectionDraft
 * @property {string} [id] Absent while creating a connection.
 * @property {string} [kind] Connection kind: `ssh` or `wsl`; the heading and the account hint follow it.
 * @property {string} title
 * @property {unknown} [ssh]
 * @property {unknown} [wsl]
 * @property {string} [account] Login account; empty means the channel's own default.
 * @property {string} workdir
 * @property {string} startCommand
 *
 * @typedef {object} ConnectionSettingsHandlers
 * @property {(draft: ConnectionDraft) => Promise<void> | void} onConfirm
 *   Save the draft and open or reconnect its tab; a rejection is shown in the panel.
 * @property {() => void} onCancel Dismiss the panel without saving.
 *
 * @typedef {object} ConnectionSettings
 * @property {HTMLElement} element The panel to append to the document.
 * @property {() => boolean} isOpen Whether the panel is currently shown.
 * @property {(draft: ConnectionDraft) => void} open
 *   Open the panel on a draft; `id` present means an existing connection.
 * @property {() => void} close Hide the panel and clear its message.
 * @property {(message: string) => void} fail Report a failure; the panel stays open.
 * @property {() => void} dispose Detach the panel and its listeners.
 */

/** Marks the settings panel element. */
export const CONNECTION_SETTINGS_ATTR = 'data-dsh-desktop-tabs-config'

/** Work directory placeholder, matching dsh-remote's wording. */
const WORKDIR_PLACEHOLDER = '/srv/dsh 或 $HOME/dsh'

/** Start command placeholder; empty means the connection default. */
const COMMAND_PLACEHOLDER = '留空使用默认命令'

/** Account placeholder, by channel: empty means the channel's own default login. */
const ACCOUNT_SSH_PLACEHOLDER = 'SSH 用户名（留空用 ssh config）'
const ACCOUNT_WSL_PLACEHOLDER = 'WSL 用户名（留空用默认用户）'

/** The two built-in start commands. */
const PRESETS = [`npm '@deepseek-ai/dsh' web`, 'npm run harness']

const NEW_TITLE = '新建'
const EDIT_TITLE = '编辑'
const CONNECTION_SUFFIX = '连接'
const CONFIRM_LABEL = '确认'
const CANCEL_LABEL = '取消'
const PRESETS_LABEL = '预设启动命令'
const CURRENT_MARK = '✓'

/**
 * Create the settings panel.
 * @param {ConnectionSettingsHandlers} handlers - the caller's save and dismiss operations.
 * @returns {ConnectionSettings} the panel element and its transitions.
 */
export function createConnectionSettings(handlers) {
  const element = document.createElement('div')
  element.setAttribute(CONNECTION_SETTINGS_ATTR, '')
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
  let draft

  const showStatus = (text) => {
    status.textContent = text ?? ''
    status.hidden = text === undefined
  }

  /** Rebuild the preset list so the current command carries the `✓` marker. */
  const renderPresets = () => {
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

  const togglePresets = (next) => {
    presets.hidden = !next
    presetsToggle.setAttribute('aria-expanded', String(next))
    if (next) renderPresets()
  }

  /**
   * Hide the panel. Named rather than `close`, because the unqualified `close`
   * name is the browser's `window.close` in this document.
   */
  const closePanel = () => {
    open = false
    element.hidden = true
    togglePresets(false)
    showStatus(undefined)
    document.removeEventListener('keydown', onKeydown, true)
  }

  const onKeydown = (event) => {
    if (event.key !== 'Escape') return
    if (!presets.hidden) {
      togglePresets(false)
      return
    }
    closePanel()
  }

  const submit = async () => {
    if (draft === undefined) return
    const next = {
      ...(draft.id === undefined ? {} : { id: draft.id }),
      kind: draftKind(draft),
      title: draft.title,
      ...(draft.ssh === undefined ? {} : { ssh: draft.ssh }),
      ...(draft.wsl === undefined ? {} : { wsl: draft.wsl }),
      account: account.value.trim(),
      workdir: workdir.value.trim(),
      startCommand: command.value.trim(),
    }
    try {
      await handlers.onConfirm(next)
    } catch (error) {
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
      const kind = draftKind(next)
      const kindLabel = connectionTypeLabel(kind)
      heading.textContent = `${next.id === undefined ? NEW_TITLE : EDIT_TITLE} ${kindLabel} ${CONNECTION_SUFFIX}`
      const hint = accountHint(kind)
      account.placeholder = hint
      account.setAttribute('aria-label', hint)
      account.value = typeof next.account === 'string' ? next.account : ''
      workdir.value = typeof next.workdir === 'string' ? next.workdir : ''
      command.value = typeof next.startCommand === 'string' ? next.startCommand : ''
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
function field(label, control) {
  const wrapper = document.createElement('div')
  wrapper.setAttribute('data-dsh-desktop-tabs-config-field', '')
  const heading = document.createElement('p')
  heading.setAttribute('data-dsh-desktop-tabs-config-label', '')
  heading.textContent = label
  wrapper.append(heading, control)
  return wrapper
}

/** A text input with its marker attribute. */
function textInput(attr, placeholder) {
  const input = document.createElement('input')
  input.type = 'text'
  input.spellcheck = false
  input.placeholder = placeholder
  input.setAttribute(attr, '')
  input.setAttribute('aria-label', placeholder)
  return input
}

/** A plain panel button with its marker attribute. */
function actionButton(label, attr) {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.setAttribute(attr, '')
  return button
}

/**
 * @returns the draft's connection kind: `ssh` or `wsl`; a draft that carries a
 * WSL descriptor is a WSL connection, and anything else reads as SSH.
 */
function draftKind(draft) {
  if (typeof draft.kind === 'string' && draft.kind.trim() !== '') return draft.kind.trim()
  return draft.wsl === undefined ? 'ssh' : 'wsl'
}

/** @returns the upper-case label of a connection kind. */
function connectionTypeLabel(kind) {
  const normalized = kind.trim()
  if (normalized.toLowerCase() === 'wsl') return 'WSL'
  if (normalized.toLowerCase() === 'ssh') return 'SSH'
  return normalized.toUpperCase()
}

/** @returns the account placeholder for a connection kind; an unknown kind reads as a channel-neutral default. */
function accountHint(kind) {
  return kind.toLowerCase() === 'wsl' ? ACCOUNT_WSL_PLACEHOLDER : ACCOUNT_SSH_PLACEHOLDER
}
