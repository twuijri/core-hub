// Every `t('key')` literal in src exists in the catalogues; dynamic prefixes are listed here
// with the values they can take.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { catalogues, createTranslator, translate } from '../src/i18n/index.js';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

function has(language: 'ar' | 'en', key: string): boolean {
  return translate(language, key) !== key;
}

const DYNAMIC: Record<string, string[]> = {
  'agents.status': [
    'available',
    'not_installed',
    'installing',
    'updating',
    'error',
    'limited',
    'disabled',
  ],
  approval: ['once', 'session', 'always', 'deny'],
  'devices.pairing': ['expired', 'cancelled'],
  'display.glass': ['0', '1', '2', '3'],
  'display.theme': ['system', 'light', 'dark'],
  'jobs.status': ['queued', 'running', 'succeeded', 'failed', 'cancelled'],
  // Both halves of every runtime check: `models.runtime.<id>.ok` and `.missing`
  // (`models/RuntimeChecks.tsx` picks one per check).
  'models.runtime.runtime_writable': ['ok', 'missing'],
  'models.runtime.provider_keys': ['ok', 'missing'],
  'models.runtime.provider_verified': ['ok', 'missing'],
  'models.runtime.model_selected': ['ok', 'missing'],
  'models.runtime.gateway_reloaded': ['ok', 'missing'],
  'pane.kind': ['tool', 'code', 'preview', 'artifact', 'tasks'],
  roles: ['owner', 'admin', 'member'],
  'sessions.source': [
    'chat',
    'global_agent',
    'room',
    'task',
    'schedule',
    'workflow',
    'channel',
    'cli',
    'api',
  ],
  'sessions.status': ['idle', 'running', 'waiting'],
  'shell.connection': ['connected', 'connecting', 'offline'],
  'tool.status': ['running', 'succeeded', 'failed', 'interrupted', 'awaiting_approval'],
};

describe('i18n', () => {
  it('every literal key used in src exists in ar and en', () => {
    const missing: string[] = [];
    for (const file of walk(src)) {
      if (!/\.tsx?$/.test(file) || file.includes('/i18n/')) continue;
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\b(?:t|fallback)\(\s*'([a-z0-9_.]+)'/g)) {
        const key = match[1] as string;
        if (!has('en', key) || !has('ar', key)) missing.push(`${path.relative(src, file)}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every dynamic key family is complete', () => {
    for (const [prefix, values] of Object.entries(DYNAMIC))
      for (const value of values) {
        const key =
          prefix === 'devices.pairing' ? `devices.pairing_${value}` : `${prefix}.${value}`;
        expect(has('en', key), key).toBe(true);
        expect(has('ar', key), key).toBe(true);
      }
  });

  it('interpolates and falls back', () => {
    const t = createTranslator('ar');
    expect(t('chat.usage', { input: 1, output: 2 })).toBe('1 داخل · 2 خارج');
    expect(translate('en', 'no.such.key')).toBe('no.such.key');
    expect(Object.keys(catalogues)).toEqual(['ar', 'en']);
  });
});
