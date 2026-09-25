// scripts/version-check.mjs (`pnpm version:check`): one version for every Core Hub deliverable,
// the root package.json's (owner, 2026-09-26; docs/RELEASING.md).
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs script without type declarations
import * as versions from '../../../scripts/version-check.mjs';

const { check, write, tagFromEnv, workspacePackages } = versions as {
  check: (root: string, options?: { tag?: string }) => string[];
  write: (root: string) => string[];
  tagFromEnv: (env: Record<string, string | undefined>) => string | undefined;
  workspacePackages: (root: string) => string[];
};

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const COPIED = [
  'package.json',
  'pnpm-workspace.yaml',
  'apps/ios/project.yml',
  'apps/android/app/build.gradle.kts',
  'packages/server/Dockerfile',
];

const roots: string[] = [];
/** A copy of the files the check reads, from this repository. */
function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'corehub-version-check-'));
  roots.push(root);
  for (const file of [...COPIED, ...workspacePackages(repo)]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    cpSync(path.join(repo, file), path.join(root, file));
  }
  return root;
}
const edit = (root: string, file: string, change: (text: string) => string) =>
  writeFileSync(path.join(root, file), change(readFileSync(path.join(root, file), 'utf8')));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('version-check', () => {
  it('passes on this repository: every copy says the root version', () => {
    expect(check(repo)).toEqual([]);
    expect(workspacePackages(repo)).toContain('apps/desktop/package.json');
    expect(workspacePackages(repo)).toContain('packages/server/package.json');
  });

  it('fails when a workspace package.json differs', () => {
    const root = fixture();
    edit(root, 'packages/web/package.json', (t) =>
      t.replace(/"version": "[^"]*"/, '"version": "0.0.0"'),
    );
    expect(check(root)).toEqual([
      expect.stringMatching(/^packages\/web\/package\.json: 0\.0\.0 \(root is /),
    ]);
  });

  it('fails when the iOS MARKETING_VERSION differs', () => {
    const root = fixture();
    edit(root, 'apps/ios/project.yml', (t) =>
      t.replace(/MARKETING_VERSION: .*/, 'MARKETING_VERSION: 1.0.2'),
    );
    expect(check(root)).toEqual([expect.stringContaining('MARKETING_VERSION: 1.0.2')]);
  });

  it('fails when Android writes its versionName out instead of reading the root', () => {
    const root = fixture();
    const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    // Even the right number, written out, is a second place to forget.
    edit(root, 'apps/android/app/build.gradle.kts', (t) =>
      t.replace(/versionName = rootVersion/, `versionName = "${version}"`),
    );
    expect(check(root)).toEqual([
      expect.stringContaining('versionName (must be read from the root package.json)'),
    ]);
  });

  it('fails when the Dockerfile default differs, and on a root that is not plain X.Y.Z', () => {
    const root = fixture();
    edit(root, 'packages/server/Dockerfile', (t) =>
      t.replace(/^ARG COREHUB_VERSION=.*$/m, 'ARG COREHUB_VERSION=0.0.0'),
    );
    expect(check(root)).toEqual([expect.stringContaining('ARG COREHUB_VERSION: 0.0.0')]);
    edit(root, 'package.json', (t) => t.replace(/"version": "[^"]*"/, '"version": "1.2.0-rc.1"'));
    expect(check(root)[0]).toContain('is not a plain X.Y.Z version');
  });

  it('checks a v* tag against the root version', () => {
    const version = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
    expect(check(repo, { tag: `v${version}` })).toEqual([]);
    expect(check(repo, { tag: 'v9.9.9' })).toEqual([
      `tag v9.9.9: does not match the root version ${version}`,
    ]);
    expect(tagFromEnv({ GITHUB_REF: 'refs/tags/v1.1.0' })).toBe('v1.1.0');
    expect(tagFromEnv({ GITHUB_REF: 'refs/heads/main' })).toBeUndefined();
    expect(tagFromEnv({})).toBeUndefined();
  });

  it('--write copies a bumped root version everywhere it is written out', () => {
    const root = fixture();
    edit(root, 'package.json', (t) => t.replace(/"version": "[^"]*"/, '"version": "1.2.0"'));
    expect(check(root).length).toBeGreaterThan(1);
    const changed = write(root);
    expect(changed).toEqual(
      expect.arrayContaining([
        'apps/ios/project.yml',
        'packages/server/Dockerfile',
        'apps/desktop/package.json',
      ]),
    );
    expect(check(root)).toEqual([]);
    expect(readFileSync(path.join(root, 'apps/ios/project.yml'), 'utf8')).toContain(
      'MARKETING_VERSION: 1.2.0\n',
    );
    // Nothing else in the file moved (the blank line after the ARG stays).
    expect(readFileSync(path.join(root, 'packages/server/Dockerfile'), 'utf8')).toMatch(
      /^ARG COREHUB_VERSION=1\.2\.0\n\n/m,
    );
    expect(write(root)).toEqual([]);
  });
});
