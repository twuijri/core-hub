import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HermesProfileError,
  PROFILE_ARCHIVE_TIMEOUT_MS,
  createHermesProfileArchives,
  createHermesProfiles,
  type ProfileRunner,
} from './hermes-profiles.js';

let home: string;
afterEach(() => rmSync(home, { recursive: true, force: true }));

const idle: ProfileRunner = async () => ({ code: 0, stdout: '', stderr: '' });

describe("Hermes's profiles", () => {
  it("reads a display name as Hermes does: default's in the home, a named one's in its folder (§102)", () => {
    home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-'));
    const profiles = createHermesProfiles({ home, run: idle });
    expect(profiles.displayName('default')).toBe('');
    writeFileSync(path.join(home, 'profile.yaml'), 'display_name: "  الرئيسي  "\n');
    mkdirSync(path.join(home, 'profiles', 'design'), { recursive: true });
    writeFileSync(
      path.join(home, 'profiles', 'design', 'profile.yaml'),
      'description: Makes the pictures.\ndisplay_name: فريق التصميم\n',
    );
    mkdirSync(path.join(home, 'profiles', 'broken'), { recursive: true });
    writeFileSync(path.join(home, 'profiles', 'broken', 'profile.yaml'), '- not: [a map\n');
    expect(profiles.displayName('default')).toBe('الرئيسي');
    expect(profiles.displayName('design')).toBe('فريق التصميم');
    // Never an error: a file Hermes cannot read is no name, as in `hermes profile list`.
    expect(profiles.displayName('broken')).toBe('');
    expect(profiles.displayName('missing')).toBe('');
    expect(profiles.displayName('../etc')).toBe('');
  });

  it('lists what Hermes lists: valid ids, not default, not deleted, directories only', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-'));
    const root = path.join(home, 'profiles');
    for (const name of ['worker', 'design', 'default', 'Bad', 'data_team', '.deleted', 'gone']) {
      mkdirSync(path.join(root, name), { recursive: true });
    }
    // `hermes profile delete` leaves a tombstone beside the profiles.
    writeFileSync(path.join(root, '.deleted', 'gone'), 'deleted\n');
    writeFileSync(path.join(root, 'notes'), 'a file, not a profile');

    const profiles = createHermesProfiles({ home, run: idle });
    expect(await profiles.list()).toEqual(['data_team', 'design', 'worker']);
  });

  it('lists nothing when Hermes has no named profile yet', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-'));
    expect(await createHermesProfiles({ home, run: idle }).list()).toEqual([]);
  });

  it("creates through Hermes, from scratch or as a copy, and says Hermes's reason when it refuses", async () => {
    home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-'));
    const calls: string[][] = [];
    let answer = { code: 0, stdout: 'Profile created', stderr: '' };
    const profiles = createHermesProfiles({
      home,
      run: async (argv) => {
        calls.push([...argv]);
        return answer;
      },
    });

    await profiles.create('design', { kind: 'blank' });
    await profiles.create('worker', { kind: 'clone', source: 'design' });
    expect(calls).toEqual([
      ['profile', 'create', 'design', '--no-alias'],
      ['profile', 'create', 'worker', '--no-alias', '--clone-from', 'design'],
    ]);

    answer = {
      code: 1,
      stdout: '',
      stderr: "Traceback …\nError: Profile 'worker' already exists\n",
    };
    await expect(profiles.create('worker', { kind: 'blank' })).rejects.toThrow(
      new HermesProfileError("Error: Profile 'worker' already exists"),
    );
  });
});

