/**
 * The devices module over HTTP: the registry (register, list, rename, unlink), push
 * registration, the senders' status, and a notice reaching a device — through notify's
 * preferences and quiet hours — delivered to fakes of Web Push, FCM and APNs.
 */
import { generateKeyPairSync } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { io as connect } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOCKET_PATH } from '../../src/app/sockets.js';
import { REALTIME_NAMESPACES } from '../../src/lib/module.js';
import { requireSqlite } from '../../src/lib/db.js';
import { overrideDevices } from '../../src/modules/devices/index.js';
import { devices } from '../../src/modules/devices/schema.js';
import { notificationDeliveries } from '../../src/modules/notify/schema.js';
import { appTokens } from '../../src/modules/auth/schema.js';
import {
  fakeFcm,
  startFakeApns,
  startFakePushService,
  type FakePushService,
} from '../../src/modules/devices/testing/fake-push.js';
import { TEST_ADMIN_PASSWORD, authed, signedInHub, type TestHub } from './helpers.js';

type Json = Record<string, unknown>;
type Hub = TestHub & { token: string; userId: string };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  overrideDevices({});
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function hubWith(env: Record<string, string> = {}): Promise<Hub> {
  const hub = await signedInHub(env);
  cleanups.push(() => hub.close());
  return hub;
}

async function fakePush(): Promise<FakePushService> {
  const service = await startFakePushService();
  cleanups.push(() => service.close());
  // The fake lives on 127.0.0.1, which the hub refuses unless a test says otherwise.
  overrideDevices({ allowPrivateEndpoints: true });
  return service;
}

const browser = (key = 'browser-key-1') => ({
  device_key: key,
  name: 'Firefox — Linux',
  platform: 'web',
  kind: 'browser',
  capabilities: ['notifications'],
});

async function registerBrowser(hub: Hub, key?: string): Promise<Json> {
  const response = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/devices',
    payload: browser(key),
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as Json;
}

