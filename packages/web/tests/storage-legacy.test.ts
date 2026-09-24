// Browser keys from before the rename (Majlis → Core Hub, ADR 0017) move once, before
// anything reads them: the session and every preference survive an image upgrade.
import { afterEach, describe, expect, it } from 'vitest';
import { migrateLegacyKeys, migrateLegacyStorage } from '../src/storage/legacy.js';

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('browser keys from before the rename', () => {
  it('move to the new names, and the old ones are gone', () => {
    localStorage.setItem('majlis.session', '{"token":"t"}');
    localStorage.setItem('majlis.display', '{"theme":"dark"}');
    localStorage.setItem('majlis.sessionOrder.default', '["a","b"]');
    sessionStorage.setItem('majlis.before-settings', '/chat');
    localStorage.setItem('unrelated', 'x');
    migrateLegacyStorage();
    expect(localStorage.getItem('corehub.session')).toBe('{"token":"t"}');
    expect(localStorage.getItem('corehub.display')).toBe('{"theme":"dark"}');
    expect(localStorage.getItem('corehub.sessionOrder.default')).toBe('["a","b"]');
    expect(sessionStorage.getItem('corehub.before-settings')).toBe('/chat');
    expect(localStorage.getItem('majlis.session')).toBeNull();
    expect(localStorage.getItem('unrelated')).toBe('x');
  });

  it('never overwrite what was already written under the new name', () => {
    localStorage.setItem('majlis.display', 'old');
    localStorage.setItem('corehub.display', 'new');
    expect(migrateLegacyKeys(localStorage)).toEqual([]);
    expect(localStorage.getItem('corehub.display')).toBe('new');
    expect(localStorage.getItem('majlis.display')).toBeNull();
  });

  it('do nothing without a store, and never throw from one that refuses', () => {
    expect(migrateLegacyKeys(null)).toEqual([]);
    const refusing = {
      length: 1,
      key: () => 'majlis.session',
      getItem: () => 'v',
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => undefined,
    };
    expect(() => migrateLegacyKeys(refusing)).not.toThrow();
  });
});
