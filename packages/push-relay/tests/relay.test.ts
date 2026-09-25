import { beforeEach, describe, expect, it } from 'vitest';
import { resetDeliveryCaches } from '../src/deliver.js';
import { hmacHex, sha256Hex } from '../src/crypto.js';
import { signingInput, tokenHash } from '../src/relay.js';
import {
  APNS_TOKEN,
  APNS_TOKEN_2,
  FCM_TOKEN,
  deviceKey,
  dump,
  harness,
  verifyJwt,
  type Harness,
  type Hub,
} from './harness.js';

type Json = Record<string, unknown>;

beforeEach(() => resetDeliveryCaches());

const message = (platform: 'apns' | 'fcm', token: string, extra: Json = {}) => ({
  platform,
  token,
  title: 'Run finished',
  body: 'The report is ready',
  data: {
    type: 'notice',
    notice_id: '01J8QK3ZR2W7M5N4P6T8V9X0AK',
    kind: 'run_completed',
    profile: 'work',
    resource: { kind: 'session', id: '01J8QK3ZR2W7M5N4P6T8V9X0YA' },
  },
  urgent: false,
  collapse_id: '01J8QK3ZR2W7M5N4P6T8V9X0AK',
  thread_id: 'work',
  ...extra,
});

async function bindOk(hub: Hub, platform: 'apns' | 'fcm', token: string, proof?: unknown) {
  const response = await hub.signed('POST', '/v1/tokens', {
    platform,
    token,
    ...(proof ? { proof } : {}),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

async function pushOne(hub: Hub, platform: 'apns' | 'fcm', token: string) {
  const response = await hub.signed('POST', '/v1/push', { messages: [message(platform, token)] });
  const body = (await response.json()) as { results?: Json[]; error?: string };
  return { status: response.status, body, result: body.results?.[0] };
}

describe('registration', () => {
  it('gives a hub an id and a secret that is never stored', async () => {
    const h = harness();
    const hub = await h.register();
    expect(hub.id).toMatch(/^hub_[A-Za-z0-9_-]{20}$/);
    expect(hub.secret.length).toBeGreaterThanOrEqual(40);
    expect(dump(h.db)).not.toContain(hub.secret);
    const me = await hub.signed('GET', '/v1/hubs/me');
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ hub_id: hub.id, tokens: 0 });
  });

  it('limits registrations per address per hour, and keeps no address', async () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) await h.register('203.0.113.9');
    const sixth = await h.call('POST', '/v1/hubs', {}, { 'cf-connecting-ip': '203.0.113.9' });
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get('retry-after')).toBe('3600');
    // Another address is fine, and an hour later the first is too.
    await h.register('203.0.113.10');
    h.clock.now += 3_600_000;
    await h.register('203.0.113.9');
    expect(dump(h.db)).not.toContain('203.0.113');
  });

  it('refuses to register without its key', async () => {
    const h = harness({ HUB_SECRET_KEY: undefined });
    expect((await h.call('POST', '/v1/hubs', {})).status).toBe(503);
  });
});

