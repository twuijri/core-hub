#!/usr/bin/env node
// Builds the embedded hub of local mode into dist/hub/ — the same packages/server code, as one
// ES module plus the few files it reads from disk at run time:
//
//   dist/hub/package.json             the server's (its version is read from here)
//   dist/hub/drizzle/                 the migrations (`packageRoot/drizzle`)
//   dist/hub/dist/app/hub.mjs         the bundle; `packageRoot` is two levels up, as in the server
//   dist/hub/dist/app/openapi.yaml    the contract, found by `contractsRoot()` walking up from the
//   dist/hub/dist/app/events/         bundle to a package.json named @corehub/contracts
//   dist/hub/node_modules/            better-sqlite3 and argon2: N-API, with prebuilt binaries for
//                                     every platform, so Electron's Node loads them unrebuilt
//
// Nothing here is Hermes (ADR 0009): the hub finds the person's own install at run time.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(here, '../..');
const server = path.join(repo, 'packages/server');
const contracts = path.join(repo, 'packages/contracts');
const out = path.join(here, 'dist/hub');
const app = path.join(out, 'dist/app');

const NATIVE = ['better-sqlite3', 'argon2'];

rmSync(out, { recursive: true, force: true });
mkdirSync(app, { recursive: true });

await build({
  entryPoints: [path.join(here, 'src/hub/entry.ts')],
  outfile: path.join(app, 'hub.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
  // Native modules stay files; pg-native and pino-pretty are optional and never installed.
  external: [...NATIVE, 'pg-native', 'pino-pretty'],
  // CommonJS dependencies inside an ES module bundle still call require() and read __dirname.
  banner: {
    js: [
      "import { createRequire as __corehubRequire } from 'node:module';",
      "import { fileURLToPath as __corehubPath } from 'node:url';",
      "import { dirname as __corehubDir } from 'node:path';",
      'const require = __corehubRequire(import.meta.url);',
      'const __filename = __corehubPath(import.meta.url);',
      'const __dirname = __corehubDir(__filename);',
    ].join('\n'),
  },
});

// What the server reads relative to its package.
const serverPkg = JSON.parse(readFileSync(path.join(server, 'package.json'), 'utf8'));
writeFileSync(
  path.join(out, 'package.json'),
  `${JSON.stringify({ name: serverPkg.name, version: serverPkg.version, private: true, type: 'module' }, null, 2)}\n`,
);
cpSync(path.join(server, 'drizzle'), path.join(out, 'drizzle'), { recursive: true });

// What the contract loader reads next to the bundle.
writeFileSync(
  path.join(app, 'package.json'),
  `${JSON.stringify({ name: '@corehub/contracts', private: true, type: 'module' }, null, 2)}\n`,
);
cpSync(path.join(contracts, 'openapi.yaml'), path.join(app, 'openapi.yaml'));
cpSync(path.join(contracts, 'events'), path.join(app, 'events'), { recursive: true });

// The native modules and what they load at run time — resolved from the server, so the
// versions are exactly the ones its lockfile pins. Sources and build files are left behind.
const requireFromServer = createRequire(path.join(server, 'package.json'));
const copied = new Set();
function copyPackage(name, from) {
  if (copied.has(name)) return;
  copied.add(name);
  const pkgFile = createRequire(from).resolve(`${name}/package.json`);
  const dir = path.dirname(pkgFile);
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  cpSync(dir, path.join(out, 'node_modules', name), {
    recursive: true,
    dereference: true,
    filter: (source) => {
      const rel = path.relative(dir, source);
      if (rel === '') return true;
      const top = rel.split(path.sep)[0];
      return ![
        'node_modules',
        'src',
        'deps',
        'build',
        'argon2',
        'binding.gyp',
        'argon2.cpp',
      ].includes(top);
    },
  });
  // Build-only dependencies are not needed to load a prebuilt binary.
  for (const dep of Object.keys(pkg.dependencies ?? {}))
    if (!['node-addon-api', 'cross-env'].includes(dep)) copyPackage(dep, pkgFile);
}
for (const name of NATIVE) copyPackage(name, requireFromServer.resolve(`${name}/package.json`));

console.log(`desktop build: ${path.relative(repo, out)} ready (${[...copied].join(', ')})`);
