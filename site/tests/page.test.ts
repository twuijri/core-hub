// The page itself: both languages complete, every string the page names exists, no script or
// style from anywhere but the page, and the built HTML has its Arabic and icons written in.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderPage } from '../build.mjs';
import { STRINGS, t } from '../src/i18n.js';

const template = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const keysIn = (pattern: RegExp) => [...template.matchAll(pattern)].map((m) => m[1]!);

describe('languages', () => {
  it('Arabic and English have the same strings', () => {
    expect(Object.keys(STRINGS.en).sort()).toEqual(Object.keys(STRINGS.ar).sort());
    for (const lang of ['ar', 'en'] as const)
      for (const [key, text] of Object.entries(STRINGS[lang]))
        expect(text.trim(), `${lang} ${key}`).not.toBe('');
  });

  it('every string the page names exists', () => {
    const used = new Set([
      ...keysIn(/\{\{([\w.]+)\}\}/g),
      ...keysIn(/data-i18n(?:-html|-aria|-content)?="([\w.]+)"/g),
    ]);
    for (const key of used) expect(STRINGS.ar, key).toHaveProperty([key]);
    for (const key of ['hero.for', 'hero.soon', 'release.version', 'store.open', 'copied'])
      expect(STRINGS.ar, key).toHaveProperty([key]);
  });

  it('markup strings are set as HTML and plain strings as text, never the other way round', () => {
    for (const key of keysIn(/data-i18n-html="([\w.]+)"/g)) expect(key).toMatch(/^html\./);
    for (const key of keysIn(/data-i18n="([\w.]+)"/g)) expect(key).not.toMatch(/^html\./);
    for (const lang of ['ar', 'en'] as const)
      for (const [key, text] of Object.entries(STRINGS[lang])) {
        const tags = [...text.matchAll(/<\/?([a-z]+)[^>]*>/g)].map((m) => m[1]);
        if (key.startsWith('html.'))
          expect(tags.every((tag) => ['b', 'code', 'bdi'].includes(tag!))).toBe(true);
        else expect(tags, `${lang} ${key}`).toEqual([]);
      }
  });

  it('fills placeholders', () => {
    expect(t('ar', 'hero.for', { platform: 'Windows' })).toBe('حمّل كور هب على Windows');
    expect(t('en', 'release.version', { version: '1.1.1' })).toBe('Version 1.1.1');
  });
});

describe('the built page', () => {
  const html = renderPage(template, STRINGS.en);

  it('is English and left-to-right before any script runs, with no placeholder left', () => {
    expect(html).toMatch(/<html lang="en" dir="ltr">/);
    expect(html).not.toMatch(/\{\{|<!--icon:/);
    expect(html).toContain(`<h1 data-i18n="hero.title">${STRINGS.en['hero.title']}</h1>`);
    expect(html).toContain('<svg class="icon" aria-hidden="true"');
  });

  it('refuses a string the page names but i18n.js lacks', () => {
    expect(() => renderPage('<p>{{nope.missing}}</p>', STRINGS.ar)).toThrow(/nope\.missing/);
  });

  it('loads scripts and styles from itself only, and calls nothing but the GitHub API', () => {
    const external = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)]
      .map((m) => m[1]!)
      .filter((url) => /^(?:https?:)?\/\//.test(url));
    expect(external).toEqual([]);
    const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain('connect-src https://api.github.com;');
    expect(html).not.toMatch(/googletagmanager|google-analytics|plausible|gtag\(/);
  });

  it('shows every store as a button that is not a link until config.js switches it on', () => {
    for (const store of ['microsoftStore', 'googlePlay', 'appStore'])
      expect(html).toMatch(new RegExp(`<a class="btn btn-store" data-store="${store}">`));
  });

  it('points every download at the releases page until the latest release is read', () => {
    const hrefs = [...html.matchAll(/data-asset="[\w-]+"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toHaveLength(5);
    for (const href of hrefs)
      expect(href).toBe('https://github.com/twuijri/core-hub/releases/latest');
  });
});