/** Pairs a phone the way the app does: a pairing from the web, claimed with its code. */
async function pairPhone(hub: Hub, key = 'phone-key', platform = 'android') {
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

async function subscribe(hub: Hub, deviceId: string, subscription: unknown, token = hub.token) {
  return authed(hub, token, {
    method: 'PUT',
    url: `/api/v1/devices/${deviceId}/push`,
    payload: { provider: 'webpush', token: JSON.stringify(subscription), locale: 'ar' },
  });
}

const testNotice = (hub: Hub) =>
  authed(hub, hub.token, { method: 'POST', url: '/api/v1/notify/test-notice' });

describe('devices: the registry', () => {
  it('registers a browser once, lists, renames and unlinks it', async () => {
    const hub = await hubWith();
    const first = await registerBrowser(hub);
    expect(first).toMatchObject({
      user_id: hub.userId,
      platform: 'web',
      kind: 'browser',
      push: null,
      app_token_id: null,
      capabilities: [{ kind: 'notifications', enabled: true, consent_at: null }],
    });
    // The same key again is the same row, not a second browser.
    const again = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/devices',
      payload: { ...browser(), name: 'Firefox' },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id: first.id, name: 'Firefox' });

    const list = (
      await authed(hub, hub.token, { method: 'GET', url: '/api/v1/devices' })
    ).json() as { items: Json[] };
    expect(list.items.map((item) => item.id)).toEqual([first.id]);

    const renamed = await authed(hub, hub.token, {
      method: 'PATCH',
      url: `/api/v1/devices/${first.id as string}`,
      payload: { name: 'حاسوب المكتب' },
    });
    expect(renamed.json()).toMatchObject({ name: 'حاسوب المكتب' });
    const empty = await authed(hub, hub.token, {
      method: 'PATCH',
      url: `/api/v1/devices/${first.id as string}`,
      payload: { name: '  ' },
    });
    expect(empty.statusCode).toBe(400);

    const unlinked = await authed(hub, hub.token, {
      method: 'DELETE',
      url: `/api/v1/devices/${first.id as string}`,
    });
    expect(unlinked.statusCode).toBe(204);
    const after = (
      await authed(hub, hub.token, { method: 'GET', url: '/api/v1/devices' })
    ).json() as { items: Json[] };
    expect(after.items).toEqual([]);
    const gone = await authed(hub, hub.token, {
      method: 'GET',
      url: `/api/v1/devices/${first.id as string}`,
    });
    expect(gone.statusCode).toBe(404);
  });

  it('unlinking a paired phone revokes its token, and a phone cannot register as a browser', async () => {
    const hub = await hubWith();
    const phone = await pairPhone(hub);
    const self = await authed(hub, phone.appToken, {
      method: 'GET',
      url: `/api/v1/devices/${phone.deviceId}`,
    });
    expect(self.json()).toMatchObject({ this_device: true, platform: 'android' });
    const asBrowser = await authed(hub, phone.appToken, {
      method: 'POST',
      url: '/api/v1/devices',
      payload: browser('x'),
    });
    expect(asBrowser.statusCode).toBe(409);
    // Its key belongs to the app: a browser cannot take the row over.
    const taken = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/devices',
      payload: browser('phone-key'),
    });
    expect(taken.statusCode).toBe(409);

    const unlink = await authed(hub, hub.token, {
      method: 'DELETE',
      url: `/api/v1/devices/${phone.deviceId}`,
    });
    expect(unlink.statusCode).toBe(204);
    const refused = await authed(hub, phone.appToken, { method: 'GET', url: '/api/v1/auth/me' });
    expect(refused.statusCode).toBe(401);
  });

  it('records when a paired device was last seen', async () => {
    const hub = await hubWith();
    const phone = await pairPhone(hub);
    const db = requireSqlite(hub.app.hub.database);
    db.update(devices)
      .set({ lastSeenAt: new Date(0) })
      .where(eq(devices.id, phone.deviceId))
      .run();
    await authed(hub, phone.appToken, { method: 'GET', url: '/api/v1/devices' });
    const row = db.select().from(devices).where(eq(devices.id, phone.deviceId)).get()!;
    expect(row.lastSeenAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('keeps what a device says about itself, and a name a person gave it', async () => {
    const hub = await hubWith();
    const created = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/auth/pairings',
      payload: { ttl_seconds: 120 },
    });
    const pairing = created.json() as { id: string; code: string };
    const device = {
      device_key: 'iphone-key',
      name: 'iPhone',
      platform: 'ios',
      kind: 'phone',
      brand: 'Apple',
      model: 'iPhone 16 Pro',
      os_version: '18.6',
      app_version: '0.1.0',
      push_blocker: 'permission_pending',
    };
    const claim = async () =>
      hub.app.inject({
        method: 'POST',
        url: `/api/v1/auth/pairings/${pairing.id}/claim`,
        payload: { code: pairing.code, device },
      });
    const first = await claim();
    expect(first.statusCode, first.body).toBe(201);
    const body = first.json() as { app_token: string; device: Json };
    expect(body.device).toMatchObject({
      name: 'iPhone',
      model: 'iPhone 16 Pro',
      os_version: '18.6',
      app_version: '0.1.0',
      push_blocker: 'permission_pending',
    });
    expect(typeof body.device.paired_at).toBe('string');
    const id = body.device.id as string;

    // At the next launch the phone reports again: a new iOS, a new build, permission given.
    const reported = await authed(hub, body.app_token, {
      method: 'PATCH',
      url: `/api/v1/devices/${id}`,
      payload: { os_version: '26.0', app_version: '0.2.0', push_blocker: 'none' },
    });
    expect(reported.statusCode, reported.body).toBe(200);
    expect(reported.json()).toMatchObject({
      name: 'iPhone',
      model: 'iPhone 16 Pro',
      os_version: '26.0',
      app_version: '0.2.0',
      push_blocker: 'none',
    });

    // The person names it on the hub; the phone pairing again with its generic name keeps it.
    await authed(hub, hub.token, {
      method: 'PATCH',
      url: `/api/v1/devices/${id}`,
      payload: { name: 'آيفون العمل' },
    });
    const again = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/auth/pairings',
      payload: { ttl_seconds: 120 },
    });
    const second = again.json() as { id: string; code: string };
    const repaired = await hub.app.inject({
      method: 'POST',
      url: `/api/v1/auth/pairings/${second.id}/claim`,
      payload: { code: second.code, device: { ...device, os_version: '26.1' } },
    });
    expect(repaired.statusCode, repaired.body).toBe(201);
    expect((repaired.json() as { device: Json }).device).toMatchObject({
      id,
      name: 'آيفون العمل',
      os_version: '26.1',
    });

    // An app older than these fields sends none of them; the row keeps what it knew.
    const bare = await authed(hub, (repaired.json() as { app_token: string }).app_token, {
      method: 'PATCH',
      url: `/api/v1/devices/${id}`,
      payload: { app_version: '0.2.1' },
    });
    expect(bare.json()).toMatchObject({ os_version: '26.1', push_blocker: 'permission_pending' });
  });

  it("keeps a renamed browser's name when it registers again, and refuses an unknown blocker", async () => {
    const hub = await hubWith();
    const first = await registerBrowser(hub);
    expect(first).toMatchObject({ os_version: null, push_blocker: null });
    await authed(hub, hub.token, {
      method: 'PATCH',
      url: `/api/v1/devices/${first.id as string}`,
      payload: { name: 'حاسوب المكتب' },
    });
    const again = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/devices',
      payload: { ...browser(), os_version: 'Linux' },
    });
    expect(again.json()).toMatchObject({ name: 'حاسوب المكتب', os_version: 'Linux' });
    const junk = await authed(hub, hub.token, {
      method: 'PATCH',
      url: `/api/v1/devices/${first.id as string}`,
      payload: { push_blocker: 'maybe' },
    });
    expect(junk.statusCode).toBe(400);
  });

  it('counts the calls of the sign-in that registered a device, at most once a minute', async () => {
    let clock = Date.now();
    overrideDevices({ now: () => clock });
    const hub = await hubWith();
    const mine = await registerBrowser(hub);
    const db = requireSqlite(hub.app.hub.database);
    const seen = () =>
      db
        .select()
        .from(devices)
        .where(eq(devices.id, mine.id as string))
        .get()!
        .lastSeenAt!.getTime();
    const forget = () =>
      db
        .update(devices)
        .set({ lastSeenAt: new Date(0) })
        .where(eq(devices.id, mine.id as string))
        .run();
    const call = (token = hub.token) =>
      authed(hub, token, { method: 'GET', url: '/api/v1/notify/notices' });

    // The registration itself was the sign-in's first call of this minute.
    forget();
    clock += 30_000;
    await call();
    expect(seen()).toBe(0);

    clock += 31_000;
    await call();
    expect(seen()).toBe(clock);

    // Another sign-in of the same person is not this browser.
    forget();
    clock += 120_000;
    const login = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: TEST_ADMIN_PASSWORD },
    });
    await call((login.json() as { access_token: string }).access_token);
    expect(seen()).toBe(0);
  });

  it("writes a paired device's last activity at most once a minute", async () => {
    let clock = Date.now();
    overrideDevices({ now: () => clock });
    const hub = await hubWith();
    const phone = await pairPhone(hub, 'throttled-phone');
    const db = requireSqlite(hub.app.hub.database);
    const seen = () =>
      db.select().from(devices).where(eq(devices.id, phone.deviceId)).get()!.lastSeenAt!.getTime();
    clock += 61_000;
    await authed(hub, phone.appToken, { method: 'GET', url: '/api/v1/devices' });
    const written = seen();
    expect(written).toBe(clock);
    clock += 20_000;
    await authed(hub, phone.appToken, { method: 'GET', url: '/api/v1/devices' });
    expect(seen()).toBe(written);
    clock += 41_000;
    await authed(hub, phone.appToken, { method: 'GET', url: '/api/v1/devices' });
    expect(seen()).toBe(clock);
  });

  it("hides one person's devices from another", async () => {
    const hub = await hubWith();
    const mine = await registerBrowser(hub);
    const created = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/auth/users',
      payload: {
        username: 'mem',
        password: 'mem-password-1',
        role: 'member',
        profiles: ['default'],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const login = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'mem', password: 'mem-password-1' },
    });
    const member = (login.json() as { access_token: string }).access_token;
    const list = (await authed(hub, member, { method: 'GET', url: '/api/v1/devices' })).json() as {
      items: Json[];
    };
    expect(list.items).toEqual([]);
    for (const method of ['GET', 'DELETE'] as const) {
      const response = await authed(hub, member, {
        method,
        url: `/api/v1/devices/${mine.id as string}`,
      });
      expect(response.statusCode).toBe(404);
    }
  });
});

