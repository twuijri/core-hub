/**
 * Process entry of the desktop app. One instance per person: a second launch (or a
 * `corehub://` link opened while the app runs) hands its arguments to the first and exits.
 */
import path from 'node:path';
import { app } from 'electron';
import { PRODUCT } from '@corehub/contracts';
import { SCHEME, deepLinkFromArgv } from '../shared/deep-link.js';
import { userDataPath } from '../shared/user-data.js';
import { parseConfigLanguage } from './config-store.js';
import { DesktopController } from './controller.js';
import { fixLegacyShortcuts } from './legacy-shortcuts.js';

// Everything the app keeps (settings, each hub's storage partition, the local hub) lives in one
// folder: the one every earlier release used, pinned by name (src/shared/user-data.ts), or the
// folder a test or portable setup names.
app.setPath(
  'userData',
  userDataPath(app.getPath('appData'), process.env.COREHUB_DESKTOP_USER_DATA),
);
app.setName(PRODUCT.name);
// The language picked on the first-run screen is also the one the web client starts in
// (it reads navigator.language until the person chooses in Display).
const chosen = parseConfigLanguage(app.getPath('userData'));
if (chosen) app.commandLine.appendSwitch('lang', chosen);
// Inside an MSIX package (the Microsoft Store build) Windows gives the app its identity from the
// package, and a different id would lose its notifications; the protocol comes from the manifest.
const windowsStore = (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore === true;
if (process.platform === 'win32' && !windowsStore)
  app.setAppUserModelId(`com.twuijri.${PRODUCT.id}`);

const here = __dirname;
const paths = {
  webDir: process.env.COREHUB_DESKTOP_WEB_DIR
    ? path.resolve(process.env.COREHUB_DESKTOP_WEB_DIR)
    : path.join(here, 'web'),
  rendererDir: path.join(here, 'renderer'),
  // Outside the asar archive in an installed app: the hub runs as its own Node process and
  // loads native modules, neither of which can come from inside an archive.
  hubEntry: path.join(
    app.isPackaged ? path.join(process.resourcesPath, 'hub') : path.join(here, 'hub'),
    'dist',
    'app',
    'hub.mjs',
  ),
  preload: path.join(here, 'preload.cjs'),
  assetsDir: path.join(here, 'assets'),
};

const pendingLinks: string[] = [];
let controller: DesktopController | null = null;

function onLink(url: string): void {
  if (controller) void controller.handleDeepLink(url);
  else pendingLinks.push(url);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Only an installed app claims the scheme: a development or test run must not rewrite
  // the person's OS link handlers. Linux packages declare it in their .desktop entry, the MSIX in
  // its manifest (electron-builder writes `protocols` there).
  if (app.isPackaged && process.platform !== 'linux' && !windowsStore)
    app.setAsDefaultProtocolClient(SCHEME);
  // The installed Windows app is `Core Hub.exe` since 1.1.1's `corehub.exe`; shortcuts a person
  // made to the old one follow it.
  if (app.isPackaged && process.platform === 'win32' && !windowsStore) fixLegacyShortcuts();

  app.on('second-instance', (_event, argv) => {
    controller?.showWindow();
    const link = deepLinkFromArgv(argv);
    if (link) onLink(link);
  });
  // macOS delivers links as an event, possibly before `ready`.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    onLink(url);
  });
  const initialLink = deepLinkFromArgv(process.argv);
  if (initialLink) pendingLinks.push(initialLink);

  app.on('window-all-closed', () => {
    if (!controller?.keepRunningWithoutWindows()) app.quit();
  });
  app.on('activate', () => controller?.showWindow());
  // Cleanup runs before the windows close, while the event loop still turns (after
  // `will-quit` Electron no longer runs Node timers or socket callbacks), then quits again.
  app.on('before-quit', (event) => {
    if (!controller) return;
    const running = controller;
    controller = null;
    running.prepareToQuit();
    event.preventDefault();
    void running.stop().finally(() => app.quit());
  });

  void app.whenReady().then(async () => {
    controller = new DesktopController(paths, {
      devTools: !app.isPackaged || process.env.COREHUB_DESKTOP_DEVTOOLS === '1',
      // Tests run without a tray, so closing the window ends the app.
      tray: process.env.COREHUB_DESKTOP_NO_TRAY !== '1',
    });
    await controller.start();
    for (const link of pendingLinks.splice(0)) void controller.handleDeepLink(link);
  });
}
