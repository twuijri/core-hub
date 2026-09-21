import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '..', 'scripts', 'check-clients.mjs');
const doc = path.resolve(here, '..', 'openapi.yaml');
const temps: string[] = [];

function fixture(source: string, file = 'packages/web/src/api.ts') {
  const root = mkdtempSync(path.join(tmpdir(), 'majlis-check-clients-'));
  temps.push(root);
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), source);
  return root;
}

function run(root: string) {
  return spawnSync(process.execPath, [script, '--root', root, '--doc', doc], { encoding: 'utf8' });
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('check-clients (ADR 0003)', () => {
  it('passes when every literal path is in the contract', () => {
    const result = run(fixture("export const health = () => fetch('/api/v1/health');\n"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('OK');
  });

  it('fails on a hand-typed path that the contract does not declare', () => {
    const result = run(fixture("const x = `/api/v1/pets/${id}`;\nconst y = '/api/v1/health';\n"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('/api/v1/pets/{p}');
    expect(result.stderr).not.toContain('/api/v1/health"');
  });

  it('scans native app sources too', () => {
    const result = run(fixture('val url = "$base/api/v1/nope"\n', 'apps/android/app/src/Main.kt'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('apps/android/app/src/Main.kt:1');
  });

  it('passes when there are no client sources yet', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'majlis-empty-'));
    temps.push(root);
    const result = run(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('nothing to check');
  });
});
