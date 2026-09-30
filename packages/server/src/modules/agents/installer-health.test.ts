/**
 * An installed agent whose program has no `--version` is installed, not an error (owner's hub,
 * 2026-09-29): installing Codex ended in "Error" with `codex-acp`'s own words — "error:
 * unexpected argument '--version' found" — although npm had installed it, the same class of
 * failure as `claude-code-acp` serving ACP on stdin instead (PR #226).
 *
 * Every catalog agent is installed here as npm or the download leaves it, with a program that
 * refuses `--version`, and must read as installed with the version npm installed; only a
 * program that cannot start at all (missing, not executable, its interpreter gone) fails.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogEntry, type CatalogEntry } from './catalog/index.js';
import { createNpmInstaller, installedVersion } from './installer.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'corehub-health-'));
  dirs.push(dataDir);
  const installer = createNpmInstaller({
    dataDir,
    host: { pathValue: process.env.PATH, inherited: { PATH: process.env.PATH ?? '' } },
  });
  return { dataDir, installer };
}

const entryOf = (id: string): CatalogEntry => {
  const entry = catalogEntry(id);
  if (!entry) throw new Error(`no catalog entry ${id}`);
  return entry;
};

/** An executable in the agent's own `bin`, as the install leaves it. */
function program(dataDir: string, id: string, binary: string, body: string, mode = 0o755): void {
  const bin = path.join(dataDir, 'agents', id, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, binary), `#!/bin/sh\n${body}\n`);
  chmodSync(path.join(bin, binary), mode);
}

/** The package's `package.json` where `npm install --global --prefix` puts it. */
function npmPackage(dataDir: string, entry: CatalogEntry, version: string): void {
  if (entry.install.kind !== 'npm') return;
  const dir = path.join(
    dataDir,
    'agents',
    entry.id,
    'lib',
    'node_modules',
    ...entry.install.package.split('/'),
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: entry.install.package, version }),
  );
}

const REFUSES = `echo "error: unexpected argument '--version' found" >&2\necho "Usage: x [OPTIONS]" >&2\nexit 2`;

describe.skipIf(process.platform === 'win32')('the health of an installed agent', () => {
  it.each([
    ['codex', 'codex-acp'],
    ['claude-code', 'claude-code-acp'],
    ['gemini-cli', 'gemini'],
    ['opencode', 'opencode'],
    ['kimi-code', 'kimi'],
    ['qwen-code', 'qwen'],
    ['goose', 'goose'],
    ['grok-build', 'grok'],
  ])('%s: a program that refuses --version is installed, with npm’s version', async (id, bin) => {
    const { dataDir, installer } = setup();
    const entry = entryOf(id);
    program(dataDir, id, bin, REFUSES);
    npmPackage(dataDir, entry, '9.8.7');
    const health = await installer.health(entry, { timeoutMs: 2_000 });
    expect(health).toEqual({
      ok: true,
      // A download (Goose, Grok) has no package.json: the version its install recorded stays.
      version: entry.install.kind === 'npm' ? '9.8.7' : null,
      error: null,
    });
  });

  it('a bridge that serves ACP instead of answering is installed, cut at its deadline', async () => {
    const { dataDir, installer } = setup();
    const entry = entryOf('gemini-cli');
    program(dataDir, 'gemini-cli', 'gemini', 'exec sleep 600');
    npmPackage(dataDir, entry, '0.60.0');
    const began = Date.now();
    const health = await installer.health(entry, { timeoutMs: 300 });
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(health).toEqual({ ok: true, version: '0.60.0', error: null });
  });

  it('asks nothing of a bridge without a version flag (Codex, Claude Code)', async () => {
    const { dataDir, installer } = setup();
    for (const id of ['codex', 'claude-code']) {
      const entry = entryOf(id);
      expect(entry.health.kind).toBe('installed');
      // Would hang for ten minutes if it were run.
      program(dataDir, id, entry.binary, 'exec sleep 600');
      npmPackage(dataDir, entry, '0.16.2');
      expect(await installer.health(entry, { timeoutMs: 60_000 })).toEqual({
        ok: true,
        version: '0.16.2',
        error: null,
      });
    }
  });

  it('still prefers the version npm installed over one the program prints', async () => {
    const { dataDir, installer } = setup();
    const entry = entryOf('opencode');
    program(dataDir, 'opencode', 'opencode', 'echo "opencode 0.0.1-dev"');
    npmPackage(dataDir, entry, '1.18.31');
    expect(await installer.health(entry)).toMatchObject({ ok: true, version: '1.18.31' });
  });

  it('fails a program that cannot start: its interpreter is gone, or it is not executable', async () => {
    const { dataDir, installer } = setup();
    const gemini = entryOf('gemini-cli');
    const bin = path.join(dataDir, 'agents', 'gemini-cli', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'gemini'), '#!/no/such/interpreter\n');
    chmodSync(path.join(bin, 'gemini'), 0o755);
    npmPackage(dataDir, gemini, '0.60.0');
    const broken = await installer.health(gemini, { timeoutMs: 2_000 });
    expect(broken.ok).toBe(false);
    expect(broken.error).toBeTruthy();

    const codex = entryOf('codex');
    program(dataDir, 'codex', 'codex-acp', 'exit 0', 0o644);
    expect((await installer.health(codex)).ok).toBe(false);
  });

  it('reads npm’s version from either prefix layout, scoped or not', () => {
    const { dataDir } = setup();
    const codex = entryOf('codex');
    npmPackage(dataDir, codex, '0.16.0');
    expect(installedVersion(dataDir, codex)).toBe('0.16.0');
    // Windows puts it under `<prefix>/node_modules`.
    const opencode = entryOf('opencode');
    const dir = path.join(dataDir, 'agents', 'opencode', 'node_modules', 'opencode-ai');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), '{"version":"1.18.31"}');
    expect(installedVersion(dataDir, opencode)).toBe('1.18.31');
    expect(installedVersion(dataDir, entryOf('goose'))).toBeNull();
  });
});
