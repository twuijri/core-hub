// The image's Hermes stage picks the Python each Hermes release was made for
// (scripts/hermes-image/python-version.mjs, docs/changes/2026-10-09-twuijri-hermes-0-21-6.md).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { LEGACY_PYTHON, hermesPython } from './hermes-image/python-version.mjs';

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function checkout(lock) {
  const dir = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-python-'));
  dirs.push(dir);
  if (lock !== undefined) {
    mkdirSync(path.join(dir, 'pm'));
    writeFileSync(path.join(dir, 'pm', 'lock.json'), JSON.stringify(lock));
  }
  return dir;
}

describe('the Python a Hermes release runs on', () => {
  it('is 3.12 for a Hermes without its own package manager (v2026.9.24 and before)', () => {
    assert.equal(hermesPython(checkout()), LEGACY_PYTHON);
    assert.equal(LEGACY_PYTHON, '3.12');
  });

  it('is the exact release the package manager pins (v0.21.6 on), build tag dropped', () => {
    assert.equal(
      hermesPython(checkout({ packages: { python: { version: '3.14.7+20260901' } } })),
      '3.14.7',
    );
    assert.equal(hermesPython(checkout({ packages: { python: { version: '3.15.0' } } })), '3.15.0');
  });

  it('refuses a lock it cannot read rather than guessing', () => {
    assert.throws(() => hermesPython(checkout({ packages: {} })), /packages\.python\.version/);
    assert.throws(
      () => hermesPython(checkout({ packages: { python: { version: '3.14' } } })),
      /expected shape/,
    );
  });
});
