/**
 * Wire values the settings page exchanges with the Quick Assistant Host half.
 *
 * The browser bundle never imports Host sources: each declaration here mirrors
 * one document the Host half serves.
 */

/** The four quick-assistant modes, in menu order. */
export const MODE_IDS = ['ask', 'translate', 'summary', 'explain'] as const

/** One quick-assistant mode id. */
export type ModeId = (typeof MODE_IDS)[number]

/**
 * Model override of one mode. `useDefault: true` makes the mode follow the main
 * model and makes the remaining fields irrelevant.
 */
export interface ModeModelOverride {
  useDefault: boolean
  provider?: string
  model?: string
  reasoningEffort?: string
}

/** Per-mode settings: its model override and prompt template. */
export interface ModeSettings {
  model: ModeModelOverride
  prompt: string
}

/** Automatic-translation language pair, as codes of the Host language table. */
export interface TranslationSettings {
  primaryLanguage: string
  secondaryLanguage: string
}

/** The stored settings document (`<DSH_HOME>/quick-assistant/settings.json`). */
export interface QuickAssistantSettings {
  version: number
  shortcut: string
  modes: Record<ModeId, ModeSettings>
  translation: TranslationSettings
}

/** One selectable translation language from `GET /api/settings`. */
export interface LanguageOption {
  code: string
  label: string
}

/** `GET /api/settings` response: the stored document, its defaults, and the language table. */
export interface SettingsPayload {
  settings: QuickAssistantSettings
  defaults: QuickAssistantSettings
  languages: LanguageOption[]
}

/** One reasoning effort a catalog model exposes. */
export interface CatalogEffort {
  id: string
  name: string
}

/** One model in the catalog, with the reasoning efforts it exposes. */
export interface CatalogModel {
  id: string
  name: string
  efforts: CatalogEffort[]
  defaultEffort?: string
}

/** One provider and the models it advertises. */
export interface CatalogProvider {
  id: string
  name: string
  models: CatalogModel[]
}

/** The main model a mode follows while its override is off. */
export interface CatalogDefaultSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** One provider whose models could not be listed. */
export interface CatalogFailure {
  id: string
  name: string
  message: string
}

/** `GET /api/catalog` response. */
export interface ModelCatalog {
  default: CatalogDefaultSelection
  providers: CatalogProvider[]
  failures: CatalogFailure[]
}

/** `GET /api/health` response. */
export interface HealthPayload {
  ok: boolean
  helperRunning: boolean
}