describe('devices: push registration and delivery', () => {
  it('pushes a notice to a subscribed browser, and records the delivery', async () => {
    const service = await fakePush();
    const hub = await hubWith();
    const config = (
      await authed(hub, hub.token, { method: 'GET', url: '/api/v1/push/config' })
    ).json() as { webpush_public_key: string; providers: string[] };
    expect(config.providers).toEqual(['webpush']);
    expect(Buffer.from(config.webpush_public_key, 'base64url')).toHaveLength(65);

    const device = await registerBrowser(hub);
    const { subscription } = service.subscribe('laptop');
    const registered = await subscribe(hub, device.id as string, subscription);
    expect(registered.statusCode, registered.body).toBe(200);
    expect(registered.json()).toMatchObject({ provider: 'webpush', locale: 'ar' });

    // The token is sealed at rest and never comes back.
    const row = requireSqlite(hub.app.hub.database)
      .select()
      .from(devices)
      .where(eq(devices.id, device.id as string))
      .get()!;
    expect(row.pushToken).not.toContain(subscription.endpoint);
    const read = await authed(hub, hub.token, {
      method: 'GET',
      url: `/api/v1/devices/${device.id as string}`,
    });
    expect(read.body).not.toContain(subscription.keys.auth);

    const notice = await testNotice(hub);
    expect(notice.statusCode).toBe(201);
    await vi.waitFor(() => expect(service.received).toHaveLength(1));
    expect(service.received[0]!.vapid).toMatchObject({ aud: service.url });
    expect(service.received[0]!.payload).toMatchObject({
      type: 'notice',
      notice_id: (notice.json() as Json).id,
      kind: 'system',
      title: 'إشعار تجريبي',
      profile: 'default',
    });
    await vi.waitFor(() => {
      const rows = requireSqlite(hub.app.hub.database).select().from(notificationDeliveries).all();
      expect(rows).toMatchObject([
        { channel: 'push', deviceId: device.id, status: 'sent', attempts: 1 },
      ]);
    });

    const test = await authed(hub, hub.token, {
      method: 'POST',
      url: `/api/v1/devices/${device.id as string}/push/test`,
    });
    expect(test.json()).toEqual({ provider: 'webpush', status: 'sent', error: null });
  });

  it("follows the person's push switch and quiet hours, and never pushes an unlinked device", async () => {
    const service = await fakePush();
    const hub = await hubWith();
    const device = await registerBrowser(hub);
    await subscribe(hub, device.id as string, service.subscribe('laptop').subscription);

    const prefs = (body: Json) =>
      authed(hub, hub.token, { method: 'PUT', url: '/api/v1/notify/preferences', payload: body });
    const quietOff = { enabled: false, from: '22:00', to: '07:00', timezone: 'UTC' };

    // "system" in the inbox but not by push.
    await prefs({ events: { system: { in_app: true, push: false } }, quiet_hours: quietOff });
    expect((await testNotice(hub)).statusCode).toBe(201);

    // Quiet hours around now, in UTC.
    const hour = new Date().getUTCHours();
    const at = (h: number) => `${String((h + 24) % 24).padStart(2, '0')}:00`;
    await prefs({
      events: { system: { in_app: true, push: true } },
      quiet_hours: { enabled: true, from: at(hour - 1), to: at(hour + 2), timezone: 'UTC' },
    });
    expect((await testNotice(hub)).statusCode).toBe(201);

    // Back on: this one is pushed.
    await prefs({ events: { system: { in_app: true, push: true } }, quiet_hours: quietOff });
    await testNotice(hub);
    await vi.waitFor(() => expect(service.received).toHaveLength(1));

    await authed(hub, hub.token, {
      method: 'DELETE',
      url: `/api/v1/devices/${device.id as string}`,
    });
    await testNotice(hub);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(service.received).toHaveLength(1);
  });

  it('forgets a subscription the push service says is gone', async () => {
    const service = await fakePush();
    const hub = await hubWith();
    const device = await registerBrowser(hub);
    await subscribe(hub, device.id as string, service.subscribe('old').subscription);
    service.answer('old', 410);
    const test = await authed(hub, hub.token, {
      method: 'POST',
      url: `/api/v1/devices/${device.id as string}/push/test`,
    });
    expect(test.json()).toMatchObject({ provider: 'webpush', status: 'failed' });
    const read = await authed(hub, hub.token, {
      method: 'GET',
      url: `/api/v1/devices/${device.id as string}`,
    });
    expect(read.json()).toMatchObject({ push: null });
  });

  it('refuses a private or plain-http endpoint, junk, and a sender that is not configured', async () => {
    const hub = await hubWith();
    const device = await registerBrowser(hub);
    const inside = await subscribe(hub, device.id as string, {
      endpoint: 'https://127.0.0.1/push/x',
      keys: {
        p256dh:
          'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        auth: 'BTBZMqHH6r4Tts7J_aSIgg',
      },
    });
    expect(inside.statusCode).toBe(400);
    expect(inside.json()).toMatchObject({ details: { reason: 'endpoint_refused' } });
    const junk = await authed(hub, hub.token, {
      method: 'PUT',
      url: `/api/v1/devices/${device.id as string}/push`,
      payload: { provider: 'webpush', token: 'nope' },
    });
    expect(junk.statusCode).toBe(400);
    const fcm = await authed(hub, hub.token, {
      method: 'PUT',
      url: `/api/v1/devices/${device.id as string}/push`,
      payload: { provider: 'fcm', token: 'f'.repeat(40) },
    });
    expect(fcm.statusCode).toBe(409);
    expect(fcm.json()).toMatchObject({ details: { reason: 'sender_not_configured' } });
  });

  it("does not let a person point their paired phone's pushes elsewhere", async () => {
    const hub = await hubWith();
    const phone = await pairPhone(hub);
    const response = await subscribe(hub, phone.deviceId, {
      endpoint: 'https://push.example/x',
      keys: { p256dh: 'x', auth: 'y' },
    });
    expect(response.statusCode).toBe(403);
  });
});

