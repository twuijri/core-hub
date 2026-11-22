#!/usr/bin/env node
// Builds the plugin into dist/ as self-contained ES modules a harness profile loads by package
// name: the contract client, Socket.IO and our code are bundled in; only the harness's own
// Schemastery stays outside, resolved from the running harness (a peer, publish.md).
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(here, 'dist');
const pkg = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: {
    index: path.join(here, 'src/index.ts'),
    'screen-consent': path.join(here, 'src/screen-consent.ts'),
  },
  outdir: out,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'warning',
  external: ['@deepseek-ai/*'],
  define: { __PLUGIN_VERSION__: JSON.stringify(pkg.version) },
  // Socket.IO's bundled CommonJS pieces call require(); give the ES module one.
  banner: {
    js: "import { createRequire as __corehubCreateRequire } from 'node:module'; const require = __corehubCreateRequire(import.meta.url);",
  },
  // @corehub/contracts also exports an OpenAPI loader that finds its YAML through
  // import.meta.url; the plugin never calls it.
  logOverride: { 'empty-import-meta': 'silent' },
});
console.log(`dsh-plugin build: ${path.relative(process.cwd(), out)} (v${pkg.version})`);
