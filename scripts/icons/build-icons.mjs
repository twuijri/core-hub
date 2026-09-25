#!/usr/bin/env node
// Builds every app icon from the one Core Hub mark (docs/changes/2026-09-26-twuijri-app-icons.md).
//
//   pnpm icons:build          # rewrite the icons
//   pnpm icons:build --check  # exit 1 when a committed icon differs from what this script makes
//
// The mark's path is read from packages/web/src/ui/brand/CoreHubMark.tsx and its colours from
// packages/ui-tokens/tokens.json (`accent` of the light and dark themes), so a change to either
// reaches every platform by running this script again and committing its output. Rasters are
// drawn with resvg (a root dev dependency) and written by the small PNG/ICO/ICNS encoders below,
// so the same inputs give the same bytes on any machine.
//
// The icon itself is the favicon's form (docs/changes/2026-09-24-twuijri-brand-mark.md): the mark
// in white on the light theme's accent. Below 33 px a tile leaves the mark too small to read, so
// those sizes draw the bare mark in the accent instead.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { Resvg } from '@resvg/resvg-js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const check = process.argv.includes('--check');

// ------------------------------------------------------------------ sources

const markSource = readFileSync(
  path.join(repo, 'packages/web/src/ui/brand/CoreHubMark.tsx'),
  'utf8',
);
const shape = (name) => {
  const m = markSource.match(new RegExp(`const ${name} =\\s*'([^']+)'`));
  if (!m) throw new Error(`CoreHubMark.tsx: ${name} not found`);
  return m[1];
};
const MARK = `${shape('OUTER')}${shape('HOLE')}${shape('CORE')}`;
// The drawn shape's own box (the component's viewBox adds 25 units above and below it).
const MARK_W = 895;
const MARK_H = 845;

const tokens = JSON.parse(readFileSync(path.join(repo, 'packages/ui-tokens/tokens.json'), 'utf8'));
const ACCENT = tokens.themes.light.accent;
const ACCENT_DARK = tokens.themes.dark.accent;
const WHITE = '#ffffff';
const BLACK = '#000000';

/** The mark's width as a share of the tile it sits on — the favicon's 20 of 32 px. */
const MARK_ON_TILE = 0.625;

// ------------------------------------------------------------------ drawing

/**
 * One square picture: an optional background (full bleed, or a rounded tile inset from the edge)
 * and the mark centred on it, `markWidth` px wide.
 */
function svg({ size, bg = null, inset = 0, radius = 0, fg, markWidth }) {
  const s = markWidth / MARK_W;
  const x = (size - MARK_W * s) / 2;
  const y = (size - MARK_H * s) / 2;
  const tile = size - 2 * inset;
  const back = bg
    ? `<rect x="${inset}" y="${inset}" width="${tile}" height="${tile}" rx="${radius}" fill="${bg}"/>`
    : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    back +
    `<path transform="translate(${x} ${y}) scale(${s})" fill="${fg}" fill-rule="evenodd" d="${MARK}"/>` +
    `</svg>`
  );
}

/** Straight (not premultiplied) RGBA pixels; resvg hands back premultiplied ones. */
function rasterize(svgText) {
  const img = new Resvg(svgText, { fitTo: { mode: 'original' } }).render();
  const px = Buffer.from(img.pixels);
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a > 0 && a < 255) {
      for (let c = 0; c < 3; c++) px[i + c] = Math.min(255, Math.round((px[i + c] * 255) / a));
    }
  }
  return { width: img.width, height: img.height, rgba: px };
}

