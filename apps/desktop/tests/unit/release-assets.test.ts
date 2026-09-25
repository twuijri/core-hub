// The files a GitHub release carries: their names match what packaging makes and what the
// desktop app's update check looks for; the MSIX version; collecting them; the release notes.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collect,
  msixVersion,
  releaseAssets,
  releaseNotes,
} from '../../scripts/release-assets.mjs';
import { pickUpdate, type GitHubRelease } from '../../src/shared/updates.js';

interface BuilderConfig {
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
    collect({ version: '1.1.0', from, to });
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

  it('fails, naming what is missing, rather than make a release without it', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'corehub-release-'));
    mkdirSync(path.join(dir, 'a'));
    writeFileSync(path.join(dir, 'a', 'Core-Hub-Setup-1.1.0-x64.exe'), 'x');
    expect(() => collect({ version: '1.1.0', from: path.join(dir, 'a'), to: path.join(dir, 'b') }))
      .toThrow(/missing .*Core-Hub-1\.1\.0-arm64\.dmg.*app-release\.apk/);
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
