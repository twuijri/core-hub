import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginStore, parseLink, type StoredLink } from '../src/store.js';

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'corehub-dsh-store-'));
  dirs.push(dir);
  return path.join(dir, 'data');
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const link: StoredLink = {
  version: 1,
  hub: 'https://hub.example',
  token: 'hub_at_secret',
  token_expires_at: '2027-01-01T00:00:00.000Z',
  device_id: '01J8QK3ZR2W7M5N4P6T8V9X0DV',
  user: { id: 'u1', username: 'tariq', display_name: 'Tariq' },
  profiles: ['default', 'work'],
  default_profile: 'work',
  linked_at: '2026-11-22T00:00:00.000Z',
};

describe('PluginStore', () => {
  it.skipIf(process.platform === 'win32')(
    'keeps the token in a file only the person can read',
    () => {
      const store = new PluginStore(temp());
      store.saveLink(link);
      expect(statSync(store.linkFile).mode & 0o777).toBe(0o600);
      expect(statSync(store.dir).mode & 0o777).toBe(0o700);
      expect(store.link()).toEqual(link);
      expect(store.linkFileTooOpen()).toBe(false);
    },
  );

  it('keeps the device key across unlink', () => {
    const store = new PluginStore(temp());
    const key = store.deviceKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    store.saveLink(link);
    store.forgetLink();
    expect(store.link()).toBeNull();
    expect(store.deviceKey()).toBe(key);
  });

  it('remembers one hub conversation per harness session', () => {
    const store = new PluginStore(temp());
    expect(store.conversation('s1')).toBeNull();
    store.saveConversation('s1', { session_id: 'h1', profile: 'work' });
    store.saveConversation('s2', { session_id: 'h2', profile: 'default' });
    expect(store.conversation('s1')).toEqual({ session_id: 'h1', profile: 'work' });
    store.forgetLink();
    expect(store.conversation('s1')).toBeNull();
  });

  it('ignores a damaged or foreign file', () => {
    const store = new PluginStore(temp());
    store.saveLink(link);
    writeFileSync(store.linkFile, '{"version":2}');
    expect(store.link()).toBeNull();
    expect(parseLink({ ...link, token: '' })).toBeNull();
    expect(parseLink({ ...link, profiles: 'x' })?.profiles).toEqual([]);
  });
});
