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
}

/** An error the first-run screen shows: a catalogue key and its parameters. */
export interface WelcomeError {
  key: string;
  params?: Record<string, string>;
}

export type WelcomeResult = { ok: true } | { ok: false; error: WelcomeError };

export interface WelcomeApi {
  init(): Promise<WelcomeInit>;
  connect(url: string): Promise<WelcomeResult>;
  pair(text: string): Promise<WelcomeResult>;
  chooseLocal(): Promise<WelcomeResult>;
  setLanguage(language: Language): Promise<void>;
  onPrefill(listener: (url: string) => void): () => void;
}
