/**
 * patch-liangshen.mjs — dsh-gui 侧对 liangshen preset 的 Windows 补丁。
 *
 * 上游 dsh-web-ui（git submodule）保持 pristine、不做任何修改：install.mjs
 * 先把上游 presets/liangshen 整目录复制到 .dsh/.agent-presets/liangshen，再
 * 调用本模块把补丁打到安装产物上。补丁只存在于 dsh-gui 仓库。
 *
 * 补丁内容（实现方式参考 presets/anchored-standard 的 custom-bash）：
 *   1. 新增 custom-bash.mjs（vendored from xiaobright/dsh-anchored-standard,
 *      MIT）：Windows 上以普通 subprocess 运行 Git Bash 的同名 `bash` 工具；
 *   2. agent.cordis.yml：
 *      a. persistent-shell 组加 `disabled: !!js process.platform === 'win32'`
 *         （DSH 的 PTY 后端仅支持 linux/darwin，win32 上冷启动 bash 会失败，
 *         bootstrap 无法晋升、固定进入降级）；
 *      b. 新增 custom-bash 行（win32 专属，注册同名 `bash` 工具）；
 *      c. 两处注释补充平台拆分说明；
 *   3. NOTICE 追加 custom-bash.mjs 的出处归属。
 *
 * 所有文本补丁都带锚点校验：上游文件形状变化导致锚点缺失时立即抛错，
 * 绝不静默产出半补丁 preset；对已打过补丁的产物重复执行是 no-op（幂等）。
 */

import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本模块所在目录：plugins/dsh-web-ui/. */
const HERE = dirname(fileURLToPath(import.meta.url))

/** vendored 补丁资产目录：plugins/dsh-web-ui/patches/liangshen/. */
const ASSET_DIR = join(HERE, 'patches', 'liangshen')

/** 读 UTF-8 文本并归一为 LF，同时保留原换行风格用于回写。 */
function readNormalized(file) {
  const raw = readFileSync(file, 'utf8')
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  return { text: raw.replace(/\r\n/g, '\n'), eol }
}

function writeWithEol(file, text, eol) {
  writeFileSync(file, eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text)
}

/** 锚点必须恰好出现一次；marker 已存在则跳过（幂等 no-op）。 */
function assertAnchor(text, anchor, what) {
  const count = text.split(anchor).length - 1
  if (count !== 1) {
    throw new Error(
      `patch-liangshen: ${what} — expected exactly one anchor match, found ${count}; `
      + 'the upstream preset shape changed, review the patch',
    )
  }
}

/** 精确块替换：oldBlock 恰好出现一次，替换为 newBlock。返回动作描述。 */
function patchBlock(text, marker, oldBlock, newBlock, what) {
  if (text.includes(marker)) return { text, applied: false }
  assertAnchor(text, oldBlock, what)
  return { text: text.replace(oldBlock, newBlock), applied: true }
}

/** 在某一行之前插入若干行（锚点行恰好出现一次；marker 已存在则跳过）。 */
function insertBeforeLine(text, marker, anchorLine, insertLines, what) {
  if (text.includes(marker)) return { text, applied: false }
  assertAnchor(text, anchorLine, what)
  return { text: text.replace(anchorLine, [...insertLines, anchorLine].join('\n')), applied: true }
}

/** 在某一行之后插入若干行（锚点行恰好出现一次；marker 已存在则跳过）。 */
function insertAfterLine(text, marker, anchorLine, insertLines, what) {
  if (text.includes(marker)) return { text, applied: false }
  assertAnchor(text, anchorLine, what)
  return { text: text.replace(anchorLine, [anchorLine, ...insertLines].join('\n')), applied: true }
}

