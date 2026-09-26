import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_MODELS_CATALOG_URL,
  ENV_KEYS,
  loadConfig,
  parseModelsCatalogUrl,
  pickEnv,
} from '../../src/app/config.js';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe('config', () => {
  it('reads only the hub variables, and nothing else from the environment', () => {
    expect([...ENV_KEYS]).toEqual([
      'DATA_DIR',
      'PORT',
      'DATABASE_URL',
      'HUB_ADMIN_PASSWORD',
      'COREHUB_VERSION',
      'COREHUB_SETUP_OPEN_MINUTES',
      'COREHUB_RESET_OWNER',
      'COREHUB_TASK_AUTO_START_MAX',
      'COREHUB_TASK_STUCK_MINUTES',
      'COREHUB_PUSH_CONTACT',
      'COREHUB_FCM_SERVICE_ACCOUNT',
      'COREHUB_APNS_KEY_ID',
      'COREHUB_APNS_TEAM_ID',
      'COREHUB_APNS_BUNDLE_ID',
      'COREHUB_APNS_KEY',
      'COREHUB_APNS_ENVIRONMENT',
      'COREHUB_PUSH_RELAY_URL',
      'COREHUB_PUSH_RELAY',
      'COREHUB_WEB_TERMINAL',
      'COREHUB_WEB_TERMINAL_IDLE_MINUTES',
      'COREHUB_TRUST_PROXY',
      'COREHUB_MODELS_CATALOG_URL',
    ]);
    const picked = pickEnv({
      DATA_DIR: '/x',
      PORT: '1',
      SECRET_THING: 'no',
      PATH: '/bin',
    } as NodeJS.ProcessEnv);
    expect(Object.keys(picked)).toEqual(['DATA_DIR', 'PORT']);
  });

  it('reads the version the image stamps, under its new name or its old one (ADR 0017)', () => {
    // Before the rename the image said MAJLIS_VERSION, and the hub never picked it up at all.
    expect(loadConfig(pickEnv({ COREHUB_VERSION: '1.4.0' } as NodeJS.ProcessEnv)).version).toBe(
      '1.4.0',
    );
    const old = pickEnv({ MAJLIS_VERSION: '1.3.0' } as NodeJS.ProcessEnv);
    expect(old.COREHUB_VERSION).toBe('1.3.0');
    expect(old.deprecated).toEqual(['MAJLIS_VERSION']);
    expect(loadConfig(old).deprecatedEnv).toEqual(['MAJLIS_VERSION']);
    const both = pickEnv({ MAJLIS_VERSION: 'old', COREHUB_VERSION: 'new' } as NodeJS.ProcessEnv);
    expect(both.COREHUB_VERSION).toBe('new');
    expect(both.deprecated).toBeUndefined();
    expect(loadConfig({}).deprecatedEnv).toEqual([]);
  });

  it('defaults to SQLite under DATA_DIR and port 8080', () => {
    const config = loadConfig({ DATA_DIR: '/tmp/hub-data' });
    expect(config.port).toBe(8080);
    expect(config.database).toEqual({ kind: 'sqlite', file: '/tmp/hub-data/hub.sqlite' });
    expect(config.bootstrapAdminPassword).toBeUndefined();
  });

  it('starts at most two tasks by itself per profile unless told otherwise', () => {
    expect(loadConfig({}).taskAutoStartMax).toBe(2);
    expect(loadConfig({ COREHUB_TASK_AUTO_START_MAX: '5' }).taskAutoStartMax).toBe(5);
    expect(() => loadConfig({ COREHUB_TASK_AUTO_START_MAX: '0' })).toThrow(
      /COREHUB_TASK_AUTO_START_MAX/,
    );
  });

  it('marks a running task stuck after 30 silent minutes unless told otherwise; 0 is off', () => {
    expect(loadConfig({}).taskStuckMinutes).toBe(30);
    expect(loadConfig({ COREHUB_TASK_STUCK_MINUTES: '5' }).taskStuckMinutes).toBe(5);
    expect(loadConfig({ COREHUB_TASK_STUCK_MINUTES: '0' }).taskStuckMinutes).toBe(0);
    expect(() => loadConfig({ COREHUB_TASK_STUCK_MINUTES: '-1' })).toThrow(
      /COREHUB_TASK_STUCK_MINUTES/,
    );
  });

  it('the web terminal is off by default, closes idle sessions after 15 minutes, three at most', () => {
    expect(loadConfig({}).webTerminal).toEqual({
      enabled: false,
      idleMs: 15 * 60_000,
      maxSessions: 3,
    });
    expect(loadConfig({ COREHUB_WEB_TERMINAL: '0' }).webTerminal.enabled).toBe(false);
    expect(loadConfig({ COREHUB_WEB_TERMINAL: '1' }).webTerminal.enabled).toBe(true);
    expect(
      loadConfig({ COREHUB_WEB_TERMINAL: '1', COREHUB_WEB_TERMINAL_IDLE_MINUTES: '5' }).webTerminal
        .idleMs,
    ).toBe(5 * 60_000);
    expect(() => loadConfig({ COREHUB_WEB_TERMINAL: 'yes' })).toThrow(/COREHUB_WEB_TERMINAL/);
    expect(() => loadConfig({ COREHUB_WEB_TERMINAL_IDLE_MINUTES: '0' })).toThrow(
      /COREHUB_WEB_TERMINAL_IDLE_MINUTES/,
    );
  });

  it('first-run setup is open for 60 minutes by default; 0 is token only; reset is opt-in (ADR 0019)', () => {
    expect(loadConfig({}).setupOpenMinutes).toBe(60);
    expect(loadConfig({ COREHUB_SETUP_OPEN_MINUTES: '0' }).setupOpenMinutes).toBe(0);
    expect(loadConfig({ COREHUB_SETUP_OPEN_MINUTES: '15' }).setupOpenMinutes).toBe(15);
    expect(() => loadConfig({ COREHUB_SETUP_OPEN_MINUTES: '-1' })).toThrow(
      /COREHUB_SETUP_OPEN_MINUTES/,
    );
    expect(() => loadConfig({ COREHUB_SETUP_OPEN_MINUTES: 'soon' })).toThrow(ConfigError);
    expect(loadConfig({}).resetOwner).toBe(false);
    expect(loadConfig({ COREHUB_RESET_OWNER: '1' }).resetOwner).toBe(true);
    expect(loadConfig({ COREHUB_RESET_OWNER: '0' }).resetOwner).toBe(false);
    expect(() => loadConfig({ COREHUB_RESET_OWNER: 'yes' })).toThrow(/COREHUB_RESET_OWNER/);
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

  it('reads the shared models catalogue from the repository unless told otherwise (§110)', () => {
    expect(loadConfig({ DATA_DIR: '/tmp/x' }).modelsCatalogUrl).toBe(DEFAULT_MODELS_CATALOG_URL);
    expect(DEFAULT_MODELS_CATALOG_URL).toBe(
      'https://raw.githubusercontent.com/twuijri/core-hub/main/catalog/models.json',
    );
    expect(parseModelsCatalogUrl('off')).toBeNull();
    expect(parseModelsCatalogUrl('https://example.test/models.json')).toBe(
      'https://example.test/models.json',
    );
    expect(() => parseModelsCatalogUrl('http://example.test/models.json')).toThrow(
      /COREHUB_MODELS_CATALOG_URL/,
    );
  });
});
