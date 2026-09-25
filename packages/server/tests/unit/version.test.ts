// One version for every deliverable (owner, 2026-09-26): without a stamp the hub reports the
// root package.json's version, not 0.0.0 (docs/RELEASING.md).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readVersion } from '../../src/app/server.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const rootVersion = (
  JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

const dirs: string[] = [];
function dirWith(pkg: object | null): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'corehub-version-'));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  if (pkg) writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readVersion', () => {
  it('reports the root package.json version when nothing is stamped', () => {
    expect(rootVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(readVersion()).toBe(rootVersion);
    expect(readVersion(undefined)).toBe(rootVersion);
    expect(readVersion('  ')).toBe(rootVersion);
    expect(readVersion()).not.toBe('0.0.0');
  });

  it('lets a stamped version (a tag, a preview) win', () => {
    expect(readVersion('1.1.0-preview.12')).toBe('1.1.0-preview.12');
    expect(readVersion(' 2.0.0 ')).toBe('2.0.0');
  });

  it('skips a package.json two levels up that is not the repository root', () => {
    const app = dirWith({ name: '@corehub/desktop', version: '9.9.9' });
    const own = dirWith({ name: '@corehub/server', version: '1.1.0' });
    expect(readVersion(undefined, [app, own])).toBe('1.1.0');
    const root = dirWith({ name: 'corehub', version: '1.2.0' });
    expect(readVersion(undefined, [root, own])).toBe('1.2.0');
  });

  it('says 0.0.0 only when no package.json can be read', () => {
    expect(readVersion(undefined, [dirWith(null), dirWith(null)])).toBe('0.0.0');
  });
});
