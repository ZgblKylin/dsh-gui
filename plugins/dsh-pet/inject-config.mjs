// inject-config.mjs — dsh-pet 用户配置注入：屏蔽桌面模式（Electron 透明窗）
//
// 原理：dsh-pet 的桌面可见性由上游 readAllConfig() 合并后的宠物 display 决定
// （web / desktop / both / none），只有存在 display∈{desktop,both} 的宠物时
// hasDesktopPet 才为 true，才会去探测/下载/拉起 Electron Helper（上游
// src/host/index.ts 的 startHelper()/launchHelper() 在 !hasDesktopPet 时直接返回）。
// 内置默认配置 assets/config.jsonc 的宠物 display 是 both，因此装完必开桌面。
// 本模块只向用户层 $DSH_HOME/dsh-pet/main-config.json 注入 display:"web" 的
// 默认宠物，把 hasDesktopPet 置 false —— 不探测、不下载、不 spawn，浏览器
// overlay / 设置页 / 余额 / 碎碎念 / 对话全部保留。绝不改包内默认配置。

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 默认宠物条目，字段与包内 assets/config.jsonc 的 pets[0]（main）对齐，
 * 仅 display 改为 "web"。display 必须显式写：上游 mergePet 对缺失 display
 * 会回落 base（内置默认 both），不写就等于没注入。
 */
export const DEFAULT_PET = {
  id: 'main',
  name: '蓝毛小女仆',
  size: 462,
  balanceEnabled: true,
  whisperEnabled: true,
  display: 'web',
  position: { corner: 'top-right', marginX: 24, marginY: 100 },
}

/** 用户层配置文件路径（与上游 readAllConfig 的 userFile 一致）。 */
export function petConfigPath(dshHome) {
  return join(dshHome, 'dsh-pet', 'main-config.json')
}

const serialize = (cfg) => JSON.stringify(cfg, null, 2) + '\n'
const seed = () => serialize({ pets: [DEFAULT_PET] })

/**
 * 注入「每只宠物 display 显式 web」到用户层 main-config.json。
 *
 * 规则（与 wrapper 安装要求一致，幂等）：
 *   - 文件不存在 → 建立：写入仅含默认宠物（display=web）的 pets，返回 'created'；
 *   - 已存在且任一只宠物带 display 字段 → 不动用户配置，返回 'skipped'；
 *   - 已存在但无任何 display（旧格式 / 手写未配）→ 补默认：宠物为空则置入默认
 *     宠物，否则给每只已存在的宠物补 display:"web"（保留其余字段与顶层键），
 *     返回 'patched'。保证 pets 非空且 display 显式——空 pets 会被上游回落成
 *     内置默认（both），等于没注入。
 *   - 文件损坏（非 JSON）→ 视为无效用户层，按建立重建为默认入配置，返回 'created'。
 *
 * @param {string} filePath - main-config.json 的绝对路径
 * @returns {'created' | 'patched' | 'skipped'}
 */
export function injectPetConfig(filePath) {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, seed(), 'utf8')
    return 'created'
  }
  let cfg
  try {
    cfg = JSON.parse(readFileSync(filePath, 'utf8'))
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