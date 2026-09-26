// The files a GitHub release carries: their names match what packaging makes and what the
// desktop app's update check looks for; the MSIX version; collecting them; the release notes.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PRODUCT } from '@corehub/contracts';
import {
  checkFeedsIn,
  collect,
  feedProblems,
  msixVersion,
  readFeed,
  releaseAssets,
  releaseNotes,
  updateAssets,
} from '../../scripts/release-assets.mjs';
import { pickUpdate, type GitHubRelease } from '../../src/shared/updates.js';

interface BuilderConfig {
  publish: { provider: string; owner: string; repo: string; releaseType: string };
  mac: { target: Array<{ target: string; arch: string[] }>; artifactName: string };
  nsis: { artifactName: string };
  dmg: { artifactName: string };
  appImage: { artifactName: string };
  deb: { artifactName: string };
  appx: Record<string, unknown> & { artifactName: string };
}
const config = createRequire(import.meta.url)('../../electron-builder.config.cjs') as BuilderConfig;

/** electron-builder's own expansion of an artifactName, for the macros these names use. */
const expand = (pattern: string, vars: { version: string; arch: string; ext: string }) =>
  pattern.replace(/\$\{(version|arch|ext)\}/g, (_m, key: 'version' | 'arch' | 'ext') => vars[key]);

describe('the MSIX version', () => {
  it.each([
    ['1.1.0', '1.1.0.0'],
    ['v2.3.4', '2.3.4.0'],
    ['1.1.0-preview.3', '1.1.0.0'],
    ['10.20.30+build.7', '10.20.30.0'],
  ])('%s → %s (the Store wants the fourth part 0)', (version, expected) => {
    expect(msixVersion(version)).toBe(expected);
  });

  it('refuses what Windows cannot take', () => {
    expect(() => msixVersion('1.1')).toThrow(/not X.Y.Z/);
    expect(() => msixVersion('latest')).toThrow(/not X.Y.Z/);
    expect(() => msixVersion('1.70000.0')).toThrow(/65535/);
  });
});

describe('the Microsoft Store package', () => {
  it('carries the product identity from Partner Center and never a build number', () => {
    expect(config.appx).toMatchObject({
      identityName: 'AbdulazizAltuwijri.CoreHub',
      publisher: 'CN=814A0A23-0E7E-4406-8883-4E483DF08BDA',
      publisherDisplayName: 'Abdulaziz Altuwijri',
      displayName: 'Core Hub',
      languages: ['en-US', 'ar'],
      setBuildNumber: false,
      electronUpdaterAware: false,
    });
  });
});

describe('release asset names', () => {
  const version = '1.2.0';
  const names = Object.fromEntries(releaseAssets(version).map((a) => [a.key, a.name]));

  it('are the names packaging gives the installers', () => {
    expect(names['windows-exe']).toBe(
      expand(config.nsis.artifactName, { version, arch: 'x64', ext: 'exe' }),
    );
    expect(names['windows-msix']).toBe(
      expand(config.appx.artifactName, { version, arch: 'x64', ext: 'appx' }),
    );
    expect(names['macos-dmg']).toBe(
      expand(config.dmg.artifactName, { version, arch: 'arm64', ext: 'dmg' }),
    );
    expect(names['linux-appimage']).toBe(
      expand(config.appImage.artifactName, { version, arch: 'x86_64', ext: 'AppImage' }),
    );
    expect(names['linux-deb']).toBe(
      expand(config.deb.artifactName, { version, arch: 'amd64', ext: 'deb' }),
    );
    expect(names['android-apk']).toBe('Core-Hub-1.2.0-android.apk');
  });

  const release = (assets: string[]): GitHubRelease => ({
    tag_name: `v${version}`,
    html_url: `https://github.com/twuijri/core-hub/releases/tag/v${version}`,
    draft: false,
    prerelease: false,
    assets: assets.map((name) => ({
      name,
      browser_download_url: `https://github.com/twuijri/core-hub/releases/download/v${version}/${name}`,
      size: 1,
    })),
  });
  const all = releaseAssets(version).map((a) => a.name);

  it.each([
    ['win32', 'x64', 'Core-Hub-Setup-1.2.0-x64.exe'],
    ['darwin', 'arm64', 'Core-Hub-1.2.0-arm64.dmg'],
    ['linux', 'x64', 'Core-Hub-1.2.0-x86_64.AppImage'],
  ] as const)(
    'let the update check of the GitHub build on %s %s find %s',
    (platform, arch, name) => {
      const update = pickUpdate([release(all)], '1.1.0', platform, arch);
      expect(update?.download.endsWith(`/${name}`)).toBe(true);
      expect(update?.version).toBe(version);
    },
  );

  it('never send the .exe build to the MSIX, and fall back to the .deb on Linux', () => {
    const noExe = all.filter((n) => !n.endsWith('.exe'));
    expect(pickUpdate([release(noExe)], '1.1.0', 'win32', 'x64')).toBeNull();
    const noAppImage = all.filter((n) => !n.endsWith('.AppImage'));
    expect(pickUpdate([release(noAppImage)], '1.1.0', 'linux', 'x64')?.download).toMatch(
      /corehub_1\.2\.0_amd64\.deb$/,
    );
  });
});

