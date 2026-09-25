/**
 * The channels between the windows and the main process, and the first-run screen's API.
 * The web client's side of the bridge is declared by the web client itself
 * (`packages/web/src/desktop/bridge-types.ts`).
 */
import type { Language } from './config.js';

export const CHANNELS = {
  state: 'desktop:state',
  takeSession: 'desktop:take-session',
  changeConnection: 'desktop:change-connection',
  setCloseToTray: 'desktop:set-close-to-tray',
  setLanguage: 'desktop:set-language',
  notify: 'desktop:notify',
  unread: 'desktop:unread',
  openPath: 'desktop:open-path',
  welcomeInit: 'welcome:init',
  welcomeConnect: 'welcome:connect',
  welcomePair: 'welcome:pair',
  welcomeLocal: 'welcome:local',
  welcomeLanguage: 'welcome:language',
  welcomePrefill: 'welcome:prefill',
  welcomeInstallHermes: 'welcome:install-hermes',
  welcomeInstallLog: 'welcome:install-log',
  helperGet: 'helper:get',
  helperEnable: 'helper:enable',
  helperAddFolder: 'helper:add-folder',
  helperRemoveFolder: 'helper:remove-folder',
  helperFolderWrite: 'helper:folder-write',
  helperAllowOpen: 'helper:allow-open',
  helperNewToken: 'helper:new-token',
  updatesGet: 'updates:get',
  updatesCheck: 'updates:check',
  updatesAuto: 'updates:auto',
} as const;

export interface WelcomeInit {
  language: Language;
  appVersion: string;
  /** The hub last used in remote mode, for the address field. */
  remoteUrl: string | null;
  recent: string[];
  /** Whether this build can run the hub itself (ADR 0009 local mode). */
  localAvailable: boolean;
  /** Opened from a `corehub://connect` link: show the remote form with this address. */
  prefill: string | null;
  /** Why the first-run screen is back (the local hub stopped, say), or null. */
  notice: WelcomeError | null;
}

/** An error the first-run screen shows: a catalogue key and its parameters. */
export interface WelcomeError {
  key: string;
  params?: Record<string, string>;
}

export type WelcomeResult = { ok: true } | { ok: false; error: WelcomeError };

/** Hermes's official installer, as the first-run screen shows it before running it. */
export interface HermesMissing {
  command: string;
  docs: string;
}

export type LocalResult =
  { ok: true } | { ok: false; error: WelcomeError | null; hermesMissing?: HermesMissing };

export interface WelcomeApi {
  init(): Promise<WelcomeInit>;
  connect(url: string): Promise<WelcomeResult>;
  pair(text: string): Promise<WelcomeResult>;
  /** Local mode; without Hermes on the computer it asks first, unless told to go on. */
  chooseLocal(options?: { withoutHermes?: boolean }): Promise<LocalResult>;
  /** Runs Hermes's own installer, then starts local mode. */
  installHermes(): Promise<LocalResult>;
  onInstallLog(listener: (line: string) => void): () => void;
  setLanguage(language: Language): Promise<void>;
  onPrefill(listener: (url: string) => void): () => void;
}
