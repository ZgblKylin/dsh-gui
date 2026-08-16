/**
 * patch-sidebar-qa.mjs — dsh-gui 侧对 maid-atelier 皮肤的 sidebar-qa 布局补丁。
 *
 * 上游 dsh-deep-whale（git submodule）保持 pristine、不做任何修改：
 * plugins/deep-whale/install.mjs 先把
 * dsh-deep-whale/maid-atelier 复制到 DSH_HOME 下的安装产物目录，再调用本模块
 * 把补丁打到该安装产物上。补丁只存在于 dsh-gui 仓库。
 *
 * 背景：dsh-sidebar-qa 的追问面板由 dsh-better-sidebar 托管，右面板与底部
 * 面板通过 html 上的 `--dsh-sidebar-width` / `--dsh-sidebar-height` 把主对话
 * 区域推开。maid-atelier 原实现把宫殿背景直接写在 body 上、并把角色舞台固定
 * 为全视口，因此背景与鲸鱼娘立绘会从半透明的 better-sidebar 面板后面透出来。
 *
 * 补丁内容：
 *   1. 新增皮肤自有的 `palace-stage` 层：把 body 背景图迁移到该固定层，按
 *      better-sidebar 的两个布局变量收缩（变量缺省为 0，未装 better-sidebar
 *      时逐像素保持原外观）；
 *   2. 角色舞台、顶部帘幕、底部饰带同步避开右面板/底部面板；角色高度在
 *      底部面板打开时按剩余高度收缩；
 *   3. 右女仆不再额外向左平移 24vw——舞台右缘已经让开右面板，平移量恢复为
 *      未开面板时的贴边值；窄视口下仍按上游逻辑隐藏右女仆。
 *
 * 所有文本补丁都带锚点校验：上游 bundle 形状变化导致锚点缺失时立即抛错，
 * 绝不静默产出半补丁 bundle；对已打过补丁的产物重复执行是 no-op（幂等）。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
function patchOnce(text, marker, oldBlock, newBlock, what) {
  if (text.includes(marker)) return { text, applied: false }
  const count = text.split(oldBlock).length - 1
  if (count !== 1) {
    throw new Error(
      `patch-sidebar-qa: ${what} — expected exactly one anchor match, found ${count}; `
      + 'the upstream maid-atelier bundle changed, review the patch',
    )
  }
  return { text: text.replace(oldBlock, newBlock), applied: true }
}

const PALACE_STAGE_MARKER = '// dsh-gui: sidebar-qa layout patch — palace stage'
const BACKDROP_SYNC_MARKER = '// dsh-gui: sidebar-qa layout patch — sync backdrop'
const CSS_MARKER = '/* dsh-gui: sidebar-qa layout patch'

const PALACE_STAGE_FACTORY_OLD = [
  '\t\treturn stage;',
  '\t\t}',
  '\t\tfunction hasAcceleratedWebGL() {',
].join('\n')

const PALACE_STAGE_FACTORY_NEW = [
  '\t\treturn stage;',
  '\t\t}',
  '\t\t// dsh-gui: sidebar-qa layout patch — palace stage: an owned fixed layer',
  '\t\t// constrained by better-sidebar\'s layout variables so the palace never',
  '\t\t// paints under the right/bottom panels.',
  '\t\tfunction createPalaceStage() {',
  '\t\t\tconst stage = document.createElement("div");',
  '\t\t\tstage.dataset.skinChrome = "palace-stage";',
  '\t\t\tstage.dataset.skinOwner = SKIN_OWNER;',
  '\t\t\tstage.setAttribute("aria-hidden", "true");',
  '\t\t\tstage.style.backgroundPosition = "center top";',
  '\t\t\tstage.style.backgroundSize = "cover";',
  '\t\t\tstage.style.backgroundRepeat = "no-repeat";',
  '\t\t\treturn stage;',
  '\t\t}',
  '\t\tfunction hasAcceleratedWebGL() {',
].join('\n')

const SYNC_BACKDROP_OLD = [
  '\t\t\tconst syncBackdrop = () => {',
  '\t\t\t\tconst source = body.hasAttribute("data-ds-dark-theme") ? MAID_ATELIER_PALACE_DARK : MAID_ATELIER_PALACE_LIGHT;',
  '\t\t\t\tbody.style.setProperty("background-image", `url(${source})`);',
  '\t\t\t};',
].join('\n')

const SYNC_BACKDROP_NEW = [
  '\t\t\t// dsh-gui: sidebar-qa layout patch — sync backdrop to the owned stage;',
  '\t\t\t// the body keeps its base color only, so translucent panels never show',
  '\t\t\t// the palace behind them.',
  '\t\t\tconst palaceStage = createPalaceStage();',
  '\t\t\townedNodes.add(palaceStage);',
  '\t\t\tbody.prepend(palaceStage);',
  '\t\t\tbody.style.setProperty("background-image", "none");',
  '\t\t\tconst syncBackdrop = () => {',
  '\t\t\t\tconst source = body.hasAttribute("data-ds-dark-theme") ? MAID_ATELIER_PALACE_DARK : MAID_ATELIER_PALACE_LIGHT;',
  '\t\t\t\tpalaceStage.style.backgroundImage = `url(${source})`;',
  '\t\t\t};',
].join('\n')

const CSS_END_ANCHOR = '}\";\n\t\tconst tagId = "@dsh-external/dsh-client-ui-skin-maid-atelier/maid-atelier.module.css";'

const CSS_PATCH = [
  '/* dsh-gui: sidebar-qa layout patch — keep palace, characters and trims out of',
  '   better-sidebar\'s right/bottom panels. The variables default to 0px when',
  '   dsh-better-sidebar is absent, so the original full-viewport composition',
  '   is preserved pixel-for-pixel. */',
  'body[data-dsh-maid-atelier] [data-skin-chrome=palace-stage]{position:fixed;top:0;right:var(--dsh-sidebar-width,0px);bottom:var(--dsh-sidebar-height,0px);left:0;z-index:-1;overflow:hidden;pointer-events:none;contain:strict}',
  'body[data-dsh-maid-atelier] [data-skin-chrome=character-stage]{right:var(--dsh-sidebar-width,0px);bottom:var(--dsh-sidebar-height,0px)}',
  'body[data-dsh-maid-atelier] [data-skin-chrome=top-trim]{right:var(--dsh-sidebar-width,0px)}',
  'body[data-dsh-maid-atelier] [data-skin-chrome=bottom-trim]{right:var(--dsh-sidebar-width,0px);bottom:var(--dsh-sidebar-height,0px)}',
  'body[data-dsh-maid-atelier] [data-maid-character=left]{height:min(clamp(560px,96vh,1180px),calc(100vh - var(--dsh-sidebar-height,0px)))}',
  'body[data-dsh-maid-atelier] [data-maid-character=right]{height:min(clamp(540px,92vh,1120px),calc(100vh - var(--dsh-sidebar-height,0px)))}',
  'body[data-dsh-maid-atelier][data-maid-chat-active] [data-maid-character=left]{height:min(clamp(420px,64vh,760px),calc(100vh - var(--dsh-sidebar-height,0px)))}',
  'body[data-dsh-maid-atelier][data-maid-chat-active] [data-maid-character=right]{height:min(clamp(420px,62vh,730px),calc(100vh - var(--dsh-sidebar-height,0px)))}',
  'body[data-dsh-maid-atelier][data-maid-better-sidebar-open] [data-maid-character=right]{translate:clamp(-8px,-0.2vw,0)}',
  'body[data-dsh-maid-atelier][data-maid-better-sidebar-open][data-maid-chat-active] [data-maid-character=right]{opacity:.9;height:min(clamp(420px,62vh,730px),calc(100vh - var(--dsh-sidebar-height,0px)));translate:clamp(-8px,-0.5vw,0)}',
  '@media (width<=700px){body[data-dsh-maid-atelier][data-maid-better-sidebar-open] [data-maid-character=right]{opacity:0;translate:0}body[data-dsh-maid-atelier][data-maid-chat-active] [data-maid-character=left]{height:min(clamp(300px,46vh,410px),calc(100vh - var(--dsh-sidebar-height,0px)))}body[data-dsh-maid-atelier][data-maid-chat-active] [data-maid-character=right]{height:min(clamp(300px,44vh,390px),calc(100vh - var(--dsh-sidebar-height,0px)))}}',
].join('')

