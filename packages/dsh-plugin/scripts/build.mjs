#!/usr/bin/env node
// Builds the plugin into dist/ as self-contained ES modules a harness profile loads by package
// name: the contract client, Socket.IO and our code are bundled in; only the harness's own
// Schemastery stays outside, resolved from the running harness (a peer, publish.md).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
// The browser half (`./client`, `dsh.client`): the harness's client module system loads one
// classic script that registers the package's factory with the page's module loader
// (`window.__ModuleLoader__.load({ id, factory })`, dsh-client-modules' published
// declarations). React and the harness's shared UI library come from the page's shared module
// table through the factory's `require`; everything else is bundled in.
const { PRODUCT } = await import('@corehub/contracts');
const client = await build({
  entryPoints: [path.join(here, 'src/client/index.ts')],
  bundle: true,
  write: false,
  platform: 'browser',
  target: 'es2022',
  format: 'cjs',
  legalComments: 'none',
  logLevel: 'warning',
  external: ['react', 'react/*', '@deepseek-ai/dsh-client-ui-primitives'],
  define: {
    __PRODUCT_NAME__: JSON.stringify(PRODUCT.name),
    __PRODUCT_NAME_AR__: JSON.stringify(PRODUCT.nameAr),
    __PLUGIN_PACKAGE__: JSON.stringify(pkg.name),
    __PLUGIN_ROW__: JSON.stringify(PRODUCT.id),
    __COMMAND_NAME__: JSON.stringify(PRODUCT.id),
    __AGENT_COMMAND_NAME__: JSON.stringify('hermes'),
  },
});
const body = client.outputFiles[0].text;
writeFileSync(
  path.join(out, 'client.js'),
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: function (require) {\n` +
    `var module = { exports: {} }; var exports = module.exports;\n${body}\nreturn module.exports;\n} });\n`,
);

console.log(`dsh-plugin build: ${path.relative(process.cwd(), out)} (v${pkg.version})`);
