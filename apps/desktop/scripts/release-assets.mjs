#!/usr/bin/env node
// The files a Core Hub GitHub release carries, their names, the MSIX version, and the release
// notes (docs/RELEASING.md). Used by package.mjs (the MSIX version) and by the release workflow
// (.github/workflows/publish-release.yml):
//
//   node scripts/release-assets.mjs collect <version> <artifacts dir> <out dir> [--without=<key>]
//       finds each release file in the downloaded workflow artifacts and copies it to <out dir>
//       under its release name; fails when one is missing.
//   node scripts/release-assets.mjs notes <tag> <generated notes file> <out file> [repository]
//                                         [--without=<key>]
//       writes the release notes: downloads, the SmartScreen step, and the merged pull requests
//       GitHub lists for the tag (its "generate release notes" answer), kept short.
//   node scripts/release-assets.mjs check-feeds <version> <dir> <windows|macos|linux>
//       after packaging (desktop.yml, desktop-signed.yml): that platform's update feed is in
//       <dir>, and every file it names is a release file that is there too.
//
// `--without=windows-msix` is for a tag whose code predates the MSIX (v1.1.0): its release has
// no Store package, and the notes say so. `--without=updates` is for a tag whose code predates
// the self-updating apps (before 1.1.3): no update feeds, no macOS zip.
//
// The desktop app's update check (src/shared/updates.ts, assetFor) picks the installer for its
// platform from these names; tests/unit/release-assets.test.ts keeps the two in step. The
// updater (src/main/auto-update.ts, DECISIONS §108) reads `latest.yml`, `latest-mac.yml` and
// `latest-linux.yml`: every file they name must be on the release under that very name, which
// `feedProblems` checks before anything is published.
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The version Windows packages take: `X.Y.Z.0`. The Microsoft Store requires the fourth part to
 * be 0 (it keeps it for itself), and each part must fit 0–65535. A pre-release or build suffix
 * (`1.1.0-preview.3`) is dropped: MSIX has no place for it.
 * @param {string} version
 * @returns {string}
 */
export function msixVersion(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version).trim());
  if (!m) throw new Error(`msixVersion: "${version}" is not X.Y.Z`);
  const parts = [m[1], m[2], m[3]].map(Number);
  if (parts.some((n) => n > 65535))
    throw new Error(`msixVersion: "${version}" has a part over 65535`);
  return `${parts.join('.')}.0`;
}

/**
 * Every file a release carries, by the name it has there. The desktop names are the ones
 * electron-builder.config.cjs gives the installers; the APK is renamed from Gradle's
 * `app-release.apk`.
 * @param {string} version plain X.Y.Z (a release tag's)
 */
export function releaseAssets(version) {
  const core = msixVersion(version).replace(/\.0$/, '');
  return [
    {
      key: 'windows-exe',
      label: 'Windows (installer)',
      name: `Core-Hub-Setup-${version}-x64.exe`,
      source: `Core-Hub-Setup-${version}-x64.exe`,
    },
    {
      key: 'windows-msix',
      label: 'Windows (MSIX, the Microsoft Store package)',
      name: `Core-Hub-${core}-x64.msix`,
      source: `Core-Hub-${core}-x64.msix`,
    },
    {
      key: 'macos-dmg',
      label: 'macOS (Apple silicon, signed and notarised)',
      name: `Core-Hub-${version}-arm64.dmg`,
      source: `Core-Hub-${version}-arm64.dmg`,
    },
    {
      key: 'linux-appimage',
      label: 'Linux (AppImage)',
      name: `Core-Hub-${version}-x86_64.AppImage`,
      source: `Core-Hub-${version}-x86_64.AppImage`,
    },
    {
      key: 'linux-deb',
      label: 'Linux (.deb)',
      name: `corehub_${version}_amd64.deb`,
      source: `corehub_${version}_amd64.deb`,
    },
    {
      key: 'android-apk',
      label: 'Android (signed APK)',
      name: `Core-Hub-${version}-android.apk`,
      source: 'app-release.apk',
    },
  ];
}

/**
 * The files the apps' updater reads (DECISIONS §108), beside the downloads above. They are not
 * downloads — the download page never offers them. electron-builder writes each feed next to
 * the installers it names; the blockmaps let a Windows or macOS update download only what
 * changed, and are left out without harm when a build made none (the update then downloads the
 * whole file).
 * @param {string} version plain X.Y.Z
 * @returns {Array<ReleaseFile & { optional?: boolean, feed?: { platform: string, installer: string } }>}
 */
