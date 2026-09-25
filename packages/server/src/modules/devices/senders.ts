/**
 * The push senders: one per service, all with the same `send(token, message)`.
 *
 * - **Web Push** (`webpush.ts` does the cryptography): browsers and the desktop app; the
 *   hub's own VAPID keys, no account anywhere.
 * - **FCM HTTP v1**: Android. A Firebase service account signs a short JWT, exchanged at
 *   Google's token endpoint for an access token that is reused until shortly before it ends.
 * - **APNs** over HTTP/2 with a provider token (ES256, key id + team id), reused for 50
 *   minutes: Apple refuses one older than an hour and one renewed too often.
 *
 * Every base URL is a parameter, so the tests talk to fakes on 127.0.0.1 and nothing here
 * ever reaches a real service from a test. A sender never throws for a delivery that
 * failed: it answers what the service said, and whether the token is gone for good
 * (`gone`), in which case the caller forgets it.
 */
import http2 from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';
import {
  encryptPayload,
  parseSubscription,
  signEs256Jwt,
  vapidAuthorization,
  type VapidKeys,
} from './webpush.js';

export type PushProvider = 'webpush' | 'fcm' | 'apns';
export const PUSH_PROVIDERS: readonly PushProvider[] = ['webpush', 'fcm', 'apns'];

/** What is pushed: a notice already written to the inbox, in the recipient's words. */
export interface PushMessage {
  noticeId: string | null;
  /** The contract's `NoticeKind`. */
  kind: string;
  title: string;
  body: string | null;
  profile: string | null;
  resource: { kind: string; id: string } | null;
  /** An approval waiting: delivered at high priority. */
  urgent: boolean;
  /** The device's language, for the relay's generic private-push title (`relay.ts`). */
  locale?: string | null;
}

export interface PushOutcome {
  ok: boolean;
  /** The service's id for the message (FCM `name`, APNs `apns-id`), for support questions. */
  providerRef: string | null;
  error: string | null;
  /** The token will never work again (unsubscribed, uninstalled): forget it. */
  gone: boolean;
}

export interface PushSender {
  readonly provider: PushProvider;
  send(token: string, message: PushMessage): Promise<PushOutcome>;
  close?(): void;
}

const failed = (error: string, gone = false): PushOutcome => ({
  ok: false,
  providerRef: null,
  error,
  gone,
});

/**
 * The one JSON body every client reads, whatever carried it. Kept small: a push service
 * limits the payload (4 KB), and the notice itself is one `notify.listNotices` away.
 */
export function pushPayload(message: PushMessage): Record<string, unknown> {
  return {
    type: 'notice',
    notice_id: message.noticeId,
    kind: message.kind,
    title: message.title,
    body: message.body,
    profile: message.profile,
    resource: message.resource,
  };
}

const clip = (text: string | null, max: number): string | null =>
  text === null ? null : text.length > max ? `${text.slice(0, max - 1)}…` : text;

// ------------------------------------------------------------------- Web Push

export interface WebPushOptions {
  keys: VapidKeys;
  subject: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Checks the endpoint's address before anything is sent (SSRF; notify's rule). */
  checkEndpoint?: (endpoint: string) => Promise<string | null>;
}

export function webPushSender(options: WebPushOptions): PushSender {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  return {
    provider: 'webpush',
    async send(token, message) {
      const subscription = parseSubscription(token);
      if (!subscription) return failed('not a Web Push subscription', true);
      const refused = await options.checkEndpoint?.(subscription.endpoint);
      if (refused) return failed(refused);
      const payload = pushPayload({
        ...message,
        title: clip(message.title, 200) ?? '',
        body: clip(message.body, 1000),
      });
      const body = encryptPayload(subscription, Buffer.from(JSON.stringify(payload)));
      let response: Response;
      try {
        response = await fetchImpl(subscription.endpoint, {
          method: 'POST',
          headers: {
            authorization: vapidAuthorization(
              subscription.endpoint,
              options.keys,
              options.subject,
              now(),
            ),
            'content-encoding': 'aes128gcm',
            'content-type': 'application/octet-stream',
            ttl: String(24 * 60 * 60),
            urgency: message.urgent ? 'high' : 'normal',
            ...(message.noticeId ? { topic: message.noticeId.slice(-32) } : {}),
          },
          body: new Uint8Array(body),
          redirect: 'error',
        });
      } catch (error) {
        return failed(`Web Push: ${(error as Error).message}`);
      }
      if (response.ok) {
        return {
          ok: true,
          providerRef: response.headers.get('location'),
          error: null,
          gone: false,
        };
      }
      const text = (await response.text().catch(() => '')).slice(0, 200);
      // 404/410: the subscription expired or was unsubscribed (RFC 8030 §7.3).
      const gone = response.status === 404 || response.status === 410;
      return failed(`Web Push: ${response.status}${text ? ` ${text}` : ''}`, gone);
    },
  };
}

