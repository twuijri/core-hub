/**
 * Delivery to Apple and Google with the owner's keys, which live only in the Worker's secrets.
 *
 * - **APNs**: `POST https://api.push.apple.com/3/device/<token>` with an ES256 provider token
 *   (key id + team id), reused for 50 minutes — Apple refuses one older than an hour and one
 *   renewed too often. APNs speaks HTTP/2 only; a deployed Worker's `fetch` negotiates HTTP/2
 *   with it (ADR 0024 §APNs). `wrangler dev` on some machines does not, so a local run is no
 *   proof either way.
 * - **FCM HTTP v1**: an RS256 assertion from the service account, exchanged at Google's token
 *   endpoint for an access token that is reused until a minute before it ends.
 *
 * Both caches live in the isolate (a module variable): a cold isolate signs again, which is
 * cheap. A delivery never throws: it answers `sent`, `failed`, or `gone` — the service says
 * this token will never work again, and the relay forgets its binding.
 */
import { importEs256Key, importRs256Key, signJwt } from './crypto.js';
import type { Env } from './env.js';

export type Platform = 'apns' | 'fcm';
export const PLATFORMS: readonly Platform[] = ['apns', 'fcm'];

/** One notification as a hub asks for it. Nothing here is stored or logged. */
export interface RelayMessage {
  platform: Platform;
  token: string;
  title: string;
  body: string | null;
  /** The app's own keys (`type`, `notice_id`, `kind`, `profile`, `resource`…). */
  data: Record<string, unknown>;
  urgent: boolean;
  collapse_id: string | null;
  thread_id: string | null;
}

export interface Delivery {
  status: 'sent' | 'failed' | 'gone';
  /** The service's id for the message (APNs `apns-id`, FCM `name`). */
  ref: string | null;
  /** A short code or sentence from the service; never the token or the content. */
  error: string | null;
}

export interface DeliverOptions {
  fetchImpl: typeof fetch;
  now: () => number;
  /** Test seams. */
  apnsOrigin?: string;
  fcmOrigin?: string;
}

const failed = (error: string, gone = false): Delivery => ({
  status: gone ? 'gone' : 'failed',
  ref: null,
  error,
});

// ----------------------------------------------------------------------- APNs

const PROVIDER_TOKEN_MS = 50 * 60_000;
let providerToken: { id: string; jwt: string; at: number } | null = null;

export function apnsConfigured(env: Env): boolean {
  return !!(env.APNS_KEY_P8 && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_BUNDLE_ID);
}

