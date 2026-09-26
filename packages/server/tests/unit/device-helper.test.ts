/**
 * A computer's local helper as the hub knows it (DECISIONS §86, ADR 0025), and the rules that
 * make a hub on a server safe to point at the person's own computer:
 *
 * - only the computer reports what its helper offers, and only its person narrows which
 *   profiles may ask it;
 * - an agent's run may ask the person's own computer for `files` and `apps`, nothing else, and
 *   only from a profile the computer serves;
 * - a computer that is not connected answers "offline" at once instead of a silent wait;
 * - how long a request waits depends on what it asks;
 * - a program's answer is one of its two shapes.
 *
 * Plus the media stream tickets of §87: a ticket plays one attachment with `Range`, and nothing
 * else answers to it.
 */
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { SOCKET_PATH } from '../../src/app/sockets.js';
import { REALTIME_NAMESPACES } from '../../src/lib/module.js';
import { issueRunToken } from '../../src/modules/auth/index.js';
import { StreamTickets, STREAM_TTL_MS } from '../../src/modules/knowledge/streams.js';
import { authed, signedInHub, type TestHub } from './helpers.js';

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

async function pairComputer(h: Hub, capabilities = ['notifications', 'files', 'apps']) {
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
      device: {
        device_key: 'studio-mac',
        name: 'Studio Mac',
        platform: 'macos',
        kind: 'computer',
        capabilities,
      },
    },
  });
  expect(claim.statusCode, claim.body).toBe(201);
  const body = claim.json() as { app_token: string; device: { id: string } };
  return { appToken: body.app_token, deviceId: body.device.id };
}

