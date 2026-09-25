#!/usr/bin/env node
// Checks the App Store listing in apps/ios/fastlane/metadata (fastlane `deliver` layout) against
// App Store Connect's limits before anything is uploaded (docs/store/apple/README.md):
//
//   node apps/ios/scripts/store-metadata.mjs            # check; exit 1 and list every broken field
//   node apps/ios/scripts/store-metadata.mjs --summary  # also print each field's length
//
// Lengths are counted in characters as App Store Connect counts them (Unicode code points). The
// keywords are also held to 100 UTF-8 bytes, so an Arabic list can never be cut by a byte limit.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const metadataDir = path.resolve(here, '..', 'fastlane', 'metadata');

export const LOCALES = ['en-US', 'ar-SA'];

/** Per-locale fields: [file, max characters, required]. */
export const FIELDS = [
  ['name.txt', 30, true],
  ['subtitle.txt', 30, true],
  ['promotional_text.txt', 170, true],
  ['description.txt', 4000, true],
  ['keywords.txt', 100, true],
  ['release_notes.txt', 4000, true],
  ['support_url.txt', 255, true],
  ['marketing_url.txt', 255, true],
  ['privacy_url.txt', 255, true],
];

// App Store Connect's category ids (the App Store Connect API's `appCategories`).
export const CATEGORIES = new Set([
  'BOOKS',
  'BUSINESS',
  'DEVELOPER_TOOLS',
  'EDUCATION',
  'ENTERTAINMENT',
  'FINANCE',
  'FOOD_AND_DRINK',
  'GAMES',
  'GRAPHICS_AND_DESIGN',
  'HEALTH_AND_FITNESS',
  'LIFESTYLE',
  'MAGAZINES_AND_NEWSPAPERS',
  'MEDICAL',
  'MUSIC',
  'NAVIGATION',
  'NEWS',
  'PHOTO_AND_VIDEO',
  'PRODUCTIVITY',
  'REFERENCE',
  'SHOPPING',
  'SOCIAL_NETWORKING',
  'SPORTS',
  'STICKERS',
  'TRAVEL',
  'UTILITIES',
  'WEATHER',
]);

/** What deliver sends: the file's text without surrounding blank space. */
export function read(file) {
  return readFileSync(file, 'utf8').trim();
}

export const characters = (text) => [...text].length;
export const bytes = (text) => Buffer.byteLength(text, 'utf8');

/** Every problem with one locale's fields, given as `{ file: text }`. */
export function checkLocale(locale, fields) {
  const problems = [];
  for (const [file, max, required] of FIELDS) {
    const text = fields[file];
    if (text === undefined || text === '') {
      if (required) problems.push(`${locale}/${file}: missing`);
      continue;
    }
    const length = characters(text);
    if (length > max) problems.push(`${locale}/${file}: ${length} characters, the limit is ${max}`);
    if (file.endsWith('_url.txt') && !/^https:\/\/\S+$/.test(text)) {
      problems.push(`${locale}/${file}: not one https:// address`);
    }
  }
  const name = fields['name.txt'] ?? '';
  if (name && characters(name) < 2) problems.push(`${locale}/name.txt: at least 2 characters`);
  const keywords = fields['keywords.txt'] ?? '';
  if (keywords) {
    if (bytes(keywords) > 100) {
      problems.push(`${locale}/keywords.txt: ${bytes(keywords)} bytes, keep it within 100`);
    }
    const words = keywords.split(',');
    if (words.some((word) => word !== word.trim() || word === '')) {
      problems.push(`${locale}/keywords.txt: comma-separated, with no spaces around the commas`);
    }
    const lower = words.map((word) => word.trim().toLowerCase());
    if (new Set(lower).size !== lower.length) problems.push(`${locale}/keywords.txt: a word twice`);
    // The name is searched already; repeating it wastes the field (App Store guidance).
    if (name && lower.includes(name.toLowerCase())) {
      problems.push(`${locale}/keywords.txt: repeats the app's name`);
    }
  }
  const subtitle = fields['subtitle.txt'] ?? '';
  if (subtitle && name && subtitle.toLowerCase() === name.toLowerCase()) {
    problems.push(`${locale}/subtitle.txt: the same as the name`);
  }
  return problems;
}

export function checkApp(fields) {
  const problems = [];
  const primary = fields['primary_category.txt'];
  const secondary = fields['secondary_category.txt'];
  if (!primary) problems.push('primary_category.txt: missing');
  for (const [file, value] of [
    ['primary_category.txt', primary],
    ['secondary_category.txt', secondary],
  ]) {
    if (value && !CATEGORIES.has(value)) problems.push(`${file}: "${value}" is not a category id`);
  }
  if (primary && primary === secondary)
    problems.push('secondary_category.txt: the same as the primary');
  if (!fields['copyright.txt']) problems.push('copyright.txt: missing');
  return problems;
}

function load(dir, files) {
  const out = {};
  for (const file of files) {
    const full = path.join(dir, file);
    if (existsSync(full)) out[file] = read(full);
  }
  return out;
}

function main() {
  const summary = process.argv.includes('--summary');
  const problems = checkApp(
    load(metadataDir, ['primary_category.txt', 'secondary_category.txt', 'copyright.txt']),
  );
  for (const locale of LOCALES) {
    const fields = load(
      path.join(metadataDir, locale),
      FIELDS.map(([file]) => file),
    );
    problems.push(...checkLocale(locale, fields));
    if (summary) {
      for (const [file, max] of FIELDS) {
        const text = fields[file] ?? '';
        const extra = file === 'keywords.txt' ? `, ${bytes(text)} bytes` : '';
        console.log(`${locale}/${file}: ${characters(text)}/${max}${extra}`);
      }
    }
  }
  if (problems.length > 0) {
    console.error(`store-metadata  ${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`store-metadata  OK — ${LOCALES.join(', ')} are within App Store Connect's limits.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