/** A hub whose FCM sender is a fake, so a phone can register a token. */
async function fcmHub() {
  const fcm = fakeFcm();
  overrideDevices({ fetchImpl: fcm.fetchImpl, fcmBaseUrl: 'https://fcm.fake' });
  const hub = await hubWith({ COREHUB_FCM_SERVICE_ACCOUNT: serviceAccountJson() });
  return { fcm, hub };
}

/** Another sign-in with a password, as the phone app does when it is not paired. */
async function signIn(hub: Hub, username = 'admin', password = TEST_ADMIN_PASSWORD) {
  const response = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
  });
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { access_token: string }).access_token;
}

/** The iOS path without pairing: the phone registers itself, then its token. */
async function passwordPhone(hub: Hub, token: string, key: string): Promise<string> {
  const device = await authed(hub, token, {
    method: 'POST',
    url: '/api/v1/devices',
    payload: { device_key: key, name: 'iPhone', platform: 'ios', kind: 'phone' },
  });
  // 201 the first time, 200 when the same install registers again.
  expect([200, 201], device.body).toContain(device.statusCode);
  const id = (device.json() as { id: string }).id;
  const push = await authed(hub, token, {
    method: 'PUT',
    url: `/api/v1/devices/${id}/push`,
    payload: { provider: 'fcm', token: `fcm-token-${key}-0123456789` },
  });
  expect(push.statusCode, push.body).toBe(200);
  return id;
}

