/**
 * Capability requests over HTTP and `/rt/devices` (contract decision §14, §74): a person asks
 * their paired phone for its location, only that phone hears `request.created`, only it may
 * answer, and the `device_request` job follows the answer — succeeded, failed on a decline or a
 * timeout, and declined by the hub for a capability the phone never offered. Before this change
 * all four operations were the contract's 501 stub.
 */
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { SOCKET_PATH } from '../../src/app/sockets.js';
import { REALTIME_NAMESPACES } from '../../src/lib/module.js';
import { authed, drainJobs, signedInHub, type TestHub } from './helpers.js';

type Json = Record<string, unknown>;
type Hub = TestHub & { token: string; userId: string };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function hub(): Promise<Hub> {
  const made = await signedInHub();
  cleanups.push(() => made.close());
  return made;
}

/** Pairs a phone the way the app does, declaring what it can do. */
async function pairPhone(h: Hub, capabilities: string[], key = 'phone-key') {
  const created = await authed(h, h.token, {
    method: 'POST',
    url: '/api/v1/auth/pairings',
    payload: { ttl_seconds: 120 },
  });
  const pairing = created.json() as { id: string; code: string };
  const claim = await h.app.inject({
    method: 'POST',
    url: `/api/v1/auth/pairings/${pairing.id}/claim`,
    payload: {
      code: pairing.code,
      device: { device_key: key, name: 'هاتف', platform: 'android', kind: 'phone', capabilities },
    },
  });
  expect(claim.statusCode, claim.body).toBe(201);
  const body = claim.json() as { app_token: string; device: { id: string } };
  return { appToken: body.app_token, deviceId: body.device.id };
}

const ask = (h: Hub, deviceId: string, extra: Json = {}, token = h.token) =>
  authed(h, token, {
    method: 'POST',
    url: '/api/v1/device-requests',
    payload: {
      device_id: deviceId,
      capability: 'location',
      purpose: 'لاقتراح المطاعم القريبة',
      params: { accuracy: 'coarse' },
      ...extra,
    },
  });

const job = async (h: Hub, id: string) =>
  (await authed(h, h.token, { method: 'GET', url: `/api/v1/jobs/${id}` })).json() as Json;

const LOCATION = {
  latitude: 24.7136,
  longitude: 46.6753,
  accuracy_m: 120,
  captured_at: '2026-09-26T10:00:10Z',
};

async function socketOf(h: Hub, token: string): Promise<{ socket: Socket; events: Json[] }> {
  if (!h.app.server.listening) await h.app.listen({ port: 0, host: '127.0.0.1' });
  const address = h.app.server.address();
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
  return { socket, events };
}

