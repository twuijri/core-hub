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
  /** The local helper (MCP) — what this computer exposes to agents (ADR 0022). */
  helper: DesktopHelperBridge;
  /** Programs on this computer the helper can share with agents (ADR 0025). */
  programs: DesktopProgramsBridge;
  /** This computer as a device of the hub it is connected to, for a hub on a server (ADR 0025). */
  device: DesktopDeviceBridge;
  /** New versions of the app (DECISIONS §108): download and restart, or a notice and a link. */
  updates: DesktopUpdatesBridge;
  /**
   * The microphone as the OS sees it, for dictation (B11). Absent in an app older than it:
   * the page then shows only what the browser itself can tell.
   */
  voice?: DesktopVoiceBridge;
}

/**
 * The OS's answer about the microphone for this app: `granted`, `denied`, `restricted` (a
 * policy), `not-determined` (macOS has not asked yet), or `unknown` (no OS switch: Linux).
 */
export type DesktopMicStatus = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';

export interface DesktopMicState {
  status: DesktopMicStatus;
  /** The OS has a microphone switch the app can open (macOS, Windows). */
  canOpenSettings: boolean;
}

export interface DesktopVoiceBridge {
  mic(): Promise<DesktopMicState>;
  /** Asks the OS (macOS shows its question once); resolves with the answer. */
  askMic(): Promise<DesktopMicState>;
  /** Opens the OS's microphone privacy settings. */
  openMicSettings(): Promise<void>;
}

export interface DesktopUpdateCheck {
  status: 'available' | 'up_to_date' | 'failed';
  current: string;
  checkedAt: string;
  update?: { version: string; download: string; size: number | null; page: string };
  message?: string;
}

export interface DesktopUpdatesState {
  /**
   * `store`: the Microsoft Store build — the Store updates it, so the app never checks and
   * `releasesPage` is its Store page. Absent (an older app) means `github`.
   */
  channel?: 'github' | 'store';
  /**
   * What the app does about a new version (DECISIONS §108): `install` downloads it in the
   * background and asks to restart (the Windows .exe, macOS, the Linux AppImage); `notify` says it
   * is out and links `downloadPage` (the Linux .deb); `off` the Store build. Absent (an app before
   * 1.1.3): the old notice with a link to the installer.
   */
  mode?: 'install' | 'notify' | 'off';
  /** Checks on its own (about ten seconds after start, then every six hours). */
  auto: boolean;
  /** The last answer, or null before the first check. */
  last: DesktopUpdateCheck | null;
  /** Where every release is listed. */
  releasesPage: string;
  /** `install` only: the new version downloading, or downloaded and waiting for a restart. */
  pending?: DesktopPendingUpdate | null;
  /** `notify` only: the download page the person gets the new version from. */
  downloadPage?: string;
  /** The version the person said "Later" to in this run; its notice stays hidden. */
  dismissed?: string | null;
  /** A check is running (one the menu started, or the schedule's). */
  checking?: boolean;
}

export interface DesktopPendingUpdate {
  version: string;
  status: 'downloading' | 'ready';
  /** 0–100 while downloading, when known. */
  percent: number | null;
}

export interface DesktopUpdatesBridge {
  get(): Promise<DesktopUpdatesState>;
  check(): Promise<DesktopUpdatesState>;
  setAuto(value: boolean): Promise<DesktopUpdatesState>;
  /** Installs the downloaded version and starts it again (`pending.status === 'ready'`). */
  restart?(): Promise<void>;
  /** "Later": hides the notice about `version` until the app starts again. */
  dismiss?(version: string): Promise<DesktopUpdatesState>;
  /** Every change the app makes on its own (a check, a download's progress, ready). */
  onChange?(listener: (state: DesktopUpdatesState) => void): () => void;
}

export interface DesktopHelperFolder {
  path: string;
  /** Read only unless true. */
  write: boolean;
}

export interface DesktopHelperActivity {
  at: string;
  tool: string;
  target: string | null;
  ok: boolean;
  detail: string | null;
  /** The program the call went to, for a program's tool. */
  program?: string | null;
  /** `local`: the hub on this computer; `hub`: a hub elsewhere, through the device connection. */
  via?: 'local' | 'hub';
}

