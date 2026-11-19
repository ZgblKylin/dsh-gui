/**
 * The language the assistant answers in, derived from the operating system's
 * locale so prompts can ask for a reply in the user's own language.
 */

/** Display names for the locales whose English name would be ambiguous. */
const SPECIAL_CASES: Readonly<Record<string, string>> = {
  'zh-cn': 'Simplified Chinese',
  'zh-sg': 'Simplified Chinese',
  'zh-tw': 'Traditional Chinese',
  'zh-hk': 'Traditional Chinese',
  'zh-mo': 'Traditional Chinese',
  'pt-br': 'Brazilian Portuguese',
}

/** Cached answer: the process locale does not change within a run. */
let cached: string | undefined

/**
 * Name of the system language in English, suitable for a prompt sentence.
 * @returns a language name such as `Simplified Chinese`; falls back to `English`.
 */
export function systemLanguageName(): string {
  if (cached !== undefined) return cached
  const locale = detectedLocale()
  cached = nameOf(locale)
  return cached
}

/** Locale of the running process, from the ICU-backed formatter defaults. */
function detectedLocale(): string {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().locale
    if (typeof resolved === 'string' && resolved !== '') return resolved
  } catch {
    // An environment without ICU falls through to the English default.
  }
  return 'en-US'
}

/** Resolve one locale to an English language name. */
function nameOf(locale: string): string {
  const lower = locale.toLowerCase()
  const special = SPECIAL_CASES[lower] ?? SPECIAL_CASES[lower.split('-')[0] ?? '']
  if (special !== undefined) return special
  const language = lower.split('-')[0] ?? ''
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(language)
    if (typeof name === 'string' && name !== '') return name
  } catch {
    // No DisplayNames support: the base-language table below still works.
  }
  return FALLBACK_NAMES[language] ?? 'English'
}

/** English names for the common languages when `Intl.DisplayNames` is absent. */
const FALLBACK_NAMES: Readonly<Record<string, string>> = {
  zh: 'Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  ru: 'Russian',
  it: 'Italian',
  pt: 'Portuguese',
}
