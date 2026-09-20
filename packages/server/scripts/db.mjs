#!/usr/bin/env node
// `pnpm db:generate` and `pnpm db:migrate`.
// - generate: drizzle-kit generate from src/modules/*/schema.ts into ./drizzle (skips when no schema exists yet).
// - migrate:  applies ./drizzle migrations to the configured database (SQLite under DATA_DIR by default,
//             PostgreSQL when DATABASE_URL is set). Skips when there are no migrations yet.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2];
const schemaFiles = existsSync(path.join(packageRoot, 'src', 'modules'))
  ? readdirSync(path.join(packageRoot, 'src', 'modules'))
      .map((name) => path.join(packageRoot, 'src', 'modules', name, 'schema.ts'))
      .filter((file) => existsSync(file))
  : [];

if (command === 'generate') {
  if (schemaFiles.length === 0) {
    console.log('db:generate  no src/modules/*/schema.ts yet — nothing to generate.');
    process.exit(0);
  }
  execFileSync(path.join(packageRoot, 'node_modules', '.bin', 'drizzle-kit'), ['generate'], {
    cwd: packageRoot,
    stdio: 'inherit',
  });
} else if (command === 'migrate') {
  const journal = path.join(packageRoot, 'drizzle', 'meta', '_journal.json');
  if (!existsSync(journal)) {
    console.log('db:migrate  no migrations in ./drizzle yet — nothing to apply.');
    process.exit(0);
  }
  const entry = existsSync(path.join(packageRoot, 'dist', 'app', 'migrate.js'))
    ? [path.join(packageRoot, 'dist', 'app', 'migrate.js')]
    : ['--import', 'tsx', path.join(packageRoot, 'src', 'app', 'migrate.ts')];
  execFileSync(process.execPath, entry, { cwd: packageRoot, stdio: 'inherit' });
} else {
  console.error('usage: node scripts/db.mjs <generate|migrate>');
  process.exit(2);
}
