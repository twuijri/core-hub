// The names the client had before the rename (Majlis → Core Hub, ADR 0017) still work, and
// each run that uses one says so on stderr — never on stdout, where a script reads.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore, defaultConfigPath, legacyConfigPath } from '../src/config.js';
import { invokedByLegacyName, withLegacyEnv } from '../src/legacy.js';
import { main } from '../src/main.js';
import { parseQrPayload } from '../src/commands/pair.js';

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'corehub-cli-legacy-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function io(env: NodeJS.ProcessEnv, invokedAs?: string) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
  return {
    io: {
      stdin: new PassThrough(),
      stdout,
      stderr,
      env,
      ...(invokedAs ? { invokedAs } : {}),
    },
    stdout: () => out,
    stderr: () => err,
  };
}

describe('the old environment names', () => {
  it('fill the new ones that are unset, and are named so the run can say so', () => {
    const result = withLegacyEnv({ MAJLIS_LANG: 'ar', MAJLIS_DEBUG: '1', COREHUB_CONFIG: '/c' });
    expect(result.env.COREHUB_LANG).toBe('ar');
    expect(result.env.COREHUB_DEBUG).toBe('1');
    expect(result.env.COREHUB_CONFIG).toBe('/c');
    expect(result.deprecated).toEqual(['MAJLIS_LANG', 'MAJLIS_DEBUG']);
  });

  it('lose to the new name when both are set', () => {
    const result = withLegacyEnv({ MAJLIS_LANG: 'ar', COREHUB_LANG: 'en' });
    expect(result.env.COREHUB_LANG).toBe('en');
    expect(result.deprecated).toEqual([]);
  });

  it('are used by a real run, which says so on stderr and keeps stdout clean', async () => {
    const run = io({ MAJLIS_LANG: 'ar', HOME: temp() });
    const code = await main(['--version'], run.io);
    expect(code).toBe(0);
    expect(run.stdout()).toMatch(/^\d+\.\d+\.\d+\n$/);
    expect(run.stderr()).toContain('MAJLIS_LANG');
    expect(run.stderr()).toContain('COREHUB_LANG');
    // The value was honoured: the notice itself is in Arabic.
    expect(run.stderr()).toContain('الاسم القديم');
  });
});

describe('the old command name', () => {
  it('is recognised by the path it was started from', () => {
    expect(invokedByLegacyName('/usr/local/bin/majlis')).toBe(true);
    expect(invokedByLegacyName('/usr/local/bin/corehub')).toBe(false);
    expect(invokedByLegacyName(undefined)).toBe(false);
  });

  it('still runs, and says which name to use', async () => {
    const run = io({ HOME: temp() }, '/usr/local/bin/majlis');
    expect(await main(['--version'], run.io)).toBe(0);
    expect(run.stderr()).toContain('use `corehub`');
  });
});

describe('the old config file', () => {
  it('is where the default path used to point', () => {
    expect(defaultConfigPath({}, '/home/u')).toBe('/home/u/.config/corehub/config.json');
    expect(legacyConfigPath({}, '/home/u')).toBe('/home/u/.config/majlis/config.json');
    expect(legacyConfigPath({ XDG_CONFIG_HOME: '/x' }, '/home/u')).toBe('/x/majlis/config.json');
    // A file chosen on purpose is never swapped for another.
    expect(legacyConfigPath({ COREHUB_CONFIG: '/etc/c.json' }, '/home/u')).toBeNull();
  });

  it('is moved in on the first read, so an upgrade signs nobody out', () => {
    const home = temp();
    const legacy = legacyConfigPath({}, home)!;
    mkdirSync(path.dirname(legacy), { recursive: true });
    writeFileSync(legacy, JSON.stringify({ version: 1, device_key: 'dev-1', session: null }));
    const store = new ConfigStore(defaultConfigPath({}, home), legacy);
    expect(store.read().device_key).toBe('dev-1');
    expect(existsSync(legacy)).toBe(false);
    expect(JSON.parse(readFileSync(defaultConfigPath({}, home), 'utf8'))).toMatchObject({
      device_key: 'dev-1',
    });
  });

  it('is left alone when the new file already exists', () => {
    const home = temp();
    const legacy = legacyConfigPath({}, home)!;
    const current = defaultConfigPath({}, home);
    mkdirSync(path.dirname(legacy), { recursive: true });
    mkdirSync(path.dirname(current), { recursive: true });
    writeFileSync(legacy, JSON.stringify({ version: 1, device_key: 'old', session: null }));
    writeFileSync(current, JSON.stringify({ version: 1, device_key: 'new', session: null }));
    expect(new ConfigStore(current, legacy).read().device_key).toBe('new');
    expect(existsSync(legacy)).toBe(true);
  });
});

describe('a pairing code shown by a hub from before the rename', () => {
  it('is still a pairing code', () => {
    const old = '{"type":"majlis.pairing","pairing_id":"P1","code":"7KQ2-M9XW"}';
    expect(parseQrPayload(old)).toMatchObject({ pairing_id: 'P1', code: '7KQ2-M9XW' });
    expect(() => parseQrPayload('{"type":"other.pairing","pairing_id":"P1","code":"C"}')).toThrow();
  });
});
