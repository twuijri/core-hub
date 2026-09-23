#!/usr/bin/env node
// A PR must add or update a dated change record under docs/changes with every mandatory
// section from docs/changes/README.md (TEAM-RULES §2). Used by .github/workflows/change-record.yml.
//
//   node scripts/check-change-record.mjs --base origin/main      # files changed vs base (git)
//   node scripts/check-change-record.mjs --files docs/changes/2026-09-21-twuijri-x.md ...
//   node scripts/check-change-record.mjs --all                  # validate every record
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const changesDir = path.join(repoRoot, 'docs', 'changes');
const FILE_PATTERN = /^docs\/changes\/\d{4}-\d{2}-\d{2}-[a-z0-9]+-[a-z0-9][a-z0-9-]*\.md$/;
const HEADER_PATTERN =
  /^المسؤول:\s*\S.*·\s*الفرع:\s*\S.*·\s*الحالة:\s*(planned|in-progress|blocked|review|done)\s*$/m;
const SECTIONS = [
  '## المشكلة والهدف',
  '## القرار والموافقات',
  '## العقد',
  '## الملفات والتأثير',
  '## الفحوص',
  '## المخاطر والرجوع',
  '## التسليم والخطوة التالية',
];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

let files;
if (flag('--all')) {
  files = readdirSync(changesDir)
    .filter((name) => name !== 'README.md' && name.endsWith('.md'))
    .map((name) => `docs/changes/${name}`);
} else if (flag('--files')) {
  files = args.slice(args.indexOf('--files') + 1).filter((a) => !a.startsWith('--'));
} else {
  const base = value('--base') ?? 'origin/main';
  const changed = (...filter) =>
    execFileSync('git', ['diff', '--name-only', ...filter, `${base}...HEAD`], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
  // The code-map bot's PR (.github/workflows/code-map.yml) only refreshes the generated map:
  // there is no task to record. Exempt exactly that — a change set touching graphify-out/ alone.
  const all = changed();
  if (all.length > 0 && all.every((f) => f.startsWith('graphify-out/'))) {
    console.log(
      `change-record  OK — only graphify-out/ changed (${all.length} file(s)): the generated code map needs no record`,
    );
    process.exit(0);
  }
  files = changed('--diff-filter=AM').filter(
    (f) => f.startsWith('docs/changes/') && f !== 'docs/changes/README.md',
  );
  if (files.length === 0) {
    console.error(
      'change-record  FAILED: this change adds or updates no file under docs/changes/ (TEAM-RULES §2).',
    );
    console.error(
      '  Add docs/changes/YYYY-MM-DD-<owner>-<topic>.md with the sections in docs/changes/README.md.',
    );
    process.exit(1);
  }
}

let failures = 0;
const fail = (file, msg) => {
  failures += 1;
  console.error(`  error  ${file}: ${msg}`);
};

for (const file of files) {
  const rel = file.replace(/\\/g, '/');
  if (!FILE_PATTERN.test(rel))
    fail(rel, 'name must be docs/changes/YYYY-MM-DD-<owner>-<topic>.md (lowercase, hyphens)');
  const abs = path.join(repoRoot, rel);
  if (!existsSync(abs)) {
    fail(rel, 'file does not exist');
    continue;
  }
  const text = readFileSync(abs, 'utf8');
  if (!/^# \S/m.test(text)) fail(rel, 'missing the "# title" line');
  if (!HEADER_PATTERN.test(text))
    fail(
      rel,
      'missing header "المسؤول: … · الفرع: … · الحالة: planned|in-progress|blocked|review|done"',
    );
  for (const section of SECTIONS) {
    if (!new RegExp(`^${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'm').test(text))
      fail(rel, `missing section "${section}"`);
  }
  const checks = text.split('## الفحوص')[1]?.split(/^## /m)[0] ?? '';
  if (!/```/.test(checks) && !/لم تُشغَّل|لم تشغل|not run/i.test(checks)) {
    fail(
      rel,
      'the الفحوص section must paste actual command output (a ``` block) or say explicitly that checks were not run',
    );
  }
}

if (failures > 0) {
  console.error(`change-record  FAILED with ${failures} problem(s)`);
  process.exit(1);
}
console.log(`change-record  OK — ${files.length} record(s) valid`);
