/**
 * The Hermes card's version check against slow `hermes` programs (the desktop report of
 * 2026-09-27: "Command failed: …/.local/bin/hermes --version" on the card, no version).
 *
 * `hermes --version` prints its version first and then checks for updates over git and the
 * network, synchronously. The fakes below do the same — a version line, then a long wait — as
 * a shell script and as a Python program (whose output a pipe buffers until it exits).
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { unreachableFetch } from '../../../../tests/unit/helpers.js';
import { createHermesAdapter, httpHermesTransport } from './hermes.js';
import { parseVersion, readVersion } from './host.js';
import type { AgentTarget } from './types.js';

const dirs: string[] = [];
function binDir(name: string, body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-version-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const VERSION_LINE = 'Hermes Agent v0.21.5+3397.gd25bbd0 (2026.9.24) · upstream d25bbd01';

/** Prints the version and then "checks for updates" for 30 s. */
const slowShell = `#!/bin/sh\necho '${VERSION_LINE}'\necho 'Install method: git'\nsleep 30\necho 'Up to date'\n`;
const slowPython = `#!/usr/bin/env python3\nimport time\nprint(${JSON.stringify(VERSION_LINE)})\nprint("Install method: git")\ntime.sleep(30)\nprint("Up to date")\n`;
const silent = '#!/bin/sh\nsleep 30\n';
const broken = '#!/bin/sh\necho "ModuleNotFoundError: No module named \'ruamel\'" >&2\nexit 1\n';

const target: AgentTarget = {
  slug: 'hermes',
  name: 'Hermes',
  command: ['hermes'],
  executablePath: null,
  endpoint: 'http://127.0.0.1:8642',
};

function adapterOver(dir: string, versionTimeoutMs = 10_000) {
  return createHermesAdapter({
    host: { pathValue: `${dir}:/usr/bin:/bin`, inherited: { HOME: dir } },
    fetchImpl: unreachableFetch,
    versionTimeoutMs,
  });
}

describe('parseVersion', () => {
  it("reads Hermes's own line, `v` and build suffix included", () => {
    expect(parseVersion(VERSION_LINE)).toBe('0.21.5+3397.gd25bbd0');
    expect(parseVersion('Hermes Agent v0.12.0 (2026.9.14)')).toBe('0.12.0');
    expect(parseVersion('Hermes Agent v0.21.6 (2026.9.24)')).toBe('0.21.6');
  });

  it('never takes the release date or Python for the version of a Hermes that knows none', () => {
    // v0.21.6 on, with no install stamp and no git tag (a copied checkout): the date is the
    // last release's, and the next lines are about Python.
    expect(
      parseVersion('Hermes Agent vunknown (2026.9.24)\nInstall directory: /opt/x\nPython: 3.14.7'),
    ).toBeNull();
    expect(parseVersion('Hermes Agent vgit.1a2b3c4 (2026.9.24)')).toBeNull();
  });

  it('reads no version, and says why, from a Hermes that names no release', async () => {
    const dir = binDir(
      'hermes',
      "#!/bin/sh\necho 'Hermes Agent vunknown (2026.9.24)'\necho 'Python: 3.14.7'\nsleep 30\n",
    );
    const started = Date.now();
    const reading = await readVersion([path.join(dir, 'hermes'), '--version'], {
      timeoutMs: 20_000,
    });
    expect(reading.version).toBeNull();
    expect(reading.error).toMatch(/names no release: Hermes Agent vunknown/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('the Hermes card: `hermes --version` that goes on checking for updates', () => {
  it('shows the version as soon as it is printed, without an error, and does not wait', async () => {
    const adapter = adapterOver(binDir('hermes', slowShell));
    const started = Date.now();
    const probe = await adapter.probe(target);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(probe).toMatchObject({ installed: true, version: '0.21.5+3397.gd25bbd0', error: null });
  });

  it('reads a Python program line by line (its pipe output is not held back)', async () => {
    const adapter = adapterOver(binDir('hermes', slowPython));
    const started = Date.now();
    const found = await adapter.discover();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(found[0]).toMatchObject({ slug: 'hermes', version: '0.21.5+3397.gd25bbd0' });
  });

  it('says plainly when no version comes in time, instead of "Command failed"', async () => {
    const dir = binDir('hermes', silent);
    const probe = await adapterOver(dir, 800).probe(target);
    expect(probe.version).toBeNull();
    expect(probe.error).toBe(
      `${path.join(dir, 'hermes')} --version did not print a version within 1 s`,
    );
  });

  it('never takes a number in a warning on stderr for the version', async () => {
    const warned = `#!/bin/sh\necho 'warning: Python 3.9 support ends soon' >&2\nsleep 0.2\necho '${VERSION_LINE}'\nsleep 30\n`;
    const probe = await adapterOver(binDir('hermes', warned)).probe(target);
    expect(probe).toMatchObject({ version: '0.21.5+3397.gd25bbd0', error: null });
  });

  it("gives Hermes's own last line when it fails", async () => {
    const reading = await readVersion([path.join(binDir('hermes', broken), 'hermes'), '--version']);
    expect(reading.version).toBeNull();
    expect(reading.error).toMatch(
      /exited with code 1: ModuleNotFoundError: No module named 'ruamel'$/,
    );
  });
});

describe('a turn that cannot reach the gateway', () => {
  it('says what the hub knows about the gateway it runs, not only `fetch failed`', async () => {
    const transport = httpHermesTransport({
      endpoint: 'http://127.0.0.1:8642',
      apiKey: 'k'.repeat(32),
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
      unreachableNote: () => 'Hermes is still starting; try again in a moment',
    });
    await expect(
      transport.createRun({ input: 'hi', session_id: 'corehub-x' }, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'agent_unavailable',
      message:
        'the Hermes gateway at http://127.0.0.1:8642 did not answer (fetch failed) — Hermes is still starting; try again in a moment',
    });
  });
});
