import { eq } from 'drizzle-orm';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModuleDb } from '../../lib/db.js';
import { REALTIME_NAMESPACES } from '../../lib/module.js';
import { testHub, type TestHub } from '../../../tests/unit/helpers.js';
import { claimPairing, createPairing, generatePairingCode, normalizeCode } from './pairing.js';
import { appTokens } from './schema.js';
import { pairingStatus } from './serialize.js';
import { findUserByUsername } from './users.js';

const PASSWORD = 'pairing-test-password';
const device = {
  deviceKey: 'key-1',
  name: 'Pixel',
  platform: 'android' as const,
  kind: 'phone' as const,
  brand: 'Google',
  model: 'Pixel 9',
  appVersion: '1.0.0',
  capabilities: ['camera' as const],
  connection: 'lan' as const,
};

describe('auth: pairing', () => {
  let hub: TestHub;
  let db: ModuleDb;
  let ownerId: string;
  let accessToken: string;
  let baseUrl: string;

  beforeAll(async () => {
    hub = await testHub({ HUB_ADMIN_PASSWORD: PASSWORD });
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const address = hub.app.server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    db = hub.app.hub.database.db as ModuleDb;
    ownerId = findUserByUsername(db, 'admin')!.id;
    const login = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: PASSWORD },
    });
    accessToken = login.json().access_token;
  });
  afterAll(async () => {
    await hub.close();
  });

  it('generates typeable codes without ambiguous characters', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generatePairingCode();
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    }
    expect(normalizeCode(' 7kq2-m9xw ')).toBe('7KQ2M9XW');
  });

  it('expires after its ttl and cannot be claimed once expired', () => {
    const now = Date.now();
    const row = createPairing(
      db,
      {
        userId: ownerId,
        connection: 'lan',
        ttlSeconds: 60,
        hubUrl: 'http://hub',
        initialWorkspaceId: null,
      },
      now,
    );
    expect(pairingStatus(row, now)).toBe('pending');
    expect(pairingStatus(row, now + 59_000)).toBe('pending');
    expect(pairingStatus(row, now + 60_000)).toBe('expired');
    expect(() =>
      claimPairing(db, { pairingId: row.id, code: row.code, device, ip: '10.0.0.1' }, now + 60_000),
    ).toThrowError(expect.objectContaining({ code: 'not_found' }));
  });

  it('is claimed exactly once, with the right code, and issues a device-bound token', () => {
    const now = Date.now();
    const row = createPairing(
      db,
      {
        userId: ownerId,
        connection: 'lan',
        ttlSeconds: 300,
        hubUrl: 'http://hub',
        initialWorkspaceId: null,
      },
      now,
    );
    expect(() =>
      claimPairing(db, { pairingId: row.id, code: 'AAAA-AAAA', device, ip: '10.0.0.2' }, now),
    ).toThrowError(expect.objectContaining({ code: 'unauthorized' }));
    const result = claimPairing(
      db,
      { pairingId: row.id, code: row.code.toLowerCase(), device, ip: '10.0.0.2' },
      now,
    );
    expect(result.token).toMatch(/^hub_at_/);
    expect(result.device.deviceKey).toBe('key-1');
    expect(result.device.appTokenId).toBe(result.tokenId);
    expect(pairingStatus(result.pairing, now)).toBe('claimed');
    expect(() =>
      claimPairing(db, { pairingId: row.id, code: row.code, device, ip: '10.0.0.2' }, now),
    ).toThrowError(expect.objectContaining({ code: 'conflict' }));
  });

  it('re-pairing the same device_key updates the row and revokes the previous token', () => {
    const now = Date.now();
    const pairing = () =>
      createPairing(
        db,
        {
          userId: ownerId,
          connection: 'lan',
          ttlSeconds: 300,
          hubUrl: 'http://hub',
          initialWorkspaceId: null,
        },
        now,
      );
    const dev = { ...device, deviceKey: 'key-repair' };
    const p1 = pairing();
    const first = claimPairing(
      db,
      { pairingId: p1.id, code: p1.code, device: dev, ip: '10.0.0.3' },
      now,
    );
    const p2 = pairing();
    const second = claimPairing(
      db,
      {
        pairingId: p2.id,
        code: p2.code,
        device: { ...dev, name: 'Pixel renamed' },
        ip: '10.0.0.3',
      },
      now + 1000,
    );
    expect(second.device.id).toBe(first.device.id);
    expect(second.device.name).toBe('Pixel renamed');
    expect(second.device.appTokenId).toBe(second.tokenId);
    expect(second.tokenId).not.toBe(first.tokenId);
    const previous = db.select().from(appTokens).where(eq(appTokens.id, first.tokenId)).get();
    expect(previous?.revokedAt).toBeInstanceOf(Date);
  });

  it('over HTTP: the web creates the QR, the phone claims it, the web hears pairing.claimed', async () => {
    const socket = connect(`${baseUrl}${REALTIME_NAMESPACES.devices}`, {
      path: '/rt',
      transports: ['websocket'],
      auth: { token: accessToken },
    });
    const claimedEvent = new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once('pairing.claimed', resolve);
      socket.once('connect_error', reject);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });

    const created = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/pairings',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { ttl_seconds: 120 },
    });
    expect(created.statusCode).toBe(201);
    const pairing = created.json();
    expect(JSON.parse(pairing.qr_payload)).toMatchObject({
      type: 'corehub.pairing',
      code: pairing.code,
    });

    const wrong = await hub.app.inject({
      method: 'POST',
      url: `/api/v1/auth/pairings/${pairing.id}/claim`,
      payload: {
        code: 'ZZZZ-ZZZZ',
        device: { device_key: 'k', name: 'p', platform: 'ios', kind: 'phone' },
      },
    });
    expect(wrong.statusCode).toBe(401);

    const claim = await hub.app.inject({
      method: 'POST',
      url: `/api/v1/auth/pairings/${pairing.id}/claim`,
      payload: {
        code: pairing.code,
        device: {
          device_key: 'phone-key',
          name: 'هاتف',
          platform: 'ios',
          kind: 'phone',
          capabilities: ['camera'],
        },
      },
    });
    expect(claim.statusCode).toBe(201);
    const result = claim.json();
    expect(result.app_token).toMatch(/^hub_at_/);
    expect(result.device.this_device).toBe(true);
    expect(result.user.id).toBe(ownerId);
    expect(result.server.setup_required).toBe(false);

    const event = await claimedEvent;
    expect(event).toMatchObject({
      event: 'pairing.claimed',
      namespace: '/rt/devices',
      profile: null,
    });
    expect((event.payload as { device: { id: string } }).device.id).toBe(result.device.id);
    socket.disconnect();

    // the app token authenticates the phone as the owner; a second claim is a conflict
    const me = await hub.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${result.app_token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().id).toBe(ownerId);
    const again = await hub.app.inject({
      method: 'POST',
      url: `/api/v1/auth/pairings/${pairing.id}/claim`,
      payload: {
        code: pairing.code,
        device: { device_key: 'phone-key', name: 'x', platform: 'ios', kind: 'phone' },
      },
    });
    expect(again.statusCode).toBe(409);

    // revoking the token unlinks the device and the token stops working
    const revoke = await hub.app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/app-tokens/${result.token_id}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(revoke.statusCode).toBe(204);
    const after = await hub.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${result.app_token}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it('refuses a socket that presents an invalid token', async () => {
    const socket = connect(`${baseUrl}${REALTIME_NAMESPACES.devices}`, {
      path: '/rt',
      transports: ['websocket'],
      auth: { token: 'hub_at_not_a_real_token' },
    });
    const error = await new Promise<Error>((resolve) => {
      socket.once('connect_error', resolve);
    });
    expect(error.message).toBe('unauthorized');
    socket.disconnect();
  });
});