// ------------------------------------------------------------------------ FCM

export interface FcmCredentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

/** Reads a Firebase service-account JSON; throws a sentence naming what is missing. */
export function parseServiceAccount(json: string): FcmCredentials {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new Error('the service account is not JSON');
  }
  const missing = ['project_id', 'client_email', 'private_key'].filter(
    (key) => typeof parsed[key] !== 'string' || !(parsed[key] as string).trim(),
  );
  if (missing.length > 0) {
    throw new Error(`the service account has no ${missing.join(', ')}`);
  }
  try {
    createPrivateKey(parsed.private_key as string);
  } catch {
    throw new Error('the service account private_key is not a PEM key');
  }
  return {
    projectId: parsed.project_id as string,
    clientEmail: parsed.client_email as string,
    privateKey: parsed.private_key as string,
    tokenUri:
      typeof parsed.token_uri === 'string' && parsed.token_uri
        ? parsed.token_uri
        : 'https://oauth2.googleapis.com/token',
  };
}

export interface FcmOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** `https://fcm.googleapis.com` unless a test says otherwise. */
  baseUrl?: string;
}

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

export function fcmSender(credentials: FcmCredentials, options: FcmOptions = {}): PushSender {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const baseUrl = options.baseUrl ?? 'https://fcm.googleapis.com';
  let access: { token: string; until: number } | null = null;

  async function accessToken(): Promise<string> {
    if (access && access.until > now() + 60_000) return access.token;
    const iat = Math.floor(now() / 1000);
    const input = `${Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString(
      'base64url',
    )}.${Buffer.from(
      JSON.stringify({
        iss: credentials.clientEmail,
        scope: FCM_SCOPE,
        aud: credentials.tokenUri,
        iat,
        exp: iat + 3600,
      }),
    ).toString('base64url')}`;
    const signature = sign('sha256', Buffer.from(input), credentials.privateKey).toString(
      'base64url',
    );
    const response = await fetchImpl(credentials.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${input}.${signature}`,
      }).toString(),
    });
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!response.ok || !body.access_token) {
      throw new Error(
        `FCM sign-in: ${response.status} ${body.error_description ?? body.error ?? ''}`.trim(),
      );
    }
    access = { token: body.access_token, until: now() + (body.expires_in ?? 3600) * 1000 };
    return access.token;
  }

  function messageFor(token: string, message: PushMessage): Record<string, unknown> {
    // FCM data values must be strings.
    const data: Record<string, string> = { type: 'notice', kind: message.kind };
    if (message.noticeId) data.notice_id = message.noticeId;
    if (message.profile) data.profile = message.profile;
    if (message.resource) {
      data.resource_kind = message.resource.kind;
      data.resource_id = message.resource.id;
    }
    return {
      message: {
        token,
        notification: {
          title: clip(message.title, 200),
          ...(message.body ? { body: clip(message.body, 1000) } : {}),
        },
        data,
        android: {
          priority: message.urgent ? 'high' : 'normal',
          notification: {
            channel_id: 'notices',
            ...(message.noticeId ? { tag: message.noticeId } : {}),
          },
        },
      },
    };
  }

  return {
    provider: 'fcm',
    async send(token, message) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let bearer: string;
        try {
          bearer = await accessToken();
        } catch (error) {
          return failed((error as Error).message);
        }
        let response: Response;
        try {
          response = await fetchImpl(
            `${baseUrl}/v1/projects/${encodeURIComponent(credentials.projectId)}/messages:send`,
            {
              method: 'POST',
              headers: {
                authorization: `Bearer ${bearer}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify(messageFor(token, message)),
            },
          );
        } catch (error) {
          return failed(`FCM: ${(error as Error).message}`);
        }
        const body = (await response.json().catch(() => ({}))) as {
          name?: string;
          error?: {
            status?: string;
            message?: string;
            details?: Array<{ errorCode?: string }>;
          };
        };
        if (response.ok)
          return { ok: true, providerRef: body.name ?? null, error: null, gone: false };
        if (response.status === 401 && attempt === 0) {
          access = null;
          continue;
        }
        const code =
          body.error?.details?.find((detail) => detail.errorCode)?.errorCode ??
          body.error?.status ??
          '';
        // `UNREGISTERED`: the app was uninstalled or the token deleted. `INVALID_ARGUMENT` is
        // a dead token only when FCM says the token itself is not valid — it also answers a
        // message the hub built wrong, and forgetting a good token over that would be worse.
        // `SENDER_ID_MISMATCH` is the hub's own settings (another Firebase project): kept.
        const gone =
          response.status === 404 ||
          code === 'UNREGISTERED' ||
          (code === 'INVALID_ARGUMENT' && /registration token/i.test(body.error?.message ?? ''));
        return failed(
          `FCM: ${code || response.status}${body.error?.message ? ` ${body.error.message}` : ''}`,
          gone,
        );
      }
      return failed('FCM: unauthorized');
    },
  };
}

