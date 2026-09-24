import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore, defaultConfigPath, type StoredSession } from '../src/config.js';
import { CliError } from '../src/errors.js';

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'corehub-cli-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const session: StoredSession = {
  server: 'http://127.0.0.1:1',
  profile: 'default',
  token: 'jwt',
  token_kind: 'session',
  refresh_token: 'hub_rt_x',
  expires_at: null,
  user: {
    id: '01J8QK3ZR2W7M5N4P6T8V9X0HM',
    username: 'admin',
    display_name: 'Admin',
    role: 'owner',
  },
};

describe('defaultConfigPath', () => {
  it('follows XDG_CONFIG_HOME, then ~/.config, and COREHUB_CONFIG overrides both', () => {
    expect(defaultConfigPath({ XDG_CONFIG_HOME: '/x' }, '/home/u')).toBe('/x/corehub/config.json');
    expect(defaultConfigPath({ XDG_CONFIG_HOME: 'relative' }, '/home/u')).toBe(
      '/home/u/.config/corehub/config.json',
    );
    expect(defaultConfigPath({}, '/home/u')).toBe('/home/u/.config/corehub/config.json');
    expect(defaultConfigPath({ COREHUB_CONFIG: '/etc/m.json' }, '/home/u')).toBe('/etc/m.json');
  });
});

describe('ConfigStore', () => {
  it('writes the file 0600 in a 0700 directory and reads it back', () => {
    const dir = temp();
    const store = new ConfigStore(path.join(dir, 'corehub', 'config.json'));
    expect(store.session()).toBeNull();
    store.saveSession(session);
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(store.file)).mode & 0o777).toBe(0o700);
    expect(store.session()).toEqual(session);
  });

  it('keeps the device key across sign-outs', () => {
    const store = new ConfigStore(path.join(temp(), 'config.json'));
    const key = store.deviceKey();
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    store.saveSession(session);
    store.clearSession();
    expect(store.session()).toBeNull();
    expect(store.deviceKey()).toBe(key);
  });

  it('rejects a corrupt file loudly and ignores an unknown session shape', () => {
    const file = path.join(temp(), 'config.json');
    writeFileSync(file, '{not json');
    expect(() => new ConfigStore(file).read()).toThrow(CliError);
    writeFileSync(file, JSON.stringify({ version: 1, session: { token: 1 } }));
    expect(new ConfigStore(file).session()).toBeNull();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1 });
  });
});
