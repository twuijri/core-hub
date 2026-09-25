/**
 * The desktop app's own words: the first-run screen, the tray, the menu, the dialogs.
 * Everything inside the window after that is the web client's, in its own catalogue.
 * `pnpm i18n:check` holds `src/i18n/{ar,en}.json` to the same keys and placeholders.
 */
import ar from '../i18n/ar.json' with { type: 'json' };
import en from '../i18n/en.json' with { type: 'json' };
import type { Language } from './config.js';

type Catalogue = { [key: string]: string | Catalogue };
const CATALOGUES: Record<Language, Catalogue> = { ar, en };

function lookup(catalogue: Catalogue, key: string): string | undefined {
  let node: string | Catalogue | undefined = catalogue;
  for (const part of key.split('.')) {
    if (!node || typeof node === 'string') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

export function translate(
  language: Language,
  key: string,
  params: Record<string, string | number> = {},
): string {
  const text = lookup(CATALOGUES[language], key) ?? lookup(CATALOGUES.en, key) ?? key;
  return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

export const direction = (language: Language): 'rtl' | 'ltr' => (language === 'ar' ? 'rtl' : 'ltr');

/**
 * A Latin value (an address, a version) inside an Arabic sentence, isolated so the bidi
 * algorithm does not reorder the sentence around it (FSI … PDI).
 */
export const isolate = (value: string): string => `⁨${value}⁩`;
