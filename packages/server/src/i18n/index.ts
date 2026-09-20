// Server-side strings: only what the server itself says to a human (error envelopes).
// Every key exists in both files; `pnpm i18n:check` enforces parity.
import ar from './ar.json' with { type: 'json' };
import en from './en.json' with { type: 'json' };

export type Language = 'ar' | 'en';
export const LANGUAGES: readonly Language[] = ['ar', 'en'];
export const DEFAULT_LANGUAGE: Language = 'en';

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

/** Translate a dotted key; falls back to English, then to the key itself. */
export function t(key: string, language: Language = DEFAULT_LANGUAGE): string {
  return lookup(catalogues[language], key) ?? lookup(catalogues.en, key) ?? key;
}

/** Pick ar or en from an Accept-Language header (highest q wins, order breaks ties). */
export function pickLanguage(acceptLanguage: string | undefined): Language {
  if (!acceptLanguage) return DEFAULT_LANGUAGE;
  let best: { language: Language; q: number; index: number } | undefined;
  acceptLanguage.split(',').forEach((entry, index) => {
    const [tag = '', ...params] = entry.trim().split(';');
    const qParam = params.find((p) => p.trim().startsWith('q='));
    const q = qParam ? Number.parseFloat(qParam.trim().slice(2)) : 1;
    const primary = tag.trim().toLowerCase().split('-')[0] as Language;
    if (!LANGUAGES.includes(primary) || Number.isNaN(q) || q <= 0) return;
    if (!best || q > best.q) best = { language: primary, q, index };
  });
  return best?.language ?? DEFAULT_LANGUAGE;
}