describe('request signing', () => {
  let h: Harness;
  let hub: Hub;
  beforeEach(async () => {
    h = harness();
    hub = await h.register();
  });

  it('refuses an unsigned request, a wrong signature, and a changed body', async () => {
    expect((await h.call('POST', '/v1/push', { messages: [] })).status).toBe(401);
    const wrong = await hub.signed('GET', '/v1/hubs/me', undefined, { signature: 'f'.repeat(64) });
    expect(wrong.status).toBe(401);
    // Signed for one body, sent with another.
    const signedFor = { platform: 'apns', token: APNS_TOKEN };
    const timestamp = String(Math.floor(h.clock.now / 1000));
    const nonce = 'tamper-nonce-000001';
    const signature = await hmacHex(
      hub.secret,
      signingInput(
        'POST',
        '/v1/tokens',
        timestamp,
        nonce,
        await sha256Hex(JSON.stringify(signedFor)),
      ),
    );
    const tampered = await h.relay.fetch(
      new Request('https://relay.test/v1/tokens', {
        method: 'POST',
        headers: {
          'x-corehub-hub': hub.id,
          'x-corehub-timestamp': timestamp,
          'x-corehub-nonce': nonce,
          'x-corehub-signature': signature,
        },
        body: JSON.stringify({ platform: 'apns', token: 'c'.repeat(64) }),
      }),
      h.env,
    );
    expect(tampered.status).toBe(401);
    expect(await tampered.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('refuses a replayed request and a stale timestamp', async () => {
    const first = await hub.signed('GET', '/v1/hubs/me', undefined, {
      nonce: 'same-nonce-00000001',
    });
    expect(first.status).toBe(200);
    const again = await hub.signed('GET', '/v1/hubs/me', undefined, {
      nonce: 'same-nonce-00000001',
    });
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ error: 'replayed' });
    const stale = await hub.signed('GET', '/v1/hubs/me', undefined, {
      timestamp: String(Math.floor(h.clock.now / 1000) - 301),
    });
    expect(await stale.json()).toMatchObject({ error: 'stale' });
    const future = await hub.signed('GET', '/v1/hubs/me', undefined, {
      timestamp: String(Math.floor(h.clock.now / 1000) + 301),
    });
    expect(future.status).toBe(401);
  });

  it('refuses a hub the relay does not know', async () => {
    const other = harness();
    const stranger = await other.register();
    // Same signing, another relay's database.
    const response = await h.relay.fetch(
      new Request('https://relay.test/v1/hubs/me', {
        headers: {
          'x-corehub-hub': stranger.id,
          'x-corehub-timestamp': String(Math.floor(h.clock.now / 1000)),
          'x-corehub-nonce': 'stranger-nonce-0001',
          'x-corehub-signature': '0'.repeat(64),
        },
      }),
      h.env,
    );
    expect(await response.json()).toMatchObject({ error: 'unknown_hub' });
  });

  it('forgets old nonces and counters on the cron', async () => {
    await hub.signed('GET', '/v1/hubs/me');
    h.clock.now += 24 * 3_600_000 * 3;
    await h.relay.scheduled({}, h.env);
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM nonces').get()).toMatchObject({ n: 0 });
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM counters').get()).toMatchObject({ n: 0 });
  });
});

describe('binding', () => {
  let h: Harness;
  let a: Hub;
  let b: Hub;
  beforeEach(async () => {
    h = harness();
    a = await h.register('198.51.100.1');
    b = await h.register('198.51.100.2');
  });

  it('first come wins; another hub is refused and cannot push to it', async () => {
    expect(await bindOk(a, 'apns', APNS_TOKEN)).toMatchObject({
      status: 200,
      body: { status: 'bound' },
    });
    expect(await bindOk(a, 'apns', APNS_TOKEN)).toMatchObject({
      status: 200,
      body: { status: 'bound' },
    });
    expect(await bindOk(b, 'apns', APNS_TOKEN)).toMatchObject({
      status: 409,
      body: { error: 'bound_elsewhere' },
    });
    const pushed = await pushOne(b, 'apns', APNS_TOKEN);
    expect(pushed.result).toMatchObject({ status: 'not_bound' });
    expect(h.services.sent.filter((s) => s.service === 'apns')).toHaveLength(0);
    // The token is kept only as its hash.
    expect(dump(h.db)).not.toContain(APNS_TOKEN);
    expect(dump(h.db)).toContain(await tokenHash('apns', APNS_TOKEN));
  });

  it('frees a token its hub unbinds, for the next hub', async () => {
    await bindOk(a, 'fcm', FCM_TOKEN);
    const response = await a.signed('DELETE', '/v1/tokens', { platform: 'fcm', token: FCM_TOKEN });
    expect(await response.json()).toMatchObject({ status: 'unbound' });
    expect(await bindOk(b, 'fcm', FCM_TOKEN)).toMatchObject({ body: { status: 'bound' } });
    const notMine = await a.signed('DELETE', '/v1/tokens', { platform: 'fcm', token: FCM_TOKEN });
    expect(await notMine.json()).toMatchObject({ status: 'not_bound' });
    expect((await pushOne(b, 'fcm', FCM_TOKEN)).result).toMatchObject({ status: 'sent' });
  });

  it('lets the device move to a new hub with a fresh proof from its own key', async () => {
    const device = deviceKey();
    const t0 = Math.floor(h.clock.now / 1000);
    expect(await bindOk(a, 'apns', APNS_TOKEN, device.sign('apns', APNS_TOKEN, t0))).toMatchObject({
      body: { status: 'bound' },
    });
    h.clock.now += 60_000;
    // Another key (a hub making one up) is refused.
    const forged = deviceKey().sign('apns', APNS_TOKEN, t0 + 60);
    expect(await bindOk(b, 'apns', APNS_TOKEN, forged)).toMatchObject({ status: 409 });
    // The device's own key, signed now: the newest registration wins.
    expect(
      await bindOk(b, 'apns', APNS_TOKEN, device.sign('apns', APNS_TOKEN, t0 + 60)),
    ).toMatchObject({ status: 200, body: { status: 'rebound', reason: 'proof' } });
    expect((await pushOne(a, 'apns', APNS_TOKEN)).result).toMatchObject({ status: 'not_bound' });
    expect((await pushOne(b, 'apns', APNS_TOKEN)).result).toMatchObject({ status: 'sent' });
    // The old hub replaying the older proof cannot take it back.
    expect(await bindOk(a, 'apns', APNS_TOKEN, device.sign('apns', APNS_TOKEN, t0))).toMatchObject({
      status: 409,
    });
  });

  it('refuses a proof that does not verify or is not fresh', async () => {
    const device = deviceKey();
    const now = Math.floor(h.clock.now / 1000);
    const signedForOther = device.sign('apns', APNS_TOKEN_2, now);
    expect(await bindOk(a, 'apns', APNS_TOKEN, signedForOther)).toMatchObject({
      status: 400,
      body: { error: 'invalid_proof' },
    });
    expect(
      await bindOk(a, 'apns', APNS_TOKEN, device.sign('apns', APNS_TOKEN, now - 3600)),
    ).toMatchObject({ status: 400 });
  });

  it('without a recorded device key, only an idle binding can move', async () => {
    await bindOk(a, 'fcm', FCM_TOKEN);
    const proof = deviceKey().sign('fcm', FCM_TOKEN, Math.floor(h.clock.now / 1000));
    expect(await bindOk(b, 'fcm', FCM_TOKEN, proof)).toMatchObject({ status: 409 });
    h.clock.now += 31 * 86_400_000;
    expect(await bindOk(b, 'fcm', FCM_TOKEN)).toMatchObject({
      status: 200,
      body: { status: 'rebound', reason: 'idle' },
    });
  });

  it('a sync keeps what the hub lists, drops the rest and names what is missing', async () => {
    await bindOk(a, 'apns', APNS_TOKEN);
    await bindOk(a, 'apns', APNS_TOKEN_2);
    const response = await a.signed('POST', '/v1/tokens/sync', {
      tokens: [
        { platform: 'apns', hash: await tokenHash('apns', APNS_TOKEN) },
        { platform: 'fcm', hash: await tokenHash('fcm', FCM_TOKEN) },
      ],
    });
    expect(await response.json()).toEqual({
      kept: 1,
      removed: 1,
      missing: [{ platform: 'fcm', hash: await tokenHash('fcm', FCM_TOKEN) }],
    });
    expect(await bindOk(b, 'apns', APNS_TOKEN_2)).toMatchObject({ body: { status: 'bound' } });
  });
});

describe('sending', () => {
  let h: Harness;
  let hub: Hub;
  beforeEach(async () => {
    h = harness();
    hub = await h.register();
    await bindOk(hub, 'apns', APNS_TOKEN);
    await bindOk(hub, 'fcm', FCM_TOKEN);
  });

  it('signs an ES256 provider token for APNs and reuses it', async () => {
    expect((await pushOne(hub, 'apns', APNS_TOKEN)).result).toMatchObject({
      status: 'sent',
      ref: 'apns-id-1',
    });
    await pushOne(hub, 'apns', APNS_TOKEN);
    const [first, second] = h.services.sent.filter((s) => s.service === 'apns');
    const jwt = first!.headers.authorization!.replace(/^bearer /, '');
    expect(verifyJwt(jwt, h.keys.apnsPublic)).toMatchObject({
      header: { alg: 'ES256', kid: 'KEYID12345' },
      claims: { iss: 'TEAMID1234', iat: Math.floor(h.clock.now / 1000) },
    });
    expect(second!.headers.authorization).toBe(first!.headers.authorization);
    expect(first!.headers['apns-topic']).toBe('com.twuijri.corehub');
    expect(first!.headers['apns-collapse-id']).toBe('01J8QK3ZR2W7M5N4P6T8V9X0AK');
    const payload = JSON.parse(first!.body) as Json;
    expect(payload).toMatchObject({
      aps: { alert: { title: 'Run finished', body: 'The report is ready' }, 'thread-id': 'work' },
      notice_id: '01J8QK3ZR2W7M5N4P6T8V9X0AK',
      resource: { kind: 'session', id: '01J8QK3ZR2W7M5N4P6T8V9X0YA' },
    });
    // 51 minutes later it is renewed.
    h.clock.now += 51 * 60_000;
    await pushOne(hub, 'apns', APNS_TOKEN);
    const third = h.services.sent.filter((s) => s.service === 'apns')[2]!;
    expect(third.headers.authorization).not.toBe(first!.headers.authorization);
  });

  it('gets an FCM access token with an RS256 assertion, caches it, renews it on 401', async () => {
    expect((await pushOne(hub, 'fcm', FCM_TOKEN)).result).toMatchObject({ status: 'sent' });
    await pushOne(hub, 'fcm', FCM_TOKEN);
    expect(h.services.oauthCalls()).toBe(1);
    const oauth = h.services.sent.find((s) => s.service === 'oauth')!;
    const assertion = new URLSearchParams(oauth.body).get('assertion')!;
    expect(verifyJwt(assertion, h.keys.fcmPublic)).toMatchObject({
      header: { alg: 'RS256' },
      claims: {
        iss: 'relay@corehub-test.iam.gserviceaccount.com',
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth.test/token',
      },
    });
    const send = h.services.sent.find((s) => s.service === 'fcm')!;
    expect(send.headers.authorization).toBe('Bearer ya29.test-1');
    expect(JSON.parse(send.body)).toMatchObject({
      message: {
        token: FCM_TOKEN,
        notification: { title: 'Run finished', body: 'The report is ready' },
        data: {
          type: 'notice',
          notice_id: '01J8QK3ZR2W7M5N4P6T8V9X0AK',
          resource_kind: 'session',
          resource_id: '01J8QK3ZR2W7M5N4P6T8V9X0YA',
        },
        android: { priority: 'normal', notification: { channel_id: 'notices' } },
      },
    });
    h.services.unauthorizeFcmOnce();
    expect((await pushOne(hub, 'fcm', FCM_TOKEN)).result).toMatchObject({ status: 'sent' });
    expect(h.services.oauthCalls()).toBe(2);
  });

  it('forgets a token APNs or FCM call dead, and tells the hub', async () => {
    h.services.answers.set(APNS_TOKEN, { status: 410, reason: 'Unregistered' });
    expect((await pushOne(hub, 'apns', APNS_TOKEN)).result).toMatchObject({ status: 'gone' });
    h.services.answers.delete(APNS_TOKEN);
    expect((await pushOne(hub, 'apns', APNS_TOKEN)).result).toMatchObject({ status: 'not_bound' });

    h.services.answers.set(FCM_TOKEN, {
      status: 404,
      fcm: { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } },
    });
    expect((await pushOne(hub, 'fcm', FCM_TOKEN)).result).toMatchObject({ status: 'gone' });
    expect(dump(h.db)).not.toContain(await tokenHash('fcm', FCM_TOKEN));
  });

  it('keeps a token when the failure is not the token’s', async () => {
    h.services.answers.set(APNS_TOKEN, { status: 400, reason: 'BadDeviceToken' });
    expect((await pushOne(hub, 'apns', APNS_TOKEN)).result).toMatchObject({
      status: 'failed',
      error: 'APNs: BadDeviceToken (400)',
    });
    h.services.answers.set(FCM_TOKEN, {
      status: 400,
      fcm: { error: { status: 'INVALID_ARGUMENT', message: 'Invalid JSON payload' } },
    });
    expect((await pushOne(hub, 'fcm', FCM_TOKEN)).result).toMatchObject({ status: 'failed' });
    h.services.answers.clear();
    expect((await pushOne(hub, 'apns', APNS_TOKEN)).result).toMatchObject({ status: 'sent' });
    expect((await pushOne(hub, 'fcm', FCM_TOKEN)).result).toMatchObject({ status: 'sent' });
  });

  it('logs counters only and stores no content', async () => {
    await pushOne(hub, 'apns', APNS_TOKEN);
    const logged = JSON.stringify(h.logs);
    expect(h.logs).toContainEqual({ evt: 'push', sent: 1, failed: 0, gone: 0, not_bound: 0 });
    for (const secret of [APNS_TOKEN, 'Run finished', 'The report is ready', hub.id]) {
      expect(logged).not.toContain(secret);
    }
    for (const secret of ['Run finished', 'The report is ready', '01J8QK3ZR2W7M5N4P6T8V9X0AK']) {
      expect(dump(h.db)).not.toContain(secret);
    }
  });

  it('refuses a malformed message', async () => {
    const bad = await hub.signed('POST', '/v1/push', {
      messages: [message('apns', APNS_TOKEN, { data: { aps: {} } })],
    });
    expect(bad.status).toBe(400);
    const tooMany = await hub.signed('POST', '/v1/push', {
      messages: Array.from({ length: 41 }, () => message('apns', APNS_TOKEN)),
    });
    expect(tooMany.status).toBe(400);
  });
});

