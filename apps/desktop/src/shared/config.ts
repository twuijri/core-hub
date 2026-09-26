/**
 * The desktop app's own settings: which mode, which hub, where the window was.
 *
 * One JSON file in the OS app-data folder (`app.getPath('userData')/desktop.json`, mode 0600).
 * Its only secret is the local helper's token; the web client keeps its sign-ins in its own
 * storage partition, one per hub. A person can read or delete it by hand. Anything unreadable falls back to the default
 * for that field instead of failing the launch: a settings file is never a reason the app
 * does not open.
 */
import { defaultHelper, parseHelper, randomToken, type HelperConfig } from './helper.js';
import { normalizeHubUrl } from './hub-url.js';
import { DEFAULT_RELAY, parseRelayConfig, type RelayConfig } from './relay.js';

export type Mode = 'remote' | 'local';
export type Language = 'ar' | 'en';

export interface WindowBounds {
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  maximized: boolean;
}

/**
 * This computer as a device of one hub (ADR 0025): the device token pairing gave it, sealed by
 * the OS keychain where there is one, so the main process can keep its own connection.
 */
export interface DeviceLinkConfig {
  deviceId: string;
  userId: string;
  /** Sealed (`sealText`); never shown, never sent anywhere but that hub. */
  token: string;
  /** The person's profiles when it paired, for catching up on missed requests. */
  profiles: string[];
}

export interface DesktopConfig {
  version: 1;
  /** `null` until the person picks one on the first-run screen. */
  mode: Mode | null;
  remote: {
    /** The hub remote mode connects to (an origin). */
    url: string | null;
    /** Hubs used before, newest first, for the first-run screen. */
    recent: string[];
  };
  /**
   * The loopback port the app serves the web client on. Kept, because the web client's
   * storage (its sign-in) belongs to the origin, and the origin includes the port.
   */
  port: number | null;
  /** `null` follows the OS language. */
  language: Language | null;
  window: WindowBounds | null;
  /** Stable id this computer presents when it pairs (`DeviceRegistration.device_key`). */
  deviceKey: string;
  /** Closing the window keeps the app in the tray (default on, where a tray exists). */
  closeToTray: boolean;
  /** The local helper (MCP): off, no folders, until the person says otherwise. */
  helper: HelperConfig;
  /** Device connections, by hub origin: this computer paired with that hub (ADR 0025). */
  links: Record<string, DeviceLinkConfig>;
  /** The update check (ADR 0023): a notice and a link, never an install. */
  updates: {
    /** Look once a day on its own (a request to GitHub's API, nothing else). */
    auto: boolean;
    lastCheckedAt: string | null;
    /** The version the OS was last told about, so it is said once. */
    notified: string | null;
  };
  /**
   * The port the hub of local mode listened on last, asked for again at the next start so a
   * way in pointed at it keeps working (DECISIONS §92).
   */
  localHubPort: number | null;
  /** The way in from outside for that hub (`shared/relay.ts`); its token sealed. */
  relay: RelayConfig;
  /** macOS: the person was asked about the old `corehub.app` (asked once, ever). */
  legacyAppAsked: boolean;
}

export const RECENT_LIMIT = 5;
export const DEFAULT_WINDOW = { width: 1280, height: 820 } as const;
export const MIN_WINDOW = { width: 420, height: 560 } as const;

