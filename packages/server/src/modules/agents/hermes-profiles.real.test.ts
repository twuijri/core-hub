/**
 * Hermes's profiles with **the real Hermes** from the image (ADR 0014): `hermes profile
 * create` from scratch and as a copy, a refusal in Hermes's words, the listing that reads
 * what Hermes wrote, and display names (contract decision §44) that Hermes itself shows. Name the image to run it; without one it is skipped:
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

  it('names default and a named profile the way Hermes shows them, ids and folders unmoved', async () => {
    const profiles = createHermesProfiles({ home, run });
    // A description Hermes keeps beside the display name, set by Hermes itself.
    const described = await run(['profile', 'describe', 'design', '--text', 'Designs screens']);
    expect(described.code).toBe(0);
    // The container's user wrote the folder; the hub writes into it as Hermes's user does.
    const opened = await new Promise<number>((resolve) =>
      execFile(
        'docker',
        [
          'run',
          '--rm',
          '-v',
          `${home}:/hh`,
          '--entrypoint',
          'chmod',
          image!,
          '-R',
          'a+rwX',
          '/hh/profiles',
        ],
        (error) => resolve(error ? 1 : 0),
      ),
    );
    expect(opened).toBe(0);

    await profiles.setDisplayName('default', 'الرئيسي');
    await profiles.setDisplayName('design', 'فريق التصميم');

    const main = await run(['profile', 'show', 'default']);
    expect(main.stdout).toContain('Profile: الرئيسي (default)');
    const design = await run(['profile', 'show', 'design']);
    expect(design.stdout).toContain('Profile: فريق التصميم (design)');
    const description = await run(['profile', 'describe', 'design']);
    expect(description.stdout).toContain('Designs screens');
    // Read back as Hermes reads it (§102): `default`'s by Hermes's own rename, and a name
    // Hermes wrote itself, with Hermes's own command, for a profile the hub never named.
    expect(profiles.displayName('default')).toBe('الرئيسي');
    expect(profiles.displayName('design')).toBe('فريق التصميم');
    expect((await run(['profile', 'rename', '--', 'default', 'البيت'])).code).toBe(0);
    expect(profiles.displayName('default')).toBe('البيت');
    expect(profiles.displayName('worker')).toBe('');
    // Nothing moved: the same ids, the same folders.
    expect(await profiles.list()).toEqual(['design', 'worker']);
    expect(existsSync(path.join(home, 'profiles', 'design', 'SOUL.md'))).toBe(true);

    // Named back to its id, Hermes shows the bare id again.
    await profiles.setDisplayName('design', '');
    expect((await run(['profile', 'show', 'design'])).stdout).toContain('Profile: design\n');
    // Hermes's own limit comes back in Hermes's words.
    await expect(
      profiles.setDisplayName('default', '-starts with a dash'),
    ).resolves.toBeUndefined();
    expect((await run(['profile', 'show', 'default'])).stdout).toContain(
      'Profile: -starts with a dash (default)',
    );
  }, 300_000);
});
