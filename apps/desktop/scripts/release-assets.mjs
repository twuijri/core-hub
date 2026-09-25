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
//
// `--without=windows-msix` is for a tag whose code predates the MSIX (v1.1.0): its release has
// no Store package, and the notes say so.
//
// The desktop app's update check (src/shared/updates.ts, assetFor) picks the installer for its
// platform from these names; tests/unit/release-assets.test.ts keeps the two in step.
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
  for (const asset of releaseAssets(version)) {
    if (without.includes(asset.key)) continue;
    const found = files.filter((f) => path.basename(f) === asset.source);
    if (found.length !== 1) {
      missing.push(`${asset.source} (${found.length === 0 ? 'not found' : 'found twice'})`);
      continue;
    }
    const target = path.join(to, asset.name);
    copyFileSync(/** @type {string} */ (found[0]), target);
    written.push(target);
  }
  if (missing.length > 0) throw new Error(`release: missing ${missing.join(', ')}`);
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
      '       release-assets.mjs notes <tag> <generated notes file> <out file> [repository]',
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
