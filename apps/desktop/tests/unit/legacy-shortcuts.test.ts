// Shortcuts a person made to 1.1.1's corehub.exe (a taskbar pin, one in Startup to open the app at
// login, a desktop copy) follow the app to Core Hub.exe; nothing else is touched.
import { describe, expect, it } from 'vitest';
import {
  retargetLegacyShortcuts,
  shortcutFolders,
  staleShortcuts,
  type ShortcutIo,
} from '../../src/shared/legacy-shortcuts.js';

const APPDATA = 'C:\\Users\\sam\\AppData\\Roaming';
const DESKTOP = 'C:\\Users\\sam\\Desktop';
const OLD = 'C:\\Users\\sam\\AppData\\Local\\Programs\\corehub\\corehub.exe';
const NEW = 'C:\\Users\\sam\\AppData\\Local\\Programs\\Core Hub\\Core Hub.exe';
const TASKBAR = `${APPDATA}\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar`;
const STARTUP = `${APPDATA}\\Microsoft\\Windows\\Start Menu\\Programs\\Startup`;

describe('the folders searched', () => {
  it('are the taskbar and Start pins, the Start menu, Startup and the desktop', () => {
    expect(shortcutFolders(APPDATA, DESKTOP)).toEqual([
      TASKBAR,
      `${APPDATA}\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\StartMenu`,
      `${APPDATA}\\Microsoft\\Windows\\Start Menu\\Programs`,
      STARTUP,
      DESKTOP,
    ]);
  });
});

describe('a stale shortcut', () => {
  const none = () => false;

  it('names corehub.exe, in any case, and that file is gone', () => {
    const links = [
      { path: 'a.lnk', target: OLD },
      { path: 'b.lnk', target: 'D:\\Apps\\CoreHub\\COREHUB.EXE' },
      { path: 'c.lnk', target: NEW },
      { path: 'd.lnk', target: 'C:\\Windows\\notepad.exe' },
      { path: 'e.lnk', target: 'C:\\tools\\corehub.exe.bak' },
    ];
    expect(staleShortcuts(links, none).map((l) => l.path)).toEqual(['a.lnk', 'b.lnk']);
  });

  it('is not one whose corehub.exe still exists (another copy still installed)', () => {
    expect(staleShortcuts([{ path: 'a.lnk', target: OLD }], (f) => f === OLD)).toEqual([]);
  });
});

describe('retargeting', () => {
  function fakeIo(files: Record<string, Record<string, string | null>>) {
    const written: [string, string][] = [];
    const io: ShortcutIo = {
      list: (folder) => {
        const entries = files[folder];
        if (!entries) throw new Error(`ENOENT ${folder}`);
        return Object.keys(entries);
      },
      read: (link) => {
        const i = link.lastIndexOf('\\');
        const target = files[link.slice(0, i)]?.[link.slice(i + 1)];
        if (target === undefined) throw new Error('not a shortcut');
        return target;
      },
      exists: (file) => file === NEW,
      retarget: (link, target) => {
        written.push([link, target]);
        return true;
      },
    };
    return { io, written };
  }

  it('points the pin and the login shortcut at the running app and leaves the rest', () => {
    const { io, written } = fakeIo({
      [TASKBAR]: { 'Core Hub.lnk': OLD, 'Notepad.lnk': 'C:\\Windows\\notepad.exe', 'x.ini': null },
      [STARTUP]: { 'Core Hub.lnk': OLD },
      [DESKTOP]: { 'Core Hub.lnk': NEW, 'broken.lnk': null },
    });
    const changed = retargetLegacyShortcuts(shortcutFolders(APPDATA, DESKTOP), NEW, io);
    expect(changed).toEqual([`${TASKBAR}\\Core Hub.lnk`, `${STARTUP}\\Core Hub.lnk`]);
    expect(written).toEqual([
      [`${TASKBAR}\\Core Hub.lnk`, NEW],
      [`${STARTUP}\\Core Hub.lnk`, NEW],
    ]);
  });

  it('skips folders that do not exist and shortcuts it cannot read or write', () => {
    const { io } = fakeIo({ [STARTUP]: { 'Core Hub.lnk': OLD, 'odd.lnk': OLD } });
    const failing: ShortcutIo = {
      ...io,
      read: (link) => {
        if (link.endsWith('odd.lnk')) throw new Error('unreadable');
        return io.read(link);
      },
      retarget: () => {
        throw new Error('access denied');
      },
    };
    expect(retargetLegacyShortcuts(shortcutFolders(APPDATA, DESKTOP), NEW, failing)).toEqual([]);
  });

  it('changes nothing on a machine that never had 1.1.1', () => {
    const { io, written } = fakeIo({ [DESKTOP]: { 'Core Hub.lnk': NEW } });
    expect(retargetLegacyShortcuts(shortcutFolders(APPDATA, DESKTOP), NEW, io)).toEqual([]);
    expect(written).toEqual([]);
  });
});