const CSS_PATCHED_END = `${CSS_PATCH}${CSS_END_ANCHOR}`

/**
 * 对安装产物里的 maid-atelier 预构建 bundle 打 sidebar-qa 布局补丁（幂等）。
 * @param {string} packageDir - 已复制的 maid-atelier 包目录。
 * @returns {string[]} 本次实际应用的动作。
 */
export function applyMaidAtelierSidebarQaPatch(packageDir) {
  const bundle = join(packageDir, 'lib', 'client.js')
  const { text, eol } = readNormalized(bundle)
  const applied = []

  let result = patchOnce(text, PALACE_STAGE_MARKER, PALACE_STAGE_FACTORY_OLD, PALACE_STAGE_FACTORY_NEW, 'palace-stage factory')
  if (result.applied) applied.push('lib/client.js: palace-stage factory')

  result = patchOnce(result.text, BACKDROP_SYNC_MARKER, SYNC_BACKDROP_OLD, SYNC_BACKDROP_NEW, 'palace backdrop sync')
  if (result.applied) applied.push('lib/client.js: palace backdrop sync')

  result = patchOnce(result.text, CSS_MARKER, CSS_END_ANCHOR, CSS_PATCHED_END, 'sidebar-qa layout CSS')
  if (result.applied) applied.push('lib/client.js: sidebar-qa layout CSS')

  writeWithEol(bundle, result.text, eol)
  return applied
}