describe('collecting the release files', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('finds each file in the downloaded artifacts and names it for the release', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'corehub-release-'));
    const from = path.join(dir, 'artifacts');
    const put = (rel: string) => {
      mkdirSync(path.dirname(path.join(from, rel)), { recursive: true });
      writeFileSync(path.join(from, rel), rel);
    };
    put('corehub-desktop-Windows/Core-Hub-Setup-1.1.0-x64.exe');
    put('corehub-desktop-Windows/Core-Hub-1.1.0-x64.msix');
    put('corehub-desktop-Windows/sizes.md');
    put('corehub-desktop-Linux/Core-Hub-1.1.0-x86_64.AppImage');
    put('corehub-desktop-Linux/corehub_1.1.0_amd64.deb');
    put('corehub-desktop-macOS-signed/Core-Hub-1.1.0-arm64.dmg');
    put('corehub-android-signed/apk/release/app-release.apk');
    put('corehub-android-signed/bundle/release/app-release.aab');
    const to = path.join(dir, 'out');
    collect({ version: '1.1.0', from, to, without: ['updates'] });
    expect(readdirSync(to).sort()).toEqual(
      [
        'Core-Hub-1.1.0-android.apk',
        'Core-Hub-1.1.0-arm64.dmg',
        'Core-Hub-1.1.0-x64.msix',
        'Core-Hub-1.1.0-x86_64.AppImage',
        'Core-Hub-Setup-1.1.0-x64.exe',
        'corehub_1.1.0_amd64.deb',
      ].sort(),
    );
  });

  it('carries the update feeds, the macOS zip and the blockmaps there are', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'corehub-release-'));
    const from = path.join(dir, 'artifacts');
    const put = (rel: string, text: string = rel) => {
      mkdirSync(path.dirname(path.join(from, rel)), { recursive: true });
      writeFileSync(path.join(from, rel), text);
    };
    const v = '1.1.3';
    put(`corehub-desktop-Windows/Core-Hub-Setup-${v}-x64.exe`);
    put(`corehub-desktop-Windows/Core-Hub-Setup-${v}-x64.exe.blockmap`);
    put(`corehub-desktop-Windows/Core-Hub-${v}-x64.msix`);
    put('corehub-desktop-Windows/latest.yml', feedText(v, [`Core-Hub-Setup-${v}-x64.exe`]));
    put(`corehub-desktop-Linux/Core-Hub-${v}-x86_64.AppImage`);
    put(`corehub-desktop-Linux/corehub_${v}_amd64.deb`);
    put(
      'corehub-desktop-Linux/latest-linux.yml',
      feedText(v, [`Core-Hub-${v}-x86_64.AppImage`, `corehub_${v}_amd64.deb`]),
    );
    put(`corehub-desktop-macOS-signed/Core-Hub-${v}-arm64.dmg`);
    put(`corehub-desktop-macOS-signed/Core-Hub-${v}-arm64-mac.zip`);
    put(`corehub-desktop-macOS-signed/Core-Hub-${v}-arm64-mac.zip.blockmap`);
    put(
      'corehub-desktop-macOS-signed/latest-mac.yml',
      feedText(v, [`Core-Hub-${v}-arm64-mac.zip`, `Core-Hub-${v}-arm64.dmg`]),
    );
    put('corehub-android-signed/apk/release/app-release.apk');
    const to = path.join(dir, 'out');
    collect({ version: v, from, to });
    expect(readdirSync(to).sort()).toEqual(
      [
        `Core-Hub-${v}-android.apk`,
        `Core-Hub-${v}-arm64.dmg`,
        `Core-Hub-${v}-arm64-mac.zip`,
        `Core-Hub-${v}-arm64-mac.zip.blockmap`,
        `Core-Hub-${v}-x64.msix`,
        `Core-Hub-${v}-x86_64.AppImage`,
        `Core-Hub-Setup-${v}-x64.exe`,
        `Core-Hub-Setup-${v}-x64.exe.blockmap`,
        `corehub_${v}_amd64.deb`,
        'latest-linux.yml',
        'latest-mac.yml',
        'latest.yml',
      ].sort(),
    );

    // A feed that names a file the release does not carry stops the release.
    put('corehub-desktop-Windows/latest.yml', feedText(v, ['Core Hub Setup 1.1.3.exe']));
    expect(() => collect({ version: v, from, to: path.join(dir, 'again') })).toThrow(
      /latest\.yml names Core Hub Setup 1\.1\.3\.exe, which the release does not carry/,
    );
  });

  it('leaves the MSIX out only when told to', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'corehub-release-'));
    const from = path.join(dir, 'a');
    mkdirSync(from);
    for (const name of [
      'Core-Hub-Setup-1.1.0-x64.exe',
      'Core-Hub-1.1.0-x86_64.AppImage',
      'corehub_1.1.0_amd64.deb',
      'Core-Hub-1.1.0-arm64.dmg',
      'app-release.apk',
    ])
      writeFileSync(path.join(from, name), name);
    expect(() => collect({ version: '1.1.0', from, to: path.join(dir, 'b') })).toThrow(
      /missing Core-Hub-1\.1\.0-x64\.msix/,
    );
    const written = collect({
      version: '1.1.0',
      from,
      to: path.join(dir, 'c'),
      without: ['windows-msix', 'updates'],
    });
    expect(written).toHaveLength(5);
  });

  it('fails, naming what is missing, rather than make a release without it', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'corehub-release-'));
    mkdirSync(path.join(dir, 'a'));
    writeFileSync(path.join(dir, 'a', 'Core-Hub-Setup-1.1.0-x64.exe'), 'x');
    expect(() =>
      collect({ version: '1.1.0', from: path.join(dir, 'a'), to: path.join(dir, 'b') }),
    ).toThrow(/missing .*Core-Hub-1\.1\.0-arm64\.dmg.*app-release\.apk/);
  });
});

