#!/usr/bin/env node
// Lucide icons (https://lucide.dev, ISC; THIRD-PARTY-NOTICES.md) for the iOS and Android apps.
//
//   node scripts/icons/lucide-mobile.mjs                  # write every icon listed in lucide-mobile.json
//   node scripts/icons/lucide-mobile.mjs camera image     # add these names to the list, then write
//   node scripts/icons/lucide-mobile.mjs --check          # exit 1 when a committed file differs
//
// The list of names lives in scripts/icons/lucide-mobile.json, so the apps carry only the icons
// they use. The shapes come from the pinned `lucide-static` package (its icon-nodes.json), never
// from a hand-copied file. Each icon is written twice from the same outline:
//
// - iOS: `Assets.xcassets/Lucide/<name>.imageset/<name>.svg`, a template image kept as a vector
//   (the `Lucide` folder is a namespace, so the app asks for `Image("Lucide/<name>")`), plus
//   `CoreHub/Generated/Lucide.swift`, an enum of the names so a typo does not compile
//   (`Image(lucide: .camera)`).
// - Android: `res/drawable/lucide_<name>.xml`, a vector drawable the app tints (`Icon(painterResource(…))`).
//
// Every element (circle, rect, line, polyline, polygon, ellipse, path) becomes path data, because
// an Android vector draws paths only; the SVG for iOS uses the same paths, so both platforms draw
// the same outline. Strokes stay Lucide's: width 2 on a 24 grid, round caps and joins.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const check = args.includes('--check');
const added = args.filter((a) => !a.startsWith('--'));

const listFile = path.join(repo, 'scripts/icons/lucide-mobile.json');
const pkgDir = path.dirname(require.resolve('lucide-static/package.json'));
const version = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
const nodes = JSON.parse(readFileSync(path.join(pkgDir, 'icon-nodes.json'), 'utf8'));

const list = JSON.parse(readFileSync(listFile, 'utf8'));
for (const name of added) {
  if (!nodes[name]) throw new Error(`lucide-static ${version} has no icon named "${name}"`);
  if (!list.icons.includes(name)) list.icons.push(name);
}
list.icons.sort();
for (const name of list.icons) {
  if (!nodes[name]) throw new Error(`lucide-static ${version} has no icon named "${name}"`);
}

// ------------------------------------------------------------------ outlines

const num = (value) => Number(value ?? 0);
const fmt = (n) => String(Number(n.toFixed(4)));

/** One element of an icon as SVG path data. */
function pathData([tag, attrs]) {
  switch (tag) {
    case 'path':
      return attrs.d;
    case 'circle':
    case 'ellipse': {
      const cx = num(attrs.cx);
      const cy = num(attrs.cy);
      const rx = num(tag === 'circle' ? attrs.r : attrs.rx);
      const ry = num(tag === 'circle' ? attrs.r : attrs.ry);
      return (
        `M${fmt(cx - rx)} ${fmt(cy)}` +
        `A${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(cx + rx)} ${fmt(cy)}` +
        `A${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(cx - rx)} ${fmt(cy)}Z`
      );
    }
    case 'rect': {
      const x = num(attrs.x);
      const y = num(attrs.y);
      const w = num(attrs.width);
      const h = num(attrs.height);
      let rx = attrs.rx ?? attrs.ry;
      let ry = attrs.ry ?? attrs.rx;
      rx = Math.min(num(rx), w / 2);
      ry = Math.min(num(ry), h / 2);
      if (!rx || !ry) return `M${fmt(x)} ${fmt(y)}H${fmt(x + w)}V${fmt(y + h)}H${fmt(x)}Z`;
      const arc = (ex, ey) => `A${fmt(rx)} ${fmt(ry)} 0 0 1 ${fmt(ex)} ${fmt(ey)}`;
      return (
        `M${fmt(x + rx)} ${fmt(y)}H${fmt(x + w - rx)}${arc(x + w, y + ry)}` +
        `V${fmt(y + h - ry)}${arc(x + w - rx, y + h)}` +
        `H${fmt(x + rx)}${arc(x, y + h - ry)}` +
        `V${fmt(y + ry)}${arc(x + rx, y)}Z`
      );
    }
    case 'line':
      return `M${fmt(num(attrs.x1))} ${fmt(num(attrs.y1))}L${fmt(num(attrs.x2))} ${fmt(num(attrs.y2))}`;
    case 'polyline':
    case 'polygon': {
      const pts = attrs.points
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      let d = '';
      for (let i = 0; i < pts.length; i += 2)
        d += `${i ? 'L' : 'M'}${fmt(pts[i])} ${fmt(pts[i + 1])}`;
      return tag === 'polygon' ? `${d}Z` : d;
    }
    default:
      throw new Error(`unsupported Lucide element <${tag}>`);
  }
}

/** The icon's parts: path data, and whether Lucide fills that part as well as stroking it. */
function parts(name) {
  return nodes[name].map((node) => ({
    d: pathData(node),
    filled: node[1].fill !== undefined && node[1].fill !== 'none',
    stroke: node[1]['stroke-width'] !== undefined ? num(node[1]['stroke-width']) : 2,
  }));
}

// ------------------------------------------------------------------ outputs

