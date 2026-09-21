import { describe, expect, it } from 'vitest';
import ar from '../src/i18n/ar.json' with { type: 'json' };
import en from '../src/i18n/en.json' with { type: 'json' };
import { createTranslator, interpolate, resolveLanguage, translate } from '../src/i18n/index.js';

function flatten(
  value: unknown,
  prefix = '',
  out = new Map<string, string>(),
): Map<string, string> {
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>))
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
  } else out.set(prefix, String(value));
  return out;
}

describe('catalogues', () => {
  it('have the same keys and placeholders in Arabic and English', () => {
    const a = flatten(ar);
    const e = flatten(en);
    expect([...a.keys()].sort()).toEqual([...e.keys()].sort());
    const placeholders = (s: string) => [...s.matchAll(/\{[a-z_]+\}/g)].map((m) => m[0]).sort();
    for (const [key, text] of e)
      expect(placeholders(a.get(key) ?? ''), key).toEqual(placeholders(text));
  });
});

describe('translate', () => {
  it('interpolates and falls back to English then to the key', () => {
    expect(interpolate('{a} and {b}', { a: 1, b: 'x' })).toBe('1 and x');
    expect(translate('ar', 'usage.unknown_command', { command: 'x' })).toBe('أمر غير معروف: x');
    expect(translate('ar', 'no.such.key')).toBe('no.such.key');
    expect(createTranslator('en')('common.yes')).toBe('yes');
  });
});

describe('resolveLanguage', () => {
  it('prefers the flag, then MAJLIS_LANG, then the locale variables', () => {
    expect(resolveLanguage('ar', { MAJLIS_LANG: 'en' })).toBe('ar');
    expect(resolveLanguage(undefined, { MAJLIS_LANG: 'ar', LANG: 'en_US.UTF-8' })).toBe('ar');
    expect(resolveLanguage(undefined, { LANG: 'ar_SA.UTF-8' })).toBe('ar');
    expect(resolveLanguage(undefined, { LC_ALL: 'en_GB', LANG: 'ar_SA' })).toBe('en');
    expect(resolveLanguage(undefined, { LANG: 'fr_FR' })).toBe('en');
    expect(resolveLanguage('xx', {})).toBe('en');
  });
});