export function updateAssets(version) {
  const exe = `Core-Hub-Setup-${version}-x64.exe`;
  const zip = `Core-Hub-${version}-arm64-mac.zip`;
  const dmg = `Core-Hub-${version}-arm64.dmg`;
  const appImage = `Core-Hub-${version}-x86_64.AppImage`;
  /** @param {string} key @param {string} name @param {object} [more] */
  const file = (key, name, more = {}) => ({ key, label: name, name, source: name, ...more });
  return [
    file('update-windows', 'latest.yml', { feed: { platform: 'windows', installer: exe } }),
    file('update-windows-blockmap', `${exe}.blockmap`, { optional: true }),
    // Squirrel.Mac installs from a zip of the signed app; the dmg stays the download.
    file('macos-zip', zip),
    file('update-macos', 'latest-mac.yml', { feed: { platform: 'macos', installer: zip } }),
    file('update-macos-zip-blockmap', `${zip}.blockmap`, { optional: true }),
    file('update-macos-dmg-blockmap', `${dmg}.blockmap`, { optional: true }),
    file('update-linux', 'latest-linux.yml', { feed: { platform: 'linux', installer: appImage } }),
  ];
}

/** @typedef {{ key: string, label: string, name: string, source: string }} ReleaseFile */

/**
 * What an electron-builder update feed names: its version, `path`, and each `files[].url`.
 * The feeds are plain YAML electron-builder writes itself; these three keys are all we read.
 * @param {string} text
 * @returns {{ version: string | null, path: string | null, urls: string[] }}
 */
