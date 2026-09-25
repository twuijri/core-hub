/**
 * What the desktop app (apps/desktop, ADR 0009) hands the web client: `window.corehubDesktop`.
 *
 * The web client is the consumer, so the shape is declared here; the desktop app's preload
 * implements it and type-checks against this very file. It is types only — no DOM, no
 * imports — so a Node-side package can include it. A browser has no bridge, and every use
 * starts from "is there one" (`desktop.ts`).
 */

export type DesktopMode = 'remote' | 'local';

export interface DesktopState {
  /** The desktop app's own version (the web bundle inside it has the same one). */
  appVersion: string;
  /** `process.platform` of the computer: `darwin`, `win32`, `linux`. */
  platform: string;
  mode: DesktopMode | null;
  /** The hub this window talks to: the remote hub's origin, or the local hub's address. */
  hubUrl: string | null;
  /** Closing the window keeps the app running in the tray. */
  closeToTray: boolean;
  /** Whether the OS gave the app a tray icon (some Linux desktops have none). */
  trayAvailable: boolean;
  /** Local mode only: where the hub keeps its data, and which Hermes it found. */
  local: DesktopLocalState | null;
}

export interface DesktopLocalState {
  /** The embedded hub's data folder (its database, keys, and Hermes home). */
  dataDir: string;
  /**
   * `program`: the hub runs the Hermes program installed on this computer; `gateway`: a
   * Hermes gateway was already running and the hub uses it; `none`: no Hermes was found.
   */
  hermes: 'program' | 'gateway' | 'none';
  /** The Hermes program the hub was given, when there is one. */
  hermesProgram: string | null;
}

/** One notice shown by the OS (the in-app inbox keeps it too). */
export interface DesktopNotice {
  title: string;
  body?: string | null;
  /** An app path to open when the person clicks the notification. */
  path?: string | null;
}

export interface DesktopBridge {
  readonly surface: 'desktop';
  getState(): Promise<DesktopState>;
  /**
   * A sign-in the app obtained by pairing this computer (`auth.claimPairing`), handed over
   * once and then forgotten. The web client stores it as its session.
   */
  takePendingSession(): Promise<unknown>;
  /** Back to the first-run screen: another hub, or the other mode. */
  changeConnection(): Promise<void>;
  setCloseToTray(value: boolean): Promise<DesktopState>;
  /** The web client's language, so the app's menus and tray follow it. */
  setLanguage(language: 'ar' | 'en'): void;
  notify(notice: DesktopNotice): void;
  /** The unread count, for the dock / taskbar badge where the OS has one. */
  setUnreadCount(count: number): void;
  /** A `corehub://open/…` link, or a clicked notification, asks for an app path. */
  onOpenPath(listener: (path: string) => void): () => void;
}