/** A feed the way electron-builder writes it (updateInfoBuilder: `files[].url`, then `path`). */
function feedText(version: string, files: string[]): string {
  return [
    `version: ${version}`,
    'files:',
    ...files.flatMap((url) => [`  - url: ${url}`, '    sha512: abc==', '    size: 1']),
    `path: ${files[0]}`,
    'sha512: abc==',
    "releaseDate: '2026-09-26T10:00:00.000Z'",
    '',
  ].join('\n');
}

describe('the update feeds (DECISIONS §109)', () => {
  const version = '1.2.0';
  const published = [...releaseAssets(version), ...updateAssets(version)].map((a) => a.name);
  /** What electron-builder names each file it lists, from this repository's own config. */
  const built = {
    exe: expand(config.nsis.artifactName, { version, arch: 'x64', ext: 'exe' }),
    zip: expand(config.mac.artifactName, { version, arch: 'arm64', ext: 'zip' }),
    dmg: expand(config.dmg.artifactName, { version, arch: 'arm64', ext: 'dmg' }),
    appImage: expand(config.appImage.artifactName, { version, arch: 'x86_64', ext: 'AppImage' }),
    deb: expand(config.deb.artifactName, { version, arch: 'amd64', ext: 'deb' }),
  };
  const feeds = {
    'latest.yml': feedText(version, [built.exe]),
    'latest-mac.yml': feedText(version, [built.zip, built.dmg]),
    'latest-linux.yml': feedText(version, [built.appImage, built.deb]),
  };

  it('name only files the release carries, under the names packaging gives them', () => {
    expect(feedProblems({ version, feeds, published })).toEqual([]);
    expect(updateAssets(version).find((a) => a.key === 'macos-zip')?.name).toBe(built.zip);
  });

  it('come from the GitHub releases of this repository, never pre-releases', () => {
    expect(config.publish).toEqual({
      provider: 'github',
      owner: PRODUCT.repository.split('/')[0],
      repo: PRODUCT.repository.split('/')[1],
      releaseType: 'release',
    });
    expect(config.mac.target.map((t) => t.target)).toEqual(['dmg', 'zip']);
  });

  it('fail when a feed names a file under another name, or misses one', () => {
    const renamed = feedText(version, ['Core-Hub-Setup-1.2.0.exe']);
    expect(
      feedProblems({ version, feeds: { ...feeds, 'latest.yml': renamed }, published }),
    ).toEqual([
      'latest.yml does not list Core-Hub-Setup-1.2.0-x64.exe',
      'latest.yml names Core-Hub-Setup-1.2.0.exe, which the release does not carry',
    ]);
    const noZip = published.filter((n) => !n.endsWith('-mac.zip'));
    expect(feedProblems({ version, feeds, published: noZip })).toEqual([
      'latest-mac.yml names Core-Hub-1.2.0-arm64-mac.zip, which the release does not carry',
    ]);
    expect(
      feedProblems({ version, feeds: { ...feeds, 'latest-linux.yml': null }, published }),
    ).toEqual(['latest-linux.yml is missing']);
    expect(
      feedProblems({
        version,
        feeds: { ...feeds, 'latest-mac.yml': feedText('1.1.9', [built.zip, built.dmg]) },
        published,
      }),
    ).toEqual(['latest-mac.yml is for version 1.1.9, not 1.2.0']);
  });

  it('check only the platform a packaging job built', () => {
    expect(
      feedProblems({
        version,
        feeds: { 'latest-linux.yml': feeds['latest-linux.yml'] },
        published,
        platforms: ['linux'],
      }),
    ).toEqual([]);
  });

  it('read the quoted and unquoted forms electron-builder writes', () => {
    expect(readFeed('version: \'1.2.0\'\nfiles:\n  - url: "a b.exe"\npath: a b.exe\n')).toEqual({
      version: '1.2.0',
      path: 'a b.exe',
      urls: ['a b.exe'],
    });
  });

  it('are checked in a packaging folder, against the files in it', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'corehub-feeds-'));
    try {
      writeFileSync(path.join(dir, 'latest-linux.yml'), feeds['latest-linux.yml']);
      expect(checkFeedsIn({ version, dir, platforms: ['linux'] })).toEqual([
        `latest-linux.yml names ${built.appImage}, which the release does not carry`,
        `latest-linux.yml names ${built.deb}, which the release does not carry`,
      ]);
      writeFileSync(path.join(dir, built.appImage), 'x');
      writeFileSync(path.join(dir, built.deb), 'x');
      expect(checkFeedsIn({ version, dir, platforms: ['linux'] })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('release notes', () => {
  const generated = [
    "## What's Changed",
    '* Desktop release channels by @twuijri in https://github.com/twuijri/core-hub/pull/150',
    '* One version for every deliverable by @twuijri in https://github.com/twuijri/core-hub/pull/144',
    '',
    '**Full Changelog**: https://github.com/twuijri/core-hub/compare/v1.0.0...v1.1.0',
  ].join('\n');

  it('are short and English: downloads, the SmartScreen step, the merged pull requests', () => {
    const notes = releaseNotes({ tag: 'v1.1.0', generated, repository: 'twuijri/core-hub' });
    expect(notes.startsWith('## Core Hub 1.1.0\n')).toBe(true);
    expect(notes).toContain('`Core-Hub-Setup-1.1.0-x64.exe`');
    expect(notes).toContain('`Core-Hub-1.1.0-android.apk`');
    expect(notes).toContain('**More info**, then **Run anyway**');
    expect(notes).toContain('- Desktop release channels (#150)');
    expect(notes).toContain('- One version for every deliverable (#144)');
    expect(notes).not.toContain('@twuijri');
    expect(notes).toContain(
      'Full changelog: https://github.com/twuijri/core-hub/compare/v1.0.0...v1.1.0',
    );
  });

  it('leave the MSIX out for a tag whose code predates it (v1.1.0)', () => {
    const notes = releaseNotes({
      tag: 'v1.1.0',
      generated,
      repository: 'twuijri/core-hub',
      without: ['windows-msix'],
    });
    expect(notes).not.toContain('.msix`');
    expect(notes).toContain('The Microsoft Store package starts with a later version.');
  });

  it('say how the apps update, except for a tag before the self-updating apps', () => {
    const notes = releaseNotes({ tag: 'v1.1.3', generated, repository: 'twuijri/core-hub' });
    expect(notes).toContain('### Updating');
    expect(notes).toContain('A copy older than 1.1.3 has to be updated by hand once.');
    expect(notes).not.toContain('latest.yml');
    const before = releaseNotes({
      tag: 'v1.1.2',
      generated,
      repository: 'twuijri/core-hub',
      without: ['updates'],
    });
    expect(before).not.toContain('### Updating');
  });

  it('keep at most twenty changes', () => {
    const many = Array.from(
      { length: 25 },
      (_, i) => `* Change ${i} by @a in https://github.com/twuijri/core-hub/pull/${i}`,
    ).join('\n');
    const notes = releaseNotes({ tag: 'v1.1.0', generated: many, repository: 'twuijri/core-hub' });
    expect(notes.match(/^- Change/gm)).toHaveLength(20);
    expect(notes).toContain('- …and 5 more.');
  });
});
