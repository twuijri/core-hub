/**
 * The relay's HTTP API (ADR 0024). Every route but `/v1/health`, `POST /v1/hubs` and the
 * admin routes is signed by a hub:
 *
 *   x-corehub-hub:        the hub id
 *   x-corehub-timestamp:  unix seconds (±5 minutes of the relay's clock)
 *   x-corehub-nonce:      16–64 url-safe characters, never reused
 *   x-corehub-signature:  hex HMAC-SHA256(secret, SIGNING_PREFIX \n METHOD \n PATH \n
 *                         TIMESTAMP \n NONCE \n hex SHA-256(body))
 *
 * A token is bound to one hub; a hub pushes only to its own tokens. Counters only are
 * logged; no token, title, body or data is stored or logged.
 */
import {
  fromBase64url,
  hmacBase64url,
  hmacHex,
  hmacVerifyHex,
  randomToken,
  sameSecret,
  sha256Hex,
  utf8,
} from './crypto.js';
import {
  PLATFORMS,
  apnsConfigured,
  deliver,
  fcmConfigured,
  type DeliverOptions,
  type Delivery,
  type Platform,
  type RelayMessage,
} from './deliver.js';
import { numberVar, type D1Database, type Env } from './env.js';

export const SIGNING_PREFIX = 'corehub-relay-v1';
export const PROOF_PREFIX = 'corehub-push-bind-v1';
const CLOCK_SKEW_S = 300;
const PROOF_SKEW_S = 600;
const MAX_BODY = 256 * 1024;
export const MAX_MESSAGES = 40;
const MAX_SYNC = 5000;
const MAX_DATA_BYTES = 2048;

export interface RelayOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  apnsOrigin?: string;
  fcmOrigin?: string;
  log?: (line: Record<string, unknown>) => void;
}

interface HubRow {
  id: string;
  salt: string;
  created_at: number;
  blocked: number;
  blocked_reason: string | null;
  limit_minute: number | null;
  limit_day: number | null;
}