const pushOf = (hub: Hub, deviceId: string) =>
  requireSqlite(hub.app.hub.database).select().from(devices).where(eq(devices.id, deviceId)).get()!;

describe('devices: a push registration ends with the sign-in that made it', () => {
  it('forgets the token when that sign-in signs out, and keeps the other sign-ins', async () => {
    const { fcm, hub } = await fcmHub();
    const phone = await signIn(hub);
    const id = await passwordPhone(hub, phone, 'iphone-a');
    const kept = await passwordPhone(hub, hub.token, 'iphone-b');
    expect(pushOf(hub, id)).toMatchObject({ pushProvider: 'fcm' });

    const out = await authed(hub, phone, { method: 'POST', url: '/api/v1/auth/logout' });
    expect(out.statusCode).toBe(204);
    expect(pushOf(hub, id)).toMatchObject({ pushProvider: 'none', pushToken: null });
    expect(pushOf(hub, kept)).toMatchObject({ pushProvider: 'fcm' });

    await testNotice(hub);
    await vi.waitFor(() => expect(fcm.sent).toHaveLength(1));
    expect(fcm.sent[0]!.body).toMatchObject({
      message: { token: 'fcm-token-iphone-b-0123456789' },
    });
  });

  it('forgets the other sign-ins’ tokens when the person changes their password', async () => {
    const { hub } = await fcmHub();
    const phone = await signIn(hub);
    const id = await passwordPhone(hub, phone, 'iphone-a');
    const own = await passwordPhone(hub, hub.token, 'iphone-b');
    const changed = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/auth/me/password',
      payload: { current_password: TEST_ADMIN_PASSWORD, new_password: 'owner-password-2' },
    });
    expect(changed.statusCode, changed.body).toBe(204);
    expect(pushOf(hub, id).pushProvider).toBe('none');
    // The sign-in that made the change stays, and so does its phone's token.
    expect(pushOf(hub, own).pushProvider).toBe('fcm');
  });

  it('forgets a person’s tokens when an admin resets their password, disables or deletes them', async () => {
    const { hub } = await fcmHub();
    const created = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/auth/users',
      payload: {
        username: 'mem',
        password: 'mem-password-1',
        role: 'member',
        profiles: ['default'],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const userId = (created.json() as { id: string }).id;
    const patch = (payload: Json) =>
      authed(hub, hub.token, { method: 'PATCH', url: `/api/v1/auth/users/${userId}`, payload });

    const first = await passwordPhone(hub, await signIn(hub, 'mem', 'mem-password-1'), 'mem-1');
    expect((await patch({ password: 'mem-password-2' })).statusCode).toBe(200);
    expect(pushOf(hub, first).pushProvider).toBe('none');

    const second = await passwordPhone(hub, await signIn(hub, 'mem', 'mem-password-2'), 'mem-1');
    expect(second).toBe(first);
    expect(pushOf(hub, first).pushProvider).toBe('fcm');
    expect((await patch({ status: 'disabled' })).statusCode).toBe(200);
    expect(pushOf(hub, first).pushProvider).toBe('none');

    expect((await patch({ status: 'active' })).statusCode).toBe(200);
    await passwordPhone(hub, await signIn(hub, 'mem', 'mem-password-2'), 'mem-1');
    expect(pushOf(hub, first).pushProvider).toBe('fcm');
    const deleted = await authed(hub, hub.token, {
      method: 'DELETE',
      url: `/api/v1/auth/users/${userId}`,
    });
    expect(deleted.statusCode).toBe(204);
    expect(pushOf(hub, first).pushProvider).toBe('none');
  });

  it('pushes nothing through a sign-in that expired, and forgets its token', async () => {
    const { fcm, hub } = await fcmHub();
    const phone = await signIn(hub);
    const id = await passwordPhone(hub, phone, 'iphone-a');
    const session = pushOf(hub, id).pushSessionId!;
    expect(session).toBeTruthy();
    // Nobody signed out: the refresh token simply ran out while the phone was away.
    requireSqlite(hub.app.hub.database)
      .update(appTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(appTokens.id, session))
      .run();

    await testNotice(hub);
    await vi.waitFor(() => expect(pushOf(hub, id).pushProvider).toBe('none'));
    expect(fcm.sent).toHaveLength(0);
  });

  it('forgets a paired phone’s token when it is paired again', async () => {
    const { hub } = await fcmHub();
    const phone = await pairPhone(hub, 'phone-key');
    const registered = await authed(hub, phone.appToken, {
      method: 'PUT',
      url: `/api/v1/devices/${phone.deviceId}/push`,
      payload: { provider: 'fcm', token: 'fcm-registration-token-123' },
    });
    expect(registered.statusCode, registered.body).toBe(200);
    const again = await pairPhone(hub, 'phone-key');
    expect(again.deviceId).toBe(phone.deviceId);
    expect(pushOf(hub, phone.deviceId).pushProvider).toBe('none');
  });

  it('forgets a token FCM calls invalid', async () => {
    const { fcm, hub } = await fcmHub();
    const id = await passwordPhone(hub, hub.token, 'iphone-a');
    fcm.invalid.add('fcm-token-iphone-a-0123456789');
    await testNotice(hub);
    await vi.waitFor(() => expect(pushOf(hub, id).pushProvider).toBe('none'));
  });

  it('forgets a browser’s subscription when its sign-in ends, and takes it again after the next', async () => {
    const service = await fakePush();
    const hub = await hubWith();
    const other = await signIn(hub);
    const device = await authed(hub, other, {
      method: 'POST',
      url: '/api/v1/devices',
      payload: browser(),
    });
    const id = (device.json() as { id: string }).id;
    const laptop = service.subscribe('laptop');
    const put = await subscribe(hub, id, laptop.subscription, other);
    expect(put.statusCode, put.body).toBe(200);
    expect(pushOf(hub, id).pushSessionId).toBeTruthy();
    await authed(hub, other, { method: 'POST', url: '/api/v1/auth/logout' });
    expect(pushOf(hub, id)).toMatchObject({ pushProvider: 'none', pushSessionId: null });
    await testNotice(hub);
    expect(service.received).toHaveLength(0);

    // Signed in again, the web hands the same subscription back (browserPush.ts).
    const again = await signIn(hub);
    const back = await subscribe(hub, id, laptop.subscription, again);
    expect(back.statusCode, back.body).toBe(200);
    await testNotice(hub);
    await vi.waitFor(() => expect(service.received).toHaveLength(1));
  });
});

