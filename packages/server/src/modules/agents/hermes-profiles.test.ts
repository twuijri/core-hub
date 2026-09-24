import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  it('lists what Hermes lists: valid ids, not default, not deleted, directories only', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'majlis-hermes-'));
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
    home = mkdtempSync(path.join(tmpdir(), 'majlis-hermes-'));
    expect(await createHermesProfiles({ home, run: idle }).list()).toEqual([]);
  });

  it("creates through Hermes, from scratch or as a copy, and says Hermes's reason when it refuses", async () => {
    home = mkdtempSync(path.join(tmpdir(), 'majlis-hermes-'));
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