/** agent.cordis.yml 的三处补丁，见文件头注释。 */
function patchAgentCordis(file) {
  const { text, eol } = readNormalized(file)
  const applied = []

  // a) 头部注释：平台拆分说明
  const headerOld = '# local filesystem (see the filesystem section below).'
  const headerNew = [
    '# local filesystem (see the filesystem section below).',
    '#',
    "# PLATFORM SPLIT: DSH's PTY backend is linux/darwin-only, so on Windows the",
    '# persistent shell cannot serve the phase-1 `bash` and the session falls into',
    '# the degraded bootstrap instead of promoting. Windows therefore gets the',
    '# bundled `custom-bash` row — the SAME tool name with a Minimal-compatible',
    '# description, executed through the ordinary cross-platform subprocess seam',
    '# (Git Bash, ported from dsh-anchored-standard) — while the persistent shell',
    '# stays byte-identical to Minimal everywhere else. The two rows are',
    "# platform-exclusive (`disabled` flips on win32), so exactly one `bash`",
    '# registers on every platform.',
  ].join('\n')
  let result = patchBlock(text, '# PLATFORM SPLIT:', headerOld, headerNew, 'agent.cordis.yml header comment')
  if (result.applied) applied.push('agent.cordis.yml: header comment')

  // b) persistent-shell 组：win32 禁用（DSH PTY 后端仅 linux/darwin）+ 段内注释
  result = insertAfterLine(
    result.text,
    '# DISABLED ON WINDOWS:',
    '# tradeoff this experimental preset evaluates.',
    [
      '#',
      '# DISABLED ON WINDOWS: DSH\'s PTY backend is linux/darwin-only, so the',
      '# persistent shell cannot serve win32 — the phase-1 bootstrap tool pair loses',
      '# its shell and the session degrades instead of promoting. The `custom-bash`',
      '# row below registers the same `bash` tool name there instead',
      '# (platform-exclusive).',
    ],
    'agent.cordis.yml persistent-shell comment',
  )
  if (result.applied) applied.push('agent.cordis.yml: persistent-shell comment')
  const shellOld = [
    '- id: persistent-shell',
    "  name: cordis:group",
    '  group: true',
    '  isolate:',
  ].join('\n')
  const shellNew = [
    '- id: persistent-shell',
    "  name: cordis:group",
    '  group: true',
    "  disabled: !!js process.platform === 'win32'",
    '  isolate:',
  ].join('\n')
  result = patchBlock(result.text, "disabled: !!js process.platform === 'win32'", shellOld, shellNew, 'agent.cordis.yml persistent-shell disabled')
  if (result.applied) applied.push('agent.cordis.yml: persistent-shell win32 disabled')

  // c) custom-bash 行：插在 filesystem 分节标题之前
  const customBashLines = [
    '# Windows-only `bash` tool (see custom-bash.mjs, ported from',
    '# dsh-anchored-standard): registers the SAME tool name as the persistent shell',
    '# with a Minimal-compatible description, but executes through the ordinary',
    '# cross-platform subprocess seam (`bash -c`, a fresh process per call)',
    '# instead of a PTY, so the phase-1 bootstrap works on win32 instead of falling',
    '# into the degraded fallback. `bashPath` pins Git Bash explicitly so the WSL',
    '# shim on PATH is never picked up. No OS sandbox confinement on Windows',
    "# (landlock is linux-only); the tool description says so.",
    '- id: custom-bash',
    '  name: ./custom-bash.mjs',
    "  disabled: !!js process.platform !== 'win32'",
    '  config:',
    "    bashPath: 'C:\\Program Files\\Git\\bin\\bash.exe'",
    '',
  ]
  result = insertBeforeLine(
    result.text,
    '- id: custom-bash',
    '# ── minimal phase-1 filesystem ──────────────────────────────────────────────',
    customBashLines,
    'agent.cordis.yml custom-bash row',
  )
  if (result.applied) applied.push('agent.cordis.yml: custom-bash row')

  writeWithEol(file, result.text, eol)
  return applied
}

/** NOTICE：追加 custom-bash.mjs 的出处归属。 */
function patchNotice(file) {
  const { text, eol } = readNormalized(file)
  const marker = 'custom-bash.mjs 同样来自'
  const insert = [
    'custom-bash.mjs 同样来自 https://github.com/xiaobright/dsh-anchored-standard（MIT），',
    '为 Windows 提供 phase-1 bash 工具。',
  ]
  const result = insertBeforeLine(text, marker, '原始 DeepSeek 版权和 MIT 许可声明见开源仓库。', insert, 'NOTICE attribution')
  writeWithEol(file, result.text, eol)
  return result.applied ? ['NOTICE: custom-bash attribution'] : []
}

/**
 * 对已复制的 preset 目录打 Windows 补丁（幂等）。返回本次实际应用的动作。
 * @param targetDir - .dsh/.agent-presets/liangshen 安装产物目录。
 */
export function applyLiangshenWindowsPatch(targetDir) {
  const applied = []
  copyFileSync(join(ASSET_DIR, 'custom-bash.mjs'), join(targetDir, 'custom-bash.mjs'))
  applied.push('custom-bash.mjs copied')
  applied.push(...patchAgentCordis(join(targetDir, 'agent.cordis.yml')))
  applied.push(...patchNotice(join(targetDir, 'NOTICE')))
  return applied
}