/** A socket on `/rt/devices` of one sign-in, and every envelope it hears. */
async function deviceSocket(hub: Hub, token: string) {
  if (!hub.app.server.listening) await hub.app.listen({ port: 0, host: '127.0.0.1' });
  const address = hub.app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const socket = connect(`http://127.0.0.1:${port}${REALTIME_NAMESPACES.devices}`, {
    path: SOCKET_PATH,
    transports: ['websocket'],
    auth: { token, profile: 'default' },
  });
  const events: Json[] = [];
  socket.onAny((_event: string, envelope: Json) => events.push(envelope));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  cleanups.push(() => void socket.disconnect());
  const updates = (deviceId: string) =>
    events.filter(
      (e) =>
        e.event === 'device.updated' &&
        (e.payload as { device: { id: string } }).device.id === deviceId,
    );
  return { events, updates };
}

describe('devices: a dropped registration is announced', () => {
  it('says device.updated when a sign-in ends and takes its phone’s token', async () => {
    const { hub } = await fcmHub();
    const web = await deviceSocket(hub, hub.token);
    const phone = await signIn(hub);
    const id = await passwordPhone(hub, phone, 'iphone-a');
    await vi.waitFor(() => expect(web.updates(id).length).toBeGreaterThan(0));
    const before = web.updates(id).length;

    await authed(hub, phone, { method: 'POST', url: '/api/v1/auth/logout' });
    await vi.waitFor(() => expect(web.updates(id).length).toBe(before + 1));
    const last = web.updates(id).at(-1)!;
    expect(last).toMatchObject({
      namespace: '/rt/devices',
      payload: { device: { id, push: null, user_id: hub.userId } },
    });
  });

  it('says device.updated when the push service calls the token dead', async () => {
    const { fcm, hub } = await fcmHub();
    const id = await passwordPhone(hub, hub.token, 'iphone-a');
    const web = await deviceSocket(hub, hub.token);
    fcm.invalid.add('fcm-token-iphone-a-0123456789');
    await testNotice(hub);
    await vi.waitFor(() => expect(web.updates(id)).toHaveLength(1));
    expect(web.updates(id)[0]).toMatchObject({ payload: { device: { id, push: null } } });
  });
});

