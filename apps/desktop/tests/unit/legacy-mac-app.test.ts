// The old `corehub.app` beside `Core Hub.app` (macOS): offered to the Trash only when it is
// really an old Core Hub, in the same folder, and not the app that is running.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bundleOf,
  findLegacyApp,
  isCoreHubPlist,
  type LegacyFs,
} from '../../src/main/legacy-mac-app.js';

const plist = (id: string) =>
  Buffer.from(
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleName</key><string>corehub</string>` +
      `<key>CFBundleIdentifier</key>\n\t<string>${id}</string></dict></plist>`,
  );

/** A pretend disk: paths that exist, with their contents, and symlinks by realpath. */
function disk(files: Record<string, Buffer | null>, links: Record<string, string> = {}): LegacyFs {
  return {
    exists: (file) => file in files,
    realpath: (file) => links[file] ?? file,
    read: (file) => {
      const data = files[file];
      if (!data) throw new Error(`ENOENT ${file}`);
      return data;
    },
  };
}

const EXE = '/Applications/Core Hub.app/Contents/MacOS/Core Hub';
const OLD = '/Applications/corehub.app';
const OLD_PLIST = path.join(OLD, 'Contents', 'Info.plist');

describe('the old corehub.app', () => {
  it('is found beside Core Hub.app when its Info.plist is Core Hub’s', () => {
    for (const id of ['com.twuijri.corehub', 'io.github.twuijri.corehub']) {
      const fs = disk({ [OLD]: null, [OLD_PLIST]: plist(id) });
      expect(findLegacyApp({ exePath: EXE, platform: 'darwin' }, fs)).toBe(OLD);
    }
  });

  it('reads a binary Info.plist too', () => {
    const binary = Buffer.concat([Buffer.from('bplist00'), Buffer.from('com.twuijri.corehub')]);
    expect(isCoreHubPlist(binary)).toBe(true);
    expect(isCoreHubPlist(Buffer.from('bplist00 com.example.other'))).toBe(false);
  });

  it('is left alone when it is someone else’s app, absent, or the running app itself', () => {
    const other = disk({ [OLD]: null, [OLD_PLIST]: plist('com.example.corehub') });
    expect(findLegacyApp({ exePath: EXE, platform: 'darwin' }, other)).toBeNull();
    expect(findLegacyApp({ exePath: EXE, platform: 'darwin' }, disk({}))).toBeNull();
    const noPlist = disk({ [OLD]: null });
    expect(findLegacyApp({ exePath: EXE, platform: 'darwin' }, noPlist)).toBeNull();
    const same = disk(
      { [OLD]: null, [OLD_PLIST]: plist('com.twuijri.corehub') },
      { [OLD]: '/Applications/Core Hub.app' },
    );
    expect(findLegacyApp({ exePath: EXE, platform: 'darwin' }, same)).toBeNull();
  });

  it('is only looked for by Core Hub.app on macOS', () => {
    const fs = disk({ [OLD]: null, [OLD_PLIST]: plist('com.twuijri.corehub') });
    expect(findLegacyApp({ exePath: EXE, platform: 'linux' }, fs)).toBeNull();
    expect(
      findLegacyApp(
        { exePath: '/Applications/corehub.app/Contents/MacOS/corehub', platform: 'darwin' },
        fs,
      ),
    ).toBeNull();
    expect(findLegacyApp({ exePath: '/usr/bin/core-hub', platform: 'darwin' }, fs)).toBeNull();
    expect(bundleOf(EXE)).toBe('/Applications/Core Hub.app');
    expect(bundleOf('/opt/Core Hub/core-hub')).toBeNull();
  });
});