async function online(h: Hub, token: string): Promise<Socket> {
  if (!h.app.server.listening) await h.app.listen({ port: 0, host: '127.0.0.1' });
  const address = h.app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const socket = connect(`http://127.0.0.1:${port}${REALTIME_NAMESPACES.devices}`, {
    path: SOCKET_PATH,
    transports: ['websocket'],
    auth: { token },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  cleanups.push(() => void socket.disconnect());
  return socket;
}

const HELPER = {
  folders: [{ path: '/Users/me/Core Hub', write: true, default: true }],
  allow_open: false,
  programs: [
    {
      id: 'davinci-resolve',
      name: 'DaVinci Resolve',
      source: 'claude_desktop_extension',
      profiles: ['default'],
      tools: [{ name: 'render', description: 'Render', input_schema: { type: 'object' } }],
    },
  ],
  reported_at: '2020-01-01T00:00:00Z',
};

async function workspaceId(h: Hub, slug = 'default'): Promise<string> {
  const list = await authed(h, h.token, { method: 'GET', url: '/api/v1/profiles' });
  return (list.json() as { items: Array<{ id: string; slug: string }> }).items.find(
    (p) => p.slug === slug,
  )!.id;
}

describe('devices: a computer’s helper and who may ask it', () => {
  it('only the computer reports its helper; the hub stamps when', async () => {
    const h = await hub();
    const mac = await pairComputer(h);
    const byPerson = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/devices/${mac.deviceId}`,
      payload: { helper: HELPER },
    });
    expect(byPerson.statusCode).toBe(403);
    expect(byPerson.json().details.reason).toBe('not_this_device');

    const byDevice = await authed(h, mac.appToken, {
      method: 'PATCH',
      url: `/api/v1/devices/${mac.deviceId}`,
      payload: { helper: HELPER },
    });
    expect(byDevice.statusCode, byDevice.body).toBe(200);
    const device = byDevice.json() as { helper: typeof HELPER; profiles: unknown };
    expect(device.profiles).toBeNull();
    expect(device.helper.programs[0]!.id).toBe('davinci-resolve');
    expect(device.helper.reported_at).not.toBe('2020-01-01T00:00:00Z');

    const off = await authed(h, mac.appToken, {
      method: 'PATCH',
      url: `/api/v1/devices/${mac.deviceId}`,
      payload: { helper: null },
    });
    expect(off.json().helper).toBeNull();
  });

  it('its person narrows the profiles; the computer itself may not; a request elsewhere is refused', async () => {
    const h = await hub();
    const mac = await pairComputer(h);
    const byDevice = await authed(h, mac.appToken, {
      method: 'PATCH',
      url: `/api/v1/devices/${mac.deviceId}`,
      payload: { profiles: ['default'] },
    });
    expect(byDevice.statusCode).toBe(403);
    expect(byDevice.json().details.reason).toBe('not_the_devices_person');

    const created = await authed(h, h.token, {
      method: 'POST',
      url: '/api/v1/profiles',
      payload: { name: 'Work', slug: 'work' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const narrowed = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/devices/${mac.deviceId}`,
      payload: { profiles: ['work', 'work'] },
    });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    expect(narrowed.json().profiles).toEqual(['work']);

    const asked = await authed(h, h.token, {
      method: 'POST',
      url: '/api/v1/device-requests',
      profile: 'default',
      payload: { device_id: mac.deviceId, capability: 'files', params: { tool: 'x' } },
    });
    expect(asked.statusCode).toBe(403);
    expect(asked.json().details).toMatchObject({
      reason: 'device_not_in_profile',
      profile: 'default',
    });

    const back = await authed(h, h.token, {
      method: 'PATCH',
      url: `/api/v1/devices/${mac.deviceId}`,
      payload: { profiles: null },
    });
    expect(back.json().profiles).toBeNull();
  });

  it("an agent's run asks the person's own computer for files and programs, and for nothing else", async () => {
    const h = await hub();
    const mac = await pairComputer(h, ['notifications', 'files', 'apps', 'location']);
    await online(h, mac.appToken);
    const run = issueRunToken({
      userId: h.userId,
      workspaceId: await workspaceId(h),
      runId: '01J8QK3ZR2W7M5N4P6T8V9X0RN',
      sessionId: null,
    });
    const files = await authed(h, run, {
      method: 'POST',
      url: '/api/v1/device-requests',
      payload: {
        device_id: mac.deviceId,
        capability: 'files',
        params: { tool: 'list_allowed_folders' },
      },
    });
    expect(files.statusCode, files.body).toBe(202);
    const request = await authed(h, h.token, {
      method: 'GET',
      url: `/api/v1/device-requests/${files.json().request_id}`,
    });
    expect(request.json()).toMatchObject({
      capability: 'files',
      status: 'pending',
      run_id: '01J8QK3ZR2W7M5N4P6T8V9X0RN',
    });

    const location = await authed(h, run, {
      method: 'POST',
      url: '/api/v1/device-requests',
      payload: { device_id: mac.deviceId, capability: 'location' },
    });
    expect(location.statusCode).toBe(403);
    expect(location.json().details.required_scope).toBe('device');

    // A run may not decide which profiles may ask the computer.
    const narrowing = await authed(h, run, {
      method: 'PATCH',
      url: `/api/v1/devices/${mac.deviceId}`,
      payload: { profiles: [] },
    });
    expect(narrowing.statusCode).toBe(403);
  });

  it('a computer that is not connected answers "offline" at once; one that is waits per capability', async () => {
    const h = await hub();
    const mac = await pairComputer(h);
    const away = await authed(h, h.token, {
      method: 'POST',
      url: '/api/v1/device-requests',
      payload: {
        device_id: mac.deviceId,
        capability: 'apps',
        params: { op: 'status', call_id: 'x' },
      },
    });
    expect(away.statusCode, away.body).toBe(202);
    const failed = (
      await authed(h, h.token, {
        method: 'GET',
        url: `/api/v1/device-requests/${away.json().request_id}`,
      })
    ).json() as Json;
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'unavailable' } });
    expect(String((failed.error as Json).message)).toContain('Studio Mac');

    await online(h, mac.appToken);
    const waits: Record<string, number> = {};
    for (const capability of ['files', 'apps', 'notifications']) {
      const asked = await authed(h, h.token, {
        method: 'POST',
        url: '/api/v1/device-requests',
        payload: { device_id: mac.deviceId, capability, params: {} },
      });
      const row = (
        await authed(h, h.token, {
          method: 'GET',
          url: `/api/v1/device-requests/${asked.json().request_id}`,
        })
      ).json() as { created_at: string; expires_at: string; status: string };
      waits[capability] = Date.parse(row.expires_at) - Date.parse(row.created_at);
    }
    expect(waits).toEqual({ files: 60_000, apps: 120_000, notifications: 30_000 });
  });

  it("a program's answer is finished or still running, nothing else", async () => {
    const h = await hub();
    const mac = await pairComputer(h);
    await online(h, mac.appToken);
    const ask = async () =>
      (
        await authed(h, h.token, {
          method: 'POST',
          url: '/api/v1/device-requests',
          payload: {
            device_id: mac.deviceId,
            capability: 'apps',
            params: { op: 'call', program: 'p', tool: 't', arguments: {} },
          },
        })
      ).json().request_id as string;
    const respond = (id: string, result: Json) =>
      authed(h, mac.appToken, {
        method: 'POST',
        url: `/api/v1/device-requests/${id}/respond`,
        payload: { status: 'fulfilled', result },
      });
    const first = await ask();
    const wrong = await respond(first, { hello: 'world' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().details.reason).toBe('not_a_program_result');
    const running = await respond(first, { state: 'running', call_id: 'c1', progress: null });
    expect(running.statusCode, running.body).toBe(200);
    const second = await ask();
    const done = await respond(second, {
      state: 'done',
      content: [{ type: 'text', text: 'ok' }],
      is_error: false,
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().result.state).toBe('done');
  });
});