export function defaultConfig(
  makeId: () => string,
  makeToken: () => string = randomToken,
): DesktopConfig {
  return {
    version: 1,
    mode: null,
    remote: { url: null, recent: [] },
    port: null,
    language: null,
    window: null,
    deviceKey: makeId(),
    closeToTray: true,
    helper: defaultHelper(makeToken),
    links: {},
    updates: { auto: true, lastCheckedAt: null, notified: null },
    localHubPort: null,
    relay: { ...DEFAULT_RELAY },
    legacyAppAsked: false,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function origin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const result = normalizeHubUrl(value);
  return result.ok ? result.origin : null;
}

function bounds(value: unknown): WindowBounds | null {
  if (!isRecord(value)) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
  const width = num(value.width);
  const height = num(value.height);
  if (width === null || height === null) return null;
  return {
    x: num(value.x),
    y: num(value.y),
    width: Math.max(MIN_WINDOW.width, width),
    height: Math.max(MIN_WINDOW.height, height),
    maximized: value.maximized === true,
  };
}

/** Reads whatever is in the file, keeping each valid field and defaulting the rest. */
export function parseConfig(
  raw: unknown,
  makeId: () => string,
  makeToken: () => string = randomToken,
): DesktopConfig {
  const base = defaultConfig(makeId, makeToken);
  if (!isRecord(raw)) return base;
  const remote = isRecord(raw.remote) ? raw.remote : {};
  const recent = Array.isArray(remote.recent)
    ? [...new Set(remote.recent.map(origin).filter((v): v is string => v !== null))].slice(
        0,
        RECENT_LIMIT,
      )
    : [];
  const port = raw.port;
  const userPort = (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 65_535
      ? value
      : null;
  return {
    version: 1,
    mode: raw.mode === 'remote' || raw.mode === 'local' ? raw.mode : null,
    remote: { url: origin(remote.url), recent },
    port: userPort(port),
    language: raw.language === 'ar' || raw.language === 'en' ? raw.language : null,
    window: bounds(raw.window),
    deviceKey:
      typeof raw.deviceKey === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(raw.deviceKey)
        ? raw.deviceKey
        : base.deviceKey,
    closeToTray: typeof raw.closeToTray === 'boolean' ? raw.closeToTray : base.closeToTray,
    helper: parseHelper(raw.helper, () => base.helper.token),
    links: parseLinks(raw.links),
    updates: parseUpdates(raw.updates),
    localHubPort: userPort(raw.localHubPort),
    relay: parseRelayConfig(raw.relay),
    legacyAppAsked: raw.legacyAppAsked === true,
  };
}

function parseLinks(raw: unknown): Record<string, DeviceLinkConfig> {
  if (!isRecord(raw)) return {};
  const out: Record<string, DeviceLinkConfig> = {};
  for (const [key, value] of Object.entries(raw)) {
    const hub = origin(key);
    if (!hub || !isRecord(value)) continue;
    const id = /^[0-9A-HJKMNP-TV-Z]{26}$/;
    if (
      typeof value.deviceId !== 'string' ||
      !id.test(value.deviceId) ||
      typeof value.userId !== 'string' ||
      typeof value.token !== 'string' ||
      value.token.length === 0
    )
      continue;
    out[hub] = {
      deviceId: value.deviceId,
      userId: value.userId,
      token: value.token,
      profiles: Array.isArray(value.profiles)
        ? value.profiles.filter((p): p is string => typeof p === 'string').slice(0, 100)
        : [],
    };
  }
  return out;
}

function parseUpdates(raw: unknown): DesktopConfig['updates'] {
  const r = isRecord(raw) ? raw : {};
  const text = (v: unknown) => (typeof v === 'string' && v.length <= 64 ? v : null);
  return {
    auto: typeof r.auto === 'boolean' ? r.auto : true,
    lastCheckedAt: text(r.lastCheckedAt),
    notified: text(r.notified),
  };
}

/** Remote mode against `url`: remembered first in the recent list. */
export function withRemote(config: DesktopConfig, url: string): DesktopConfig {
  return {
    ...config,
    mode: 'remote',
    remote: {
      url,
      recent: [url, ...config.remote.recent.filter((u) => u !== url)].slice(0, RECENT_LIMIT),
    },
  };
}

/** The OS language, reduced to the two the app speaks. Arabic for any `ar-*` locale. */
export function languageFromLocale(locale: string | null | undefined): Language {
  return (locale ?? '').toLowerCase().startsWith('ar') ? 'ar' : 'en';
}
