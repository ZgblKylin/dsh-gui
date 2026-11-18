/**
 * Settings storage for the quick assistant.
 *
 * One JSON file under the harness home holds what both shells share: the
 * shortcut, the four mode templates and per-mode model overrides, and the
 * translation language pair. Writes are atomic (temp file + rename) so a crash
 * mid-save never leaves a half-written file, and unknown fields are preserved
 * so a newer settings page can round-trip fields an older host does not know.
 */

import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { DEFAULT_PRIMARY_LANGUAGE, DEFAULT_SECONDARY_LANGUAGE, isKnownLanguage } from './languages.ts'
import { ASSISTANT_MODES, DEFAULT_PROMPTS, type AssistantMode } from './prompts.ts'

/** Default global shortcut recorded by the settings page. */
export const DEFAULT_SHORTCUT = 'Ctrl+Alt+Space'

/** The settings file schema version this host writes. */
export const SETTINGS_VERSION = 1

/**
 * Default reasoning effort per mode: answering questions benefits from a low
 * effort, while translation, summarizing, and explaining run without thinking.
 */
export const DEFAULT_REASONING_EFFORT: Readonly<Record<AssistantMode, string>> = Object.freeze({
  ask: 'low',
  translate: 'off',
  summary: 'off',
  explain: 'off',
})

/** Per-mode model override. */
export interface ModeModel {
  /** Follow `agentDefaultModel` instead of a pinned provider/model. */
  useDefault: boolean
  /** Provider route id when pinned. */
  provider?: string
  /** Model id when pinned. */
  model?: string
  /**
   * Adapter-owned reasoning effort applied to whichever route the mode uses;
   * omitted follows the model default.
   */
  reasoningEffort?: string
}

/** One assistant mode's settings. */
export interface ModeSettings {
  /** Model selection for this mode. */
  model: ModeModel
  /** Prompt template; `{{text}}` is replaced with the submitted text. */
  prompt: string
}

/** Automatic translation language pair. */
export interface TranslationSettings {
  /** Language chosen when `auto` is not applicable. */
  primaryLanguage: string
  /** Fallback language when the primary equals the source language. */
  secondaryLanguage: string
}

/** Settings shared by the host half, the settings page and the overlay. */
export interface AssistantSettings {
  /** Schema version; bump only for an incompatible layout. */
  version: number
  /** Global accelerator that shows the overlay. */
  shortcut: string
  /** Prompt and model settings per assistant mode. */
  modes: Record<AssistantMode, ModeSettings>
  /** Automatic translation language pair. */
  translation: TranslationSettings
}

/**
 * Deep-copy one settings value.
 * @param settings - value to copy.
 * @returns a detached copy safe to hand to callers.
 */
export function cloneSettings(settings: AssistantSettings): AssistantSettings {
  return structuredClone(settings)
}

/**
 * Build the default settings object.
 * @returns a fresh default settings value (no shared references).
 */
export function defaultSettings(): AssistantSettings {
  const modes = {} as Record<AssistantMode, ModeSettings>
  for (const mode of ASSISTANT_MODES) {
    modes[mode] = {
      model: { useDefault: true, reasoningEffort: DEFAULT_REASONING_EFFORT[mode] },
      prompt: DEFAULT_PROMPTS[mode],
    }
  }
  return {
    version: SETTINGS_VERSION,
    shortcut: DEFAULT_SHORTCUT,
    modes,
    translation: {
      primaryLanguage: DEFAULT_PRIMARY_LANGUAGE,
      secondaryLanguage: DEFAULT_SECONDARY_LANGUAGE,
    },
  }
}

/** Treat a non-object JSON value as "nothing stored". */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A non-empty string field, or `undefined`. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Normalize one stored model override.
 *
 * A model object without a `reasoningEffort` field takes the mode default; an
 * explicit empty string means "follow the model default" and stays empty.
 * @param raw - stored value.
 * @param fallback - default for the mode.
 * @returns a valid override; incomplete overrides fall back to following the default model.
 */
