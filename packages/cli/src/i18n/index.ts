// Every string the CLI shows exists in ar.json and en.json; `pnpm i18n:check` enforces parity
// (the same rule the server follows). Keys are dotted, placeholders are `{name}`.
import ar from './ar.json' with { type: 'json' };
import en from './en.json' with { type: 'json' };

export type Language = 'ar' | 'en';
export const LANGUAGES: readonly Language[] = ['ar', 'en'];
export const DEFAULT_LANGUAGE: Language = 'en';

export type Params = Record<string, string | number | null | undefined>;
export type Translator = (key: string, params?: Params) => string;

type Catalogue = Record<string, unknown>;
const catalogues: Record<Language, Catalogue> = { ar, en };

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

/** Translate a dotted key; falls back to English, then to the key itself. */
export function translate(language: Language, key: string, params?: Params): string {
  const text = lookup(catalogues[language], key) ?? lookup(catalogues.en, key) ?? key;
  return interpolate(text, params);
}

export function createTranslator(language: Language): Translator {
  return (key, params) => translate(language, key, params);
}

function fromTag(tag: string | undefined): Language | undefined {
  const primary = tag?.trim().toLowerCase().split(/[-_.]/)[0];
  return primary && (LANGUAGES as readonly string[]).includes(primary)
    ? (primary as Language)
    : undefined;
}

/** `--lang`, then MAJLIS_LANG, then LC_ALL / LC_MESSAGES / LANG, then English. */
export function resolveLanguage(explicit: string | undefined, env: NodeJS.ProcessEnv): Language {
  return (
    fromTag(explicit) ??
    fromTag(env.MAJLIS_LANG) ??
    fromTag(env.LC_ALL) ??
    fromTag(env.LC_MESSAGES) ??
    fromTag(env.LANG) ??
    DEFAULT_LANGUAGE
  );
}