export interface DesktopHelperState {
  /** Off by default; nothing listens until it is on. */
  enabled: boolean;
  /** The MCP address an agent on this computer connects to, while it runs. */
  url: string | null;
  /** The bearer token that address wants. */
  token: string;
  folders: DesktopHelperFolder[];
  /** Opening files (in the shared folders) and web links on this computer. */
  allowOpen: boolean;
  /** Exactly the tools an agent sees now, as the helper describes them. */
  tools: Array<{ name: string; description: string }>;
  /** The last calls, newest first. */
  activity: DesktopHelperActivity[];
  /** Why it is not running although on, or null. */
  error: string | null;
  /** The folder the app made for Core Hub's own files (`~/Core Hub`), while it is shared. */
  defaultFolder?: string | null;
}

/** A setting a program needs that only the person can give (an API key). */
export interface DesktopProgramField {
  key: string;
  title: string;
  description: string | null;
  sensitive: boolean;
  required: boolean;
  /** A value is saved (a secret's value is never shown back). */
  set: boolean;
  /** The saved value, for a setting that is not secret. */
  value: string | null;
}

export type DesktopProgramSource =
  'claude_desktop' | 'claude_desktop_extension' | 'claude_code' | 'codex' | 'cursor' | 'windsurf';

export interface DesktopProgram {
  id: string;
  name: string;
  source: DesktopProgramSource;
  /** The file it was found in. */
  origin: string;
  description: string | null;
  /**
   * `ready`: can be switched on; `needs_setup`: a setting is missing; `remote`: a server on the
   * network, not passed through in this version; `invalid`: its registration names no program.
   */
  status: 'ready' | 'needs_setup' | 'remote' | 'invalid';
  fields: DesktopProgramField[];
  /** The profiles whose agents may use it; empty: off (the default). */
  profiles: string[];
  /** Its tools as it last listed them. */
  tools: Array<{ name: string; description: string }>;
  running: boolean;
  /** Why it could not start, the last time it was tried. */
  error: string | null;
  /** DaVinci Resolve's integration: the page shows its readiness check. */
  resolve: boolean;
}

export type DesktopResolveStep =
  'install_integration' | 'share_program' | 'start_resolve' | 'enable_scripting' | 'needs_studio';

export interface DesktopResolveReadiness {
  checkedAt: string;
  programId: string | null;
  integration: 'missing' | 'found' | 'shared';
  running: boolean | null;
  scripting: 'reachable' | 'unreachable' | 'unknown';
  product: string | null;
  version: string | null;
  studio: boolean | null;
  steps: DesktopResolveStep[];
}

export interface DesktopProgramsState {
  programs: DesktopProgram[];
  /** When the other assistants' files were last read. */
  scannedAt: string | null;
  /** The last DaVinci Resolve check, or null before the first. */
  resolve: DesktopResolveReadiness | null;
}

export interface DesktopProgramsBridge {
  get(): Promise<DesktopProgramsState>;
  /** Reads the other assistants' files again. */
  rescan(): Promise<DesktopProgramsState>;
  /** The profiles whose agents may use it; empty switches it off. */
  setProfiles(id: string, profiles: string[]): Promise<DesktopProgramsState>;
  /** Saves (or, with null, forgets) one of its settings. */
  setField(id: string, key: string, value: string | null): Promise<DesktopProgramsState>;
  checkResolve(): Promise<DesktopProgramsState>;
}

export type DesktopDeviceStatus =
  'unlinked' | 'connecting' | 'connected' | 'offline' | 'refused' | 'stopped';

export interface DesktopDeviceState {
  /** The hub this window talks to (remote mode), or null in local mode. */
  hub: string | null;
  /** This computer has a device token of that hub. */
  linked: boolean;
  deviceId: string | null;
  status: DesktopDeviceStatus;
  /** Why it is offline or refused, as the connection said. */
  detail: string | null;
}

export interface DesktopDeviceBridge {
  get(): Promise<DesktopDeviceState>;
  /**
   * Pairs this computer with the hub from a pairing the signed-in page just made
   * (`auth.createPairing`); the token stays in the app, never in the page.
   */
  link(pairingId: string, code: string): Promise<DesktopDeviceState>;
  /** Forgets this computer's device token here (the page unlinks it on the hub). */
  forget(): Promise<DesktopDeviceState>;
}

export interface DesktopHelperBridge {
  get(): Promise<DesktopHelperState>;
  setEnabled(value: boolean): Promise<DesktopHelperState>;
  /** Opens the system's folder picker; nothing changes if the person cancels. */
  addFolder(): Promise<DesktopHelperState>;
  removeFolder(path: string): Promise<DesktopHelperState>;
  setFolderWrite(path: string, write: boolean): Promise<DesktopHelperState>;
  setAllowOpen(value: boolean): Promise<DesktopHelperState>;
  /** A new token; whatever used the old one must be given the new one. */
  newToken(): Promise<DesktopHelperState>;
}
