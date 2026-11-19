/**
 * Translation language table shared by the settings page, the overlay and the
 * prompt templates.
 *
 * `code` is the stable value stored in settings and sent over the wire;
 * `promptName` is the English name written into a prompt (a model reads it more
 * reliably than a BCP 47 tag); `label` is the localized name the UI shows.
 *
 * The UI-only `auto` option is deliberately absent: it never reaches a prompt
 * name, and `resolvePromptLanguage` in `./prompts.ts` owns its rendering.
 */

/** One selectable translation language. */
export interface Language {
  /** Stable code stored in settings and exchanged over HTTP. */
  code: string
  /** Localized display name for selectors. */
  label: string
  /** English name written into prompt templates. */
  promptName: string
}

/** Built-in language table, ordered as the settings selectors show it. */
export const LANGUAGES: ReadonlyArray<Language> = Object.freeze([
  { code: 'en-us', label: '英文', promptName: 'English' },
  { code: 'zh-cn', label: '简体中文', promptName: 'Chinese (Simplified)' },
  { code: 'zh-tw', label: '繁体中文', promptName: 'Chinese (Traditional)' },
  { code: 'ja-jp', label: '日文', promptName: 'Japanese' },
  { code: 'ko-kr', label: '韩文', promptName: 'Korean' },
  { code: 'fr-fr', label: '法文', promptName: 'French' },
  { code: 'de-de', label: '德文', promptName: 'German' },
  { code: 'it-it', label: '意大利文', promptName: 'Italian' },
  { code: 'es-es', label: '西班牙文', promptName: 'Spanish' },
  { code: 'pt-pt', label: '葡萄牙文', promptName: 'Portuguese' },
  { code: 'ru-ru', label: '俄文', promptName: 'Russian' },
  { code: 'pl-pl', label: '波兰文', promptName: 'Polish' },
  { code: 'cs-cz', label: '捷克文', promptName: 'Czech' },
  { code: 'ar-sa', label: '阿拉伯文', promptName: 'Arabic' },
  { code: 'tr-tr', label: '土耳其文', promptName: 'Turkish' },
  { code: 'th-th', label: '泰文', promptName: 'Thai' },
  { code: 'vi-vn', label: '越南文', promptName: 'Vietnamese' },
  { code: 'id-id', label: '印尼文', promptName: 'Indonesian' },
  { code: 'ur-pk', label: '乌尔都文', promptName: 'Urdu' },
  { code: 'ms-my', label: '马来文', promptName: 'Malay' },
  { code: 'uk-ua', label: '乌克兰文', promptName: 'Ukrainian' },
])

/** Language value meaning "detect the source / pick from the configured pair". */
export const AUTO_LANGUAGE = 'auto'

/** Default primary translation language (`zh-cn`). */
export const DEFAULT_PRIMARY_LANGUAGE = 'zh-cn'

/** Default secondary translation language (`en-us`). */
export const DEFAULT_SECONDARY_LANGUAGE = 'en-us'

/** Index from `code` to its entry, for O(1) lookups. */
const BY_CODE = new Map(LANGUAGES.map(language => [language.code, language]))

/**
 * Look one language up by code.
 * @param code - language code or the `auto` sentinel.
 * @returns the language, or `undefined` when the code is unknown.
 */
export function findLanguage(code: string): Language | undefined {
  return BY_CODE.get(code)
}

/**
 * Resolve the prompt name for one language code.
 * @param code - language code; unknown codes fall back to the code itself so a
 *   stale settings value still produces a usable prompt.
 * @returns the English language name written into prompts.
 */
export function promptNameOf(code: string): string {
  return BY_CODE.get(code)?.promptName ?? code
}

/**
 * Whether a code names a built-in language.
 * @param code - candidate settings value.
 * @returns `true` for a known language code; `auto` is not a language.
 */
export function isKnownLanguage(code: string): boolean {
  return BY_CODE.has(code)
}

/**
 * Localized label for one language code.
 * @param code - language code.
 * @returns the label, or the code when unknown.
 */
export function labelOf(code: string): string {
  return BY_CODE.get(code)?.label ?? code
}
