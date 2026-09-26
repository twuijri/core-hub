/**
 * The languages a person can pick for speech (DECISIONS §92): Core Hub is for everyone, so
 * "Arabic" means "Arabic too" — every language a provider speaks is offered, the popular ones
 * first, the rest behind "All languages", and a code can always be typed by hand.
 *
 * Names come from the browser (`Intl.DisplayNames`) in the interface language, so no language
 * name is translated by hand and every one of them reads right in Arabic and in English.
 */

/** The languages most people speak, in this order: what a picker shows first. */
export const POPULAR_LANGUAGES = [
  'en',
  'ar',
  'es',
  'fr',
  'de',
  'zh',
  'hi',
  'pt',
  'ja',
  'ru',
  'ko',
  'it',
  'tr',
  'id',
  'ur',
  'fa',
  'bn',
] as const;

/**
 * Every language a speech-to-text hint may name: the ISO 639-1 codes Whisper-class models
 * transcribe (plus Cantonese), which is wider than any one provider and narrower than every
 * code in the standard. A code that is not here can still be typed.
 */
export const ALL_LANGUAGES = [
  'af', 'am', 'ar', 'as', 'az', 'ba', 'be', 'bg', 'bn', 'bo', 'br', 'bs', 'ca', 'cs', 'cy',
  'da', 'de', 'el', 'en', 'es', 'et', 'eu', 'fa', 'fi', 'fil', 'fo', 'fr', 'gl', 'gu', 'ha',
  'haw', 'he', 'hi', 'hr', 'ht', 'hu', 'hy', 'id', 'is', 'it', 'ja', 'jv', 'ka', 'kk', 'km',
  'kn', 'ko', 'la', 'lb', 'ln', 'lo', 'lt', 'lv', 'mg', 'mi', 'mk', 'ml', 'mn', 'mr', 'ms',
  'mt', 'my', 'ne', 'nl', 'nn', 'no', 'oc', 'pa', 'pl', 'ps', 'pt', 'ro', 'ru', 'sa', 'sd',
  'si', 'sk', 'sl', 'sn', 'so', 'sq', 'sr', 'su', 'sv', 'sw', 'ta', 'te', 'tg', 'th', 'tk',
  'tr', 'tt', 'uk', 'ur', 'uz', 'vi', 'yi', 'yo', 'yue', 'zh',
] as const; // prettier-ignore

/** `ar-SA` -> `ar`; `null` stays null. */
export function baseLanguage(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const base = tag.trim().split(/[-_]/)[0]?.toLowerCase();
  return base || null;
}

const namers = new Map<string, Intl.DisplayNames | null>();

function namer(ui: string): Intl.DisplayNames | null {
  if (!namers.has(ui)) {
    try {
      namers.set(ui, new Intl.DisplayNames([ui], { type: 'language' }));
    } catch {
      namers.set(ui, null);
    }
  }
  return namers.get(ui) ?? null;
}

/** A language tag's name in the interface language (`ar-SA` -> "Arabic (Saudi Arabia)"). */
export function languageName(tag: string, ui: string): string {
  try {
    return namer(ui)?.of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** Where a language sorts: the popular ones in their order, then everything else. */
export function popularRank(tag: string | null): number {
  const base = baseLanguage(tag);
  const at = base ? (POPULAR_LANGUAGES as readonly string[]).indexOf(base) : -1;
  return at >= 0 ? at : POPULAR_LANGUAGES.length;
}

export function isPopular(tag: string | null): boolean {
  return popularRank(tag) < POPULAR_LANGUAGES.length;
}

/**
 * Tags in picker order: popular first (in their order), the rest by their name in the
 * interface language.
 */
export function sortLanguages<T extends string>(tags: readonly T[], ui: string): T[] {
  return [...tags].sort(
    (a, b) =>
      popularRank(a) - popularRank(b) || languageName(a, ui).localeCompare(languageName(b, ui), ui),
  );
}
