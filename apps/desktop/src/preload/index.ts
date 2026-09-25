/**
 * The only door between a window and the main process. The window runs sandboxed with
 * context isolation and no Node; what it may ask for is exactly the functions below.
 *
 * The web client gets `window.corehubDesktop` (its shape is the web client's own
 * `DesktopBridge`). The first-run screen, a local file, gets `window.corehubWelcome` as well.
 * The main process checks who is asking on every call anyway.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  DesktopBridge,
  DesktopHelperState,
  DesktopNotice,
  DesktopState,
} from '../../../../packages/web/src/desktop/bridge-types.js';
import type { Language } from '../shared/config.js';
import { CHANNELS, type WelcomeApi } from '../shared/ipc.js';

function listen<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const bridge: DesktopBridge = {
  surface: 'desktop',
  getState: () => ipcRenderer.invoke(CHANNELS.state) as Promise<DesktopState>,
  takePendingSession: () => ipcRenderer.invoke(CHANNELS.takeSession) as Promise<unknown>,
  changeConnection: () => ipcRenderer.invoke(CHANNELS.changeConnection) as Promise<void>,
  setCloseToTray: (value: boolean) =>
    ipcRenderer.invoke(CHANNELS.setCloseToTray, value === true) as Promise<DesktopState>,
  setLanguage: (language) => ipcRenderer.send(CHANNELS.setLanguage, language),
  notify: (notice: DesktopNotice) =>
    ipcRenderer.send(CHANNELS.notify, {
      title: String(notice.title ?? ''),
      body: notice.body == null ? null : String(notice.body),
      path: notice.path == null ? null : String(notice.path),
    }),
  setUnreadCount: (count: number) => ipcRenderer.send(CHANNELS.unread, Number(count) || 0),
  onOpenPath: (listener) => listen<string>(CHANNELS.openPath, listener),
  helper: {
    get: () => ipcRenderer.invoke(CHANNELS.helperGet) as Promise<DesktopHelperState>,
    setEnabled: (value) => ipcRenderer.invoke(CHANNELS.helperEnable, value === true),
    addFolder: () => ipcRenderer.invoke(CHANNELS.helperAddFolder),
    removeFolder: (folder) => ipcRenderer.invoke(CHANNELS.helperRemoveFolder, String(folder)),
    setFolderWrite: (folder, write) =>
      ipcRenderer.invoke(CHANNELS.helperFolderWrite, String(folder), write === true),
    setAllowOpen: (value) => ipcRenderer.invoke(CHANNELS.helperAllowOpen, value === true),
    newToken: () => ipcRenderer.invoke(CHANNELS.helperNewToken),
  },
};

contextBridge.exposeInMainWorld('corehubDesktop', bridge);

if (location.protocol === 'file:') {
  const welcome: WelcomeApi = {
    init: () => ipcRenderer.invoke(CHANNELS.welcomeInit),
    connect: (url: string) => ipcRenderer.invoke(CHANNELS.welcomeConnect, String(url)),
    pair: (text: string) => ipcRenderer.invoke(CHANNELS.welcomePair, String(text)),
    chooseLocal: (options) =>
      ipcRenderer.invoke(CHANNELS.welcomeLocal, { withoutHermes: options?.withoutHermes === true }),
    installHermes: () => ipcRenderer.invoke(CHANNELS.welcomeInstallHermes),
    onInstallLog: (listener) => listen<string>(CHANNELS.welcomeInstallLog, listener),
    setLanguage: (language: Language) =>
      ipcRenderer.invoke(CHANNELS.welcomeLanguage, language === 'ar' ? 'ar' : 'en'),
    onPrefill: (listener) => listen<string>(CHANNELS.welcomePrefill, listener),
  };
  contextBridge.exposeInMainWorld('corehubWelcome', welcome);
}