const until = async (check: () => boolean, ms = 3000) => {
  const began = Date.now();
  while (!check()) {
    if (Date.now() - began > ms) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe('devices: capability requests', () => {
  it('asks the phone, only the phone hears it, it answers, and the job succeeds', async () => {
    const h = await hub();
    const phone = await pairPhone(h, ['location']);
    const other = await pairPhone(h, ['location'], 'tablet-key');
    const onPhone = await socketOf(h, phone.appToken);
    const onTablet = await socketOf(h, other.appToken);

    const asked = await ask(h, phone.deviceId);
    expect(asked.statusCode, asked.body).toBe(202);
    const { job_id: jobId, request_id: requestId } = asked.json() as {
      job_id: string;
      request_id: string;
    };

    await until(() => onPhone.events.some((e) => e.event === 'request.created'));
    const created = onPhone.events.find((e) => e.event === 'request.created')!;
    expect(created).toMatchObject({
      namespace: '/rt/devices',
      profile: 'default',
      payload: {
        request: {
          id: requestId,
          device_id: phone.deviceId,
          capability: 'location',
          purpose: 'لاقتراح المطاعم القريبة',
          params: { accuracy: 'coarse' },
          status: 'pending',
          job_id: jobId,
          result: null,
          error: null,
        },
      },
    });
    // The other device of the same person is not asked.
    expect(onTablet.events.some((e) => e.event === 'request.created')).toBe(false);

    // The phone catches up the way it would after a reconnect.
    const pending = await authed(h, phone.appToken, {
      method: 'GET',
      url: '/api/v1/device-requests?status=pending',
    });
    expect((pending.json() as { items: Json[] }).items.map((item) => item.id)).toEqual([requestId]);
    const tabletList = await authed(h, other.appToken, {
      method: 'GET',
      url: '/api/v1/device-requests',
    });
    expect((tabletList.json() as { items: Json[] }).items).toEqual([]);

    // Only the addressed device may answer: not the person, not their other device.
    for (const token of [h.token, other.appToken]) {
      const refused = await authed(h, token, {
        method: 'POST',
        url: `/api/v1/device-requests/${requestId}/respond`,
        payload: { status: 'fulfilled', result: LOCATION },
      });
      expect([403, 404]).toContain(refused.statusCode);
    }
    const wrongShape = await authed(h, phone.appToken, {
      method: 'POST',
      url: `/api/v1/device-requests/${requestId}/respond`,
      payload: { status: 'fulfilled', result: { lat: 1 } },
    });
    expect(wrongShape.statusCode).toBe(400);

    const answered = await authed(h, phone.appToken, {
      method: 'POST',
      url: `/api/v1/device-requests/${requestId}/respond`,
      payload: { status: 'fulfilled', result: LOCATION, error: null },
    });
    expect(answered.statusCode, answered.body).toBe(200);
    expect(answered.json()).toMatchObject({ status: 'fulfilled', result: LOCATION, error: null });

    await drainJobs(h.app);
    const done = await job(h, jobId);
    expect(done).toMatchObject({
      kind: 'device_request',
      status: 'succeeded',
      resource: { kind: 'device_request', id: requestId },
      result: { request_id: requestId, status: 'fulfilled' },
    });
    // The location stays in the request, never in the job the whole profile can see.
    expect(JSON.stringify(done)).not.toContain('46.6753');

    await until(() => onPhone.events.some((e) => e.event === 'request.completed'));
    const again = await authed(h, phone.appToken, {
      method: 'POST',
      url: `/api/v1/device-requests/${requestId}/respond`,
      payload: { status: 'denied' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ details: { reason: 'request_not_pending' } });

    const read = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/device-requests/${requestId}`,
    });
    expect(read.json()).toMatchObject({ status: 'fulfilled', result: LOCATION });
  });

  it('a decline fails the job with the fixed code', async () => {
    const h = await hub();
    const phone = await pairPhone(h, ['location']);
    const { job_id: jobId, request_id: requestId } = (await ask(h, phone.deviceId)).json() as {
      job_id: string;
      request_id: string;
    };
    const declined = await authed(h, phone.appToken, {
      method: 'POST',
      url: `/api/v1/device-requests/${requestId}/respond`,
      payload: { status: 'denied' },
    });
    expect(declined.json()).toMatchObject({
      status: 'denied',
      error: { code: 'permission_denied', message: null },
    });
    await drainJobs(h.app);
    expect(await job(h, jobId)).toMatchObject({ status: 'failed' });
  });

  it('declines at once a capability the phone never offered', async () => {
    const h = await hub();
    const phone = await pairPhone(h, ['notifications']);
    const asked = await ask(h, phone.deviceId);
    expect(asked.statusCode).toBe(202);
    const { job_id: jobId, request_id: requestId } = asked.json() as {
      job_id: string;
      request_id: string;
    };
    const read = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/device-requests/${requestId}`,
    });
    expect(read.json()).toMatchObject({ status: 'denied', error: { code: 'unavailable' } });
    await drainJobs(h.app);
    expect(await job(h, jobId)).toMatchObject({ status: 'failed' });
  });

  it('expires an unanswered request with `timeout`', async () => {
    const h = await hub();
    const phone = await pairPhone(h, ['location']);
    const { job_id: jobId, request_id: requestId } = (
      await ask(h, phone.deviceId, { timeout_ms: 1000 })
    ).json() as { job_id: string; request_id: string };
    await drainJobs(h.app);
    const read = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/device-requests/${requestId}`,
    });
    expect(read.json()).toMatchObject({ status: 'expired', error: { code: 'timeout' } });
    expect(await job(h, jobId)).toMatchObject({ status: 'failed' });
    const late = await authed(h, phone.appToken, {
      method: 'POST',
      url: `/api/v1/device-requests/${requestId}/respond`,
      payload: { status: 'fulfilled', result: LOCATION },
    });
    expect(late.statusCode).toBe(409);
  });

  it("nobody asks, reads or lists somebody else's phone", async () => {
    const h = await hub();
    const phone = await pairPhone(h, ['location']);
    const { request_id: requestId } = (await ask(h, phone.deviceId)).json() as {
      request_id: string;
    };
    const member = await authed(h, h.token, {
      method: 'POST',
      url: '/api/v1/auth/users',
      payload: {
        username: 'member1',
        password: 'member-password-1',
        role: 'admin',
        profiles: ['default'],
      },
    });
    expect(member.statusCode, member.body).toBe(201);
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'member1', password: 'member-password-1' },
    });
    const adminToken = (login.json() as { access_token: string }).access_token;

    expect((await ask(h, phone.deviceId, {}, adminToken)).statusCode).toBe(404);
    const read = await authed(h, adminToken, {
      method: 'GET',
      url: `/api/v1/device-requests/${requestId}`,
    });
    expect(read.statusCode).toBe(404);
    const list = await authed(h, adminToken, { method: 'GET', url: '/api/v1/device-requests' });
    expect((list.json() as { items: Json[] }).items).toEqual([]);
  });
});