function normalizeModeModel(raw: unknown, fallback: ModeModel): ModeModel {
  if (!isRecord(raw)) return { ...fallback }
  const storedEffort = typeof raw['reasoningEffort'] === 'string'
    ? String(raw['reasoningEffort'])
    : fallback.reasoningEffort ?? ''
  const effort = { reasoningEffort: storedEffort }
  if (raw['useDefault'] !== false) return { useDefault: true, ...effort }
  const provider = text(raw['provider'])
  const model = text(raw['model'])
  if (provider === undefined || model === undefined) return { useDefault: true, ...effort }
  return { useDefault: false, provider, model, ...effort }
}

/** Normalize one mode's settings, preserving unknown fields on the mode object. */
function normalizeMode(raw: unknown, fallback: ModeSettings): ModeSettings {
  if (!isRecord(raw)) return { ...fallback }
  return {
    ...raw,
    model: normalizeModeModel(raw['model'], fallback.model),
    prompt: typeof raw['prompt'] === 'string' ? raw['prompt'] : fallback.prompt,
  }
}

/** Normalize the translation pair, keeping only known language codes. */
function normalizeTranslation(raw: unknown, fallback: TranslationSettings): TranslationSettings {
  if (!isRecord(raw)) return { ...fallback }
  const primary = text(raw['primaryLanguage'])
  const secondary = text(raw['secondaryLanguage'])
  return {
    ...raw,
    primaryLanguage: primary !== undefined && isKnownLanguage(primary) ? primary : fallback.primaryLanguage,
    secondaryLanguage: secondary !== undefined && isKnownLanguage(secondary) ? secondary : fallback.secondaryLanguage,
  }
}

/**
 * Merge a stored or submitted value onto valid settings.
 * @param raw - untrusted JSON value (a settings file or an HTTP body).
 * @param base - current settings the result extends; defaults are used when omitted.
 * @returns normalized settings that preserve unknown fields from `raw` and `base`.
 */
export function normalizeSettings(raw: unknown, base: AssistantSettings = defaultSettings()): AssistantSettings {
  const defaults = defaultSettings()
  const record = isRecord(raw) ? raw : {}
  const rawModes = isRecord(record['modes']) ? record['modes'] : {}
  const modes = {} as Record<AssistantMode, ModeSettings>
  for (const mode of ASSISTANT_MODES) {
    modes[mode] = normalizeMode(rawModes[mode], base.modes[mode] ?? defaults.modes[mode])
  }
  return {
    ...base,
    ...record,
    version: typeof record['version'] === 'number' ? record['version'] : SETTINGS_VERSION,
    shortcut: text(record['shortcut']) ?? text(base.shortcut) ?? DEFAULT_SHORTCUT,
    modes,
    translation: normalizeTranslation(record['translation'], base.translation ?? defaults.translation),
  }
}

/** Accelerator modifiers understood by the native helper. */
const MODIFIER_NAMES = new Set(['ctrl', 'control', 'shift', 'alt', 'option', 'win', 'meta', 'super', 'cmd', 'command'])

/** Named non-modifier keys understood by the native helper. */
const NAMED_KEYS = new Set([
  'space', 'tab', 'enter', 'return', 'esc', 'escape', 'backspace', 'delete', 'del', 'insert', 'ins',
  'home', 'end', 'pageup', 'prior', 'pagedown', 'next', 'up', 'down', 'left', 'right',
  'minus', 'equal', 'comma', 'period', 'slash', 'backquote', 'semicolon', 'quote',
  'lbracket', 'rbracket', 'backslash',
])

/**
 * Validate an accelerator against the native helper's parser.
 * @param accelerator - shortcut text such as `Ctrl+Alt+Space`.
 * @returns `true` when the helper can register it (at least one modifier and
 *   exactly one non-modifier key).
 */
