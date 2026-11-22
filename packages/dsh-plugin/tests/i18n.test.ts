import { describe, expect, it } from 'vitest';
import { CATALOGUES, pickLanguage, translator } from '../src/i18n.js';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('strings', () => {
  it('has every English string in Arabic, with the same placeholders', () => {
    for (const [key, text] of Object.entries(CATALOGUES.en)) {
      const ar = CATALOGUES.ar[key as keyof typeof CATALOGUES.en];
      expect(ar, key).toBeTruthy();
      expect(placeholders(ar), key).toEqual(placeholders(text));
    }
  });

  it('names the product from the contract', () => {
    expect(translator('en')('status.unlinked', { command: 'corehub' })).toBe(
      'Not linked to a hub. Use /corehub link.',
    );
    expect(translator('ar')('consent.title')).toBe('كور هب');
  });

  it('follows the setting, then the locale', () => {
    expect(pickLanguage('ar')).toBe('ar');
    expect(pickLanguage('auto', { LANG: 'ar_SA.UTF-8' })).toBe('ar');
    expect(pickLanguage('auto', {})).toBe('en');
  });
});
