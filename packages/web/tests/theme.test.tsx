import { describe, expect, it } from 'vitest';
import { applyPrefs, readStoredPrefs } from '../src/design/theme.js';

describe('display preferences', () => {
  it('paints theme, glass, language direction and text scale on the root', () => {
    const root = document.createElement('html');
    applyPrefs({ theme: 'dark', glass: '3', language: 'ar', textScale: 1.1 }, root);
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(root.getAttribute('data-glass')).toBe('3');
    expect(root.getAttribute('dir')).toBe('rtl');
    expect(root.getAttribute('lang')).toBe('ar');
    expect(root.style.getPropertyValue('--mj-text-scale')).toBe('1.1');
    applyPrefs({ theme: 'system', glass: '0', language: 'en', textScale: 1 }, root);
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(root.getAttribute('dir')).toBe('ltr');
  });

  it('reads stored preferences defensively', () => {
    expect(
      readStoredPrefs({
        getItem: () => JSON.stringify({ theme: 'dark', glass: '9', language: 'fr', textScale: 3 }),
      }),
    ).toMatchObject({ theme: 'dark', glass: '2', textScale: 1 });
    expect(readStoredPrefs({ getItem: () => '{not json' }).theme).toBe('system');
    expect(readStoredPrefs(null).glass).toBe('2');
  });
});