describe("Hermes's display names", () => {
  it('names the default profile with `hermes profile rename default`, which keeps its id', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-'));
    const calls: string[][] = [];
    let answer = { code: 0, stdout: '✓ Display name set: الرئيسي', stderr: '' };
    const profiles = createHermesProfiles({
      home,
      run: async (argv) => {
        calls.push([...argv]);
        return answer;
      },
    });
    await profiles.setDisplayName('default', ' الرئيسي ');
    await profiles.setDisplayName('default', '-dash first');
    expect(calls).toEqual([
      ['profile', 'rename', '--', 'default', 'الرئيسي'],
      ['profile', 'rename', '--', 'default', '-dash first'],
    ]);

    answer = { code: 1, stdout: '', stderr: 'Error: Display name cannot be empty.\n' };
    await expect(profiles.setDisplayName('default', 'x')).rejects.toThrow(
      new HermesProfileError('Error: Display name cannot be empty.'),
    );
  });

  it("writes a named profile's `display_name` in its profile.yaml, and never moves it", async () => {
    home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-'));
    const dir = path.join(home, 'profiles', 'design');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'profile.yaml');
    writeFileSync(file, 'description: Designs the screens\ndescription_auto: false\n');
    const calls: string[][] = [];
    const profiles = createHermesProfiles({
      home,
      run: async (argv) => {
        calls.push([...argv]);
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    await profiles.setDisplayName('design', 'فريق التصميم');
    // Hermes's other keys stay; only the display name is added.
    expect(readFileSync(file, 'utf8')).toBe(
      'description: Designs the screens\ndescription_auto: false\ndisplay_name: فريق التصميم\n',
    );
    await profiles.setDisplayName('design', 'Design Team');
    expect(readFileSync(file, 'utf8')).toContain('display_name: Design Team\n');
    // Empty clears it, as in Hermes.
    await profiles.setDisplayName('design', '');
    expect(readFileSync(file, 'utf8')).toBe(
      'description: Designs the screens\ndescription_auto: false\n',
    );
    // No Hermes command ran: `hermes profile rename` would have moved the folder.
    expect(calls).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('creates no metadata to clear, and refuses a missing profile or a name over 64', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-'));
    mkdirSync(path.join(home, 'profiles', 'fresh'), { recursive: true });
    const profiles = createHermesProfiles({ home, run: idle });
    await profiles.setDisplayName('fresh', '');
    expect(existsSync(path.join(home, 'profiles', 'fresh', 'profile.yaml'))).toBe(false);
    await expect(profiles.setDisplayName('gone', 'X')).rejects.toThrow(
      new HermesProfileError("Profile 'gone' does not exist."),
    );
    await expect(profiles.setDisplayName('fresh', 'x'.repeat(65))).rejects.toThrow(
      new HermesProfileError('Display name too long (65 chars, max 64).'),
    );
  });
});

describe("Hermes's profile archives (dashboard API)", () => {
  it('asks for an export at a path and an import under a name, with the long timeout', async () => {
    const calls: Array<{ method: string; path: string; body: unknown; timeoutMs?: number }> = [];
    const archives = createHermesProfileArchives(async (method, route, body, options) => {
      calls.push({ method, path: route, body, ...options });
      return (
        route.endsWith('/export')
          ? { ok: true, archive: '/data/tmp/x/work.tar.gz' }
          : {
              ok: true,
              name: 'restored',
            }
      ) as never;
    });
    expect(await archives.export('work', '/data/tmp/x/work.tar.gz')).toBe(
      '/data/tmp/x/work.tar.gz',
    );
    await archives.import('/data/tmp/y/restored.tar.gz', 'restored');
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/profiles/work/export',
        body: { output: '/data/tmp/x/work.tar.gz' },
        timeoutMs: PROFILE_ARCHIVE_TIMEOUT_MS,
      },
      {
        method: 'POST',
        path: '/api/profiles/import',
        body: { archive: '/data/tmp/y/restored.tar.gz', name: 'restored' },
        timeoutMs: PROFILE_ARCHIVE_TIMEOUT_MS,
      },
    ]);
  });

  it('falls back to the path it asked for when Hermes does not say where it wrote', async () => {
    const archives = createHermesProfileArchives(async () => ({ ok: true }) as never);
    expect(await archives.export('default', '/tmp/a.tar.gz')).toBe('/tmp/a.tar.gz');
  });
});
