/**
 * The Worker's bindings. Secrets are set by the owner with `wrangler secret put` (README);
 * the limits are plain `[vars]` in wrangler.toml. The D1 types are the few methods the relay
 * calls, restated so the package needs no Cloudflare type package; the real binding has more.
 */

export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: { changes?: number } & Record<string, unknown>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export interface Env {
  DB: D1Database;

  // --- Secrets (wrangler secret put). None of them is ever logged or answered.
  /** The APNs auth key (`AuthKey_<id>.p8`), PEM. */
  APNS_KEY_P8?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  /** The iOS app's bundle id, the `apns-topic` (`com.twuijri.corehub`). */
  APNS_BUNDLE_ID?: string;
  /** `production` (TestFlight and the App Store) or `sandbox` (Xcode builds). */
  APNS_ENV?: string;
  /** The Firebase service-account JSON. */
  FCM_SERVICE_ACCOUNT_JSON?: string;
  /** Derives every hub's secret: a hub secret is never stored, only this key and a salt. */
  HUB_SECRET_KEY?: string;
  /** The admin endpoints answer only `Authorization: Bearer <ADMIN_TOKEN>`; unset = no admin. */
  ADMIN_TOKEN?: string;

  // --- Vars (wrangler.toml). Strings, as Cloudflare passes them.
  LIMIT_PER_MINUTE?: string;
  LIMIT_PER_DAY?: string;
  BINDS_PER_MINUTE?: string;
  REGISTRATIONS_PER_IP_HOUR?: string;
  REGISTRATIONS_PER_DAY?: string;
  /** Days a binding may go unused before another hub may take the token. */
  BINDING_IDLE_DAYS?: string;
}

export function numberVar(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
