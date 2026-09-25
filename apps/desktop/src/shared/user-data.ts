/**
 * Where the desktop app keeps everything it stores: settings (`desktop.json`), each hub's
 * storage partition and the local hub (`local-hub/`).
 *
 * Electron names this folder after package.json's `productName`, not after the `.app` bundle or
 * the executable, so every release up to 1.1.1 already wrote to `<appData>/Core Hub`
 * (`~/Library/Application Support/Core Hub`, `%APPDATA%\Core Hub`, `~/.config/Core Hub`), even the
 * ones installed as `corehub.app` / `corehub.exe`. The folder is pinned here by name so that a later
 * rename of the product, the bundle or the executable never moves a person's local hub away.
 */
import path from 'node:path';

/** The folder name under the OS app-data folder. Never change it: people's data lives there. */
export const USER_DATA_FOLDER = 'Core Hub';

/**
 * The app's data folder: `override` when a test or a portable setup names one
 * (COREHUB_DESKTOP_USER_DATA), otherwise `<appData>/Core Hub`.
 */
export function userDataPath(appData: string, override?: string): string {
  const custom = override?.trim();
  return custom ? path.resolve(custom) : path.join(appData, USER_DATA_FOLDER);
}