describe('limits and blocking', () => {
  it('holds a hub to its per-minute and per-day limits', async () => {
    const h = harness({ LIMIT_PER_MINUTE: '2', LIMIT_PER_DAY: '3' });
    const hub = await h.register();
    await bindOk(hub, 'apns', APNS_TOKEN);
    expect((await pushOne(hub, 'apns', APNS_TOKEN)).status).toBe(200);
    expect((await pushOne(hub, 'apns', APNS_TOKEN)).status).toBe(200);
    const third = await hub.signed('POST', '/v1/push', { messages: [message('apns', APNS_TOKEN)] });
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBe('60');
    expect(await third.json()).toMatchObject({ error: 'rate_limited', limits: { per_minute: 2 } });
    h.clock.now += 60_000;
    expect((await pushOne(hub, 'apns', APNS_TOKEN)).status).toBe(200);
    h.clock.now += 60_000;
    const daily = await pushOne(hub, 'apns', APNS_TOKEN);
    expect(daily.status).toBe(429);
    expect(daily.body).toMatchObject({ message: 'this hub is over its daily limit' });
    // Only three reached Apple.
    expect(h.services.sent.filter((s) => s.service === 'apns')).toHaveLength(3);
  });

  it('the owner can block a hub, raise its limits and unblock it', async () => {
    const h = harness({ LIMIT_PER_MINUTE: '1' });
    const hub = await h.register();
    await bindOk(hub, 'apns', APNS_TOKEN);
    const admin = { authorization: 'Bearer test-admin-token' };
    // Without the token the admin routes do not exist.
    expect((await h.call('POST', `/v1/admin/hubs/${hub.id}/block`, {})).status).toBe(404);
    expect(
      (await h.call('POST', `/v1/admin/hubs/${hub.id}/block`, {}, { authorization: 'Bearer nope' }))
        .status,
    ).toBe(404);
    expect(
      (await h.call('POST', `/v1/admin/hubs/${hub.id}/block`, { reason: 'spam' }, admin)).status,
    ).toBe(200);
    const blocked = await pushOne(hub, 'apns', APNS_TOKEN);
    expect(blocked).toMatchObject({ status: 403, body: { error: 'blocked' } });
    const info = await h.call('GET', `/v1/admin/hubs/${hub.id}`, undefined, admin);
    expect(await info.json()).toMatchObject({ blocked: true, blocked_reason: 'spam', tokens: 1 });
    await h.call('POST', `/v1/admin/hubs/${hub.id}/unblock`, {}, admin);
    await h.call('PUT', `/v1/admin/hubs/${hub.id}/limits`, { per_minute: 5, per_day: null }, admin);
    for (let i = 0; i < 5; i += 1) {
      expect((await pushOne(hub, 'apns', APNS_TOKEN)).status).toBe(200);
    }
    expect((await pushOne(hub, 'apns', APNS_TOKEN)).status).toBe(429);
  });

  it('answers its health without secrets', async () => {
    const h = harness({ FCM_SERVICE_ACCOUNT_JSON: undefined });
    const response = await h.call('GET', '/v1/health');
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ ok: true, apns: true, fcm: false, registration: true });
    expect(body).not.toContain('KEYID12345');
  });
});
