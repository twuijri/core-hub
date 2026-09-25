/**
 * The Core Hub push relay from the hub's side (ADR 0024): a hub with no FCM/APNs credentials
 * registers itself with the relay on first need, binds its phones' tokens, pushes through it
 * with signed calls, forgets what the relay calls gone, tells it what it let go of, keeps
 * private push private — and never touches it when local credentials exist or it is off.
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { requireSqlite } from '../../src/lib/db.js';
import { overrideDevices, pushFor } from '../../src/modules/devices/index.js';
import { devices, pushRelay } from '../../src/modules/devices/schema.js';
import { fakeFcm } from '../../src/modules/devices/testing/fake-push.js';
import { fakeRelay, type FakeRelay } from '../../src/modules/devices/testing/fake-relay.js';
import { TEST_ADMIN_PASSWORD, authed, signedInHub, type TestHub } from './helpers.js';

type Json = Record<string, unknown>;
type Hub = TestHub & { token: string; userId: string };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  overrideDevices({});
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function relayHub(env: Record<string, string> = {}): Promise<{ hub: Hub; relay: FakeRelay }> {
  const relay = fakeRelay();
  overrideDevices({ relayFetch: relay.fetch });
  const hub = await signedInHub({ COREHUB_PUSH_RELAY_URL: relay.url, ...env });
  cleanups.push(() => hub.close());
  return { hub, relay };
}

async function pairPhone(hub: Hub, key = 'phone-key', platform = 'ios') {
  const created = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/auth/pairings',
    payload: { ttl_seconds: 120 },
  });
  const pairing = created.json() as { id: string; code: string };
  const claim = await hub.app.inject({
    method: 'POST',
    url: `/api/v1/auth/pairings/${pairing.id}/claim`,
    payload: {
      code: pairing.code,
      device: { device_key: key, name: 'هاتف', platform, kind: 'phone' },
    },
  });
  expect(claim.statusCode, claim.body).toBe(201);
  const body = claim.json() as { app_token: string; device: { id: string } };
  return { appToken: body.app_token, deviceId: body.device.id };
}

const APNS = 'a'.repeat(64);

async function registerApns(hub: Hub, phone: { appToken: string; deviceId: string }, token = APNS) {
  const response = await authed(hub, phone.appToken, {
    method: 'PUT',
    url: `/api/v1/devices/${phone.deviceId}/push`,
    payload: { provider: 'apns', token, locale: 'en' },
  });
  expect(response.statusCode, response.body).toBe(200);
}

const senders = async (hub: Hub) =>
  (
    (await authed(hub, hub.token, { method: 'GET', url: '/api/v1/push/senders' })).json() as {
      items: Json[];
    }
  ).items;

const testNotice = (hub: Hub) =>
  authed(hub, hub.token, { method: 'POST', url: '/api/v1/notify/test-notice' });

const relayRow = (hub: Hub) => requireSqlite(hub.app.hub.database).select().from(pushRelay).get();

describe('push relay: zero setup', () => {
  it('offers FCM and APNs through the relay, registers on first need and binds the token', async () => {
    const { hub, relay } = await relayHub();
    const before = await senders(hub);
    expect(before.find((s) => s.provider === 'apns')).toMatchObject({
      state: 'ready',
      source: 'relay',
      missing: [],
      relay: { state: 'not_registered', enabled: true, private_push: false, url: relay.url },
    });
    expect(before.find((s) => s.provider === 'webpush')).toMatchObject({ relay: null });
    const config = (
      await authed(hub, hub.token, { method: 'GET', url: '/api/v1/push/config' })
    ).json() as { providers: string[] };
    expect(config.providers).toEqual(['webpush', 'fcm', 'apns']);
    // Nothing was asked of the relay yet.
    expect(relay.calls).toEqual([]);

    const phone = await pairPhone(hub);
    await registerApns(hub, phone);
    expect(relay.calls.map((c) => `${c.method} ${c.path} ${c.signed}`)).toEqual([
      'POST /v1/hubs false',
      'POST /v1/tokens true',
    ]);
    expect([...relay.bindings.keys()]).toEqual([`apns:${APNS}`]);
    // The secret is sealed like every other; the id is not a secret.
    const row = relayRow(hub)!;
    const secret = relay.hubs.get(row.hubId!)!;
    expect(row.ciphertext).not.toContain(secret);
    expect(JSON.stringify(row)).not.toContain(secret);
    const after = await senders(hub);
    expect(after.find((s) => s.provider === 'apns')).toMatchObject({
      devices: 1,
      relay: { state: 'ready', hub_id: row.hubId, checked_at: expect.any(String) },
    });
  });

  it('pushes a notice through the relay with the words, or privately with none', async () => {
    const { hub, relay } = await relayHub();
    const phone = await pairPhone(hub);
    await registerApns(hub, phone);
    await testNotice(hub);
    await vi.waitFor(() => expect(relay.pushed).toHaveLength(1));
    expect(relay.pushed[0]).toMatchObject({
      platform: 'apns',
      token: APNS,
      title: 'إشعار تجريبي',
      data: { type: 'notice', kind: 'system', profile: 'default' },
      thread_id: 'default',
    });

    const set = await authed(hub, hub.token, {
      method: 'PUT',
      url: '/api/v1/push/relay',
      payload: { private_push: true },
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toMatchObject({ private_push: true, state: 'ready' });
    await testNotice(hub);
    await vi.waitFor(() => expect(relay.pushed).toHaveLength(2));
    const quiet = relay.pushed[1]!;
    expect(quiet).toMatchObject({ title: 'New notice in Core Hub', body: null, thread_id: null });
    expect(Object.keys(quiet.data).sort()).toEqual(['kind', 'notice_id', 'type']);
    expect(quiet.data.notice_id).toEqual(expect.any(String));
    expect(JSON.stringify(quiet)).not.toContain('إشعار تجريبي');
  });

  it('binds again when the relay does not hold the token, and re-registers a forgotten hub', async () => {
    const { hub, relay } = await relayHub();
    const phone = await pairPhone(hub);
    await registerApns(hub, phone);
    relay.bindings.clear();
    relay.forgetHubs();
    const test = await authed(hub, hub.token, {
      method: 'POST',
      url: `/api/v1/devices/${phone.deviceId}/push/test`,
    });
    expect(test.json()).toEqual({ provider: 'apns', status: 'sent', error: null });
    expect(relay.calls.map((c) => `${c.method} ${c.path}`).slice(-5)).toEqual([
      'POST /v1/push', // unknown hub
      'POST /v1/hubs',
      'POST /v1/push', // not bound
      'POST /v1/tokens',
      'POST /v1/push',
    ]);
    expect(relay.hubs.size).toBe(1);
  });

  it('forgets a token the relay calls gone', async () => {
    const { hub, relay } = await relayHub();
    const phone = await pairPhone(hub);
    await registerApns(hub, phone);
    relay.gone.add(APNS);
    const test = await authed(hub, hub.token, {
      method: 'POST',
      url: `/api/v1/devices/${phone.deviceId}/push/test`,
    });
    expect(test.json()).toMatchObject({ status: 'failed' });
    const row = requireSqlite(hub.app.hub.database)
      .select()
      .from(devices)
      .where(eq(devices.id, phone.deviceId))
      .get()!;
    expect(row).toMatchObject({ pushProvider: 'none', pushToken: null });
  });

  it('lets go of a token at the relay when the phone unregisters or is unlinked', async () => {
    const { hub, relay } = await relayHub();
    const first = await pairPhone(hub, 'phone-1');
    const second = await pairPhone(hub, 'phone-2');
    await registerApns(hub, first, 'a'.repeat(64));
    await registerApns(hub, second, 'b'.repeat(64));
    expect(relay.bindings.size).toBe(2);
    const off = await authed(hub, first.appToken, {
      method: 'DELETE',
      url: `/api/v1/devices/${first.deviceId}/push`,
    });
    expect(off.statusCode).toBe(204);
    await vi.waitFor(() => expect([...relay.bindings.keys()]).toEqual([`apns:${'b'.repeat(64)}`]));
    const unlinked = await authed(hub, hub.token, {
      method: 'DELETE',
      url: `/api/v1/devices/${second.deviceId}`,
    });
    expect(unlinked.statusCode).toBe(204);
    await vi.waitFor(() => expect(relay.bindings.size).toBe(0));
  });

  it('lets go at the relay of a token whose sign-in ended, on the next tick, and only then', async () => {
    const { hub, relay } = await relayHub();
    const login = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: TEST_ADMIN_PASSWORD },
    });
    const phone = (login.json() as { access_token: string }).access_token;
    const device = await authed(hub, phone, {
      method: 'POST',
      url: '/api/v1/devices',
      payload: { device_key: 'iphone-a', name: 'iPhone', platform: 'ios', kind: 'phone' },
    });
    const id = (device.json() as { id: string }).id;
    await registerApns(hub, { appToken: phone, deviceId: id });
    expect(relay.bindings.size).toBe(1);
    const push = pushFor(hub.app);
    await push.syncRelayIfNeeded();
    const syncs = () => relay.calls.filter((c) => c.path === '/v1/tokens/sync').length;
    expect(syncs()).toBe(1);
    // Nothing changed: nothing is sent.
    await push.syncRelayIfNeeded();
    expect(syncs()).toBe(1);

    const out = await authed(hub, phone, { method: 'POST', url: '/api/v1/auth/logout' });
    expect(out.statusCode).toBe(204);
    expect(relay.bindings.size).toBe(1);
    await push.syncRelayIfNeeded();
    expect(syncs()).toBe(2);
    expect(relay.bindings.size).toBe(0);
  });

  it('says a token is bound to another hub instead of pushing', async () => {
    const { hub, relay } = await relayHub();
    const phone = await pairPhone(hub);
    relay.hubs.set('hub_someone_else', 'x');
    relay.bindings.set(`apns:${APNS}`, 'hub_someone_else');
    await registerApns(hub, phone);
    const test = await authed(hub, hub.token, {
      method: 'POST',
      url: `/api/v1/devices/${phone.deviceId}/push/test`,
    });
    expect(test.json()).toMatchObject({
      status: 'failed',
      error: 'relay: this phone is bound to another hub',
    });
    expect(relay.pushed).toHaveLength(0);
  });
});

describe('push relay: states', () => {
  it('shows blocked, rate-limited and unreachable, and stops offering a blocked relay', async () => {
    const { hub, relay } = await relayHub();
    const phone = await pairPhone(hub);
    await registerApns(hub, phone);
    const test = () =>
      authed(hub, hub.token, {
        method: 'POST',
        url: `/api/v1/devices/${phone.deviceId}/push/test`,
      });
    const relayOf = async () =>
      (await senders(hub)).find((s) => s.provider === 'apns') as Json & { relay: Json };

    relay.mode = 'rate_limited';
    expect((await test()).json()).toMatchObject({ status: 'failed' });
    expect(await relayOf()).toMatchObject({ state: 'ready', relay: { state: 'rate_limited' } });

    relay.mode = 'down';
    expect((await test()).json()).toMatchObject({ status: 'failed' });
    expect((await relayOf()).relay).toMatchObject({
      state: 'unreachable',
      last_error: expect.stringContaining('did not answer'),
    });

    relay.mode = 'blocked';
    await test();
    expect(await relayOf()).toMatchObject({ state: 'error', relay: { state: 'blocked' } });
    const config = (
      await authed(hub, hub.token, { method: 'GET', url: '/api/v1/push/config' })
    ).json() as { providers: string[] };
    expect(config.providers).toEqual(['webpush']);

    relay.mode = 'ok';
    expect((await test()).json()).toMatchObject({ status: 'sent' });
    expect((await relayOf()).relay).toMatchObject({ state: 'ready', last_error: null });
  });

  it('is off by the admin switch, by COREHUB_PUSH_RELAY=off, and without an address', async () => {
    const { hub, relay } = await relayHub();
    const off = await authed(hub, hub.token, {
      method: 'PUT',
      url: '/api/v1/push/relay',
      payload: { enabled: false },
    });
    expect(off.json()).toMatchObject({ state: 'off', enabled: false, forced_off: false });
    expect((await senders(hub)).find((s) => s.provider === 'fcm')).toMatchObject({
      state: 'not_configured',
      source: 'none',
      relay: { state: 'off' },
    });
    const register = await authed(hub, hub.token, {
      method: 'PUT',
      url: '/api/v1/push/relay',
      payload: { enabled: true },
    });
    expect(register.json()).toMatchObject({ state: 'not_registered' });

    const forced = await relayHub({ COREHUB_PUSH_RELAY: 'off' });
    expect((await senders(forced.hub)).find((s) => s.provider === 'apns')).toMatchObject({
      source: 'none',
      relay: { state: 'off', forced_off: true, enabled: true },
    });

    const none = await signedInHub();
    cleanups.push(() => none.close());
    expect((await senders(none as Hub)).find((s) => s.provider === 'apns')).toMatchObject({
      source: 'none',
      relay: { state: 'no_url', url: null },
    });
    expect(relay.calls).toEqual([]);
    expect(forced.relay.calls).toEqual([]);
  });

  it('only an owner or admin changes it, with a well-formed body', async () => {
    const { hub } = await relayHub();
    const made = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/auth/users',
      payload: {
        username: 'sara',
        password: 'sara-password-1',
        role: 'member',
        profiles: ['default'],
      },
    });
    expect(made.statusCode, made.body).toBe(201);
    const login = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'sara', password: 'sara-password-1' },
    });
    const member = (login.json() as { access_token: string }).access_token;
    const refused = await authed(hub, member, {
      method: 'PUT',
      url: '/api/v1/push/relay',
      payload: { private_push: true },
    });
    expect(refused.statusCode).toBe(403);
    const bad = await authed(hub, hub.token, {
      method: 'PUT',
      url: '/api/v1/push/relay',
      payload: { private_push: 'yes' },
    });
    expect(bad.statusCode).toBe(400);
    expect(relayRow(hub)?.privatePush ?? false).toBe(false);
  });
});

describe('push relay: local credentials win', () => {
  it('never uses the relay for a sender with its own credentials', async () => {
    const fcm = fakeFcm();
    const relay = fakeRelay();
    overrideDevices({
      relayFetch: relay.fetch,
      fetchImpl: fcm.fetchImpl,
      fcmBaseUrl: 'https://fcm.fake',
    });
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const hub = await signedInHub({
      COREHUB_PUSH_RELAY_URL: relay.url,
      COREHUB_FCM_SERVICE_ACCOUNT: JSON.stringify({
        type: 'service_account',
        project_id: 'corehub-test',
        client_email: 'hub@corehub-test.iam.gserviceaccount.com',
        private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        token_uri: 'https://oauth2.fake/token',
      }),
    });
    cleanups.push(() => hub.close());
    const list = await senders(hub);
    expect(list.find((s) => s.provider === 'fcm')).toMatchObject({
      source: 'environment',
      relay: { state: 'not_registered' },
    });
    expect(list.find((s) => s.provider === 'apns')).toMatchObject({ source: 'relay' });
    const phone = await pairPhone(hub, 'pixel', 'android');
    const response = await authed(hub, phone.appToken, {
      method: 'PUT',
      url: `/api/v1/devices/${phone.deviceId}/push`,
      payload: { provider: 'fcm', token: 'fcm-registration-token-123' },
    });
    expect(response.statusCode, response.body).toBe(200);
    await testNotice(hub);
    await vi.waitFor(() => expect(fcm.sent).toHaveLength(1));
    expect(relay.calls).toEqual([]);
  });
});
