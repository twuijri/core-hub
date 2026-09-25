/**
 * A plain Node harness for the Worker: D1 is played by `node:sqlite` with the real migration,
 * APNs and FCM by a recording `fetch`, and every key is generated here (no real key exists in
 * this repository). The Worker code itself only uses web APIs, so it runs unchanged.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { D1Database, D1PreparedStatement, D1Result, Env } from '../src/env.js';
import { createRelay, signingInput } from '../src/relay.js';
import { hmacHex, sha256Hex } from '../src/crypto.js';

const MIGRATION = fileURLToPath(new URL('../migrations/0001_init.sql', import.meta.url));

export function fakeD1(): D1Database & { raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec(readFileSync(MIGRATION, 'utf8'));
  const statement = (query: string, values: unknown[] = []): D1PreparedStatement => {
    const run = () => {
      const prepared = raw.prepare(query);
      return { prepared, args: values as SQLInputValue[] };
    };
    const result = <T>(rows: T[], changes = 0): D1Result<T> => ({
      results: rows,
      success: true,
      meta: { changes },
    });
    return {
      bind: (...next) => statement(query, next),
      async first<T>() {
        const { prepared, args } = run();
        return ((prepared.get(...args) as T | undefined) ?? null) as T | null;
      },
      async all<T>() {
        const { prepared, args } = run();
        return result(prepared.all(...args) as T[]);
      },
      async run() {
        const { prepared, args } = run();
        const info = prepared.run(...args);
        return result([], Number(info.changes));
      },
    };
  };
  return {
    raw,
    prepare: (query) => statement(query),
    async batch(statements) {
      const out: D1Result[] = [];
      for (const item of statements) out.push(await item.run());
      return out;
    },
  };
}

export interface Keys {
  apnsPem: string;
  apnsPublic: KeyObject;
  serviceAccount: string;
  fcmPublic: KeyObject;
}

export function makeKeys(): Keys {
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    apnsPem: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    apnsPublic: ec.publicKey,
    serviceAccount: JSON.stringify({
      type: 'service_account',
      project_id: 'corehub-test',
      client_email: 'relay@corehub-test.iam.gserviceaccount.com',
      private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      token_uri: 'https://oauth.test/token',
    }),
    fcmPublic: rsa.publicKey,
  };
}

/** Verifies a compact JWS with a public key; answers the header and claims when it holds. */
export function verifyJwt(
  jwt: string,
  key: KeyObject,
): { header: Record<string, unknown>; claims: Record<string, unknown> } | null {
  const [header, claims, signature] = jwt.split('.');
  if (!header || !claims || !signature) return null;
  const decoded = JSON.parse(Buffer.from(header, 'base64url').toString()) as { alg: string };
  const ok = verify(
    'sha256',
    Buffer.from(`${header}.${claims}`),
    decoded.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key,
    Buffer.from(signature, 'base64url'),
  );
  if (!ok) return null;
  return {
    header: decoded as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString()) as Record<string, unknown>,
  };
}

