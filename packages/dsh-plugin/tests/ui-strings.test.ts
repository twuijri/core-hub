import { describe, expect, it } from 'vitest';
import { UI_CATALOGUES, uiLanguage, uiTranslator } from '../src/ui-strings.js';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('the browser half’s strings', () => {
  it('has every English string in Arabic, with the same placeholders', () => {
    for (const [key, text] of Object.entries(UI_CATALOGUES.en)) {
      const ar = UI_CATALOGUES.ar[key as keyof typeof UI_CATALOGUES.en];
      expect(ar, key).toBeTruthy();
      expect(placeholders(ar), key).toEqual(placeholders(text));
    }
  });

  it('puts the product name in', () => {
    expect(uiTranslator('ar', 'كور هب')('chat.ok.link')).toBe('تم الربط مع كور هب');
    expect(uiTranslator('en', 'Core Hub')('link.models.count', { count: 2 })).toBe(
      '2 models in the model picker',
    );
  });

  it('follows the setting, then the browser', () => {
    expect(uiLanguage('ar', ['en-US'])).toBe('ar');
    expect(uiLanguage('auto', ['ar-SA', 'en'])).toBe('ar');
    expect(uiLanguage('auto', ['fr-FR', 'en-GB'])).toBe('en');
    expect(uiLanguage(undefined, [])).toBe('en');
  });
});
