import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hermesManagedEnv, inheritedManagedDir } from './hermes-managed-env.js';

const dirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'corehub-managed-env-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the managed scope of a Hermes process the hub starts', () => {
  it('names its origin, and the values every profile it serves must resolve', () => {
    const dataDir = temp();
    const none = path.join(dataDir, 'no-system-scope');
    const env = hermesManagedEnv({
      dataDir,
      role: 'gateway',
      inherited: {},
      values: { API_SERVER_KEY: 'k'.repeat(32) },
      systemDir: none,
    });
    const dir = path.join(dataDir, 'hermes-managed', 'gateway');
    expect(env).toEqual({
      COREHUB_MCP_ORIGIN: 'gateway',
      API_SERVER_KEY: 'k'.repeat(32),
      HERMES_MANAGED_DIR: dir,
    });
    const text = readFileSync(path.join(dir, '.env'), 'utf8');
    expect(text).toContain('COREHUB_MCP_ORIGIN=gateway\n');
    expect(text).toContain(`API_SERVER_KEY=${'k'.repeat(32)}\n`);
    expect(statSync(path.join(dir, '.env')).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('gives each role its own folder and origin; the dashboard is neither hub nor gateway', () => {
    const dataDir = temp();
    const systemDir = path.join(dataDir, 'none');
    const tui = hermesManagedEnv({ dataDir, role: 'tui', inherited: {}, systemDir });
    const dashboard = hermesManagedEnv({ dataDir, role: 'dashboard', inherited: {}, systemDir });
    const profile = hermesManagedEnv({
      dataDir,
      role: 'profile-gateway',
      inherited: {},
      systemDir,
    });
    expect(tui.COREHUB_MCP_ORIGIN).toBe('hub');
    expect(dashboard.COREHUB_MCP_ORIGIN).toBe('dashboard');
    expect(profile.COREHUB_MCP_ORIGIN).toBe('gateway');
    expect(new Set([tui, dashboard, profile].map((env) => env.HERMES_MANAGED_DIR)).size).toBe(3);
    expect(readFileSync(path.join(tui.HERMES_MANAGED_DIR!, '.env'), 'utf8')).not.toContain(
      'API_SERVER_KEY',
    );
  });

  it("keeps an administrator's managed scope: its files first, the hub's names last", () => {
    const dataDir = temp();
    const admin = path.join(temp(), 'it-policy');
    mkdirSync(admin);
    writeFileSync(path.join(admin, '.env'), 'OPENAI_BASE_URL=https://proxy.example\n');
    writeFileSync(path.join(admin, 'config.yaml'), 'security:\n  redact_secrets: true\n');
    const env = hermesManagedEnv({
      dataDir,
      role: 'tui',
      inherited: { HERMES_MANAGED_DIR: admin },
    });
    const text = readFileSync(path.join(env.HERMES_MANAGED_DIR!, '.env'), 'utf8');
    expect(text.indexOf('OPENAI_BASE_URL=https://proxy.example')).toBeGreaterThan(-1);
    expect(text.indexOf('OPENAI_BASE_URL')).toBeLessThan(text.indexOf('COREHUB_MCP_ORIGIN=hub'));
    expect(readFileSync(path.join(env.HERMES_MANAGED_DIR!, 'config.yaml'), 'utf8')).toBe(
      'security:\n  redact_secrets: true\n',
    );
    // The system scope counts when nothing is named.
    expect(inheritedManagedDir({}, admin)).toBe(admin);
    // A named folder that does not exist is no scope, as Hermes reads it.
    expect(inheritedManagedDir({ HERMES_MANAGED_DIR: path.join(admin, 'gone') }, admin)).toBeNull();
  });

  it('quotes a value Hermes would otherwise read differently', () => {
    const dataDir = temp();
    const env = hermesManagedEnv({
      dataDir,
      role: 'gateway',
      inherited: {},
      values: { API_SERVER_KEY: 'a b#c"d' },
      systemDir: path.join(dataDir, 'none'),
    });
    expect(readFileSync(path.join(env.HERMES_MANAGED_DIR!, '.env'), 'utf8')).toContain(
      'API_SERVER_KEY="a b#c\\"d"\n',
    );
  });
});
