#!/usr/bin/env node
// Builds this platform's installers into release/ and prints their sizes. `pnpm build` first.
//   node scripts/package.mjs [--linux|--mac|--win] [extra electron-builder args]
// COREHUB_VERSION stamps the version (a tag, or a preview's); without it the app carries the root
// package.json's version, the one every Core Hub deliverable carries (docs/RELEASING.md).
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(path.join(here, 'dist/main.cjs')) || !existsSync(path.join(here, 'dist/hub'))) {
  console.error('package: dist/ is incomplete — run `pnpm build` at the repository root first.');
  process.exit(1);
}
const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve('electron-builder/package.json')), 'cli.js');
const rootVersion = JSON.parse(readFileSync(path.join(here, '../../package.json'), 'utf8')).version;
const version = process.env.COREHUB_VERSION?.trim().replace(/^v/, '') || rootVersion;
const args = [
  cli,
  '--config',
  'electron-builder.config.cjs',
  '--publish',
  'never',
  `-c.extraMetadata.version=${version}`,
  ...process.argv.slice(2),
];
const result = spawnSync(process.execPath, args, {
  cwd: here,
  stdio: 'inherit',
  // Never sign with whatever identity the machine's keychain holds; a signed build names its
  // certificate in CSC_LINK or CSC_NAME (electron-builder.config.cjs).
  env:
    process.env.CSC_LINK || process.env.CSC_NAME
      ? process.env
      : { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
});
if (result.status !== 0) process.exit(result.status ?? 1);

const release = path.join(here, 'release');
const installers = readdirSync(release).filter((f) => /\.(AppImage|deb|dmg|exe)$/.test(f));
const mb = (bytes) => `${(bytes / 1_000_000).toFixed(1)} MB`;
const rows = installers.map((f) => `| ${f} | ${mb(statSync(path.join(release, f)).size)} |`);
const table = ['| Installer | Size |', '|---|---|', ...rows].join('\n');
console.log(`\n${table}\n`);
writeFileSync(path.join(release, 'sizes.md'), `${table}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