interface BindingRow {
  token_hash: string;
  platform: string;
  hub_id: string;
  device_key: string | null;
  proof_at: number | null;
  bound_at: number;
  seen_at: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

/** The key a token is bound under: the relay never keeps the token itself. */
export function tokenHash(platform: string, token: string): Promise<string> {
  return sha256Hex(`${platform}:${token}`);
}

/** The message a hub signs; exported so the hub side and the tests build the same one. */
export function signingInput(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  bodyHash: string,
): string {
  return [SIGNING_PREFIX, method.toUpperCase(), path, timestamp, nonce, bodyHash].join('\n');
}

/** A hub's secret: derived, never stored, so a copy of D1 alone cannot sign anything. */
export function hubSecret(env: Env, id: string, salt: string): Promise<string> {
  return hmacBase64url(env.HUB_SECRET_KEY!, `hub-secret-v1:${id}:${salt}`);
}

// ----------------------------------------------------------------- validation

function object(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'invalid', `${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function platformOf(value: unknown): Platform {
  if (!PLATFORMS.includes(value as Platform)) {
    throw new HttpError(400, 'invalid', 'platform must be apns or fcm');
  }
  return value as Platform;
}

function tokenOf(platform: Platform, value: unknown): string {
  const ok =
    typeof value === 'string' &&
    (platform === 'apns'
      ? /^[0-9a-f]{32,200}$/i.test(value)
      : value.length > 0 && value.length <= 4096 && !/\s/.test(value));
  if (!ok) throw new HttpError(400, 'invalid', `token is not an ${platform} device token`);
  return value as string;
}

const optionalText = (value: unknown, max: number, what: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max) {
    throw new HttpError(400, 'invalid', `${what} must be a string of at most ${max} characters`);
  }
  return value;
};

function messageOf(value: unknown): RelayMessage {
  const input = object(value, 'a message');
  const platform = platformOf(input.platform);
  const token = tokenOf(platform, input.token);
  const title = input.title;
  if (typeof title !== 'string' || !title.trim() || title.length > 500) {
    throw new HttpError(400, 'invalid', 'title must be 1–500 characters');
  }
  const data = input.data === undefined ? {} : object(input.data, 'data');
  if ('aps' in data) throw new HttpError(400, 'invalid', 'data may not carry aps');
  if (utf8(JSON.stringify(data)).length > MAX_DATA_BYTES) {
    throw new HttpError(400, 'invalid', `data must be at most ${MAX_DATA_BYTES} bytes`);
  }
  return {
    platform,
    token,
    title,
    body: optionalText(input.body, 2000, 'body'),
    data,
    urgent: input.urgent === true,
    collapse_id: optionalText(input.collapse_id, 64, 'collapse_id'),
    thread_id: optionalText(input.thread_id, 64, 'thread_id'),
  };
}

// ------------------------------------------------------------------- counters

/** Adds `by` to a window's counter and answers the new total. */
async function bump(db: D1Database, key: string, by: number, expiresAt: number): Promise<number> {
  const row = await db
    .prepare(
      'INSERT INTO counters (key, count, expires_at) VALUES (?1, ?2, ?3) ' +
        'ON CONFLICT(key) DO UPDATE SET count = count + ?2 RETURNING count',
    )
    .bind(key, by, expiresAt)
    .first<{ count: number }>();
  return row?.count ?? by;
}

async function peek(db: D1Database, key: string): Promise<number> {
  const row = await db
    .prepare('SELECT count FROM counters WHERE key = ?1')
    .bind(key)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

const minuteOf = (now: number) => Math.floor(now / 60_000);
const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

function limitsOf(env: Env, hub: HubRow) {
  return {
    per_minute: hub.limit_minute ?? numberVar(env.LIMIT_PER_MINUTE, 120),
    per_day: hub.limit_day ?? numberVar(env.LIMIT_PER_DAY, 5000),
  };
}

// ----------------------------------------------------------------------- auth

async function authenticate(
  request: Request,
  env: Env,
  path: string,
  body: string,
  now: number,
): Promise<HubRow> {
  const id = request.headers.get('x-corehub-hub') ?? '';
  const timestamp = request.headers.get('x-corehub-timestamp') ?? '';
  const nonce = request.headers.get('x-corehub-nonce') ?? '';
  const signature = request.headers.get('x-corehub-signature') ?? '';
  if (!id || !timestamp || !nonce || !signature) {
    throw new HttpError(401, 'unauthorized', 'the request is not signed');
  }
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(Number(timestamp) - now / 1000) > CLOCK_SKEW_S) {
    throw new HttpError(401, 'stale', 'the timestamp is outside the allowed window');
  }
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) {
    throw new HttpError(401, 'unauthorized', 'the nonce is malformed');
  }
  if (!env.HUB_SECRET_KEY) throw new HttpError(503, 'not_configured', 'the relay has no key');
  const hub = await env.DB.prepare('SELECT * FROM hubs WHERE id = ?1').bind(id).first<HubRow>();
  if (!hub) throw new HttpError(401, 'unknown_hub', 'this hub is not registered');
  const secret = await hubSecret(env, hub.id, hub.salt);
  const input = signingInput(request.method, path, timestamp, nonce, await sha256Hex(body));
  if (!(await hmacVerifyHex(secret, input, signature))) {
    throw new HttpError(401, 'unauthorized', 'the signature does not match');
  }
  if (hub.blocked) {
    throw new HttpError(403, 'blocked', 'this hub is blocked on the relay');
  }
  const fresh = await env.DB.prepare(
    'INSERT OR IGNORE INTO nonces (hub_id, nonce, expires_at) VALUES (?1, ?2, ?3)',
  )
    .bind(hub.id, nonce, now + 2 * CLOCK_SKEW_S * 1000)
    .run();
  if (!fresh.meta.changes) throw new HttpError(401, 'replayed', 'this request was already seen');
  return hub;
}

async function isAdmin(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_TOKEN) return false;
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  return !!match && (await sameSecret(match[1]!, env.ADMIN_TOKEN));
}

// ---------------------------------------------------------------- device proof

interface Proof {
  keyHash: string;
  signedAt: number;
}

/**
 * The app's proof that it holds the device (ADR 0024 §Binding): a P-256 key made once per
 * install signs `PROOF_PREFIX \n platform \n token \n signed_at`. `key` is the raw public
 * point (65 bytes, base64url), `signature` the raw r||s (64 bytes, base64url).
 */
async function proofOf(
  value: unknown,
  platform: Platform,
  token: string,
  now: number,
): Promise<Proof | null> {
  if (value === undefined || value === null) return null;
  const input = object(value, 'proof');
  const bad = () => new HttpError(400, 'invalid_proof', 'the device proof does not verify');
  if (typeof input.key !== 'string' || typeof input.signature !== 'string') throw bad();
  const signedAt = Number(input.signed_at);
  if (!Number.isInteger(signedAt) || Math.abs(signedAt - now / 1000) > PROOF_SKEW_S) throw bad();
  let raw: Uint8Array<ArrayBuffer>;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    raw = fromBase64url(input.key);
    signature = fromBase64url(input.signature);
  } catch {
    throw bad();
  }
  if (raw.length !== 65 || raw[0] !== 4 || signature.length !== 64) throw bad();
  let ok: boolean;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      raw,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signature,
      utf8([PROOF_PREFIX, platform, token, String(signedAt)].join('\n')),
    );
  } catch {
    ok = false;
  }
  if (!ok) throw bad();
  return { keyHash: await sha256Hex(raw), signedAt };
}

// ---------------------------------------------------------------------- routes

async function register(request: Request, env: Env, now: number) {
  if (!env.HUB_SECRET_KEY) throw new HttpError(503, 'not_configured', 'the relay has no key');
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  // The address is kept only as a keyed hash inside an hourly counter.
  const ipKey = await hmacHex(env.HUB_SECRET_KEY, `ip:${ip}`);
  const hour = Math.floor(now / 3_600_000);
  const perIp = await bump(env.DB, `r:${ipKey}:${hour}`, 1, (hour + 1) * 3_600_000);
  const perDay = await bump(env.DB, `R:${dayOf(now)}`, 1, now + 2 * 86_400_000);
  if (
    perIp > numberVar(env.REGISTRATIONS_PER_IP_HOUR, 5) ||
    perDay > numberVar(env.REGISTRATIONS_PER_DAY, 500)
  ) {
    throw new HttpError(429, 'rate_limited', 'too many registrations; try again later', {
      retry_after: 3600,
    });
  }
  const id = `hub_${randomToken(15)}`;
  const salt = randomToken(16);
  await env.DB.prepare('INSERT INTO hubs (id, salt, created_at) VALUES (?1, ?2, ?3)')
    .bind(id, salt, now)
    .run();
  return json(201, { hub_id: id, secret: await hubSecret(env, id, salt) });
}

async function me(env: Env, hub: HubRow, now: number) {
  const limits = limitsOf(env, hub);
  const tokens = await env.DB.prepare('SELECT COUNT(*) AS n FROM bindings WHERE hub_id = ?1')
    .bind(hub.id)
    .first<{ n: number }>();
  return json(200, {
    hub_id: hub.id,
    blocked: false,
    tokens: tokens?.n ?? 0,
    limits,
    used: {
      minute: await peek(env.DB, `m:${hub.id}:${minuteOf(now)}`),
      day: await peek(env.DB, `d:${hub.id}:${dayOf(now)}`),
    },
  });
}

async function bind(env: Env, hub: HubRow, body: Record<string, unknown>, now: number) {
  const minute = minuteOf(now);
  const binds = await bump(env.DB, `b:${hub.id}:${minute}`, 1, (minute + 2) * 60_000);
  if (binds > numberVar(env.BINDS_PER_MINUTE, 60)) {
    throw new HttpError(429, 'rate_limited', 'too many bindings this minute', {
      retry_after: 60,
    });
  }
  const platform = platformOf(body.platform);
  const token = tokenOf(platform, body.token);
  const proof = await proofOf(body.proof, platform, token, now);
  const hash = await tokenHash(platform, token);
  const inserted = await env.DB.prepare(
    'INSERT OR IGNORE INTO bindings (token_hash, platform, hub_id, device_key, proof_at, bound_at, seen_at) ' +
      'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)',
  )
    .bind(hash, platform, hub.id, proof?.keyHash ?? null, proof?.signedAt ?? null, now)
    .run();
  if (inserted.meta.changes) return json(200, { status: 'bound' });

  const existing = await env.DB.prepare('SELECT * FROM bindings WHERE token_hash = ?1')
    .bind(hash)
    .first<BindingRow>();
  if (!existing) return bind(env, hub, body, now); // unbound in between: first come again
  if (existing.hub_id === hub.id) {
    // The same hub again: refresh, and let a proof record (or renew) the device's key.
    const newer = proof && (existing.proof_at === null || proof.signedAt > existing.proof_at);
    await env.DB.prepare(
      'UPDATE bindings SET seen_at = ?2, device_key = ?3, proof_at = ?4 WHERE token_hash = ?1',
    )
      .bind(
        hash,
        now,
        newer ? proof.keyHash : existing.device_key,
        newer ? proof.signedAt : existing.proof_at,
      )
      .run();
    return json(200, { status: 'bound' });
  }
  const idleMs = numberVar(env.BINDING_IDLE_DAYS, 30) * 86_400_000;
  const idle = existing.seen_at < now - idleMs;
  const proven =
    !!proof &&
    existing.device_key !== null &&
    existing.device_key === proof.keyHash &&
    proof.signedAt > (existing.proof_at ?? 0);
  if (!idle && !proven) {
    throw new HttpError(409, 'bound_elsewhere', 'this token is bound to another hub');
  }
  // Conditional on the row not having moved since it was read.
  const moved = await env.DB.prepare(
    'UPDATE bindings SET hub_id = ?2, device_key = ?3, proof_at = ?4, bound_at = ?5, seen_at = ?5 ' +
      'WHERE token_hash = ?1 AND hub_id = ?6',
  )
    .bind(
      hash,
      hub.id,
      proof?.keyHash ?? (idle ? null : existing.device_key),
      proof?.signedAt ?? null,
      now,
      existing.hub_id,
    )
    .run();
  if (!moved.meta.changes) {
    throw new HttpError(409, 'bound_elsewhere', 'this token is bound to another hub');
  }
  return json(200, { status: 'rebound', reason: proven ? 'proof' : 'idle' });
}

async function unbind(env: Env, hub: HubRow, body: Record<string, unknown>) {
  const platform = platformOf(body.platform);
  const token = tokenOf(platform, body.token);
  const result = await env.DB.prepare('DELETE FROM bindings WHERE token_hash = ?1 AND hub_id = ?2')
    .bind(await tokenHash(platform, token), hub.id)
    .run();
  return json(200, { status: result.meta.changes ? 'unbound' : 'not_bound' });
}

/**
 * The hub states every token it still wants (as `tokenHash`es): the relay forgets the rest of
 * its bindings and answers which of the listed ones it does not hold for this hub, so the hub
 * binds those again. This is how a hub's own clean-ups reach the relay.
 */
async function sync(env: Env, hub: HubRow, body: Record<string, unknown>, now: number) {
  const list = body.tokens;
  if (!Array.isArray(list) || list.length > MAX_SYNC) {
    throw new HttpError(400, 'invalid', `tokens must be an array of at most ${MAX_SYNC}`);
  }
  const wanted = new Map<string, Platform>();
  for (const entry of list) {
    const item = object(entry, 'a token');
    const platform = platformOf(item.platform);
    if (typeof item.hash !== 'string' || !/^[0-9a-f]{64}$/.test(item.hash)) {
      throw new HttpError(400, 'invalid', 'hash must be a hex SHA-256');
    }
    wanted.set(item.hash, platform);
  }
  const held = await env.DB.prepare('SELECT token_hash FROM bindings WHERE hub_id = ?1')
    .bind(hub.id)
    .all<{ token_hash: string }>();
  const heldSet = new Set(held.results.map((row) => row.token_hash));
  const stale = [...heldSet].filter((hash) => !wanted.has(hash));
  for (let i = 0; i < stale.length; i += 50) {
    await env.DB.batch(
      stale
        .slice(i, i + 50)
        .map((hash) =>
          env.DB.prepare('DELETE FROM bindings WHERE token_hash = ?1 AND hub_id = ?2').bind(
            hash,
            hub.id,
          ),
        ),
    );
  }
  await env.DB.batch([
    // Refreshed at most once a day per binding: D1 counts every row written.
    env.DB.prepare('UPDATE bindings SET seen_at = ?2 WHERE hub_id = ?1 AND seen_at < ?3').bind(
      hub.id,
      now,
      now - 86_400_000,
    ),
    env.DB.prepare('UPDATE hubs SET last_seen_at = ?2 WHERE id = ?1').bind(hub.id, now),
  ]);
  const missing = [...wanted]
    .filter(([hash]) => !heldSet.has(hash))
    .map(([hash, platform]) => ({ platform, hash }));
  return json(200, { kept: heldSet.size - stale.length, removed: stale.length, missing });
}

async function push(
  env: Env,
  hub: HubRow,
  body: Record<string, unknown>,
  now: number,
  options: DeliverOptions,
  log: (line: Record<string, unknown>) => void,
) {
  const list = body.messages;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_MESSAGES) {
    throw new HttpError(400, 'invalid', `messages must be 1–${MAX_MESSAGES} messages`);
  }
  const messages = list.map(messageOf);
  const limits = limitsOf(env, hub);
  const minute = minuteOf(now);
  const perMinute = await bump(
    env.DB,
    `m:${hub.id}:${minute}`,
    messages.length,
    (minute + 2) * 60_000,
  );
  const perDay = await bump(
    env.DB,
    `d:${hub.id}:${dayOf(now)}`,
    messages.length,
    now + 2 * 86_400_000,
  );
  if (perMinute > limits.per_minute || perDay > limits.per_day) {
    // A refused request does not count: the hub gets its allowance back when the window turns.
    await env.DB.batch([
      env.DB.prepare('UPDATE counters SET count = count - ?2 WHERE key = ?1').bind(
        `m:${hub.id}:${minute}`,
        messages.length,
      ),
      env.DB.prepare('UPDATE counters SET count = count - ?2 WHERE key = ?1').bind(
        `d:${hub.id}:${dayOf(now)}`,
        messages.length,
      ),
    ]);
    const daily = perDay > limits.per_day;
    throw new HttpError(
      429,
      'rate_limited',
      `this hub is over its ${daily ? 'daily' : 'per-minute'} limit`,
      {
        retry_after: daily
          ? Math.ceil((Date.parse(`${dayOf(now)}T00:00:00Z`) + 86_400_000 - now) / 1000)
          : 60,
        limits,
      },
    );
  }
  const hashes = await Promise.all(messages.map((m) => tokenHash(m.platform, m.token)));
  const unique = [...new Set(hashes)];
  const rows = await env.DB.prepare(
    `SELECT * FROM bindings WHERE token_hash IN (${unique.map((_, i) => `?${i + 1}`).join(', ')})`,
  )
    .bind(...unique)
    .all<BindingRow>();
  const bound = new Map(rows.results.map((row) => [row.token_hash, row]));
  const tally = { sent: 0, failed: 0, gone: 0, not_bound: 0 };
  const results = await Promise.all(
    messages.map(
      async (
        message,
        index,
      ): Promise<Delivery | { status: 'not_bound'; ref: null; error: string }> => {
        const hash = hashes[index]!;
        const binding = bound.get(hash);
        if (!binding || binding.hub_id !== hub.id) {
          tally.not_bound += 1;
          return { status: 'not_bound', ref: null, error: 'this token is not bound to this hub' };
        }
        const outcome = await deliver(env, message, options);
        tally[outcome.status] += 1;
        if (outcome.status === 'gone') {
          await env.DB.prepare('DELETE FROM bindings WHERE token_hash = ?1 AND hub_id = ?2')
            .bind(hash, hub.id)
            .run();
        } else if (outcome.status === 'sent' && binding.seen_at < now - 86_400_000) {
          await env.DB.prepare('UPDATE bindings SET seen_at = ?2 WHERE token_hash = ?1')
            .bind(hash, now)
            .run();
        }
        return outcome;
      },
    ),
  );
  log({ evt: 'push', ...tally });
  return json(200, { results });
}

async function admin(
  request: Request,
  env: Env,
  id: string,
  action: string | undefined,
  body: Record<string, unknown>,
) {
  const hub = await env.DB.prepare('SELECT * FROM hubs WHERE id = ?1').bind(id).first<HubRow>();
  if (!hub) throw new HttpError(404, 'not_found', 'no such hub');
  if (request.method === 'GET' && !action) {
    const tokens = await env.DB.prepare('SELECT COUNT(*) AS n FROM bindings WHERE hub_id = ?1')
      .bind(id)
      .first<{ n: number }>();
    return json(200, {
      hub_id: hub.id,
      created_at: new Date(hub.created_at).toISOString(),
      blocked: !!hub.blocked,
      blocked_reason: hub.blocked_reason,
      tokens: tokens?.n ?? 0,
      limits: limitsOf(env, hub),
    });
  }
  if (request.method === 'POST' && (action === 'block' || action === 'unblock')) {
    const reason = action === 'block' ? optionalText(body.reason, 200, 'reason') : null;
    await env.DB.prepare('UPDATE hubs SET blocked = ?2, blocked_reason = ?3 WHERE id = ?1')
      .bind(id, action === 'block' ? 1 : 0, reason)
      .run();
    return json(200, { hub_id: id, blocked: action === 'block' });
  }
  if (request.method === 'PUT' && action === 'limits') {
    const limit = (value: unknown, what: string) => {
      if (value === null || value === undefined) return null;
      if (!Number.isInteger(value) || (value as number) < 1) {
        throw new HttpError(400, 'invalid', `${what} must be a positive whole number or null`);
      }
      return value as number;
    };
    await env.DB.prepare('UPDATE hubs SET limit_minute = ?2, limit_day = ?3 WHERE id = ?1')
      .bind(id, limit(body.per_minute, 'per_minute'), limit(body.per_day, 'per_day'))
      .run();
    return json(200, { hub_id: id });
  }
  throw new HttpError(404, 'not_found', 'no such route');
}

// ---------------------------------------------------------------------- entry

export function createRelay(options: RelayOptions = {}) {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line) => console.log(JSON.stringify(line)));
  const deliverOptions: DeliverOptions = {
    fetchImpl: options.fetchImpl ?? ((input, init) => fetch(input, init)),
    now,
    ...(options.apnsOrigin ? { apnsOrigin: options.apnsOrigin } : {}),
    ...(options.fcmOrigin ? { fcmOrigin: options.fcmOrigin } : {}),
  };

  async function handle(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const at = now();
    const route = `${request.method} ${path}`;
    if (route === 'GET /v1/health') {
      return json(200, {
        ok: true,
        apns: apnsConfigured(env),
        fcm: fcmConfigured(env),
        registration: !!env.HUB_SECRET_KEY,
      });
    }
    const text = request.method === 'GET' ? '' : await request.text();
    if (text.length > MAX_BODY) throw new HttpError(413, 'too_large', 'the body is too large');
    const parse = (): Record<string, unknown> => {
      if (!text) return {};
      try {
        return object(JSON.parse(text), 'the body');
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, 'invalid', 'the body is not JSON');
      }
    };
    if (route === 'POST /v1/hubs') return register(request, env, at);

    const adminRoute =
      /^\/v1\/admin\/hubs\/([A-Za-z0-9_-]{1,64})(?:\/(block|unblock|limits))?$/.exec(path);
    if (adminRoute) {
      if (!(await isAdmin(request, env))) throw new HttpError(404, 'not_found', 'no such route');
      return admin(request, env, adminRoute[1]!, adminRoute[2], parse());
    }

    const signed = [
      'GET /v1/hubs/me',
      'POST /v1/tokens',
      'DELETE /v1/tokens',
      'POST /v1/tokens/sync',
      'POST /v1/push',
    ];
    if (!signed.includes(route)) throw new HttpError(404, 'not_found', 'no such route');
    const hub = await authenticate(request, env, path, text, at);
    const body = parse();
    switch (route) {
      case 'GET /v1/hubs/me':
        return me(env, hub, at);
      case 'POST /v1/tokens':
        return bind(env, hub, body, at);
      case 'DELETE /v1/tokens':
        return unbind(env, hub, body);
      case 'POST /v1/tokens/sync':
        return sync(env, hub, body, at);
      default:
        return push(env, hub, body, at, deliverOptions, log);
    }
  }

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      try {
        return await handle(request, env);
      } catch (error) {
        if (error instanceof HttpError) {
          const retry = error.extra.retry_after;
          return json(
            error.status,
            { error: error.code, message: error.message, ...error.extra },
            typeof retry === 'number' ? { 'retry-after': String(retry) } : {},
          );
        }
        // Never the request, never the stack: a code only.
        log({ evt: 'error', kind: (error as Error).name });
        return json(500, { error: 'internal', message: 'the relay failed' });
      }
    },

    /** The cron: expired counters and nonces go. */
    async scheduled(_controller: unknown, env: Env): Promise<void> {
      const at = now();
      await env.DB.batch([
        env.DB.prepare('DELETE FROM counters WHERE expires_at < ?1').bind(at),
        env.DB.prepare('DELETE FROM nonces WHERE expires_at < ?1').bind(at),
      ]);
    },
  };
}
