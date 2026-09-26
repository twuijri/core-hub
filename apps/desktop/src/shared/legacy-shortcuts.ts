/**
 * Windows shortcuts left pointing at an executable that earlier releases installed.
 *
 * 1.1.1 was `corehub.exe`; the app is now `Core Hub.exe`. The installer replaces its own Start
 * menu and desktop shortcuts, but not the ones a person made: a taskbar or Start pin, a copy on the
 * desktop, or one in the Startup folder to open the app at login. Those still name `corehub.exe`,
 * which the upgrade removed. At start the installed app points each such shortcut at itself; a
 * shortcut whose old target still exists (another copy) is left alone.
 */
import path from 'node:path';

/** Executables of earlier Windows releases, lowercase. */
export const LEGACY_EXECUTABLES: readonly string[] = ['corehub.exe'];

export interface ShortcutTarget {
  /** The .lnk file. */
  path: string;
  /** Where it points. */
  target: string;
}

/**
 * The folders where a person's own shortcuts to the app live, under `%APPDATA%` (`appData`)
 * and the desktop: taskbar and Start pins, the Start menu, the Startup folder.
 */
export function shortcutFolders(appData: string, desktop: string): string[] {
  const win = path.win32;
  const pinned = win.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned');
  const programs = win.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  return [
    win.join(pinned, 'TaskBar'),
    win.join(pinned, 'StartMenu'),
    programs,
    win.join(programs, 'Startup'),
    desktop,
  ];
}

/** The shortcuts to point at the running app: an old executable's name, and that file is gone. */
export function staleShortcuts(
  links: readonly ShortcutTarget[],
  exists: (file: string) => boolean,
): ShortcutTarget[] {
  return links.filter(
    (link) =>
      LEGACY_EXECUTABLES.includes(path.win32.basename(link.target).toLowerCase()) &&
      !exists(link.target),
  );
}

/** What retargeting needs from the OS; Electron's `shell` and `fs` in the app, fakes in tests. */
export interface ShortcutIo {
  list(folder: string): string[];
  read(link: string): string | null;
  exists(file: string): boolean;
  retarget(link: string, target: string): boolean;
}

/**
 * Points every stale shortcut in `folders` at `executable` and returns the ones it changed.
 * A folder that cannot be read or a shortcut that cannot be read or written is skipped.
 */
export function retargetLegacyShortcuts(
  folders: readonly string[],
  executable: string,
  io: ShortcutIo,
): string[] {
  const links: ShortcutTarget[] = [];
  for (const folder of folders) {
    let names: string[];
    try {
      names = io.list(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.lnk')) continue;
      const link = path.win32.join(folder, name);
      try {
        const target = io.read(link);
        if (target) links.push({ path: link, target });
      } catch {
        // not a shortcut Windows can read
      }
    }
  }
  const changed: string[] = [];
  for (const link of staleShortcuts(links, io.exists)) {
    try {
      if (io.retarget(link.path, executable)) changed.push(link.path);
    } catch {
      // read-only or locked: left as it was
    }
  }
  return changed;
}