const outputs = new Map();
const put = (rel, text) => outputs.set(rel, Buffer.from(text));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const header = `Generated by scripts/icons/lucide-mobile.mjs from lucide-static ${version} (ISC); do not edit by hand.`;

const ios = 'apps/ios/CoreHub/Resources/Assets.xcassets/Lucide';
const res = 'apps/android/app/src/main/res/drawable';
const SWIFT_KEYWORDS = new Set(
  'as break case catch class continue default defer do else enum extension fallthrough false for func guard if import in init inout internal is let nil operator private protocol public repeat return self static struct subscript super switch throw throws true try typealias var where while'.split(
    ' ',
  ),
);
/** `file-text` → `fileText`; a Swift keyword is escaped, a leading digit prefixed. */
const swiftCase = (name) => {
  const id = name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
  if (/^[0-9]/.test(id)) return `_${id}`;
  return SWIFT_KEYWORDS.has(id) ? `\`${id}\`` : id;
};
const androidName = (name) => `lucide_${name.replace(/-/g, '_')}`;

put(
  `${ios}/Contents.json`,
  json({ info: { author: 'xcode', version: 1 }, properties: { 'provides-namespace': true } }),
);
for (const name of list.icons) {
  const svgParts = parts(name)
    .map(
      (p) =>
        `<path d="${p.d}" fill="${p.filled ? '#000000' : 'none'}" stroke="#000000" stroke-width="${p.stroke}"` +
        ` stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join('');
  put(
    `${ios}/${name}.imageset/${name}.svg`,
    `<!-- lucide ${name} · ${header} -->\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${svgParts}</svg>\n`,
  );
  put(
    `${ios}/${name}.imageset/Contents.json`,
    json({
      images: [{ filename: `${name}.svg`, idiom: 'universal' }],
      info: { author: 'xcode', version: 1 },
      properties: {
        'preserves-vector-representation': true,
        'template-rendering-intent': 'template',
      },
    }),
  );
  const vectorParts = parts(name)
    .map(
      (p) =>
        `    <path\n` +
        `        android:pathData="${p.d}"\n` +
        `        android:fillColor="${p.filled ? '#FF000000' : '#00000000'}"\n` +
        `        android:strokeColor="#FF000000"\n` +
        `        android:strokeWidth="${p.stroke}"\n` +
        `        android:strokeLineCap="round"\n` +
        `        android:strokeLineJoin="round" />\n`,
    )
    .join('');
  put(
    `${res}/${androidName(name)}.xml`,
    `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<!-- lucide ${name} · ${header} -->\n` +
      `<vector xmlns:android="http://schemas.android.com/apk/res/android"\n` +
      `    android:width="24dp" android:height="24dp"\n` +
      `    android:viewportWidth="24" android:viewportHeight="24">\n` +
      vectorParts +
      `</vector>\n`,
  );
}
put(
  'apps/ios/CoreHub/Generated/Lucide.swift',
  `// ${header}\n` +
    `// The Lucide icons the app carries (scripts/icons/lucide-mobile.json), as template images.\n` +
    `import SwiftUI\n\n` +
    `enum Lucide: String, CaseIterable {\n` +
    list.icons.map((n) => `    case ${swiftCase(n)} = "${n}"\n`).join('') +
    `}\n\n` +
    `extension Image {\n` +
    `    /// A Lucide icon as a template image: it takes the foreground colour, like an SF Symbol.\n` +
    `    init(lucide icon: Lucide) {\n` +
    `        self = Image("Lucide/\\(icon.rawValue)").renderingMode(.template)\n` +
    `    }\n` +
    `}\n`,
);

// ------------------------------------------------------------------ write, prune or compare

/** Files this script owns that no longer belong to a listed icon. */
function stale() {
  const found = [];
  const iosDir = path.join(repo, ios);
  if (existsSync(iosDir)) {
    for (const entry of readdirSync(iosDir)) {
      if (entry.endsWith('.imageset') && !list.icons.includes(entry.replace(/\.imageset$/, ''))) {
        found.push(`${ios}/${entry}`);
      }
    }
  }
  const wanted = new Set(list.icons.map((n) => `${androidName(n)}.xml`));
  for (const entry of readdirSync(path.join(repo, res))) {
    if (entry.startsWith('lucide_') && !wanted.has(entry)) found.push(`${res}/${entry}`);
  }
  return found;
}

let bad = 0;
if (check) {
  for (const [rel, data] of outputs) {
    const file = path.join(repo, rel);
    if (!existsSync(file) || !readFileSync(file).equals(data)) {
      console.error(`lucide: ${rel} is out of date`);
      bad++;
    }
  }
  for (const rel of stale()) {
    console.error(`lucide: ${rel} is not in lucide-mobile.json`);
    bad++;
  }
  if (bad) {
    console.error(
      `lucide: ${bad} file(s) differ — run node scripts/icons/lucide-mobile.mjs and commit the result`,
    );
    process.exit(1);
  }
} else {
  for (const rel of stale()) rmSync(path.join(repo, rel), { recursive: true, force: true });
  for (const [rel, data] of outputs) {
    const file = path.join(repo, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
  }
  if (added.length) writeFileSync(listFile, json(list));
}
console.log(
  `lucide: ${list.icons.length} icon(s) from lucide-static ${version} ${check ? 'up to date' : 'written'}`,
);
