#!/usr/bin/env node
// The aiohttp a Hermes checkout's API server is installed with — Hermes's own pin when its
// pyproject declares one (`aiohttp==3.14.5` in the `messaging` extra from v0.22.5), else the
// image's long-standing 3.14.3. The image (packages/server/Dockerfile) and CI's Hermes venv
// (ci.yml `hermes-real`, hermes-real-suites.yml) install it next to the core, and the channel
// step installs the extra under the core's versions as constraints, so the two must agree:
// v0.22.5 with a fixed 3.14.3 failed with "requirements are unsatisfiable"
// (docs/changes/2026-10-25-twuijri-hermes-v0-22-5.md).
//
//   node scripts/hermes-image/aiohttp-version.mjs <hermes checkout>
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_AIOHTTP = '3.14.3';

/** The aiohttp release the checkout's pyproject pins (`3.14.5`), or the image's default. */
export function hermesAiohttp(checkout) {
  const pyproject = path.join(checkout, 'pyproject.toml');
  if (!existsSync(pyproject)) return DEFAULT_AIOHTTP;
  const pins = new Set(
    [
      ...readFileSync(pyproject, 'utf8').matchAll(
        /["']aiohttp(?:\[[^\]]*\])?==(\d+\.\d+\.\d+)["']/g,
      ),
    ].map((match) => match[1]),
  );
  if (pins.size > 1)
    throw new Error(`${pyproject}: more than one aiohttp pin (${[...pins].join(', ')})`);
  return pins.size === 1 ? [...pins][0] : DEFAULT_AIOHTTP;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const checkout = process.argv[2];
  if (!checkout) {
    console.error('usage: node scripts/hermes-image/aiohttp-version.mjs <hermes checkout>');
    process.exit(2);
  }
  console.log(hermesAiohttp(checkout));
}