export function readFeed(text) {
  const unquote = (/** @type {string} */ v) => v.trim().replace(/^(['"])(.*)\1$/, '$2');
  let version = null;
  let feedPath = null;
  const urls = [];
  for (const line of text.split(/\r?\n/)) {
    let m = /^version:\s*(.+)$/.exec(line);
    if (m) version = unquote(/** @type {string} */ (m[1]));
    m = /^path:\s*(.+)$/.exec(line);
    if (m) feedPath = unquote(/** @type {string} */ (m[1]));
    m = /^\s*-?\s*url:\s*(.+)$/.exec(line);
    if (m) urls.push(unquote(/** @type {string} */ (m[1])));
  }
  return { version, path: feedPath, urls };
}

/**
 * Everything wrong with the update feeds of a release: a feed missing, of another version, not
 * listing its platform's installer, or naming — in `path` or any `files[].url` — a file the
 * release does not carry under that name (the updater would ask for a file that is not there).
 * `path` itself may be any file of the feed: the updaters pick theirs from `files` by extension.
 * @param {{
 *   version: string,
 *   feeds: Record<string, string | null>,
 *   published: string[],
 *   platforms?: string[],
 * }} options `feeds`: each feed's file name → its text (null when it is not there);
 *   `published`: the file names the release carries; `platforms`: which feeds to check
 *   (default all three).
 * @returns {string[]}
 */
export function feedProblems({ version, feeds, published, platforms }) {
  const problems = [];
  const names = new Set(published);
  for (const asset of updateAssets(version)) {
    if (!asset.feed) continue;
    if (platforms && !platforms.includes(asset.feed.platform)) continue;
    const text = feeds[asset.name];
    if (text == null) {
      problems.push(`${asset.name} is missing`);
      continue;
    }
    const feed = readFeed(text);
    if (feed.version !== version)
      problems.push(`${asset.name} is for version ${feed.version}, not ${version}`);
    if (!feed.urls.includes(asset.feed.installer))
      problems.push(`${asset.name} does not list ${asset.feed.installer}`);
    for (const name of new Set([feed.path, ...feed.urls]))
      if (name && !names.has(name))
        problems.push(`${asset.name} names ${name}, which the release does not carry`);
  }
  return problems;
}

/**
 * Reads the feeds in `dir` and checks them against the files in `dir` (see feedProblems).
 * @param {{ version: string, dir: string, platforms?: string[] }} options
 * @returns {string[]}
 */
export function checkFeedsIn({ version, dir, platforms }) {
  const present = readdirSync(dir);
  /** @type {Record<string, string | null>} */
  const feeds = {};
  for (const asset of updateAssets(version))
    if (asset.feed)
      feeds[asset.name] = present.includes(asset.name)
        ? readFileSync(path.join(dir, asset.name), 'utf8')
        : null;
  const releaseNames = new Set(
    [...releaseAssets(version), ...updateAssets(version)].map((a) => a.name),
  );
  const published = present.filter((name) => releaseNames.has(name));
  return feedProblems({ version, feeds, published, ...(platforms ? { platforms } : {}) });
}

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

/**
 * Copies each release file from the downloaded artifacts to `to`, under its release name.
 * @param {{ version: string, from: string, to: string, without?: string[] }} options
 * @returns {string[]} the files written
 */
export function collect({ version, from, to, without = [] }) {
  const files = walk(from);
  const missing = [];
  const written = [];
  mkdirSync(to, { recursive: true });
  const updates = without.includes('updates') ? [] : updateAssets(version);
  for (const asset of [...releaseAssets(version), ...updates]) {
    if (without.includes(asset.key)) continue;
    const found = files.filter((f) => path.basename(f) === asset.source);
    if (found.length === 0 && 'optional' in asset && asset.optional) continue;
    if (found.length !== 1) {
      missing.push(`${asset.source} (${found.length === 0 ? 'not found' : 'found twice'})`);
      continue;
    }
    const target = path.join(to, asset.name);
    copyFileSync(/** @type {string} */ (found[0]), target);
    written.push(target);
  }
  if (missing.length > 0) throw new Error(`release: missing ${missing.join(', ')}`);
  if (updates.length > 0) {
    const problems = checkFeedsIn({ version, dir: to });
    if (problems.length > 0) throw new Error(`release: update feeds — ${problems.join('; ')}`);
  }
  return written;
}

const MAX_CHANGES = 20;

/**
 * The release notes: a short English page. `generated` is the body GitHub's "generate release
 * notes" returns for the tag (the merged pull requests since the previous tag); only its pull
 * request lines are kept, as `- Title (#n)`, at most MAX_CHANGES of them.
 * @param {{ tag: string, generated: string, repository: string, without?: string[] }} options
 * @returns {string}
 */
export function releaseNotes({ tag, generated, repository, without = [] }) {
  const version = tag.replace(/^v/, '');
  const changes = [];
  for (const line of generated.split(/\r?\n/)) {
    const m = /^\s*[*-]\s+(.+?)\s+by\s+@\S+\s+in\s+(\S+\/pull\/(\d+))\s*$/.exec(line);
    if (m) changes.push(`- ${m[1]} (#${m[3]})`);
  }
  const compare = /\*\*Full Changelog\*\*:\s*(\S+)/.exec(generated)?.[1];
  const rows = releaseAssets(version)
    .filter((a) => !without.includes(a.key))
    .map((a) => `| ${a.label} | \`${a.name}\` |`);
  const msix = !without.includes('windows-msix');
  const updates = !without.includes('updates');
  const lines = [
    `## Core Hub ${version}`,
    '',
    '### Downloads',
    '',
    '| For | File |',
    '|---|---|',
    ...rows,
    '',
    `iPhone and iPad: TestFlight / the App Store. The hub: \`ghcr.io/${repository}:${version}\`.`,
    '',
    '### Windows: the SmartScreen warning',
    '',
    'The `.exe` installer is not code-signed yet, so Windows SmartScreen may say "Windows protected',
    'your PC". Click **More info**, then **Run anyway**.',
    ...(msix
      ? [
          'The Microsoft Store version is signed by the Store and updates from there. The `.msix` here',
          'is the Store package: Windows installs it only once it is signed, so use the `.exe` or the',
          'Store.',
        ]
      : ['The Microsoft Store package starts with a later version.']),
    ...(updates
      ? [
          '',
          '### Updating',
          '',
          'From 1.1.3 on, the Windows installer, the macOS app and the Linux AppImage download a new',
          'version by themselves and ask you to restart; the `.deb` says a new version is out and links',
          'the download page. A copy older than 1.1.3 has to be updated by hand once.',
        ]
      : []),
    '',
    '### Changes',
    '',
  ];
  if (changes.length === 0) lines.push('- Maintenance and fixes.');
  else {
    lines.push(...changes.slice(0, MAX_CHANGES));
    if (changes.length > MAX_CHANGES) lines.push(`- …and ${changes.length - MAX_CHANGES} more.`);
  }
  if (compare) lines.push('', `Full changelog: ${compare}`);
  return `${lines.join('\n')}\n`;
}

function main(argv) {
  const without = argv.filter((a) => a.startsWith('--without=')).map((a) => a.slice(10));
  const [command, ...rest] = argv.filter((a) => !a.startsWith('--without='));
  if (command === 'collect' && rest.length === 3) {
    const [version, from, to] = /** @type {[string, string, string]} */ (rest);
    for (const file of collect({ version: version.replace(/^v/, ''), from, to, without }))
      console.log(`release: ${path.basename(file)}`);
    return;
  }
  if (command === 'check-feeds' && rest.length === 3) {
    const [version, dir, platform] = /** @type {[string, string, string]} */ (rest);
    const plain = version.replace(/^v/, '');
    const problems = checkFeedsIn({ version: plain, dir, platforms: [platform] });
    if (problems.length > 0) throw new Error(`update feed (${platform}): ${problems.join('; ')}`);
    console.log(`update feed (${platform}): names only files the release carries`);
    return;
  }
  if (command === 'notes' && (rest.length === 3 || rest.length === 4)) {
    const [tag, generatedFile, out, repository = 'twuijri/core-hub'] = rest;
    const generated = readFileSync(/** @type {string} */ (generatedFile), 'utf8');
    writeFileSync(
      /** @type {string} */ (out),
      releaseNotes({ tag: /** @type {string} */ (tag), generated, repository, without }),
    );
    return;
  }
  console.error(
    'usage: release-assets.mjs collect <version> <artifacts dir> <out dir>\n' +
      '       release-assets.mjs notes <tag> <generated notes file> <out file> [repository]\n' +
      '       release-assets.mjs check-feeds <version> <dir> <windows|macos|linux>',
  );
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