describe('attachments: a media stream ticket (§87)', () => {
  it('plays one attachment with Range, without the bearer; an unknown ticket is nothing', async () => {
    const h = await hub();
    const bytes = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypisom'),
      Buffer.alloc(64, 1),
    ]);
    const started = await authed(h, h.token, {
      method: 'POST',
      url: '/api/v1/attachment-uploads',
      payload: { name: 'cut.mp4', mime: 'video/mp4', size_bytes: bytes.length },
    });
    const upload = started.json() as { id: string };
    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/attachment-uploads/${upload.id}?offset=0`,
      headers: {
        authorization: `Bearer ${h.token}`,
        'x-hub-profile': 'default',
        'content-type': 'application/octet-stream',
      },
      payload: bytes,
    });
    const done = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/attachment-uploads/${upload.id}/complete`,
    });
    expect(done.statusCode, done.body).toBe(201);
    const attachment = done.json() as { id: string; kind: string };
    expect(attachment.kind).toBe('video');

    const ticket = await authed(h, h.token, {
      method: 'POST',
      url: `/api/v1/attachments/${attachment.id}/stream`,
    });
    expect(ticket.statusCode, ticket.body).toBe(201);
    const { url } = ticket.json() as { url: string };
    expect(url).toMatch(/^\/api\/v1\/attachment-streams\/[0-9a-f]{64}$/);
    const ranged = await h.app.inject({ method: 'GET', url, headers: { range: 'bytes=4-11' } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.body).toBe('ftypisom');
    expect(ranged.headers['cache-control']).toBe('private, no-store');

    const unknown = await h.app.inject({
      method: 'GET',
      url: `/api/v1/attachment-streams/${'0'.repeat(64)}`,
    });
    expect(unknown.statusCode).toBe(404);
    const missing = await authed(h, h.token, {
      method: 'POST',
      url: '/api/v1/attachments/01J8QK3ZR2W7M5N4P6T8V9X0AT/stream',
    });
    expect(missing.statusCode).toBe(404);
  });

  it('forgets a ticket after its hour', () => {
    let now = 1_000;
    const tickets = new StreamTickets(() => now);
    const { ticket } = tickets.issue({
      attachmentId: 'a',
      workspace: 'w',
      profile: 'default',
      userId: 'u',
    });
    expect(tickets.read(ticket)?.attachmentId).toBe('a');
    now += STREAM_TTL_MS;
    expect(tickets.read(ticket)).toBeNull();
    expect(tickets.read('not-a-ticket')).toBeNull();
  });
});
