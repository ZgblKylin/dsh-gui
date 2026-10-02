// inject-config.mjs — dsh-pet 用户配置注入：屏蔽桌面模式（Electron 透明窗）
//
// 原理：dsh-pet 的桌面可见性由上游 readAllConfig() 合并后的宠物 display 决定
// （web / desktop / both / none），只有存在 display∈{desktop,both} 的宠物时
// hasDesktopPet 才为 true，才会去探测/下载/拉起 Electron Helper（上游
// src/host/index.ts 的 startHelper()/launchHelper() 在 !hasDesktopPet 时直接返回）。
// 内置默认配置 assets/config.jsonc 的宠物 display 是 both，因此装完必开桌面。
// 本模块只向用户层配置注入 display:"web" 的默认宠物，把 hasDesktopPet 置 false
// ——不探测、不下载、不 spawn，浏览器 overlay / 设置页 / 余额 / 碎碎念 / 对话全部保留。
// 绝不改包内默认配置。

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 默认宠物条目：除 whisperEnabled（本 wrapper 固定关闭）外，字段与包内
 * assets/config.jsonc 的 pets[0]（main）对齐，display 改为 "web"。
 * display 必须显式写：上游 mergePet 对缺失 display 会回落 base（内置默认 both），
 * 不写就等于没注入。
 */
export const DEFAULT_PET = {
  id: 'main',
  name: '蓝毛小女仆',
  size: 462,
  balanceEnabled: true,
  // 碎碎念每次生成都会调用当前对话的模型；本地单并发 LLM 下，后台碎碎念会顶掉正在
  // 运行任务的 KV cache，因此本 wrapper 固定关闭，需要时在设置页开启。
  whisperEnabled: false,
  workStatusEnabled: true,
  display: 'web',
  position: { corner: 'top-right', marginX: 24, marginY: 100 },
}

/**
 * 用户层配置文件的生效路径。0.3 起上游以 `main-config.jsonc` 为生效文件，
 * 迁移前遗留的 `main-config.json` 仍被读取（并会在启动时重命名为 .jsonc），
 * 因此已有旧文件时继续就地注入，避免另建 .jsonc 抢占优先级、让用户既有设置失效。
 */
export function petConfigPath(dshHome) {
  const dir = join(dshHome, 'dsh-pet')
  const jsonc = join(dir, 'main-config.jsonc')
  if (existsSync(jsonc)) return jsonc
  const legacy = join(dir, 'main-config.json')
  return existsSync(legacy) ? legacy : jsonc
}

const serialize = (cfg) => JSON.stringify(cfg, null, 2) + '\n'
const seed = () => serialize({ pets: [DEFAULT_PET] })

/**
 * 注入「每只宠物 display 显式 web」到用户层配置。
 *
 * 规则（与 wrapper 安装要求一致，幂等）：
 *   - 文件不存在 → 建立：写入仅含默认宠物（display=web）的 pets，返回 'created'；
 *   - 已存在且任一只宠物带 display 字段 → 不动用户配置，返回 'skipped'；
 *   - 已存在但无任何 display（旧格式 / 手写未配）→ 补默认：宠物为空则置入默认
 *     宠物，否则给每只已存在的宠物补 display:"web"（保留其余字段与顶层键），
 *     返回 'patched'。保证 pets 非空且 display 显式——空 pets 会被上游回落成
 *     内置默认（both），等于没注入。
 *   - 文件损坏（连 JSONC 剥注释都解析失败）→ 视为无效用户层，按建立重建为默认
 *     配置，返回 'created'。
 *
 * @param {string} filePath - 用户层配置文件的绝对路径
 * @returns {'created' | 'patched' | 'skipped'}
 */
export function injectPetConfig(filePath) {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, seed(), 'utf8')
    return 'created'
  }
  let cfg
  try {
    cfg = parseUserConfig(readFileSync(filePath, 'utf8'))
  } catch {
    // 损坏文件上游同样会按「无用户配置」处理：直接重建不丢任何有效内容。
    writeFileSync(filePath, seed(), 'utf8')
    return 'created'
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    writeFileSync(filePath, seed(), 'utf8')
    return 'created'
  }
  const pets = Array.isArray(cfg.pets) ? cfg.pets : []
  const hasDisplay = pets.some((p) => p !== null && typeof p === 'object' && 'display' in p)
  if (hasDisplay) return 'skipped'
  const next = pets.length === 0 ? [DEFAULT_PET] : pets.map((p) => (p !== null && typeof p === 'object' ? { ...p, display: 'web' } : p))
  writeFileSync(filePath, serialize({ ...cfg, pets: next }), 'utf8')
  return 'patched'
}

/**
 * 解析用户层文件。用户层允许 JSONC 注释（设置页「同步」写入的就是包内 config.jsonc
 * 原文），因此剥除行注释与块注释后再按 JSON 解析，与上游 readJsonc 一致。
 * 解析失败即抛出，由调用方按「无效用户层」处理。
 */
function parseUserConfig(raw) {
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1')
    .trim()
  return JSON.parse(stripped)
}