// The pictures each platform uses.
const pictures = {
  /** Full-bleed square (iOS, Android Play listing, apple-touch-icon): the system rounds it. */
  square: (size) => svg({ size, bg: ACCENT, fg: WHITE, markWidth: size * MARK_ON_TILE }),
  /** iOS 18 dark appearance: the mark in the dark accent, the system supplies the background. */
  squareDark: (size) => svg({ size, fg: ACCENT_DARK, markWidth: size * MARK_ON_TILE }),
  /** iOS 18 tinted appearance: grayscale, white mark on black; the system tints it. */
  squareTinted: (size) => svg({ size, bg: BLACK, fg: WHITE, markWidth: size * MARK_ON_TILE }),
  /** macOS: Apple's grid, an 824-of-1024 rounded tile. */
  macTile: (size) => {
    if (size <= 32) return pictures.bare(size);
    const inset = size * (100 / 1024);
    const tile = size - 2 * inset;
    return svg({
      size,
      bg: ACCENT,
      inset,
      radius: tile * 0.225,
      fg: WHITE,
      markWidth: tile * MARK_ON_TILE,
    });
  },
  /** Windows and Linux: the rounded tile with a thin margin. */
  tile: (size) => {
    if (size <= 32) return pictures.bare(size);
    const inset = size / 32;
    const tile = size - 2 * inset;
    return svg({
      size,
      bg: ACCENT,
      inset,
      radius: tile * 0.225,
      fg: WHITE,
      markWidth: tile * MARK_ON_TILE,
    });
  },
  /** The bare mark, for small sizes and the tray. */
  bare: (size, fg = ACCENT) => svg({ size, fg, markWidth: size * (15 / 16) }),
  /**
   * The wide Microsoft Store tile: the rounded tile, as tall as the picture's
   * shorter side allows, centred on transparency (Windows fills the rest with the manifest's
   * background colour).
   */
  wide: (width, height) => {
    const size = Math.min(width, height);
    const square = pictures.tile(size);
    const x = (width - size) / 2;
    const y = (height - size) / 2;
    return square
      .replace(
        /^<svg [^>]*>/,
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g transform="translate(${x} ${y})">`,
      )
      .replace(/<\/svg>$/, '</g></svg>');
  },
};

// ------------------------------------------------------------------ encoders

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** PNG, colour type 6 (RGBA) or, with `opaque`, 2 (RGB: no alpha channel, as App Store wants). */
function png({ width, height, rgba }, { opaque = false } = {}) {
  const channels = opaque ? 3 : 4;
  const raw = Buffer.alloc(height * (1 + width * channels));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (opaque && rgba[i + 3] !== 255) throw new Error('an opaque icon has a transparent pixel');
      for (let c = 0; c < channels; c++) raw[o++] = rgba[i + c];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = opaque ? 2 : 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A 32-bit BMP (DIB) entry for an .ico: bottom-up BGRA, then the 1-bit AND mask. */
function dib({ width, height, rgba }) {
  const maskRow = Math.ceil(width / 32) * 4;
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0);
  head.writeInt32LE(width, 4);
  head.writeInt32LE(height * 2, 8);
  head.writeUInt16LE(1, 12);
  head.writeUInt16LE(32, 14);
  head.writeUInt32LE(width * height * 4 + maskRow * height, 20);
  const pixels = Buffer.alloc(width * height * 4);
  const mask = Buffer.alloc(maskRow * height);
  for (let y = 0; y < height; y++) {
    const row = height - 1 - y;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const o = (row * width + x) * 4;
      pixels[o] = rgba[i + 2];
      pixels[o + 1] = rgba[i + 1];
      pixels[o + 2] = rgba[i];
      pixels[o + 3] = rgba[i + 3];
      if (rgba[i + 3] === 0) mask[row * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([head, pixels, mask]);
}

/** .ico: BMP entries up to 128 px (every Windows reader takes them), PNG for 256. */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const bodies = images.map((img) => (img.width >= 256 ? png(img) : dib(img)));
  let offset = header.length;
  images.forEach((img, n) => {
    const e = 6 + 16 * n;
    header[e] = img.width >= 256 ? 0 : img.width;
    header[e + 1] = img.height >= 256 ? 0 : img.height;
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(bodies[n].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += bodies[n].length;
  });
  return Buffer.concat([header, ...bodies]);
}

/** .icns with PNG entries, keyed by Apple's type codes. */
function icns(entries) {
  const parts = entries.map(([type, data]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4);
  return Buffer.concat([head, ...parts]);
}

// ------------------------------------------------------------------ Android vector drawables

function vector({ size, viewport, markWidth, comment }) {
  const s = markWidth / MARK_W;
  const round = (n) => Number(n.toFixed(4));
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${comment}
     Generated by scripts/icons/build-icons.mjs from CoreHubMark.tsx; do not edit by hand. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="${size}dp" android:height="${size}dp"
    android:viewportWidth="${viewport}" android:viewportHeight="${viewport}">
    <group
        android:translateX="${round((viewport - MARK_W * s) / 2)}"
        android:translateY="${round((viewport - MARK_H * s) / 2)}"
        android:scaleX="${round(s)}" android:scaleY="${round(s)}">
        <path android:fillColor="#FFFFFF" android:fillType="evenOdd"
            android:pathData="${MARK}" />
    </group>
</vector>
`;
}

// ------------------------------------------------------------------ outputs

const outputs = new Map();
const put = (rel, data) => outputs.set(rel, Buffer.isBuffer(data) ? data : Buffer.from(data));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

// iOS: one 1024 px icon (Xcode 14+ derives every size), plus the iOS 18 dark and tinted looks.
const ios = 'apps/ios/CoreHub/Resources/Assets.xcassets';
put(`${ios}/Contents.json`, json({ info: { author: 'xcode', version: 1 } }));
put(
  `${ios}/AppIcon.appiconset/AppIcon.png`,
  png(rasterize(pictures.square(1024)), { opaque: true }),
);
put(`${ios}/AppIcon.appiconset/AppIcon-dark.png`, png(rasterize(pictures.squareDark(1024))));
put(
  `${ios}/AppIcon.appiconset/AppIcon-tinted.png`,
  png(rasterize(pictures.squareTinted(1024)), { opaque: true }),
);
put(
  `${ios}/AppIcon.appiconset/Contents.json`,
  json({
    images: [
      { filename: 'AppIcon.png', idiom: 'universal', platform: 'ios', size: '1024x1024' },
      {
        appearances: [{ appearance: 'luminosity', value: 'dark' }],
        filename: 'AppIcon-dark.png',
        idiom: 'universal',
        platform: 'ios',
        size: '1024x1024',
      },
      {
        appearances: [{ appearance: 'luminosity', value: 'tinted' }],
        filename: 'AppIcon-tinted.png',
        idiom: 'universal',
        platform: 'ios',
        size: '1024x1024',
      },
    ],
    info: { author: 'xcode', version: 1 },
  }),
);

// The mark inside the apps (the drawer's header, sign-in, the new chat), as on the web: the bare
// mark, drawn by the app in its accent. iOS gets a template SVG in the asset catalog (kept as a
// vector, so it is sharp at every size); Android a vector drawable the app tints.
put(
  `${ios}/BrandMark.imageset/BrandMark.svg`,
  `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 -25 895 895">` +
    `<path fill="#000000" fill-rule="evenodd" d="${MARK}"/></svg>\n`,
);
put(
  `${ios}/BrandMark.imageset/Contents.json`,
  json({
    images: [{ filename: 'BrandMark.svg', idiom: 'universal' }],
    info: { author: 'xcode', version: 1 },
    properties: {
      'preserves-vector-representation': true,
      'template-rendering-intent': 'template',
    },
  }),
);

// Android: the adaptive icon's foreground (also its monochrome layer; the background is
// @color/icon_bg = accent) keeps the mark at 45 of the 72 dp a mask shows, like the favicon;
// the notification icon fills 20 of 24 dp. The Play listing wants a 512 px square.
const res = 'apps/android/app/src/main/res';
put(
  `${res}/drawable/ic_launcher_foreground.xml`,
  vector({
    size: 108,
    viewport: 108,
    markWidth: 72 * MARK_ON_TILE,
    comment: "The launcher icon's foreground and monochrome layers: the Core Hub mark in white.",
  }),
);
put(
  `${res}/drawable/ic_notice.xml`,
  vector({
    size: 24,
    viewport: 24,
    markWidth: 20,
    comment: "The notification's small icon: the Core Hub mark, white on transparent.",
  }),
);
put(
  `${res}/drawable/ic_brand_mark.xml`,
  vector({
    size: 28,
    viewport: 28,
    markWidth: 28,
    comment:
      'The mark inside the app (drawer, sign-in): white here, tinted with the accent by the app.',
  }),
);
put('apps/android/store/icon-512.png', png(rasterize(pictures.square(512))));

// Desktop: the window icon, the installers' icons (.icns, .ico, Linux PNGs) and the tray.
const desk = 'apps/desktop/assets';
const tile = (n) => rasterize(pictures.tile(n));
put(`${desk}/icon.png`, png(tile(512)));
put(`${desk}/icon.ico`, ico([16, 24, 32, 48, 64, 128, 256].map(tile)));
const mac = (n) => png(rasterize(pictures.macTile(n)));
put(
  `${desk}/icon.icns`,
  icns([
    ['icp4', mac(16)],
    ['icp5', mac(32)],
    ['icp6', mac(64)],
    ['ic07', mac(128)],
    ['ic08', mac(256)],
    ['ic09', mac(512)],
    ['ic10', mac(1024)],
    ['ic11', mac(32)],
    ['ic12', mac(64)],
    ['ic13', mac(256)],
    ['ic14', mac(512)],
  ]),
);
for (const n of [16, 32, 48, 64, 128, 256, 512]) put(`${desk}/icons/${n}x${n}.png`, png(tile(n)));
put(`${desk}/tray-16.png`, png(rasterize(pictures.bare(16))));
put(`${desk}/tray-32.png`, png(rasterize(pictures.bare(32))));
// macOS template images: black and alpha only; the menu bar recolours them.
put(`${desk}/trayTemplate.png`, png(rasterize(pictures.bare(16, BLACK))));
put(`${desk}/trayTemplate@2x.png`, png(rasterize(pictures.bare(32, BLACK))));

// Microsoft Store (MSIX, electron-builder's appx target reads assets/appx): each tile at 100, 200
// and 400 % scale, and the taskbar/Start icon at the target sizes Windows asks for, plated (on the
// tile) and unplated (the same picture; the tile already carries its own background). The names
// are the ones electron-builder puts in the manifest; makepri picks the scale.
const appx = `${desk}/appx`;
const storeTiles = {
  StoreLogo: [50, 50],
  Square44x44Logo: [44, 44],
  SmallTile: [71, 71],
  Square150x150Logo: [150, 150],
  LargeTile: [310, 310],
  Wide310x150Logo: [310, 150],
};
for (const [name, [w, h]] of Object.entries(storeTiles)) {
  for (const scale of [100, 200, 400]) {
    const width = (w * scale) / 100;
    const height = (h * scale) / 100;
    const picture = width === height ? pictures.tile(width) : pictures.wide(width, height);
    put(`${appx}/${name}.scale-${scale}.png`, png(rasterize(picture)));
  }
}
for (const n of [16, 24, 32, 48, 256]) {
  put(`${appx}/Square44x44Logo.targetsize-${n}.png`, png(tile(n)));
  put(`${appx}/Square44x44Logo.targetsize-${n}_altform-unplated.png`, png(tile(n)));
}

// Web: the home-screen icon iOS Safari uses (the favicon itself stays inline in index.html).
put(
  'packages/web/public/apple-touch-icon.png',
  png(rasterize(pictures.square(180)), { opaque: true }),
);

// ------------------------------------------------------------------ write or compare

let stale = 0;
for (const [rel, data] of outputs) {
  const file = path.join(repo, rel);
  if (check) {
    if (!existsSync(file) || !readFileSync(file).equals(data)) {
      console.error(`icons: ${rel} is out of date`);
      stale++;
    }
    continue;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
}
if (check && stale) {
  console.error(`icons: ${stale} file(s) differ — run pnpm icons:build and commit the result`);
  process.exit(1);
}
console.log(`icons: ${outputs.size} files ${check ? 'up to date' : 'written'}`);
