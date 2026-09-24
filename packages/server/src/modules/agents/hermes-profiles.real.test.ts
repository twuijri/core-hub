/**
 * Hermes's profiles with **the real Hermes** from the image (ADR 0014): `hermes profile
 * create` from scratch and as a copy, a refusal in Hermes's words, and the listing that
 * reads what Hermes wrote. Name the image to run it; without one it is skipped:
 *
 *   COREHUB_HERMES_IMAGE=ghcr.io/twuijri/core-hub:latest pnpm --filter @corehub/server test
 */
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HermesProfileError, createHermesProfiles, type ProfileRunner } from './hermes-profiles.js';

const image = process.env.COREHUB_HERMES_IMAGE;

describe.skipIf(!image)('Hermes profiles (real Hermes; set COREHUB_HERMES_IMAGE to run)', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'corehub-profiles-'));
  // The container's user is not ours; the throwaway home must be writable by it.
  chmodSync(home, 0o777);

  const run: ProfileRunner = (argv) =>
    new Promise((resolve) => {
      execFile(
        'docker',
        [
          'run',
          '--rm',
          '-v',
          `${home}:/hh`,
          '-e',
          'HERMES_HOME=/hh',
          '--entrypoint',
          '/opt/hermes/.venv/bin/hermes',
          image!,
          ...argv,
        ],
        { timeout: 120_000 },
        (error, stdout, stderr) =>
          resolve({
            code: error ? ((error as { code?: number }).code ?? 1) : 0,
            stdout: String(stdout),
            stderr: String(stderr),
          }),
      );
    });

  afterAll(() => {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // written by the container's user; the OS reclaims the temp dir
    }
  });

  it('creates from scratch and as a copy, refuses an existing name, and lists both', async () => {
    const profiles = createHermesProfiles({ home, run });

    await profiles.create('design', { kind: 'blank' });
    await profiles.create('worker', { kind: 'clone', source: 'design' });
    expect(existsSync(path.join(home, 'profiles', 'worker', 'SOUL.md'))).toBe(true);

    const refusal = await profiles.create('design', { kind: 'blank' }).catch((error) => error);
    expect(refusal).toBeInstanceOf(HermesProfileError);
    expect(String((refusal as Error).message)).toMatch(/design/);

    expect(await profiles.list()).toEqual(['design', 'worker']);
  }, 300_000);
});
