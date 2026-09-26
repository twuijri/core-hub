// Every string the web client shows exists in ar.json and en.json; `pnpm i18n:check` enforces
// parity and tests/i18n.test.ts checks that every `t('key')` literal in src exists. Keys are
// dotted, placeholders are `{name}`. Same mechanism as the server and the reference client.
import ar from './ar.json' with { type: 'json' };
import en from './en.json' with { type: 'json' };

export type Language = 'ar' | 'en';
export const LANGUAGES: readonly Language[] = ['ar', 'en'];
export const DEFAULT_LANGUAGE: Language = 'ar';

export type Params = Record<string, string | number | null | undefined>;
export type Translator = (key: string, params?: Params) => string;

type Catalogue = Record<string, unknown>;
export const catalogues: Record<Language, Catalogue> = { ar, en };

function lookup(catalogue: Catalogue, key: string): string | undefined {
  const value = key.split('.').reduce<unknown>((node, part) => {
    if (node && typeof node === 'object' && part in (node as Catalogue))
      return (node as Catalogue)[part];
    return undefined;
  }, catalogue);
  return typeof value === 'string' ? value : undefined;
}

export function interpolate(text: string, params: Params = {}): string {
  return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? match : String(value);
  });
}

/** Translate a dotted key; falls back to the other language, then to the key itself. */
export function translate(language: Language, key: string, params?: Params): string {
  const other: Language = language === 'ar' ? 'en' : 'ar';
  const text = lookup(catalogues[language], key) ?? lookup(catalogues[other], key) ?? key;
  return interpolate(text, params);
}

export function createTranslator(language: Language): Translator {
  return (key, params) => translate(language, key, params);
}

export function isLanguage(value: unknown): value is Language {
  return value === 'ar' || value === 'en';
}

/**
 * The locale every number, date, time, size and percentage is formatted in: Latin digits (123)
 * in both languages, also in the Arabic UI — Arabic words, plural forms and RTL stay (owner,
 * 2026-09-26, DECISIONS §113). Never pass the bare UI language to `Intl` or `toLocale*String`:
 * some engines give `ar` Arabic-Indic digits (tests/latin-digits.test.ts guards the call sites).
 */
export function intlLocale(language: string): string {
  return language === 'ar' ? 'ar-u-nu-latn' : 'en';
}

/** UI direction follows the UI language; content direction is decided per string (dir="auto"). */
export function directionOf(language: Language): 'rtl' | 'ltr' {
  return language === 'ar' ? 'rtl' : 'ltr';
}

export function browserLanguage(
  navigatorLanguages: readonly string[] = navigator.languages,
): Language {
  for (const tag of navigatorLanguages) {
    const primary = tag.toLowerCase().split(/[-_]/)[0];
    if (isLanguage(primary)) return primary;
  }
  return DEFAULT_LANGUAGE;
}
