// The name a person sees is "Core Hub" on every platform (1.1.1 shipped `corehub.app` in a
// `corehub 1.1.1-arm64` DMG window, `corehub.exe` in a `corehub` folder, `/opt/Core Hub/corehub`),
// while what an update or the data rely on keeps its name: the ids, the protocol, the Linux desktop
// entry and window class, the .deb package, the release assets and the data folder.
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { USER_DATA_FOLDER, userDataPath } from '../../src/shared/user-data.js';

type Options = Record<string, unknown>;
interface BuilderConfig extends Options {
  productName: string;
  appId: string;
  protocols: { name: string; schemes: string[] }[];
  mac: Options;
  win: Options;
  linux: Options;
  dmg: Options & { title?: string };
  appx: Options;
  deb: Options;
}
interface AppInfoLike {
  productName: string;
  productFilename: string;
}

const require = createRequire(import.meta.url);
const config = require('../../electron-builder.config.cjs') as BuilderConfig;
const pkg = require('../../package.json') as Options & { productName: string; desktopName: string };

// electron-builder's own naming code, so the test follows the packager rather than a copy of it.
const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
const { AppInfo } = builderRequire('app-builder-lib/out/appInfo') as {
  AppInfo: new (info: unknown, buildVersion: null, options: Options, nfd?: boolean) => AppInfoLike;
};
const { DmgTarget } = builderRequire('dmg-builder') as {
  DmgTarget: { prototype: { computeVolumeName(arch: number, custom?: string): string } };
};
const { Arch } = builderRequire('builder-util') as { Arch: { arm64: number } };
const { getWindowsInstallationDirName } = builderRequire(
  'app-builder-lib/out/targets/targetUtil',
) as {
  getWindowsInstallationDirName(appInfo: AppInfoLike, tryProductName: boolean): string;
};
const { LinuxTargetHelper } = builderRequire('app-builder-lib/out/targets/LinuxTargetHelper') as {
  LinuxTargetHelper: new (packager: unknown) => {
    computeDesktopEntry(options: Options, exec?: string | null, extra?: Options): Promise<string>;
  };
};

const appInfo = (platform: 'mac' | 'win' | 'linux', cfg: BuilderConfig = config) =>
  new AppInfo(
    { config: cfg, metadata: { ...pkg, version: '1.1.1' } },
    null,
    cfg[platform],
    platform === 'mac',
  );
const dmgWindow = (cfg: BuilderConfig = config) =>
  DmgTarget.prototype.computeVolumeName.call(
    { packager: { appInfo: appInfo('mac', cfg), platformSpecificBuildOptions: cfg.mac } },
    Arch.arm64,
    cfg.dmg.title,
  );

describe('the app name a person sees', () => {
  it('is "Core Hub" everywhere electron-builder shows the product name', () => {
    expect(config.productName).toBe('Core Hub');
    expect(pkg.productName).toBe('Core Hub');
    for (const platform of ['mac', 'win', 'linux'] as const)
      expect(appInfo(platform).productName).toBe('Core Hub');
  });

  it('names the macOS bundle Core Hub.app and the DMG window "Core Hub 1.1.1"', () => {
    expect(config).not.toHaveProperty('executableName');
    expect(config.mac).not.toHaveProperty('executableName');
    expect(`${appInfo('mac').productFilename}.app`).toBe('Core Hub.app');
    expect(dmgWindow()).toBe('Core Hub 1.1.1');
  });

  it('reproduces what 1.1.1 shipped with the old top-level executableName', () => {
    const dmg: Options = { ...config.dmg };
    delete dmg.title;
    const old: BuilderConfig = { ...config, executableName: 'corehub', dmg };
    expect(`${appInfo('mac', old).productFilename}.app`).toBe('corehub.app');
    expect(dmgWindow(old)).toBe('corehub 1.1.1-arm64');
  });

  it('installs Core Hub.exe in a Core Hub folder on Windows', () => {
    expect(config.win).not.toHaveProperty('executableName');
    expect(`${appInfo('win').productFilename}.exe`).toBe('Core Hub.exe');
    // oneClick: false, so electron-builder names the folder after the product when it can.
    expect(getWindowsInstallationDirName(appInfo('win'), true)).toBe('Core Hub');
    expect((config.nsis as Options).include).toBe('scripts/installer.nsh');
  });

  it('gives Linux a Core Hub menu entry, /opt/Core Hub and a core-hub command', async () => {
    const packager = {
      appInfo: appInfo('linux'),
      executableName: config.linux.executableName,
      info: { metadata: pkg },
      config,
      platformSpecificBuildOptions: config.linux,
      fileAssociations: [],
    };
    const entry = await new LinuxTargetHelper(packager).computeDesktopEntry(config.linux, null, {});
    expect(entry).toContain('\nName=Core Hub\n');
    // The folder has a space, so Exec is quoted; the command itself has none.
    expect(entry).toContain('\nExec="/opt/Core Hub/core-hub" %U\n');
    // The window class Electron takes from package.json desktopName, and the entry's match for it.
    expect(pkg.desktopName).toBe('corehub.desktop');
    expect(entry).toContain('\nStartupWMClass=corehub\n');
    expect(entry).toContain('x-scheme-handler/corehub;');
    // Debian package names allow no capitals or spaces.
    expect(config.deb.packageName).toBe('corehub');
  });

  it('leaves the ids, the protocol and the Store identity alone', () => {
    expect(config.appId).toBe('com.twuijri.corehub');
    expect(config.protocols).toEqual([{ name: 'Core Hub', schemes: ['corehub'] }]);
    expect(config.appx.displayName).toBe('Core Hub');
    expect(config.appx.identityName).toBe('AbdulazizAltuwijri.CoreHub');
  });
});

describe('the data folder', () => {
  it('is <appData>/Core Hub, the folder Electron used for every earlier release', () => {
    // Electron names userData after package.json's productName, so 1.1.1's corehub.app already
    // wrote to "Core Hub"; the pinned name must stay that folder.
    expect(USER_DATA_FOLDER).toBe(pkg.productName);
    expect(USER_DATA_FOLDER).toBe('Core Hub');
    const appData = path.join(path.sep, 'Users', 'someone', 'Library', 'Application Support');
    expect(userDataPath(appData)).toBe(path.join(appData, 'Core Hub'));
  });

  it('uses the folder a test or portable setup names', () => {
    const custom = path.join(path.sep, 'tmp', 'portable');
    expect(userDataPath('/ignored', custom)).toBe(path.resolve(custom));
    expect(userDataPath('/ignored', ` ${custom} `)).toBe(path.resolve(custom));
    expect(userDataPath('/base', '')).toBe(path.join('/base', 'Core Hub'));
    expect(userDataPath('/base', '   ')).toBe(path.join('/base', 'Core Hub'));
  });
});