// ----------------------------------------------------------------------- APNs

export interface ApnsCredentials {
  keyId: string;
  teamId: string;
  bundleId: string;
  /** The `.p8` key (PEM). */
  privateKey: string;
  environment: 'production' | 'sandbox';
}

export interface ApnsOptions {
  now?: () => number;
  /** `https://api.push.apple.com` (or the sandbox) unless a test says otherwise. */
  origin?: string;
}

const PROVIDER_TOKEN_MS = 50 * 60_000;

export function apnsSender(credentials: ApnsCredentials, options: ApnsOptions = {}): PushSender {
  const now = options.now ?? Date.now;
  const origin =
    options.origin ??
    (credentials.environment === 'sandbox'
      ? 'https://api.sandbox.push.apple.com'
      : 'https://api.push.apple.com');
  const key = createPrivateKey(credentials.privateKey);
  let providerToken: { jwt: string; at: number } | null = null;
  let session: http2.ClientHttp2Session | null = null;

  const jwt = (): string => {
    if (providerToken && now() - providerToken.at < PROVIDER_TOKEN_MS) return providerToken.jwt;
    const at = now();
    providerToken = {
      at,
      jwt: signEs256Jwt(
        { alg: 'ES256', kid: credentials.keyId },
        { iss: credentials.teamId, iat: Math.floor(at / 1000) },
        key,
      ),
    };
    return providerToken.jwt;
  };

  const connect = (): http2.ClientHttp2Session => {
    if (session && !session.closed && !session.destroyed) return session;
    const next = http2.connect(origin);
    next.on('error', () => {
      if (session === next) session = null;
    });
    next.on('goaway', () => {
      if (session === next) session = null;
    });
    next.unref();
    session = next;
    return next;
  };

  function request(
    token: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; id: string | null; reason: string | null }> {
    return new Promise((resolve, reject) => {
      let stream: http2.ClientHttp2Stream;
      try {
        stream = connect().request({
          ':method': 'POST',
          ':path': `/3/device/${token}`,
          ...headers,
        });
      } catch (error) {
        reject(error as Error);
        return;
      }
      let status = 0;
      let id: string | null = null;
      const chunks: Buffer[] = [];
      stream.setTimeout(15_000, () => stream.close(http2.constants.NGHTTP2_CANCEL));
      stream.on('response', (response) => {
        status = Number(response[':status'] ?? 0);
        const header = response['apns-id'];
        id = typeof header === 'string' ? header : null;
      });
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('close', () => {
        if (status === 0) {
          reject(new Error('no answer'));
          return;
        }
        let reason: string | null = null;
        if (chunks.length > 0) {
          try {
            reason =
              (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { reason?: string }).reason ??
              null;
          } catch {
            reason = null;
          }
        }
        resolve({ status, id, reason });
      });
      stream.end(body);
    });
  }

  return {
    provider: 'apns',
    async send(token, message) {
      if (!/^[0-9a-f]{32,200}$/i.test(token)) return failed('not an APNs device token', true);
      const payload = {
        aps: {
          alert: {
            title: clip(message.title, 200),
            ...(message.body ? { body: clip(message.body, 1000) } : {}),
          },
          sound: 'default',
          ...(message.profile ? { 'thread-id': message.profile } : {}),
          'interruption-level': message.urgent ? 'time-sensitive' : 'active',
        },
        ...pushPayload(message),
      };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let answer: { status: number; id: string | null; reason: string | null };
        try {
          answer = await request(token, JSON.stringify(payload), {
            authorization: `bearer ${jwt()}`,
            'apns-topic': credentials.bundleId,
            'apns-push-type': 'alert',
            'apns-priority': '10',
            'apns-expiration': String(Math.floor(now() / 1000) + 24 * 60 * 60),
            ...(message.noticeId ? { 'apns-collapse-id': message.noticeId } : {}),
            'content-type': 'application/json',
          });
        } catch (error) {
          session = null;
          return failed(`APNs: ${(error as Error).message}`);
        }
        if (answer.status === 200) {
          return { ok: true, providerRef: answer.id, error: null, gone: false };
        }
        if (answer.status === 403 && answer.reason === 'ExpiredProviderToken' && attempt === 0) {
          providerToken = null;
          continue;
        }
        // Only Apple's "this token is dead" forgets it. `BadDeviceToken` and
        // `DeviceTokenNotForTopic` also follow from a wrong environment or bundle id in the
        // hub's own settings, and forgetting every phone's token over that would be worse.
        const gone = answer.status === 410 || answer.reason === 'Unregistered';
        return failed(`APNs: ${answer.reason ?? 'error'} (${answer.status})`, gone);
      }
      return failed('APNs: the provider token was refused');
    },
    close() {
      session?.close();
      session = null;
    },
  };
}