export function isValidAccelerator(accelerator: string): boolean {
  let modifiers = 0
  let keys = 0
  for (const token of accelerator.split('+').map(part => part.trim()).filter(part => part !== '')) {
    const lower = token.toLowerCase()
    if (MODIFIER_NAMES.has(lower)) {
      modifiers += 1
      continue
    }
    keys += 1
    const upper = token.toUpperCase()
    if (upper.length === 1 && /^[0-9A-Z]$/.test(upper)) continue
    const functionKey = /^F(\d{1,2})$/.exec(upper)
    if (functionKey !== null && Number(functionKey[1]) >= 1 && Number(functionKey[1]) <= 24) continue
    if (!NAMED_KEYS.has(lower)) return false
  }
  return modifiers > 0 && keys === 1
}

/** Environment variable overriding the harness home, mirroring the harness helper. */
const DSH_HOME_ENV = 'DSH_HOME'

/** Expand `~`, `~/`, and `~\` against the operating-system home. */
function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the harness home: `$DSH_HOME` when set, otherwise `~/.dsh`.
 *
 * The local implementation mirrors `dshHomePath` from
 * `@deepseek-ai/dsh-home-paths`; the plugin runs from its own directory and
 * only type-level imports of harness packages are guaranteed to resolve there.
 * @param env - environment mapping to read; defaults to the process environment.
 * @returns the absolute harness home.
 */
export function resolveDshHome(env: Record<string, string | undefined> = process.env): string {
  const configured = env[DSH_HOME_ENV]
  const selected = configured !== undefined && configured.trim() !== ''
    ? expandHomePath(configured.trim())
    : join(homedir(), '.dsh')
  return resolve(selected)
}

/**
 * Join path segments onto the resolved harness home.
 * @param segments - path segments appended to the home.
 * @returns the absolute joined path.
 */
export function dshHomePath(...segments: string[]): string {
  return join(resolveDshHome(), ...segments)
}

/**
 * Absolute path of the settings file.
 * @returns `<DSH_HOME>/quick-assistant/settings.json`.
 */
export function settingsFilePath(): string {
  return dshHomePath('quick-assistant', 'settings.json')
}

/** Write one file atomically: a sibling temp file renamed over the target. */
async function writeFileAtomic(file: string, contents: string): Promise<void> {
  const directory = dirname(file)
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, `.${basename(file)}.${process.pid}.${Date.now()}.tmp`)
  try {
    await writeFile(temporary, contents, 'utf8')
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * In-memory view of the settings file with atomic persistence.
 *
 * Reads happen on every route call, so the current value is cached; a write
 * goes through {@link save}, which normalizes the submitted value, writes the
 * file atomically, and only then publishes the new value. Concurrent saves are
 * serialized so the last one wins in submission order.
 */
export class SettingsStore {
  private current: AssistantSettings
  private writes: Promise<void> = Promise.resolve()

  /**
   * @param file - settings file path; defaults to {@link settingsFilePath}.
   */
  constructor(private readonly file: string = settingsFilePath()) {
    this.current = defaultSettings()
    this.loadSync()
  }

  /** Path of the backing file. */
  get path(): string {
    return this.file
  }

  /**
   * Current settings value.
   * @returns a detached copy so callers cannot mutate the cache.
   */
  get(): AssistantSettings {
    return cloneSettings(this.current)
  }

  /**
   * Persist a submitted settings value.
   * @param raw - submitted JSON value; normalized against the current settings.
   * @returns the stored settings value.
   */
  async save(raw: unknown): Promise<AssistantSettings> {
    const next = normalizeSettings(raw, this.current)
    const run = this.writes.then(async () => {
      await writeFileAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`)
      this.current = next
    })
    this.writes = run.catch(() => undefined)
    await run
    return cloneSettings(this.current)
  }

  /** Read the file once at construction; a missing or corrupt file keeps the defaults. */
  private loadSync(): void {
    let contents: string
    try {
      contents = readFileSync(this.file, 'utf8')
    } catch {
      return
    }
    try {
      this.current = normalizeSettings(JSON.parse(contents))
    } catch {
      // A corrupt file must not take the assistant down; the next save rewrites it.
      this.current = defaultSettings()
    }
  }
}
