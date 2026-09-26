// Latin digits (123) everywhere, also in the Arabic UI (owner, 2026-09-26, DECISIONS §113):
// numbers, dates, times, sizes and percentages keep Arabic words and plural forms but never show
// Arabic-Indic digits (٠١٢…). Every formatter goes through `intlLocale`, and this test reads the
// source so a new `Intl` call or `toLocale*String` with the bare UI language fails here.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { exactTime, relativeTime, shortDate } from '../src/devices/format.js';
import { intlLocale } from '../src/i18n/index.js';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const ARABIC_INDIC = /[٠-٩۰-۹]/;
const ARABIC_LETTER = /[ء-ي]/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe('Latin digits in the Arabic UI', () => {
  const ar = intlLocale('ar');

  it('asks every formatter for the Latin numbering system', () => {
    expect(ar).toBe('ar-u-nu-latn');
    expect(intlLocale('en')).toBe('en');
    expect(new Intl.NumberFormat(ar).resolvedOptions().numberingSystem).toBe('latn');
    expect(new Intl.DateTimeFormat(ar).resolvedOptions().numberingSystem).toBe('latn');
    // The engine may default `ar` to Arabic-Indic digits; the extension wins over any default.
    expect(new Intl.NumberFormat('ar-EG').format(43)).toMatch(ARABIC_INDIC);
    expect(new Intl.NumberFormat(intlLocale('ar')).format(43)).toBe('43');
  });

  it('keeps Arabic words around Latin digits: durations, counts, percentages, dates', () => {
    const when = '2026-09-26T21:05:00Z';
    const now = Date.parse(when) + 43 * 60_000;
    const samples = [
      relativeTime(when, now, 'ar'),
      exactTime(when, 'ar'),
      shortDate(when, 'ar'),
      new Intl.NumberFormat(ar, { style: 'percent' }).format(0.5),
      new Intl.NumberFormat(ar).format(1234567),
      new Intl.DateTimeFormat(ar, { dateStyle: 'long', timeStyle: 'short' }).format(new Date(when)),
    ];
    for (const text of samples) expect(text, text).not.toMatch(ARABIC_INDIC);
    expect(relativeTime(when, now, 'ar')).toMatch(/43/);
    expect(relativeTime(when, now, 'ar')).toMatch(ARABIC_LETTER);
    expect(shortDate(when, 'ar')).toMatch(/2026/);
  });

  it('no formatter in the web client bypasses intlLocale', () => {
    const offenders: string[] = [];
    for (const file of walk(src)) {
      if (!/\.tsx?$/.test(file)) continue;
      const text = readFileSync(file, 'utf8');
      const localVariable = /const locale = intlLocale\(/.test(text);
      const calls =
        /new Intl\.(?:NumberFormat|DateTimeFormat|RelativeTimeFormat)\(([^,)]*)|\.toLocale(?:Date|Time)?String\(([^,)]*)|Intl\.DateTimeFormat\(\)\.resolvedOptions/g;
      for (const match of text.matchAll(calls)) {
        if (match[0].endsWith('resolvedOptions')) continue; // the time zone, not a format
        const argument = (match[1] ?? match[2] ?? '').trim();
        if (argument.startsWith('intlLocale(')) continue;
        if (argument === 'locale' && localVariable) continue;
        const line = text.slice(0, match.index).split('\n').length;
        offenders.push(`${path.relative(src, file)}:${line}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
