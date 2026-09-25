/**
 * The push senders on their own: the Web Push cryptography against RFC 8291's own example,
 * VAPID signatures, and FCM / APNs against fakes on 127.0.0.1 — never a real service.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { generateKeyPairSync, verify } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  encryptPayload,
  loadOrCreateVapidKeys,
  parseSubscription,
  vapidAuthorization,
  generateVapidKeys,
} from './webpush.js';
import {
  apnsSender,
  fcmSender,
  parseServiceAccount,
  webPushSender,
  type PushMessage,
} from './senders.js';
import {
  fakeBrowser,
  fakeFcm,
  startFakeApns,
  startFakePushService,
  verifyVapid,
} from './testing/fake-push.js';

const message: PushMessage = {
  noticeId: '01J8QK3ZR2W7M5N4P6T8V9X0NT',
  kind: 'approval_requested',
  title: 'Hermes ينتظر إذنك',
  body: 'حذف ملف',
  profile: 'work',
  resource: { kind: 'session', id: '01J8QK3ZR2W7M5N4P6T8V9X0SE' },
  urgent: true,
};

const b64 = (value: string) => Buffer.from(value, 'base64url');
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

describe('Web Push cryptography (RFC 8291, RFC 8292)', () => {
  it('encrypts RFC 8291 Appendix A to the byte', () => {
    const body = encryptPayload(
      {
        endpoint: 'https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV',
        keys: {
          p256dh:
            'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
          auth: 'BTBZMqHH6r4Tts7J_aSIgg',
        },
      },
      Buffer.from('When I grow up, I want to be a watermelon'),
      {
        salt: b64('DGv6ra1nlYgDCS1FRnbzlw'),
        ephemeralPrivateKey: b64('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
      },
    );
    expect(body.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('is opened by the browser it was encrypted for', () => {
    const browser = fakeBrowser();
    const body = encryptPayload(
      browser.subscription('https://push.example/x'),
      Buffer.from('مرحبا'),
    );
    expect(browser.open(body)).toBe('مرحبا');
  });

  it('signs VAPID with the hub key, for the push service origin, for less than a day', () => {
    const keys = generateVapidKeys();
    const now = Date.UTC(2026, 8, 25, 9, 0, 0);
    const header = vapidAuthorization(
      'https://fcm.googleapis.com/fcm/send/abc',
      keys,
      'mailto:owner@example.com',
      now,
    );
    expect(header).toMatch(new RegExp(`, k=${keys.publicKey}$`));
    const claims = verifyVapid(header);
    expect(claims).toMatchObject({
      aud: 'https://fcm.googleapis.com',
      sub: 'mailto:owner@example.com',
    });
    expect((claims!.exp as number) - now / 1000).toBeLessThanOrEqual(24 * 60 * 60);
    // Another key does not verify it.
    const other = generateVapidKeys();
    expect(verifyVapid(header.replace(keys.publicKey, other.publicKey))).toBeNull();
  });

  it('makes the hub keys once, in keys/vapid.json, readable by the hub alone', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'corehub-vapid-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const first = loadOrCreateVapidKeys(dir);
    const again = loadOrCreateVapidKeys(dir);
    expect(again).toEqual(first);
    expect(b64(first.publicKey)).toHaveLength(65);
    expect(statSync(path.join(dir, 'keys', 'vapid.json')).mode & 0o777).toBe(0o600);
  });

  it('accepts only a real subscription', () => {
    const good = fakeBrowser().subscription('https://push.example/x');
    expect(parseSubscription(JSON.stringify(good))).toEqual(good);
    expect(parseSubscription('not json')).toBeNull();
    expect(parseSubscription(JSON.stringify({ endpoint: 'https://x' }))).toBeNull();
    expect(
      parseSubscription(JSON.stringify({ ...good, keys: { ...good.keys, p256dh: 'AAAA' } })),
    ).toBeNull();
    expect(
      parseSubscription(JSON.stringify({ ...good, endpoint: 'file:///etc/passwd' })),
    ).toBeNull();
  });
});

describe('the Web Push sender', () => {
  it('delivers an encrypted, signed notice the browser can read', async () => {
    const service = await startFakePushService();
    cleanups.push(() => service.close());
    const { subscription } = service.subscribe('laptop');
    const sender = webPushSender({ keys: generateVapidKeys(), subject: 'mailto:a@example.com' });
    const outcome = await sender.send(JSON.stringify(subscription), message);
    expect(outcome).toMatchObject({ ok: true, gone: false });
    const [received] = service.received;
    expect(received!.headers['content-encoding']).toBe('aes128gcm');
    expect(received!.headers.urgency).toBe('high');
    expect(received!.vapid).toMatchObject({ aud: service.url, sub: 'mailto:a@example.com' });
    expect(received!.payload).toEqual({
      type: 'notice',
      notice_id: message.noticeId,
      kind: 'approval_requested',
      title: message.title,
      body: message.body,
      profile: 'work',
      resource: message.resource,
    });
  });

  it('says a subscription is gone when the push service answers 410', async () => {
    const service = await startFakePushService();
    cleanups.push(() => service.close());
    const { subscription } = service.subscribe('old');
    service.answer('old', 410);
    const sender = webPushSender({ keys: generateVapidKeys(), subject: 'mailto:a@example.com' });
    const outcome = await sender.send(JSON.stringify(subscription), message);
    expect(outcome).toMatchObject({ ok: false, gone: true });
    expect(outcome.error).toMatch(/410/);
  });

  it('refuses an endpoint its check refuses, without calling it', async () => {
    const service = await startFakePushService();
    cleanups.push(() => service.close());
    const { subscription } = service.subscribe('inside');
    const sender = webPushSender({
      keys: generateVapidKeys(),
      subject: 'mailto:a@example.com',
      checkEndpoint: async () => 'private',
    });
    expect(await sender.send(JSON.stringify(subscription), message)).toMatchObject({
      ok: false,
      error: 'private',
    });
    expect(service.received).toHaveLength(0);
  });
});

function serviceAccount(tokenUri = 'https://oauth.fake/token') {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    publicKey,
    json: JSON.stringify({
      type: 'service_account',
      project_id: 'core-hub-test',
      client_email: 'push@core-hub-test.iam.gserviceaccount.com',
      private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      token_uri: tokenUri,
    }),
  };
}

describe('the FCM sender', () => {
  it('reads a service account and names what is missing', () => {
    expect(() => parseServiceAccount('{')).toThrow(/not JSON/);
    expect(() => parseServiceAccount('{"project_id":"x"}')).toThrow(/client_email, private_key/);
    expect(parseServiceAccount(serviceAccount().json)).toMatchObject({
      projectId: 'core-hub-test',
      tokenUri: 'https://oauth.fake/token',
    });
  });

  it('signs in with a JWT the service account signed, then sends the v1 message', async () => {
    const account = serviceAccount();
    const fcm = fakeFcm();
    const sender = fcmSender(parseServiceAccount(account.json), {
      fetchImpl: fcm.fetchImpl,
      baseUrl: 'https://fcm.fake',
    });
    expect(await sender.send('fcm-token-aaaaaaaaaaaaaaaa', message)).toMatchObject({
      ok: true,
      providerRef: 'projects/core-hub-test/messages/1',
    });
    await sender.send('fcm-token-aaaaaaaaaaaaaaaa', { ...message, urgent: false });

    // One sign-in for both: the access token is reused.
    expect(fcm.signIns).toBe(1);
    const [head, claims, signature] = fcm.assertions[0]!.split('.');
    expect(
      verify(
        'sha256',
        Buffer.from(`${head}.${claims}`),
        account.publicKey,
        Buffer.from(signature!, 'base64url'),
      ),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toMatchObject({
      iss: 'push@core-hub-test.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth.fake/token',
    });

    expect(fcm.sent[0]).toMatchObject({
      project: 'core-hub-test',
      authorization: 'Bearer fake-access-1',
      body: {
        message: {
          token: 'fcm-token-aaaaaaaaaaaaaaaa',
          notification: { title: message.title, body: message.body },
          // FCM data values are strings, so the resource is flattened.
          data: {
            type: 'notice',
            kind: 'approval_requested',
            notice_id: message.noticeId,
            profile: 'work',
            resource_kind: 'session',
            resource_id: message.resource!.id,
          },
          android: { priority: 'high', notification: { channel_id: 'notices' } },
        },
      },
    });
    expect(fcm.sent[1]!.body).toMatchObject({ message: { android: { priority: 'normal' } } });
  });

  it('says a token is gone when FCM answers UNREGISTERED', async () => {
    const fcm = fakeFcm();
    fcm.unregistered.add('fcm-token-bbbbbbbbbbbbbbbb');
    const sender = fcmSender(parseServiceAccount(serviceAccount().json), {
      fetchImpl: fcm.fetchImpl,
      baseUrl: 'https://fcm.fake',
    });
    expect(await sender.send('fcm-token-bbbbbbbbbbbbbbbb', message)).toMatchObject({
      ok: false,
      gone: true,
      error: expect.stringMatching(/UNREGISTERED/),
    });
  });
});

function apnsKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), publicKey };
}

describe('the APNs sender', () => {
  it('sends over HTTP/2 with a provider token, the topic and an alert', async () => {
    const apns = await startFakeApns();
    const key = apnsKey();
    const sender = apnsSender(
      {
        keyId: 'ABC123DEFG',
        teamId: 'DEF123GHIJ',
        bundleId: 'com.twuijri.corehub',
        privateKey: key.pem,
        environment: 'sandbox',
      },
      { origin: apns.origin },
    );
    cleanups.push(async () => {
      sender.close?.();
      await apns.close();
    });
    const token = 'a'.repeat(64);
    expect(await sender.send(token, message)).toMatchObject({ ok: true, providerRef: 'apns-1' });
    await sender.send(token, { ...message, urgent: false });

    const [first, second] = apns.received;
    expect(first!.token).toBe(token);
    expect(first!.headers).toMatchObject({
      'apns-topic': 'com.twuijri.corehub',
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-collapse-id': message.noticeId,
    });
    const bearer = String(first!.headers.authorization).replace('bearer ', '');
    const [head, claims, signature] = bearer.split('.');
    expect(JSON.parse(Buffer.from(head!, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'ABC123DEFG',
    });
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toMatchObject({
      iss: 'DEF123GHIJ',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${head}.${claims}`),
        { key: key.publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature!, 'base64url'),
      ),
    ).toBe(true);
    // The provider token is reused, not minted per message (Apple limits renewals).
    expect(second!.headers.authorization).toBe(first!.headers.authorization);
    expect(first!.body).toMatchObject({
      aps: {
        alert: { title: message.title, body: message.body },
        'thread-id': 'work',
        'interruption-level': 'time-sensitive',
      },
      type: 'notice',
      notice_id: message.noticeId,
      resource: message.resource,
    });
    expect(second!.body).toMatchObject({ aps: { 'interruption-level': 'active' } });
  });

  it('forgets a token Apple says is unregistered, and refuses one that is not hex', async () => {
    const apns = await startFakeApns();
    const sender = apnsSender(
      {
        keyId: 'ABC123DEFG',
        teamId: 'DEF123GHIJ',
        bundleId: 'com.twuijri.corehub',
        privateKey: apnsKey().pem,
        environment: 'production',
      },
      { origin: apns.origin },
    );
    cleanups.push(async () => {
      sender.close?.();
      await apns.close();
    });
    apns.unregistered.add('b'.repeat(64));
    expect(await sender.send('b'.repeat(64), message)).toMatchObject({
      ok: false,
      gone: true,
      error: 'APNs: Unregistered (410)',
    });
    expect(await sender.send('not-a-token', message)).toMatchObject({ ok: false, gone: true });
    expect(apns.received).toHaveLength(1);
  });
});
