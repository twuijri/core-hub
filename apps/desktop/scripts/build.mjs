#!/usr/bin/env node
// Builds the desktop app into dist/: the main process and the preload as CommonJS bundles
// (Electron loads a sandboxed preload as CommonJS only), the first-run screen, the icons, and
// a copy of the built web client (packages/web/dist) that the app serves on its loopback origin.
// `pnpm build` at the root builds the web client first (this package depends on it).
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(here, '../..');
const out = path.join(here, 'dist');
const webDist = path.join(repo, 'packages/web/dist');

if (!existsSync(path.join(webDist, 'index.html'))) {
  console.error(
    'desktop build: packages/web/dist is missing — run `pnpm --filter @corehub/web build` first.',
  );
  process.exit(1);
}
if (!existsSync(path.join(repo, 'packages/ui-tokens/dist/tokens.css'))) {
  console.error(
    'desktop build: packages/ui-tokens/dist is missing — run `pnpm tokens:build` first.',
  );
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: 'warning', legalComments: 'none' };
await build({
  ...common,
  entryPoints: { main: path.join(here, 'src/main/index.ts') },
  outExtension: { '.js': '.cjs' },
  outdir: out,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['electron'],
  // @corehub/contracts also exports the OpenAPI loader, which finds its YAML through
  // import.meta.url. The app never calls it (it uses the client and the product names), so the
  // empty import.meta in a CommonJS bundle is harmless; the warning would only be noise.
  logOverride: { 'empty-import-meta': 'silent' },
});
await build({
  ...common,
  entryPoints: { preload: path.join(here, 'src/preload/index.ts') },
  outExtension: { '.js': '.cjs' },
  outdir: out,
  platform: 'node',
  target: 'chrome140',
  format: 'cjs',
  external: ['electron'],
});
await build({
  ...common,
  entryPoints: {
    welcome: path.join(here, 'src/renderer/welcome.ts'),
    'welcome-style': path.join(here, 'src/renderer/welcome.css'),
  },
  outdir: path.join(out, 'renderer'),
  platform: 'browser',
  target: 'chrome140',
  format: 'iife',
});
// esbuild names the CSS bundle after its entry; the page asks for welcome.css.
cpSync(path.join(out, 'renderer/welcome-style.css'), path.join(out, 'renderer/welcome.css'));
rmSync(path.join(out, 'renderer/welcome-style.css'));
rmSync(path.join(out, 'renderer/welcome-style.css.map'), { force: true });
cpSync(path.join(here, 'src/renderer/welcome.html'), path.join(out, 'renderer/welcome.html'));
cpSync(path.join(repo, 'docs/assets/core-hub-mark-light.svg'), path.join(out, 'renderer/logo.svg'));
// The window and tray icons; the installers' own files (.icns, .ico, icons/, the Store's appx/,
// the macOS entitlements and Info.plist strings) stay out of the app.
cpSync(path.join(here, 'assets'), path.join(out, 'assets'), {
  recursive: true,
  filter: (source) =>
    !/\.(icns|ico|plist)$/.test(source) &&
    !source.startsWith(path.join(here, 'assets', 'icons')) &&
    !source.startsWith(path.join(here, 'assets', 'appx')) &&
    !source.startsWith(path.join(here, 'assets', 'mac')),
});
// The web client without its source maps: they help nobody inside an installer.
cpSync(webDist, path.join(out, 'web'), {
  recursive: true,
  filter: (source) => !source.endsWith('.map'),
});
console.log(`desktop build: ${path.relative(repo, out)} ready`);
