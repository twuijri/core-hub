/**
 * Windows only: a person's own shortcuts to 1.1.1's `corehub.exe` (pins, Startup, desktop) are
 * pointed at the running `Core Hub.exe` (src/shared/legacy-shortcuts.ts).
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { app, shell } from 'electron';
import { retargetLegacyShortcuts, shortcutFolders } from '../shared/legacy-shortcuts.js';

export function fixLegacyShortcuts(): string[] {
  const executable = process.execPath;
  return retargetLegacyShortcuts(
    shortcutFolders(app.getPath('appData'), app.getPath('desktop')),
    executable,
    {
      list: (folder) => readdirSync(folder),
      read: (link) => shell.readShortcutLink(link).target || null,
      exists: (file) => existsSync(file),
      retarget: (link, target) =>
        shell.writeShortcutLink(link, 'update', {
          target,
          // The old "Start in" folder went with the old install.
          cwd: path.dirname(target),
          icon: target,
          iconIndex: 0,
        }),
    },
  );
}
