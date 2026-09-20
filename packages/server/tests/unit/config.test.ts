import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError, ENV_KEYS, loadConfig, pickEnv } from '../../src/app/config.js';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe('config', () => {
  it('reads only DATA_DIR, PORT, DATABASE_URL and HUB_ADMIN_PASSWORD', () => {
    expect([...ENV_KEYS]).toEqual(['DATA_DIR', 'PORT', 'DATABASE_URL', 'HUB_ADMIN_PASSWORD']);
    const picked = pickEnv({
      DATA_DIR: '/x',
      PORT: '1',
      SECRET_THING: 'no',
      PATH: '/bin',
    } as NodeJS.ProcessEnv);
    expect(Object.keys(picked)).toEqual(['DATA_DIR', 'PORT']);
  });

  it('defaults to SQLite under DATA_DIR and port 8080', () => {
    const config = loadConfig({ DATA_DIR: '/tmp/hub-data' });
    expect(config.port).toBe(8080);
    expect(config.database).toEqual({ kind: 'sqlite', file: '/tmp/hub-data/hub.sqlite' });
    expect(config.bootstrapAdminPassword).toBeUndefined();
  });

  it('switches to PostgreSQL when DATABASE_URL is set', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://hub:pw@db:5432/hub',
      HUB_ADMIN_PASSWORD: 'correct-horse',
    });
    expect(config.database).toEqual({ kind: 'postgres', url: 'postgres://hub:pw@db:5432/hub' });
    expect(config.bootstrapAdminPassword).toBe('correct-horse');
  });

  it('rejects an invalid port, a non-postgres URL and a short admin password', () => {
    expect(() => loadConfig({ PORT: '99999' })).toThrow(ConfigError);
    expect(() => loadConfig({ DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ HUB_ADMIN_PASSWORD: 'short' })).toThrow(/HUB_ADMIN_PASSWORD/);
  });

  it('is the only source file that touches process.env', () => {
    const offenders = walk(srcDir)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .filter((file) => path.relative(srcDir, file) !== path.join('app', 'config.ts'))
      .filter((file) => /process\.env/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(srcDir, file));
    expect(offenders).toEqual([]);
  });
});
