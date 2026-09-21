#!/usr/bin/env node
// ADR 0003: a hand-typed API path in a client is a CI failure.
// Scans client sources (packages/cli, packages/web, apps/*) for literal strings containing `/api/`
// and fails when one is not an operation path of the OpenAPI document.
//
//   node scripts/check-clients.mjs [--root <repoRoot>] [--doc <openapi.yaml>]
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { listOperations, loadDocument, openapiPath, repoRoot, walk } from './lib.mjs';

const args = process.argv.slice(2);
const option = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const root = path.resolve(option('--root', repoRoot));
const docPath = path.resolve(option('--doc', openapiPath));

const CLIENT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.vue',
  '.kt',
  '.kts',
  '.swift',
  '.dart',
  '.java',
]);
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'generated',
  '.gradle',
  'Pods',
  'DerivedData',
  '.git',
  'coverage',
]);

const clientRoots = [path.join(root, 'packages', 'cli'), path.join(root, 'packages', 'web')];
const appsDir = path.join(root, 'apps');
if (existsSync(appsDir)) {
  for (const entry of readdirSync(appsDir)) clientRoots.push(path.join(appsDir, entry));
}
const existingRoots = clientRoots.filter((dir) => existsSync(dir));
if (existingRoots.length === 0) {
  console.log(
    'check-clients  no client sources yet (packages/cli, packages/web, apps/*) — nothing to check.',
  );
  process.exit(0);
}

const doc = loadDocument(docPath);
if (!doc) {
  console.error(`check-clients  ${docPath} is missing; cannot verify client paths.`);
  process.exit(1);
}
const allowed = new Set(listOperations(doc).map((op) => normalise(op.fullPath)));

/** Turn any literal into a comparable template: params become {p}, no query, no trailing slash. */
export function normalise(literal) {
  return literal
    .replace(/[?#].*$/, '')
    .replace(/\$\{[^}]*\}/g, '{p}') // JS / Kotlin template `${x}`
    .replace(/\\\([^)]*\)/g, '{p}') // Swift interpolation \(x)
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, '{p}') // Kotlin `$x`
    .replace(/\{[^}]*\}/g, '{p}') // OpenAPI `{id}`
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '{p}') // Express-style `:id`
    .replace(/\/+$/, '')
    .replace(/^.*?(?=\/api\/)/, ''); // drop any origin before /api/
}

const LITERAL = /(["'`])((?:(?!\1)[^\\\n]|\\.)*?\/api\/(?:(?!\1)[^\\\n]|\\.)*?)\1/g;
const offenders = [];
let scanned = 0;
for (const dir of existingRoots) {
  for (const file of walk(dir, { extensions: CLIENT_EXTENSIONS, skipDirs: SKIP_DIRS })) {
    scanned += 1;
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      for (const match of line.matchAll(LITERAL)) {
        const literal = match[2];
        const candidate = normalise(literal);
        if (!candidate.startsWith('/api/')) continue;
        if (!allowed.has(candidate)) {
          offenders.push({ file: path.relative(root, file), line: index + 1, literal, candidate });
        }
      }
    });
  }
}

if (offenders.length > 0) {
  console.error(
    `check-clients  ${offenders.length} hand-typed path(s) not in the contract (ADR 0003):`,
  );
  for (const o of offenders)
    console.error(`  ${o.file}:${o.line}  "${o.literal}"  (as ${o.candidate})`);
  console.error(
    '  Fix: use the generated client, or add the operation to packages/contracts/openapi.yaml first.',
  );
  process.exit(1);
}
console.log(
  `check-clients  OK — ${scanned} client file(s) scanned, ${allowed.size} contract path(s) known.`,
);
