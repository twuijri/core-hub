/**
 * The desktop app's main process: one first-run window, one app window per mode, a tray,
 * a menu, and the loopback origin that serves the web client (`proxy.ts`).
 *
 * Remote mode (ADR 0009): the app window loads the bundled web client from the loopback
 * origin, and `/api` + `/rt` go to the hub the person chose. Each hub gets its own storage
 * partition, so its sign-in and preferences never reach another hub, and switching modes
 * or hubs keeps each one's data where it was.
 */
import os from 'node:os';
import path from 'node:path';
import {
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  app,
  dialog,
  ipcMain,
  nativeImage,
  screen,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import { PRODUCT } from '@corehub/contracts';
import type {
  DesktopHelperState,
  DesktopNotice,
  DesktopState,
} from '../../../../packages/web/src/desktop/bridge-types.js';
import { FOLDER_LIMIT, randomToken, type HelperConfig } from '../shared/helper.js';
import { languageFromLocale, withRemote, type Language } from '../shared/config.js';
import {
  isSafeAppPath,
  parseDeepLink,
  parsePairingInput,
  type PairingRequest,
} from '../shared/deep-link.js';
import { normalizeHubUrl, partitionKey } from '../shared/hub-url.js';
import { isolate, translate } from '../shared/i18n.js';
import {
  HERMES_INSTALL_DOCS,
  hermesInstallerFor,
  pathWithHermes,
} from '../shared/hermes-detect.js';
import {
  CHANNELS,
  type LocalResult,
  type WelcomeError,
  type WelcomeInit,
  type WelcomeResult,
} from '../shared/ipc.js';
import { placeWindow } from '../shared/window-state.js';
import { ConfigStore } from './config-store.js';
import { findHermes, installHermes, thisMachine, type HermesFound } from './hermes.js';
import { claimPairing, probeHub, type WebSession } from './hub.js';
import { LocalHubError, startLocalHub, type LocalHub } from './local-hub.js';
import { startHelper, toolsFor, type HelperServer } from './helper.js';
import { appMenuTemplate, trayMenuTemplate, type MenuActions } from './menu.js';
import { startProxy, type ProxyServer } from './proxy.js';

export interface ControllerPaths {
  /** The built web client. */
  webDir: string;
  /** `welcome.html` and its script. */
  rendererDir: string;
  /** The embedded hub's entry (`dist/hub/dist/app/hub.mjs`), for local mode. */
  hubEntry: string;
  preload: string;
  assetsDir: string;
}

export class DesktopController {
  private readonly config: ConfigStore;
  private proxy: ProxyServer | null = null;
  private appWindow: BrowserWindow | null = null;
  private welcomeWindow: BrowserWindow | null = null;
  private tray: Tray | null = null;
  private quitting = false;
  private pendingSession: WebSession | null = null;
  private pendingPath: string | null = null;
  private saveBoundsTimer: NodeJS.Timeout | null = null;
  private localHub: LocalHub | null = null;
  private hermes: HermesFound | null = null;
  /** Shown on the first-run screen when the app came back to it on its own. */
  private welcomeNotice: WelcomeError | null = null;
  private installing = false;
  private helper: HelperServer | null = null;
  private helperError: string | null = null;

  constructor(
    private readonly paths: ControllerPaths,
    private readonly options: { devTools: boolean; tray: boolean },
  ) {
    this.config = new ConfigStore(app.getPath('userData'));
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    this.proxy = await startProxy({
      webDir: this.paths.webDir,
      preferredPort: this.config.get().port,
    });
    if (this.config.get().port !== this.proxy.port) {
      const port = this.proxy.port;
      this.config.update((c) => ({ ...c, port }));
    }
    this.registerIpc();
    this.buildMenus();
    if (this.config.get().helper.enabled) await this.syncHelper();
    if (this.options.tray) this.createTray();
    const config = this.config.get();
    if (config.mode === 'remote' && config.remote.url) this.openRemote(config.remote.url);
    else if (config.mode === 'local') {
      const started = await this.startLocal();
      if (!started.ok) {
        this.welcomeNotice = started.error;
        this.openWelcome();
      }
    } else this.openWelcome();
  }

  prepareToQuit(): void {
    this.quitting = true;
  }

  /** With a tray the app keeps running when its last window closes; without one it quits. */
  keepRunningWithoutWindows(): boolean {
    return !this.quitting && this.tray !== null && this.config.get().closeToTray;
  }

  async stop(): Promise<void> {
    this.quitting = true;
    this.tray?.destroy();
    this.tray = null;
    // The local hub is stopped properly (its database, its Hermes child); the rest never
    // holds up quitting: the process ending closes whatever socket is left.
    const helper = this.helper;
    this.helper = null;
    await Promise.all([
      this.stopLocal(),
      helper?.close(),
      Promise.race([this.proxy?.close(), new Promise((resolve) => setTimeout(resolve, 1_000))]),
    ]);
  }

  /** Another launch, a dock click, a tray click: bring the current window forward. */
  showWindow(): void {
    const window = this.appWindow ?? this.welcomeWindow;
    if (!window) {
      this.openWelcome();
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  language(): Language {
    return this.config.get().language ?? languageFromLocale(app.getLocale());
  }

  private t = (key: string, params?: Record<string, string>) =>
    translate(this.language(), key, params);

  // ---------------------------------------------------------------- deep links

  async handleDeepLink(raw: string): Promise<void> {
    const link = parseDeepLink(raw);
    if (!link) return;
    if (link.kind === 'open') {
      this.openPath(link.path);
      return;
    }
    if (link.kind === 'connect') {
      // A link never switches hubs by itself: it fills the address, the person connects.
      this.openWelcome(link.hub);
      return;
    }
    const answer = await dialog.showMessageBox({
      type: 'question',
      buttons: [this.t('dialog.pair'), this.t('dialog.cancel')],
      defaultId: 0,
      cancelId: 1,
      message: this.t('dialog.pair_question', { hub: isolate(link.pairing.hub) }),
      detail: this.t('dialog.pair_detail'),
    });
    if (answer.response !== 0) return;
    const result = await this.pair(link.pairing);
    if (!result.ok) {
      this.openWelcome();
      dialog.showErrorBox(
        this.t('app.name'),
        this.t(result.error.key, result.error.params as Record<string, string>),
      );
    }
  }

  private openPath(appPath: string): void {
    if (!isSafeAppPath(appPath)) return;
    if (this.appWindow) {
      this.appWindow.webContents.send(CHANNELS.openPath, appPath);
      this.showWindow();
    } else {
      this.pendingPath = appPath;
      this.showWindow();
    }
  }

  // ---------------------------------------------------------------- windows

  private openWelcome(prefill: string | null = null): void {
    if (this.welcomeWindow) {
      this.closeAppWindow();
      if (prefill) this.welcomeWindow.webContents.send(CHANNELS.welcomePrefill, prefill);
      this.showWindow();
      return;
    }
    const window = new BrowserWindow({
      width: 760,
      height: 700,
      minWidth: 420,
      minHeight: 560,
      show: false,
      title: this.t('app.name'),
      icon: path.join(this.paths.assetsDir, 'icon.png'),
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.paths.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    this.welcomeWindow = window;
    this.lockNavigation(window.webContents, null);
    window.once('ready-to-show', () => window.show());
    window.on('closed', () => {
      if (this.welcomeWindow === window) this.welcomeWindow = null;
    });
    void window.loadFile(path.join(this.paths.rendererDir, 'welcome.html'), {
      query: prefill ? { prefill } : {},
    });
    // The app window goes only once this one exists, so the app never has zero windows in
    // between (which quits it on Windows and Linux).
    this.closeAppWindow();
  }

  private openRemote(hub: string): void {
    const proxy = this.requireProxy();
    proxy.setTarget(hub);
    this.openAppWindow(`persist:hub-${partitionKey(hub)}`);
    // Local mode's hub has no one to serve now.
    void this.stopLocal();
  }

  // ---------------------------------------------------------------- local mode

  /** The embedded hub's data, apart from everything remote mode keeps. */
  private localDataDir(): string {
    return path.join(app.getPath('userData'), 'local-hub');
  }

  private async startLocal(): Promise<LocalResult> {
    this.hermes = await findHermes(thisMachine());
    if (!this.localHub) {
      try {
        const hub: LocalHub = await startLocalHub({
          entry: this.paths.hubEntry,
          dataDir: this.localDataDir(),
          pathEnv: pathWithHermes(process.platform, this.hermes.cli, process.env.PATH),
          env: process.env,
          onExit: (code, signal) => this.localHubExited(code, signal),
        });
        this.localHub = hub;
      } catch (error) {
        const message =
          error instanceof LocalHubError
            ? [error.message, ...error.log.slice(-5)].join('\n')
            : String(error);
        return { ok: false, error: { key: 'errors.local_failed', params: { message } } };
      }
    }
    this.requireProxy().setTarget(this.localHub.origin);
    this.config.update((c) => ({ ...c, mode: 'local' }));
    this.openAppWindow('persist:local');
    return { ok: true };
  }

  private localHubExited(code: number | null, signal: NodeJS.Signals | null): void {
    if (!this.localHub) return; // stopped on purpose
    this.localHub = null;
    if (this.quitting || this.config.get().mode !== 'local') return;
    this.welcomeNotice = {
      key: 'errors.local_stopped',
      params: { reason: signal ?? `exit ${code ?? '?'}` },
    };
    this.requireProxy().setTarget(null);
    this.openWelcome();
  }

  private async stopLocal(): Promise<void> {
    const hub = this.localHub;
    if (!hub) return;
    this.localHub = null;
    await hub.stop();
  }

  private openAppWindow(partition: string): void {
    const previous = this.appWindow;
    const proxy = this.requireProxy();
    const saved = this.config.get().window;
    const display = screen.getPrimaryDisplay();
    const placement = placeWindow(
      saved,
      screen.getAllDisplays().map((d) => d.workArea),
      display.workArea,
    );
    const window = new BrowserWindow({
      ...(placement.positioned ? { x: placement.x, y: placement.y } : {}),
      width: placement.width,
      height: placement.height,
      minWidth: 420,
      minHeight: 560,
      show: false,
      title: this.t('app.name'),
      icon: path.join(this.paths.assetsDir, 'icon.png'),
      autoHideMenuBar: process.platform !== 'darwin',
      webPreferences: {
        preload: this.paths.preload,
        partition,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: true,
      },
    });
    this.appWindow = window;
    this.guardSession(window.webContents.session, proxy.origin);
    this.lockNavigation(window.webContents, proxy.origin);
    window.once('ready-to-show', () => {
      if (placement.maximized) window.maximize();
      window.show();
    });
    const remember = () => this.scheduleSaveBounds(window);
    window.on('resize', remember);
    window.on('move', remember);
    window.on('maximize', remember);
    window.on('unmaximize', remember);
    window.on('close', (event) => {
      this.saveBounds(window);
      if (!this.quitting && this.tray && this.config.get().closeToTray) {
        event.preventDefault();
        window.hide();
      }
    });
    window.on('closed', () => {
      if (this.appWindow === window) this.appWindow = null;
    });
    const start = this.pendingPath ?? '/';
    this.pendingPath = null;
    void window.loadURL(`${proxy.origin}${start}`);
    // Close the first-run screen, or the window of the hub before, only once the new window
    // exists (see openWelcome).
    if (previous && !previous.isDestroyed()) {
      this.saveBounds(previous);
      previous.destroy();
    }
    this.welcomeWindow?.destroy();
    this.welcomeWindow = null;
  }

  private closeAppWindow(): void {
    const window = this.appWindow;
    if (!window) return;
    this.appWindow = null;
    this.saveBounds(window);
    window.destroy();
  }

  /** Only the app's own pages load inside the window; every other link opens in the browser. */
  private lockNavigation(contents: WebContents, origin: string | null): void {
    const openOutside = (url: string) => {
      if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) void shell.openExternal(url);
    };
    contents.setWindowOpenHandler(({ url }) => {
      openOutside(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      const allowed = origin ? url.startsWith(`${origin}/`) || url === origin : false;
      if (allowed || (origin === null && url.startsWith('file:'))) return;
      event.preventDefault();
      openOutside(url);
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  }

  /** What the page may ask the OS for: notifications and the clipboard, nothing else. */
  private guardSession(target: Electron.Session, origin: string): void {
    const allowed = new Set(['notifications', 'clipboard-sanitized-write', 'clipboard-read']);
    target.setPermissionRequestHandler((contents, permission, callback) => {
      callback(allowed.has(permission) && contents.getURL().startsWith(`${origin}/`));
    });
    target.setPermissionCheckHandler(
      (_contents, permission, requestingOrigin) =>
        allowed.has(permission) && requestingOrigin === origin,
    );
  }

  private scheduleSaveBounds(window: BrowserWindow): void {
    if (this.saveBoundsTimer) clearTimeout(this.saveBoundsTimer);
    this.saveBoundsTimer = setTimeout(() => this.saveBounds(window), 500);
  }

  private saveBounds(window: BrowserWindow): void {
    if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
    const maximized = window.isMaximized();
    const bounds = maximized ? window.getNormalBounds() : window.getBounds();
    this.config.update((c) => ({ ...c, window: { ...bounds, maximized } }));
  }

  // ---------------------------------------------------------------- local helper (MCP)

  /** Starts or stops the helper to match the setting. */
  private async syncHelper(): Promise<void> {
    const wanted = this.config.get().helper.enabled;
    if (!wanted && this.helper) {
      const helper = this.helper;
      this.helper = null;
      await helper.close();
    }
    if (wanted && !this.helper) {
      try {
        this.helper = await startHelper({
          config: () => this.config.get().helper,
          env: {
            openPath: (file) => shell.openPath(file),
            openUrl: (url) => shell.openExternal(url),
          },
          version: app.getVersion(),
          preferredPort: this.config.get().helper.port,
        });
        this.helperError = null;
        const port = this.helper.port;
        if (this.config.get().helper.port !== port) this.updateHelper((h) => ({ ...h, port }));
      } catch (error) {
        this.helperError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  private updateHelper(change: (helper: HelperConfig) => HelperConfig): void {
    this.config.update((c) => ({ ...c, helper: change(c.helper) }));
  }

  private helperState(): DesktopHelperState {
    const helper = this.config.get().helper;
    return {
      enabled: helper.enabled,
      url: this.helper?.url ?? null,
      token: helper.token,
      folders: helper.folders.map((f) => ({ ...f })),
      allowOpen: helper.allowOpen,
      tools: toolsFor(helper).map(({ name, description }) => ({ name, description })),
      activity: this.helper?.activity() ?? [],
      error: helper.enabled ? this.helperError : null,
    };
  }

  private registerHelperIpc(): void {
    const guarded = <A extends unknown[]>(
      channel: string,
      run: (...args: A) => void | Promise<void>,
    ) =>
      ipcMain.handle(channel, async (event, ...args: unknown[]) => {
        if (!this.fromApp(event)) return null;
        await run(...(args as A));
        return this.helperState();
      });
    guarded(CHANNELS.helperGet, () => {});
    guarded(CHANNELS.helperEnable, async (value: unknown) => {
      this.updateHelper((h) => ({ ...h, enabled: value === true }));
      await this.syncHelper();
    });
    guarded(CHANNELS.helperAddFolder, async () => {
      const parent = this.appWindow;
      const options = {
        title: this.t('helper.pick_folder'),
        properties: ['openDirectory' as const, 'createDirectory' as const],
      };
      const picked = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      const folder = picked.canceled ? undefined : picked.filePaths[0];
      if (!folder) return;
      this.updateHelper((h) =>
        h.folders.some((f) => f.path === folder) || h.folders.length >= FOLDER_LIMIT
          ? h
          : { ...h, folders: [...h.folders, { path: folder, write: false }] },
      );
    });
    guarded(CHANNELS.helperRemoveFolder, (folder: unknown) =>
      this.updateHelper((h) => ({ ...h, folders: h.folders.filter((f) => f.path !== folder) })),
    );
    guarded(CHANNELS.helperFolderWrite, (folder: unknown, write: unknown) =>
      this.updateHelper((h) => ({
        ...h,
        folders: h.folders.map((f) => (f.path === folder ? { ...f, write: write === true } : f)),
      })),
    );
    guarded(CHANNELS.helperAllowOpen, (value: unknown) =>
      this.updateHelper((h) => ({ ...h, allowOpen: value === true })),
    );
    guarded(CHANNELS.helperNewToken, () =>
      this.updateHelper((h) => ({ ...h, token: randomToken() })),
    );
  }

  // ---------------------------------------------------------------- tray and menus

  private readonly actions: MenuActions = {
    showWindow: () => this.showWindow(),
    changeConnection: () => this.openWelcome(),
    openWebsite: () => void shell.openExternal(`https://github.com/${PRODUCT.repository}`),
    quit: () => {
      this.quitting = true;
      app.quit();
    },
  };

  private createTray(): void {
    try {
      const icon =
        process.platform === 'darwin'
          ? nativeImage.createFromPath(path.join(this.paths.assetsDir, 'trayTemplate.png'))
          : nativeImage.createFromPath(path.join(this.paths.assetsDir, 'tray-32.png'));
      if (process.platform === 'darwin') icon.setTemplateImage(true);
      this.tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
      this.tray.setToolTip(this.t('app.name'));
      this.tray.on('click', () => this.showWindow());
      this.buildMenus();
    } catch {
      this.tray = null;
    }
  }

  private buildMenus(): void {
    const t = (key: string) => this.t(key);
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        appMenuTemplate(t, this.actions, {
          platform: process.platform,
          devTools: this.options.devTools,
        }),
      ),
    );
    this.tray?.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(t, this.actions)));
    this.tray?.setToolTip(this.t('app.name'));
  }

  // ---------------------------------------------------------------- IPC

  private requireProxy(): ProxyServer {
    if (!this.proxy) throw new Error('the loopback origin is not running');
    return this.proxy;
  }

  private fromApp(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    const origin = this.proxy?.origin;
    const url = event.senderFrame?.url ?? '';
    return (
      !!origin &&
      event.sender === this.appWindow?.webContents &&
      (url === origin || url.startsWith(`${origin}/`))
    );
  }

  private fromWelcome(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    return (
      event.sender === this.welcomeWindow?.webContents &&
      (event.senderFrame?.url ?? '').startsWith('file:')
    );
  }

  private state(): DesktopState {
    const config = this.config.get();
    return {
      appVersion: app.getVersion(),
      platform: process.platform,
      mode: config.mode,
      hubUrl: config.mode === 'remote' ? config.remote.url : (this.localHub?.origin ?? null),
      closeToTray: config.closeToTray,
      trayAvailable: this.tray !== null,
      local:
        config.mode === 'local'
          ? {
              dataDir: this.localDataDir(),
              hermes: this.hermes?.gateway ? 'gateway' : this.hermes?.cli ? 'program' : 'none',
              hermesProgram: this.hermes?.cli ?? null,
            }
          : null,
    };
  }

  private registerIpc(): void {
    this.registerHelperIpc();
    ipcMain.handle(CHANNELS.state, (event) => (this.fromApp(event) ? this.state() : null));
    ipcMain.handle(CHANNELS.takeSession, (event) => {
      if (!this.fromApp(event)) return null;
      const pending = this.pendingSession;
      this.pendingSession = null;
      return pending;
    });
    ipcMain.handle(CHANNELS.changeConnection, (event) => {
      if (this.fromApp(event)) setImmediate(() => this.openWelcome());
    });
    ipcMain.handle(CHANNELS.setCloseToTray, (event, value: unknown) => {
      if (!this.fromApp(event)) return null;
      this.config.update((c) => ({ ...c, closeToTray: value === true }));
      return this.state();
    });
    ipcMain.on(CHANNELS.setLanguage, (event, value: unknown) => {
      if (!this.fromApp(event) || (value !== 'ar' && value !== 'en')) return;
      if (this.config.get().language === value) return;
      this.config.update((c) => ({ ...c, language: value }));
      this.buildMenus();
    });
    ipcMain.on(CHANNELS.notify, (event, notice: DesktopNotice) => {
      if (!this.fromApp(event) || !Notification.isSupported()) return;
      const shown = new Notification({
        title: String(notice?.title ?? '').slice(0, 200) || this.t('app.name'),
        body: String(notice?.body ?? '').slice(0, 1000),
        icon: path.join(this.paths.assetsDir, 'icon.png'),
      });
      const target = typeof notice?.path === 'string' ? notice.path : null;
      shown.on('click', () => (target ? this.openPath(target) : this.showWindow()));
      shown.show();
    });
    ipcMain.on(CHANNELS.unread, (event, count: unknown) => {
      if (!this.fromApp(event)) return;
      const n = typeof count === 'number' && Number.isFinite(count) ? Math.max(0, count) : 0;
      app.setBadgeCount(Math.floor(n));
    });

    ipcMain.handle(CHANNELS.welcomeInit, (event): WelcomeInit | null => {
      if (!this.fromWelcome(event)) return null;
      const config = this.config.get();
      const prefill = new URL(event.senderFrame?.url ?? 'file:///').searchParams.get('prefill');
      return {
        language: this.language(),
        appVersion: app.getVersion(),
        remoteUrl: config.remote.url,
        recent: config.remote.recent,
        localAvailable: true,
        prefill,
        notice: this.welcomeNotice,
      };
    });
    ipcMain.handle(CHANNELS.welcomeLanguage, (event, value: unknown) => {
      if (!this.fromWelcome(event) || (value !== 'ar' && value !== 'en')) return;
      this.config.update((c) => ({ ...c, language: value }));
      this.buildMenus();
    });
    ipcMain.handle(
      CHANNELS.welcomeConnect,
      async (event, raw: unknown): Promise<WelcomeResult | null> => {
        if (!this.fromWelcome(event)) return null;
        return this.connect(String(raw ?? ''));
      },
    );
    ipcMain.handle(
      CHANNELS.welcomePair,
      async (event, raw: unknown): Promise<WelcomeResult | null> => {
        if (!this.fromWelcome(event)) return null;
        const pairing = parsePairingInput(String(raw ?? ''));
        if (!pairing) return { ok: false, error: { key: 'errors.pair_invalid' } };
        return this.pair(pairing);
      },
    );
    ipcMain.handle(
      CHANNELS.welcomeLocal,
      async (event, options: unknown): Promise<LocalResult | null> => {
        if (!this.fromWelcome(event)) return null;
        this.welcomeNotice = null;
        const withoutHermes = (options as { withoutHermes?: unknown } | null)?.withoutHermes;
        if (withoutHermes !== true) {
          const found = await findHermes(thisMachine());
          if (!found.cli && !found.gateway) {
            const installer = hermesInstallerFor(process.platform);
            return {
              ok: false,
              error: null,
              hermesMissing: { command: installer.display, docs: HERMES_INSTALL_DOCS },
            };
          }
        }
        return this.startLocal();
      },
    );
    ipcMain.handle(CHANNELS.welcomeInstallHermes, async (event): Promise<LocalResult | null> => {
      if (!this.fromWelcome(event) || this.installing) return null;
      this.installing = true;
      const sender = event.sender;
      try {
        const result = await installHermes({
          onLine: (line) => {
            if (!sender.isDestroyed()) sender.send(CHANNELS.welcomeInstallLog, line);
          },
        });
        if (!result.ok)
          return {
            ok: false,
            error: { key: 'errors.install_failed', params: { message: result.message } },
          };
        const found = await findHermes(thisMachine());
        if (!found.cli && !found.gateway)
          return { ok: false, error: { key: 'errors.install_not_found' } };
        return await this.startLocal();
      } finally {
        this.installing = false;
      }
    });
  }

  private async connect(raw: string): Promise<WelcomeResult> {
    const url = normalizeHubUrl(raw);
    if (!url.ok) return { ok: false, error: { key: `errors.url.${url.reason}` } };
    const probe = await probeHub(url.origin);
    if (!probe.ok)
      return {
        ok: false,
        error: {
          key: probe.reason === 'unreachable' ? 'errors.hub_unreachable' : 'errors.not_a_hub',
          params: { url: url.origin },
        },
      };
    this.config.update((c) => withRemote(c, url.origin));
    this.openRemote(url.origin);
    return { ok: true };
  }

  private async pair(pairing: PairingRequest): Promise<WelcomeResult> {
    const result = await claimPairing(pairing, {
      deviceKey: this.config.get().deviceKey,
      name: os.hostname() || PRODUCT.name,
      platform: process.platform,
      appVersion: app.getVersion(),
      model: `${os.type()} ${os.release()}`.slice(0, 80),
    });
    if (!result.ok)
      return {
        ok: false,
        error: { key: 'errors.pair_failed', params: { message: result.message } },
      };
    this.pendingSession = result.session;
    this.config.update((c) => withRemote(c, result.hub));
    this.openRemote(result.hub);
    return { ok: true };
  }
}
