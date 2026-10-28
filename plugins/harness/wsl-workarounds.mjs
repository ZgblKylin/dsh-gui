/**
 * WSL-specific workarounds: install the WSL skills shipped under
 * `plugins/harness/skills/` into the harness home, append their AGENTS.md
 * sections, and warn when the computer-use virtual desktop services are absent.
 *
 * The paired installers (`browser-use.mjs`, `computer-use.mjs`) install the
 * plugins themselves. This module adds only the pieces those plugins need on
 * WSL — Edge CDP port forwarding and an Xvfb virtual desktop — and is called by
 * `scripts/dsh-gui.mjs` right after `installGlobalTemplate()`: the plugin
 * installers run before the global template, so the AGENTS.md sections cannot
 * be written from them.
 *
 * Two skills are installed into `<DSH_HOME>/skills/` for everyday use. The
 * one-shot `wsl-xvfb-service` skill is NOT installed: it generates the Xvfb and
 * openbox systemd user services once, so it stays in the repository and is only
 * referenced by the install-time warning.
 *
 * Both artefacts follow the same no-overwrite rule as the global template:
 * an installed skill file that already exists is never rewritten, and an
 * AGENTS.md section is appended only when its heading is absent.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url))
const SKILLS_SOURCE = join(HARNESS_DIR, 'skills')

/** One-shot skill that generates the virtual desktop services; never installed into the harness home. */
const ONE_SHOT_SKILL = 'wsl-xvfb-service'
const ONE_SHOT_SKILL_PATH = join('plugins', 'harness', 'skills', ONE_SHOT_SKILL, 'SKILL.md')

/** Systemd user services the computer-use virtual desktop needs. */
const COMPUTER_USE_SERVICES = ['xvfb.service', 'openbox.service']

/**
 * AGENTS.md sections appended for each installed skill. The heading doubles as
 * the idempotency key: a section is appended only when no line equals it.
 */
const WORKAROUNDS = [
  {
    skill: 'wsl-edge-browser-use',
    heading: '## WSL workaround：Edge browser-use 端口转发',
    body: [
      '本节由 dsh-gui 安装脚本在 WSL 环境中自动追加；已有本节时不再重复写入。',
      '',
      'WSL2 的 NAT 网络下，browser-use（Playwright MCP）无法连接 Windows 端 Edge 监听的 127.0.0.1 调试端口。改用 Windows 侧 TCP 转发把调试端口暴露到 Windows 局域网地址，并让 browser-use 以 `mode: attach` 连接。完整步骤、转发脚本与故障排查见 skill `wsl-edge-browser-use`（`<DSH_HOME>/skills/wsl-edge-browser-use/SKILL.md`）。',
    ].join('\n'),
  },
  {
    skill: 'wsl-computer-use',
    heading: '## WSL workaround：computer-use 虚拟桌面',
    body: [
      '本节由 dsh-gui 安装脚本在 WSL 环境中自动追加；已有本节时不再重复写入。',
      '',
      'WSLg 的 Weston 占用窗口管理器且不维护 `_NET_CLIENT_LIST`，Xwayland 的 root window 不可截图，cua-driver 因此无法枚举窗口或截取全屏。computer-use 需要 Xvfb 与 openbox 提供的虚拟桌面。日常用法与限制见 skill `wsl-computer-use`（`<DSH_HOME>/skills/wsl-computer-use/SKILL.md`）。',
    ].join('\n'),
  },
]

/**
 * Detect WSL from the kernel release string. WSL1 and WSL2 both report a
 * Microsoft kernel (`4.4.0-19041-Microsoft`, `microsoft-standard-WSL2`).
 *
 * @returns {boolean} whether the current host is WSL.
 */
export function isWsl() {
  if (process.platform !== 'linux') return false
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'))
  } catch {
    return false
  }
}

/**
 * Render `text` with exactly one trailing newline.
 *
 * @param {string} text - file content.
 * @returns {string} normalized content.
 */
function withTrailingNewline(text) {
  return text.endsWith('\n') ? text : `${text}\n`
}

/**
 * Append one section unless its heading already exists in the file.
 *
 * @param {string} agentsFile - `<DSH_HOME>/AGENTS.md` path.
 * @param {string} heading - section heading, used as the idempotency key.
 * @param {string} body - section body.
 * @returns {boolean} whether the file was written.
 */
function appendSection(agentsFile, heading, body) {
  const current = existsSync(agentsFile) ? readFileSync(agentsFile, 'utf8') : ''
  if (current.split('\n').some((line) => line.trim() === heading)) return false
  writeFileSync(agentsFile, `${withTrailingNewline(current)}\n${heading}\n\n${body}\n`, 'utf8')
  return true
}

/**
 * Install the WSL skills and AGENTS.md sections into a harness home, and report
 * a missing computer-use virtual desktop.
 *
 * @param {object} [options] - install options.
 * @param {string} [options.dshHome] - harness home; defaults to `DSH_HOME`.
 * @param {string} [options.systemdUserDir] - systemd user unit directory; defaults to `~/.config/systemd/user`.
 * @param {boolean} [options.wsl] - override WSL detection (tests).
 * @returns {{
 *   skipped: boolean,
 *   skills: string[],
 *   addedSections: string[],
 *   missingServices: string[],
 *   messages: string[],
 *   warning: string | null,
 * }} installed skill names, appended section headings, missing services,
 *   human-readable log lines, and a plain-text warning for the caller to highlight.
 */
export function installWslWorkarounds({ dshHome, systemdUserDir, wsl = isWsl() } = {}) {
  const home = dshHome ?? process.env.DSH_HOME
  const result = {
    skipped: false,
    skills: [],
    addedSections: [],
    missingServices: [],
    messages: [],
    warning: null,
  }
  if (!wsl) {
    result.skipped = true
    return result
  }
  if (home === undefined || home === '') {
    result.skipped = true
    result.messages.push('wsl-workarounds: DSH_HOME is not set — skipping.')
    return result
  }
  const agentsFile = join(home, 'AGENTS.md')
  for (const { skill, heading, body } of WORKAROUNDS) {
    const source = join(SKILLS_SOURCE, skill, 'SKILL.md')
    const targetDir = join(home, 'skills', skill)
    const target = join(targetDir, 'SKILL.md')
    if (!existsSync(target) && existsSync(source)) {
      mkdirSync(targetDir, { recursive: true })
      copyFileSync(source, target)
      result.skills.push(skill)
      result.messages.push(`wsl-workarounds: installed skill ${skill} into ${targetDir}`)
    }
    if (appendSection(agentsFile, heading, body)) {
      result.addedSections.push(heading)
      result.messages.push(`wsl-workarounds: appended AGENTS.md section "${heading}"`)
    }
  }
  const unitDir = systemdUserDir ?? join(homedir(), '.config', 'systemd', 'user')
  result.missingServices = COMPUTER_USE_SERVICES.filter((name) => !existsSync(join(unitDir, name)))
  if (result.missingServices.length > 0) {
    result.warning = [
      `computer-use 虚拟桌面未安装：缺少 ${result.missingServices.join('、')}。`,
      'WSLg 的 Weston 占用了窗口管理器，cua 无法枚举窗口或截取全屏；computer-use 需要 Xvfb 与 openbox 提供的虚拟桌面。',
      '在 dsh 会话中让 agent 按一次性安装 skill 完成配置：',
      `  ${ONE_SHOT_SKILL_PATH}`,
    ].join('\n')
  }
  return result
}
