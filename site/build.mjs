#!/usr/bin/env node
// Assembles the download page into site/dist, the folder GitHub Pages publishes
// (.github/workflows/pages.yml). No bundler: the page is plain HTML, CSS and ES modules.
//
//   - src/index.html gets its Arabic text ({{key}} from src/i18n.js) and its icons
//     (<!--icon:name--> from lucide-static, the icon set the apps use) written in, so it reads
//     right before any script runs;
//   - tokens.css is the product's design tokens (packages/ui-tokens), built if missing;
//   - the Core Hub mark (docs/assets) and the touch icon (packages/web/public) are copied.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS } from './src/i18n.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const require = createRequire(import.meta.url);

/** @param {string} text */
const escapeHtml = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * One Lucide icon, inline and hidden from screen readers (the text beside it says what it is).
 * @param {string} name
 */
export function icon(name) {
  const file = path.join(
    path.dirname(require.resolve('lucide-static/package.json')),
    'icons',
    `${name}.svg`,
  );
  const svg = readFileSync(file, 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .replace(/ (width|height)="24"/g, '')
    .replace(/class="[^"]*"/, 'class="icon" aria-hidden="true" focusable="false"')
    .replace(/\s*(\/?>)\s*/g, '$1')
    .trim();
  if (!svg.startsWith('<svg')) throw new Error(`icon ${name}: not an SVG`);
  return svg;
}

/**
 * The page with its strings and icons written in. `html.*` keys are our own markup; everything
 * else is escaped.
 * @param {string} template
 * @param {Record<string, string>} strings
 */
export function renderPage(template, strings) {
  return template
    .replace(/<!--icon:([a-z0-9-]+)-->/g, (_m, name) => icon(name))
    .replace(/\{\{([\w.]+)\}\}/g, (_m, key) => {
      const text = strings[key];
      if (text === undefined) throw new Error(`index.html uses {{${key}}}, missing from i18n.js`);
      return key.startsWith('html.') ? text : escapeHtml(text);
    });
}

function tokensCss() {
  const css = path.join(repo, 'packages/ui-tokens/dist/tokens.css');
  if (!existsSync(css)) {
    execFileSync(process.execPath, [path.join(repo, 'packages/ui-tokens/scripts/build.mjs')], {
      stdio: 'inherit',
    });
  }
  return css;
}

function build() {
  const src = path.join(here, 'src');
  const dist = path.join(here, 'dist');
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });

  const template = readFileSync(path.join(src, 'index.html'), 'utf8');
  writeFileSync(path.join(dist, 'index.html'), renderPage(template, STRINGS.en));
  for (const file of ['styles.css', 'app.js', 'config.js', 'i18n.js', 'releases.js'])
    copyFileSync(path.join(src, file), path.join(dist, file));
  copyFileSync(tokensCss(), path.join(dist, 'tokens.css'));
  copyFileSync(
    path.join(repo, 'docs/assets/core-hub-mark-light.svg'),
    path.join(dist, 'mark-light.svg'),
  );
  copyFileSync(
    path.join(repo, 'docs/assets/core-hub-mark-dark.svg'),
    path.join(dist, 'mark-dark.svg'),
  );
  copyFileSync(
    path.join(repo, 'packages/web/public/apple-touch-icon.png'),
    path.join(dist, 'apple-touch-icon.png'),
  );
  console.log(`site: built ${path.relative(repo, dist)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) build();
