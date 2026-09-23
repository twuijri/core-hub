import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HermesProfileError, createHermesProfiles, type ProfileRunner } from './hermes-profiles.js';

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
