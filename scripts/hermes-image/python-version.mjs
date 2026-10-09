#!/usr/bin/env node
// The Python a Hermes checkout runs on — read from the checkout, so the image
// (packages/server/Dockerfile) and CI's Hermes venv (ci.yml `hermes-real`, hermes-real-suites.yml)
// build every Hermes release on the interpreter that release was made for, the floor and the pin
// alike (docs/changes/2026-10-09-twuijri-hermes-0-21-6.md).
//
//   node scripts/hermes-image/python-version.mjs <hermes checkout>
//
// - Hermes v0.21.6 and later carry their own package manager (`pm/`), whose lock pins the one
//   CPython they support (`packages.python.version`, e.g. `3.14.7+20260901`); that exact release
//   is printed (`3.14.7`). Their core dependencies are declared for that Python only
//   (`; python_version >= '3.14'`): on an older interpreter they install with no dependencies at
//   all. The exact patch matters too: 3.14.4's SQLite (3.50.4) has the WAL-reset bug, and Hermes
//   then keeps its databases out of WAL mode; 3.14.7's (3.53.1) does not.
// - Older releases (v2026.9.24 and before, `requires-python = ">=3.11,<3.14"`) have no such lock
//   and run on 3.12, the Python the image always used.
//
// The image's uv (`ARG UV_VERSION`) must know the release printed; Hermes's own pin (uv 0.12.3)
// does.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const LEGACY_PYTHON = '3.12';

/** The Python release the checkout's `pm/lock.json` pins (`3.14.7`), or the legacy default. */
export function hermesPython(checkout) {
  const lock = path.join(checkout, 'pm', 'lock.json');
  if (!existsSync(lock)) return LEGACY_PYTHON;
  const pinned = JSON.parse(readFileSync(lock, 'utf8'))?.packages?.python?.version;
  const match = /^(\d+\.\d+\.\d+)(?:\+[0-9A-Za-z.]+)?$/.exec(String(pinned ?? ''));
  if (!match) throw new Error(`${lock}: no packages.python.version in the expected shape`);
  return match[1];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const checkout = process.argv[2];
  if (!checkout) {
    console.error('usage: node scripts/hermes-image/python-version.mjs <hermes checkout>');
    process.exit(2);
  }
  console.log(hermesPython(checkout));
}