export interface Sent {
  service: 'apns' | 'fcm' | 'oauth';
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Apple and Google as one `fetch`. `answers` maps a device token to the status (and reason
 * or FCM error) the service gives it; anything else is delivered.
 */
export function fakeServices(keys: Keys) {
  const sent: Sent[] = [];
  const answers = new Map<string, { status: number; reason?: string; fcm?: unknown }>();
  let oauthCalls = 0;
  let fcmUnauthorizedOnce = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = String(init?.body ?? '');
    if (url === 'https://oauth.test/token') {
      oauthCalls += 1;
      sent.push({ service: 'oauth', url, headers, body });
      const assertion = new URLSearchParams(body).get('assertion') ?? '';
      if (!verifyJwt(assertion, keys.fcmPublic)) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      return Response.json({ access_token: `ya29.test-${oauthCalls}`, expires_in: 3600 });
    }
    if (url.startsWith('https://apns.test/3/device/')) {
      sent.push({ service: 'apns', url, headers, body });
      const jwt = (headers.authorization ?? '').replace(/^bearer /, '');
      if (!verifyJwt(jwt, keys.apnsPublic)) {
        return Response.json({ reason: 'InvalidProviderToken' }, { status: 403 });
      }
      const token = url.slice('https://apns.test/3/device/'.length);
      const answer = answers.get(token);
      if (answer) return Response.json({ reason: answer.reason }, { status: answer.status });
      return new Response(null, { status: 200, headers: { 'apns-id': 'apns-id-1' } });
    }
    if (url.startsWith('https://fcm.test/v1/projects/corehub-test/messages:send')) {
      sent.push({ service: 'fcm', url, headers, body });
      if (fcmUnauthorizedOnce) {
        fcmUnauthorizedOnce = false;
        return Response.json({ error: { status: 'UNAUTHENTICATED' } }, { status: 401 });
      }
      const token = (JSON.parse(body) as { message: { token: string } }).message.token;
      const answer = answers.get(token);
      if (answer) return Response.json(answer.fcm ?? {}, { status: answer.status });
      return Response.json({ name: 'projects/corehub-test/messages/1' });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return {
    fetchImpl,
    sent,
    answers,
    oauthCalls: () => oauthCalls,
    unauthorizeFcmOnce() {
      fcmUnauthorizedOnce = true;
    },
  };
}

export const APNS_TOKEN = 'a'.repeat(64);
export const APNS_TOKEN_2 = 'b'.repeat(64);
export const FCM_TOKEN = 'fcm-token:APA91b-test-1';

export interface Harness {
  env: Env;
  db: ReturnType<typeof fakeD1>;
  services: ReturnType<typeof fakeServices>;
  keys: Keys;
  logs: Array<Record<string, unknown>>;
  clock: { now: number };
  relay: ReturnType<typeof createRelay>;
  call(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response>;
  register(ip?: string): Promise<Hub>;
}

export interface Hub {
  id: string;
  secret: string;
  signed(
    method: string,
    path: string,
    body?: unknown,
    overrides?: { timestamp?: string; nonce?: string; signature?: string; rawBody?: string },
  ): Promise<Response>;
}

let nonceCounter = 0;

/** `vars` overrides the test bindings; `undefined` removes one (a secret the owner has not set). */
export function harness(
  vars: { [K in Exclude<keyof Env, 'DB'>]?: string | undefined } = {},
): Harness {
  const keys = makeKeys();
  const db = fakeD1();
  const services = fakeServices(keys);
  const logs: Array<Record<string, unknown>> = [];
  const clock = { now: Date.parse('2026-09-25T10:00:00Z') };
  const env: Env = {
    DB: db,
    APNS_KEY_P8: keys.apnsPem,
    APNS_KEY_ID: 'KEYID12345',
    APNS_TEAM_ID: 'TEAMID1234',
    APNS_BUNDLE_ID: 'com.twuijri.corehub',
    APNS_ENV: 'production',
    FCM_SERVICE_ACCOUNT_JSON: keys.serviceAccount,
    HUB_SECRET_KEY: 'test-hub-secret-key-not-a-real-one',
    ADMIN_TOKEN: 'test-admin-token',
  };
  for (const [key, value] of Object.entries(vars)) {
    const bindings = env as unknown as Record<string, string | undefined>;
    if (value === undefined) delete bindings[key];
    else bindings[key] = value;
  }
  const relay = createRelay({
    fetchImpl: services.fetchImpl,
    now: () => clock.now,
    apnsOrigin: 'https://apns.test',
    fcmOrigin: 'https://fcm.test',
    log: (line) => logs.push(line),
  });
  const call: Harness['call'] = (method, path, body, headers = {}) =>
    relay.fetch(
      new Request(`https://relay.test${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        ...(body === undefined
          ? {}
          : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      }),
      env,
    );
  const register: Harness['register'] = async (ip = '198.51.100.7') => {
    const response = await call('POST', '/v1/hubs', {}, { 'cf-connecting-ip': ip });
    if (response.status !== 201) throw new Error(`register: ${response.status}`);
    const { hub_id: id, secret } = (await response.json()) as { hub_id: string; secret: string };
    return {
      id,
      secret,
      async signed(method, path, body, overrides = {}) {
        const text = overrides.rawBody ?? (body === undefined ? '' : JSON.stringify(body));
        const timestamp = overrides.timestamp ?? String(Math.floor(clock.now / 1000));
        nonceCounter += 1;
        const nonce = overrides.nonce ?? `nonce-${String(nonceCounter).padStart(12, '0')}`;
        const signature =
          overrides.signature ??
          (await hmacHex(
            secret,
            signingInput(method, path, timestamp, nonce, await sha256Hex(text)),
          ));
        return relay.fetch(
          new Request(`https://relay.test${path}`, {
            method,
            headers: {
              'content-type': 'application/json',
              'x-corehub-hub': id,
              'x-corehub-timestamp': timestamp,
              'x-corehub-nonce': nonce,
              'x-corehub-signature': signature,
            },
            ...(method === 'GET' ? {} : { body: text }),
          }),
          env,
        );
      },
    };
  };
  return { env, db, services, keys, logs, clock, relay, call, register };
}

/** A device's proof key, as the app would hold it (raw point, raw r||s signatures). */
export function deviceKey() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x!, 'base64url'),
    Buffer.from(jwk.y!, 'base64url'),
  ]).toString('base64url');
  return {
    key: point,
    sign(platform: string, token: string, signedAt: number) {
      const signature = sign(
        'sha256',
        Buffer.from(`corehub-push-bind-v1\n${platform}\n${token}\n${signedAt}`),
        { key: pair.privateKey, dsaEncoding: 'ieee-p1363' },
      ).toString('base64url');
      return { key: point, signed_at: signedAt, signature };
    },
  };
}

/** Every text value in every table, to prove what is (not) stored. */
export function dump(db: ReturnType<typeof fakeD1>): string {
  const tables = ['hubs', 'bindings', 'counters', 'nonces'];
  return tables
    .map((table) => JSON.stringify(db.raw.prepare(`SELECT * FROM ${table}`).all()))
    .join('\n');
}