function serviceAccountJson(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return JSON.stringify({
    type: 'service_account',
    project_id: 'core-hub-test',
    client_email: 'push@core-hub-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    token_uri: 'https://oauth.fake/token',
  });
}

describe('devices: the senders', () => {
  it('shows what each sender needs, and stores FCM credentials from Settings', async () => {
    const hub = await hubWith();
    const list = async () =>
      (
        (await authed(hub, hub.token, { method: 'GET', url: '/api/v1/push/senders' })).json() as {
          items: Json[];
        }
      ).items;
    expect(await list()).toMatchObject([
      { provider: 'webpush', state: 'ready', source: 'generated', missing: [] },
      { provider: 'fcm', state: 'not_configured', missing: ['service_account'] },
      {
        provider: 'apns',
        state: 'not_configured',
        // The hub knows its own app's bundle id, and offers production.
        missing: ['key_id', 'team_id', 'private_key'],
        details: { bundle_id: 'com.twuijri.corehub', environment: 'production' },
      },
    ]);

    const bad = await authed(hub, hub.token, {
      method: 'PUT',
      url: '/api/v1/push/senders/fcm',
      payload: { service_account: '{"project_id":"x"}' },
    });
    expect(bad.statusCode).toBe(400);

    const account = serviceAccountJson();
    const set = await authed(hub, hub.token, {
      method: 'PUT',
      url: '/api/v1/push/senders/fcm',
      payload: { service_account: account },
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toMatchObject({
      state: 'ready',
      source: 'settings',
      details: { project_id: 'core-hub-test', service_account: '[stored]' },
    });
    expect(set.body).not.toContain('PRIVATE KEY');

    const off = await authed(hub, hub.token, {
      method: 'PUT',
      url: '/api/v1/push/senders/fcm',
      payload: { enabled: false, service_account: '[stored]' },
    });
    expect(off.json()).toMatchObject({ state: 'disabled' });

    expect(
      (await authed(hub, hub.token, { method: 'DELETE', url: '/api/v1/push/senders/fcm' }))
        .statusCode,
    ).toBe(204);
    expect((await list())[1]).toMatchObject({ state: 'not_configured' });
    expect(
      (await authed(hub, hub.token, { method: 'DELETE', url: '/api/v1/push/senders/webpush' }))
        .statusCode,
    ).toBe(400);
  });

  it('refuses the wrong file for each sender, saying which it is', async () => {
    const hub = await hubWith();
    const put = (provider: string, payload: unknown) =>
      authed(hub, hub.token, { method: 'PUT', url: `/api/v1/push/senders/${provider}`, payload });
    const googleServices = JSON.stringify({
      project_info: { project_id: 'core-hub-66772', project_number: '1' },
      client: [{ client_info: { android_client_info: { package_name: 'com.twuijri.corehub' } } }],
    });
    const app = await put('fcm', { service_account: googleServices });
    expect(app.statusCode).toBe(400);
    expect(app.body).toContain('google-services.json');
    const user = await put('fcm', {
      service_account: JSON.stringify({ type: 'authorized_user', client_id: 'x' }),
    });
    expect(user.statusCode).toBe(400);
    expect(user.body).toContain('authorized_user');

    // An RSA key parses, but cannot sign an APNs token.
    const { privateKey: rsa } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const wrongKey = await put('apns', {
      key_id: 'ABC123DEFG',
      team_id: 'DEF123GHIJ',
      private_key: rsa.export({ format: 'pem', type: 'pkcs8' }).toString(),
    });
    expect(wrongKey.statusCode).toBe(400);
    expect(wrongKey.body).toContain('EC P-256');
    const notAKey = await put('apns', { key_id: 'ABC123DEFG', private_key: 'hello' });
    expect(notAKey.statusCode).toBe(400);
    expect(notAKey.body).toContain('.p8');
  });

  it('lets the environment win over Settings', async () => {
    const hub = await hubWith({ COREHUB_APNS_KEY_ID: 'ABC123DEFG' });
    const apns = (
      (await authed(hub, hub.token, { method: 'GET', url: '/api/v1/push/senders' })).json() as {
        items: Json[];
      }
    ).items[2];
    expect(apns).toMatchObject({
      source: 'environment',
      state: 'not_configured',
      missing: ['team_id', 'private_key'],
      details: { key_id: 'ABC123DEFG', bundle_id: 'com.twuijri.corehub' },
    });
    const refused = await authed(hub, hub.token, {
      method: 'PUT',
      url: '/api/v1/push/senders/apns',
      payload: { team_id: 'DEF123GHIJ' },
    });
    expect(refused.statusCode).toBe(409);
  });

  it('pushes to an Android phone through FCM configured by the environment', async () => {
    const fcm = fakeFcm();
    overrideDevices({ fetchImpl: fcm.fetchImpl, fcmBaseUrl: 'https://fcm.fake' });
    const hub = await hubWith({ COREHUB_FCM_SERVICE_ACCOUNT: serviceAccountJson() });
    const phone = await pairPhone(hub);
    const registered = await authed(hub, phone.appToken, {
      method: 'PUT',
      url: `/api/v1/devices/${phone.deviceId}/push`,
      payload: { provider: 'fcm', token: 'fcm-registration-token-123' },
    });
    expect(registered.statusCode, registered.body).toBe(200);
    await testNotice(hub);
    await vi.waitFor(() => expect(fcm.sent).toHaveLength(1));
    expect(fcm.sent[0]!.body).toMatchObject({
      message: {
        token: 'fcm-registration-token-123',
        notification: { title: 'إشعار تجريبي' },
        data: { type: 'notice', kind: 'system', profile: 'default' },
      },
    });
  });

  it('pushes to an iPhone through APNs stored in Settings', async () => {
    const apns = await startFakeApns();
    cleanups.push(() => apns.close());
    overrideDevices({ apnsOrigin: apns.origin });
    const hub = await hubWith();
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const set = await authed(hub, hub.token, {
      method: 'PUT',
      url: '/api/v1/push/senders/apns',
      payload: {
        key_id: 'ABC123DEFG',
        team_id: 'DEF123GHIJ',
        // No bundle id: the hub's own app's is the default.
        environment: 'sandbox',
        private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      },
    });
    expect(set.json()).toMatchObject({ state: 'ready', details: { private_key: '[stored]' } });
    const phone = await pairPhone(hub, 'iphone-key', 'ios');
    const token = 'c'.repeat(64);
    await authed(hub, phone.appToken, {
      method: 'PUT',
      url: `/api/v1/devices/${phone.deviceId}/push`,
      payload: { provider: 'apns', token },
    });
    const test = await authed(hub, hub.token, {
      method: 'POST',
      url: `/api/v1/devices/${phone.deviceId}/push/test`,
    });
    expect(test.json()).toEqual({ provider: 'apns', status: 'sent', error: null });
    expect(apns.received[0]).toMatchObject({
      token,
      headers: { 'apns-topic': 'com.twuijri.corehub' },
      body: { aps: { alert: { title: 'إشعار تجريبي' } } },
    });
  });
});