async function apnsJwt(env: Env, now: number, fresh = false): Promise<string> {
  const id = `${env.APNS_KEY_ID}:${env.APNS_TEAM_ID}`;
  if (!fresh && providerToken?.id === id && now - providerToken.at < PROVIDER_TOKEN_MS) {
    return providerToken.jwt;
  }
  const key = await importEs256Key(env.APNS_KEY_P8!);
  const jwt = await signJwt(
    { alg: 'ES256', kid: env.APNS_KEY_ID },
    { iss: env.APNS_TEAM_ID, iat: Math.floor(now / 1000) },
    key,
  );
  providerToken = { id, jwt, at: now };
  return jwt;
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

async function sendApns(env: Env, message: RelayMessage, options: DeliverOptions) {
  if (!apnsConfigured(env)) return failed('apns_not_configured');
  if (!/^[0-9a-f]{32,200}$/i.test(message.token)) return failed('not an APNs device token', true);
  const origin =
    options.apnsOrigin ??
    (env.APNS_ENV === 'sandbox'
      ? 'https://api.sandbox.push.apple.com'
      : 'https://api.push.apple.com');
  const payload = {
    ...message.data,
    aps: {
      alert: {
        title: clip(message.title, 200),
        ...(message.body ? { body: clip(message.body, 1000) } : {}),
      },
      sound: 'default',
      ...(message.thread_id ? { 'thread-id': message.thread_id } : {}),
      'interruption-level': message.urgent ? 'time-sensitive' : 'active',
    },
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response;
    try {
      const jwt = await apnsJwt(env, options.now(), attempt > 0);
      response = await options.fetchImpl(`${origin}/3/device/${message.token}`, {
        method: 'POST',
        headers: {
          authorization: `bearer ${jwt}`,
          'apns-topic': env.APNS_BUNDLE_ID!,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-expiration': String(Math.floor(options.now() / 1000) + 24 * 60 * 60),
          ...(message.collapse_id ? { 'apns-collapse-id': message.collapse_id } : {}),
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      return failed(`APNs: ${(error as Error).message}`);
    }
    if (response.status === 200) {
      return { status: 'sent', ref: response.headers.get('apns-id'), error: null } as Delivery;
    }
    const reason =
      ((await response.json().catch(() => ({}))) as { reason?: string }).reason ?? null;
    if (response.status === 403 && reason === 'ExpiredProviderToken' && attempt === 0) continue;
    // Only Apple's "this token is dead" forgets it. `BadDeviceToken` also follows from an
    // Xcode (sandbox) build talking to a production relay, and is kept.
    const gone = response.status === 410 || reason === 'Unregistered';
    return failed(`APNs: ${reason ?? 'error'} (${response.status})`, gone);
  }
  return failed('APNs: the provider token was refused');
}

// ------------------------------------------------------------------------ FCM

interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

let access: { id: string; token: string; until: number } | null = null;

export function fcmConfigured(env: Env): boolean {
  try {
    serviceAccount(env);
    return true;
  } catch {
    return false;
  }
}

function serviceAccount(env: Env): ServiceAccount {
  if (!env.FCM_SERVICE_ACCOUNT_JSON) throw new Error('fcm_not_configured');
  const parsed = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON) as Record<string, unknown>;
  const text = (key: string) => (typeof parsed[key] === 'string' ? (parsed[key] as string) : '');
  if (!text('project_id') || !text('client_email') || !text('private_key')) {
    throw new Error('fcm_not_configured');
  }
  return {
    projectId: text('project_id'),
    clientEmail: text('client_email'),
    privateKey: text('private_key'),
    tokenUri: text('token_uri') || 'https://oauth2.googleapis.com/token',
  };
}

async function fcmAccessToken(
  account: ServiceAccount,
  options: DeliverOptions,
  fresh: boolean,
): Promise<string> {
  const now = options.now();
  if (!fresh && access?.id === account.clientEmail && access.until > now + 60_000) {
    return access.token;
  }
  const iat = Math.floor(now / 1000);
  const assertion = await signJwt(
    { alg: 'RS256', typ: 'JWT' },
    {
      iss: account.clientEmail,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: account.tokenUri,
      iat,
      exp: iat + 3600,
    },
    await importRs256Key(account.privateKey),
  );
  const response = await options.fetchImpl(account.tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!response.ok || !body.access_token) {
    throw new Error(`FCM sign-in: ${response.status} ${body.error ?? ''}`.trim());
  }
  access = {
    id: account.clientEmail,
    token: body.access_token,
    until: now + (body.expires_in ?? 3600) * 1000,
  };
  return access.token;
}

/**
 * FCM data values must be strings: a nested object becomes `<key>_<field>` (`resource` →
 * `resource_kind`, `resource_id`), as the Android app reads it; null is left out.
 */
export function flattenData(data: Record<string, unknown>): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object' && !Array.isArray(value)) {
      for (const [field, inner] of Object.entries(value as Record<string, unknown>)) {
        if (inner !== null && inner !== undefined && typeof inner !== 'object') {
          flat[`${key}_${field}`] = String(inner);
        }
      }
    } else if (typeof value !== 'object') {
      flat[key] = String(value);
    }
  }
  return flat;
}

async function sendFcm(env: Env, message: RelayMessage, options: DeliverOptions) {
  let account: ServiceAccount;
  try {
    account = serviceAccount(env);
  } catch {
    return failed('fcm_not_configured');
  }
  const origin = options.fcmOrigin ?? 'https://fcm.googleapis.com';
  const body = {
    message: {
      token: message.token,
      notification: {
        title: clip(message.title, 200),
        ...(message.body ? { body: clip(message.body, 1000) } : {}),
      },
      data: flattenData(message.data),
      android: {
        priority: message.urgent ? 'high' : 'normal',
        notification: {
          channel_id: 'notices',
          ...(message.collapse_id ? { tag: message.collapse_id } : {}),
        },
      },
    },
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response;
    try {
      const bearer = await fcmAccessToken(account, options, attempt > 0);
      response = await options.fetchImpl(
        `${origin}/v1/projects/${encodeURIComponent(account.projectId)}/messages:send`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
    } catch (error) {
      return failed(`FCM: ${(error as Error).message}`);
    }
    const answer = (await response.json().catch(() => ({}))) as {
      name?: string;
      error?: { status?: string; message?: string; details?: Array<{ errorCode?: string }> };
    };
    if (response.ok) return { status: 'sent', ref: answer.name ?? null, error: null } as Delivery;
    if (response.status === 401 && attempt === 0) continue;
    const code =
      answer.error?.details?.find((detail) => detail.errorCode)?.errorCode ??
      answer.error?.status ??
      '';
    // `INVALID_ARGUMENT` is a dead token only when FCM says the token itself is invalid; it
    // also answers a message built wrong, and forgetting a good token over that is worse.
    const gone =
      response.status === 404 ||
      code === 'UNREGISTERED' ||
      (code === 'INVALID_ARGUMENT' && /registration token/i.test(answer.error?.message ?? ''));
    return failed(`FCM: ${code || response.status}`, gone);
  }
  return failed('FCM: unauthorized');
}

export function deliver(env: Env, message: RelayMessage, options: DeliverOptions) {
  return message.platform === 'apns'
    ? sendApns(env, message, options)
    : sendFcm(env, message, options);
}

/** Tests only: forget the cached provider and access tokens. */
export function resetDeliveryCaches(): void {
  providerToken = null;
  access = null;
}
