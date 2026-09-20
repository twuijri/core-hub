#!/usr/bin/env node
// `pnpm i18n:check`: Arabic/English key parity for every locale set in the repository.
// Today: packages/server/src/i18n/{ar,en}.json. Later: packages/web and apps/* locale files —
// add their directories to LOCALE_SETS; the rule is the same (same keys, same placeholders, no empties).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LANGUAGES = ['ar', 'en'];
const LOCALE_SETS = [
  { name: 'server', dir: 'packages/server/src/i18n', required: true },
  { name: 'web', dir: 'packages/web/src/i18n', required: false },
  { name: 'desktop', dir: 'apps/desktop/src/i18n', required: false },
];

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`  error  ${msg}`);
};

function flatten(value, prefix = '', out = new Map()) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value))
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
  } else {
    out.set(prefix, value);
  }
  return out;
}

const placeholders = (text) =>
  [...String(text).matchAll(/\{[a-zA-Z0-9_]+\}/g)]
    .map((m) => m[0])
    .sort()
    .join(',');

for (const set of LOCALE_SETS) {
  const dir = path.join(repoRoot, set.dir);
  if (!existsSync(dir)) {
    if (set.required) fail(`${set.dir} is missing`);
    else console.log(`i18n:check  ${set.name}: ${set.dir} not present yet — skipped`);
    continue;
  }
  const catalogues = {};
  for (const language of LANGUAGES) {
    const file = path.join(dir, `${language}.json`);
    if (!existsSync(file)) {
      fail(`${set.dir}/${language}.json is missing`);
      continue;
    }
    try {
      catalogues[language] = flatten(JSON.parse(readFileSync(file, 'utf8')));
    } catch (error) {
      fail(`${set.dir}/${language}.json: ${error.message}`);
    }
  }
  if (Object.keys(catalogues).length !== LANGUAGES.length) continue;
  const [ar, en] = [catalogues.ar, catalogues.en];
  for (const key of en.keys())
    if (!ar.has(key)) fail(`${set.name}: "${key}" exists in en.json but not in ar.json`);
  for (const key of ar.keys())
    if (!en.has(key)) fail(`${set.name}: "${key}" exists in ar.json but not in en.json`);
  for (const [key, value] of en) {
    if (typeof value !== 'string' || value.trim() === '')
      fail(`${set.name}: en "${key}" is empty or not a string`);
    const other = ar.get(key);
    if (typeof other !== 'string' || other.trim() === '')
      fail(`${set.name}: ar "${key}" is empty or not a string`);
    else if (placeholders(value) !== placeholders(other))
      fail(`${set.name}: "${key}" placeholders differ between ar and en`);
  }
  console.log(`i18n:check  ${set.name}: ${en.size} keys, ar/en in parity`);
}

if (failures > 0) {
  console.error(`i18n:check  FAILED with ${failures} problem(s)`);
  process.exit(1);
}
console.log('i18n:check  OK');
