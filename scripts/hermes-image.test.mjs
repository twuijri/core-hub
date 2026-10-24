// The image's Hermes stage picks the Python each Hermes release was made for
// (scripts/hermes-image/python-version.mjs, docs/changes/2026-10-09-twuijri-hermes-0-21-6.md).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { DEFAULT_AIOHTTP, hermesAiohttp } from './hermes-image/aiohttp-version.mjs';
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

function project(text) {
  const dir = mkdtempSync(path.join(tmpdir(), 'corehub-hermes-aiohttp-'));
  dirs.push(dir);
  if (text !== undefined) writeFileSync(path.join(dir, 'pyproject.toml'), text);
  return dir;
}

describe('the aiohttp a Hermes release is installed with', () => {
  it('is 3.14.3 when Hermes pins none (v0.22.2 and before)', () => {
    assert.equal(DEFAULT_AIOHTTP, '3.14.3');
    assert.equal(hermesAiohttp(project()), DEFAULT_AIOHTTP);
    assert.equal(hermesAiohttp(project('[project]\ndependencies = ["httpx==0.28.1"]\n')), '3.14.3');
  });

  it("is Hermes's own pin when it declares one (v0.22.5: the messaging extra)", () => {
    const text =
      '[project.optional-dependencies]\nmessaging = [\n  "aiohttp==3.14.5",\n  "slack-sdk==3.44.1",\n]\nweb = ["aiohttp[speedups]==3.14.5"]\n';
    assert.equal(hermesAiohttp(project(text)), '3.14.5');
  });

  it('refuses two different pins rather than guessing', () => {
    const text = 'a = ["aiohttp==3.14.5"]\nb = ["aiohttp==3.14.6"]\n';
    assert.throws(() => hermesAiohttp(project(text)), /more than one aiohttp pin/);
  });
});
