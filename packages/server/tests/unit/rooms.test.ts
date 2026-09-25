/**
 * Rooms, part 1 (DECISIONS §57): who is in a room, who may do what, invite codes, seats and
 * the transcript — through the real routes, with `sessions` composed on a scripted runner so
 * a seat's conversation is real.
 */
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SOCKET_PATH } from '../../src/app/sockets.js';
import { modules as defaultModules } from '../../src/modules/index.js';
import { principalScopeResolver } from '../../src/modules/auth/index.js';
import { createSessionsModule } from '../../src/modules/sessions/index.js';
import {
  FakeAgentDirectory,
  FakeAgentRunner,
  fakeHermes,
} from '../../src/modules/sessions/testing/fake-runner.js';
import { authed, signedInHub } from './helpers.js';

type Json = Record<string, unknown>;
type Hub = Awaited<ReturnType<typeof signedInHub>>;
const AGENT = '01KAGENTXYZ000000000000000';
const OFFLINE = '01KAGENTXFF000000000000000';
const MISSING = '01KAGENTNAWAY0000000000000';

let hub: Hub;
const tokens: Record<string, string> = {};

async function call(
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
  profile = 'default',
) {
  const res = await authed(hub, token, {
    method,
    url: `/api/v1${url}`,
    profile,
    ...(payload === undefined ? {} : { payload }),
  });
  return { status: res.statusCode, body: (res.body ? res.json() : {}) as Json };
}

async function login(username: string, password: string): Promise<string> {
  const res = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
  });
  return (res.json() as { access_token: string }).access_token;
}

async function newRoom(name: string, seats: Json[] = []) {
  const res = await call(tokens.owner!, 'POST', '/rooms', { name, seats });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { room: Json & { id: string; invite_code: string }; seat_results: Json[] };
}

const seat = (name: string, extra: Json = {}) => ({ agent_id: AGENT, name, ...extra });

beforeAll(async () => {
  const directory = new FakeAgentDirectory([
    fakeHermes(AGENT),
    { ...fakeHermes(OFFLINE), available: false, unavailableReason: 'not_installed' },
  ]);
  const sessions = createSessionsModule({
    agents: directory,
    runner: new FakeAgentRunner({ script: [{ type: 'completed' }] }),
    agentTimeoutMs: 5_000,
    scopes: principalScopeResolver,
  });
  hub = await signedInHub(
    {},
    { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
  );
  tokens.owner = hub.token;
  expect(
    (await call(tokens.owner, 'POST', '/profiles', { slug: 'studio', name: 'Studio' })).status,
  ).toBe(201);
  for (const [username, profiles] of [
    ['sara', ['default']],
    ['omar', ['studio']],
  ] as const) {
    const created = await call(tokens.owner, 'POST', '/auth/users', {
      username,
      password: `${username}-password-1`,
      role: 'member',
      profiles,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    tokens[username] = await login(username, `${username}-password-1`);
  }
});

afterAll(async () => {
  await hub?.close();
});

describe('rooms: making one', () => {
  it('makes the room with its seats; its maker manages it and the first seat leads', async () => {
    const { room, seat_results } = await newRoom('غرفة الإطلاق', [
      seat('المخطِّط', { description: 'يضع الخطة', instructions: 'كن موجزًا' }),
      seat('المبرمج', { model: 'hermes-4-large' }),
    ]);
    expect(seat_results).toEqual([
      { id: expect.any(String), ok: true, error: null },
      { id: expect.any(String), ok: true, error: null },
    ]);
    expect(room).toMatchObject({
      name: 'غرفة الإطلاق',
      can_manage: true,
      member_count: 1,
      archived_at: null,
      lead_seat_id: seat_results[0]!.id,
    });
    expect(room.invite_code).toMatch(/^[A-Z2-9]{8}$/);
    const seats = room.seats as Json[];
    expect(seats.map((s) => [s.name, s.instructions, s.model, s.status])).toEqual([
      ['المخطِّط', 'كن موجزًا', null, 'idle'],
      ['المبرمج', null, 'hermes-4-large', 'idle'],
    ]);
  });

  it('opens a conversation for each seat that stays out of the chats list', async () => {
    const before = await call(tokens.owner!, 'GET', '/sessions?source=room');
    const count = (before.body.items as Json[]).length;
    await newRoom('غرفة', [seat('وحيد')]);
    const after = await call(tokens.owner!, 'GET', '/sessions?source=room');
    const rows = after.body.items as Json[];
    expect(rows.length).toBe(count + 1);
    expect(rows[0]).toMatchObject({ source: 'room', agent_id: AGENT });
  });

  it('still makes the room when a seat cannot be made, and says which and why', async () => {
    const { room, seat_results } = await newRoom('غرفة ناقصة', [
      seat('موجود'),
      { agent_id: MISSING, name: 'غائب' },
      { agent_id: OFFLINE, name: 'مطفأ' },
    ]);
    expect(seat_results.map((r) => [r.ok, (r.error as Json | null)?.code ?? null])).toEqual([
      [true, null],
      [false, 'not_found'],
      [false, 'agent_unavailable'],
    ]);
    expect((room.seats as Json[]).map((s) => s.name)).toEqual(['موجود']);
  });

  it('keeps seat names unique in the room, ignoring case, and keeps `all` for @all', async () => {
    const { room } = await newRoom('Names', [seat('Reviewer')]);
    const again = await call(tokens.owner!, 'POST', `/rooms/${room.id}/seats`, seat('reviewer'));
    expect(again.status).toBe(409);
    expect(again.body.details).toMatchObject({ reason: 'seat_name_taken' });
    const all = await call(tokens.owner!, 'POST', `/rooms/${room.id}/seats`, seat('ALL'));
    expect(all.status).toBe(400);
    const second = await call(tokens.owner!, 'POST', `/rooms/${room.id}/seats`, seat('Coder'));
    expect(second.status).toBe(201);
    const rename = await call(
      tokens.owner!,
      'PATCH',
      `/rooms/${room.id}/seats/${String(second.body.id)}`,
      { name: 'REVIEWER' },
    );
    expect(rename.status).toBe(409);
  });
});

describe('rooms: who may do what', () => {
  it('a room is invisible to a person who is not in it, even in the same profile', async () => {
    const { room } = await newRoom('سرية');
    expect((await call(tokens.sara!, 'GET', `/rooms/${room.id}`)).status).toBe(404);
    const list = await call(tokens.sara!, 'GET', '/rooms');
    expect((list.body.items as Json[]).some((r) => r.id === room.id)).toBe(false);
    expect((await call(tokens.sara!, 'GET', `/rooms/${room.id}/messages`)).status).toBe(404);
  });

  it('joining by code lets the person in, as a member who does not manage', async () => {
    const { room } = await newRoom('مفتوحة', [seat('المساعد')]);
    const preview = await call(tokens.sara!, 'GET', `/room-invites/${room.invite_code}`);
    expect(preview.status).toBe(200);
    expect(preview.body).toEqual({
      room_id: room.id,
      profile: 'default',
      name: 'مفتوحة',
      seat_count: 1,
      member_count: 1,
      already_member: false,
    });
    const joined = await call(tokens.sara!, 'POST', `/room-invites/${room.invite_code}/join`, {});
    expect(joined.status).toBe(200);
    expect(joined.body).toMatchObject({
      id: room.id,
      can_manage: false,
      invite_code: null,
      member_count: 2,
    });
    // A second join is the same answer, not an error.
    const twice = await call(tokens.sara!, 'POST', `/room-invites/${room.invite_code}/join`, {});
    expect(twice.status).toBe(200);
    expect(twice.body.member_count).toBe(2);

    const members = await call(tokens.sara!, 'GET', `/rooms/${room.id}/members`);
    expect((members.body.items as Json[]).map((m) => [m.role, m.name])).toEqual([
      ['owner', 'Admin'],
      ['member', 'sara'],
    ]);

    // Only the maker manages it.
    for (const [method, url, body] of [
      ['PATCH', `/rooms/${room.id}`, { name: 'x' }],
      ['POST', `/rooms/${room.id}/invite-code`, undefined],
      ['POST', `/rooms/${room.id}/seats`, seat('ثانٍ')],
      ['DELETE', `/rooms/${room.id}`, undefined],
    ] as const) {
      expect((await call(tokens.sara!, method, url, body)).status, `${method} ${url}`).toBe(403);
    }
    // But a member may post and read.
    const posted = await call(tokens.sara!, 'POST', `/rooms/${room.id}/messages`, {
      content: [{ type: 'text', text: 'مرحبا' }],
    });
    expect(posted.status).toBe(202);
  });

  it('an invite code never opens a profile the person was not given', async () => {
    const { room } = await newRoom('في الافتراضي');
    expect(
      (await call(tokens.omar!, 'GET', `/room-invites/${room.invite_code}`, undefined, 'studio'))
        .status,
    ).toBe(404);
    expect(
      (await call(tokens.omar!, 'POST', `/room-invites/${room.invite_code}/join`, {}, 'studio'))
        .status,
    ).toBe(404);
  });

  it('a new code retires the old one', async () => {
    const { room } = await newRoom('تدوير');
    const rotated = await call(tokens.owner!, 'POST', `/rooms/${room.id}/invite-code`);
    expect(rotated.status).toBe(200);
    expect(rotated.body.invite_code).not.toBe(room.invite_code);
    expect(String(rotated.body.join_url)).toMatch(
      new RegExp(`/join/${String(rotated.body.invite_code)}$`),
    );
    expect((await call(tokens.sara!, 'GET', `/room-invites/${room.invite_code}`)).status).toBe(404);
    expect(
      (await call(tokens.sara!, 'GET', `/room-invites/${String(rotated.body.invite_code)}`)).status,
    ).toBe(200);
  });

  it('a member may leave, the manager may remove, and the maker stays', async () => {
    const { room } = await newRoom('مغادرة');
    await call(tokens.sara!, 'POST', `/room-invites/${room.invite_code}/join`, {});
    const members = (await call(tokens.owner!, 'GET', `/rooms/${room.id}/members`)).body
      .items as Json[];
    const owner = members.find((m) => m.role === 'owner')!;
    const sara = members.find((m) => m.role === 'member')!;
    expect(
      (await call(tokens.sara!, 'DELETE', `/rooms/${room.id}/members/${String(owner.id)}`)).status,
    ).toBe(403);
    expect(
      (await call(tokens.owner!, 'DELETE', `/rooms/${room.id}/members/${String(owner.id)}`)).status,
    ).toBe(403);
    expect(
      (await call(tokens.sara!, 'DELETE', `/rooms/${room.id}/members/${String(sara.id)}`)).status,
    ).toBe(204);
    expect((await call(tokens.sara!, 'GET', `/rooms/${room.id}`)).status).toBe(404);
  });
});

describe('rooms: the transcript', () => {
  it('stores a message with its mentions and pages back through the room', async () => {
    const { room } = await newRoom('نقاش', [seat('أ'), seat('ب')]);
    const seats = room.seats as Array<Json & { id: string }>;
    // Nobody leads here, so a message that mentions nobody wakes nobody.
    await call(tokens.owner!, 'PATCH', `/rooms/${room.id}`, { lead_seat_id: null });
    for (let i = 1; i <= 3; i += 1) {
      const res = await call(tokens.owner!, 'POST', `/rooms/${room.id}/messages`, {
        content: [{ type: 'text', text: `رسالة ${i}` }],
      });
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ message_id: expect.any(String), runs: [] });
    }
    const last = await call(tokens.owner!, 'GET', `/rooms/${room.id}/messages?limit=2`);
    const items = last.body.items as Json[];
    expect(items.map((m) => [m.seq, m.role, (m.content as Json[])[0]])).toEqual([
      [2, 'user', { type: 'text', text: 'رسالة 2' }],
      [3, 'user', { type: 'text', text: 'رسالة 3' }],
    ]);
    expect(items[0]).toMatchObject({
      room_id: room.id,
      session_id: room.id,
      author: { kind: 'user', name: 'Admin' },
    });
    expect(last.body.has_more).toBe(true);
    const older = await call(
      tokens.owner!,
      'GET',
      `/rooms/${room.id}/messages?limit=2&before=${String(items[0]!.id)}`,
    );
    expect((older.body.items as Json[]).map((m) => m.seq)).toEqual([1]);
    expect(older.body.has_more).toBe(false);

    const mentioned = await call(tokens.owner!, 'POST', `/rooms/${room.id}/messages`, {
      content: [{ type: 'text', text: '@ب رأيك؟' }],
      mentions: [{ kind: 'seat', seat_id: seats[1]!.id }],
    });
    const stored = (
      (await call(tokens.owner!, 'GET', `/rooms/${room.id}/messages`)).body.items as Json[]
    ).find((m) => m.id === mentioned.body.message_id);
    expect(stored!.mentions).toEqual([{ kind: 'seat', seat_id: seats[1]!.id }]);
  });

  it('refuses a mention of a seat not in the room, and @all when the room says no', async () => {
    const { room } = await newRoom('قيود', [seat('وحيد')]);
    const stranger = await call(tokens.owner!, 'POST', `/rooms/${room.id}/messages`, {
      content: [{ type: 'text', text: 'hi' }],
      mentions: [{ kind: 'seat', seat_id: MISSING }],
    });
    expect(stranger.status).toBe(404);
    await call(tokens.owner!, 'PATCH', `/rooms/${room.id}`, { can_mention_all: false });
    const all = await call(tokens.owner!, 'POST', `/rooms/${room.id}/messages`, {
      content: [{ type: 'text', text: 'hi all' }],
      mentions: [{ kind: 'all', seat_id: null }],
    });
    expect(all.status).toBe(400);
    expect(all.body.details).toMatchObject({ reason: 'mention_all_disabled' });
  });

  it('an archived room is listed apart and refuses new messages until it is back', async () => {
    const { room } = await newRoom('أرشيف');
    const archived = await call(tokens.owner!, 'PATCH', `/rooms/${room.id}`, {
      archived: true,
      name: 'أرشيف قديم',
    });
    expect(archived.status).toBe(200);
    expect(archived.body.archived_at).toEqual(expect.any(String));
    expect(archived.body.name).toBe('أرشيف قديم');
    const active = (await call(tokens.owner!, 'GET', '/rooms')).body.items as Json[];
    expect(active.some((r) => r.id === room.id)).toBe(false);
    const old = (await call(tokens.owner!, 'GET', '/rooms?archived=true')).body.items as Json[];
    expect(old.map((r) => r.id)).toContain(room.id);
    const refused = await call(tokens.owner!, 'POST', `/rooms/${room.id}/messages`, {
      content: [{ type: 'text', text: 'hi' }],
    });
    expect(refused.status).toBe(409);
    await call(tokens.owner!, 'PATCH', `/rooms/${room.id}`, { archived: false });
    expect(
      (
        await call(tokens.owner!, 'POST', `/rooms/${room.id}/messages`, {
          content: [{ type: 'text', text: 'hi' }],
        })
      ).status,
    ).toBe(202);
  });
});

describe('rooms: seats and the lead', () => {
  it('a removed seat leaves, its words stay, and the next seat leads', async () => {
    const { room } = await newRoom('قيادة', [seat('الأول'), seat('الثاني')]);
    const [first, second] = room.seats as Array<Json & { id: string }>;
    expect(room.lead_seat_id).toBe(first!.id);
    expect(
      (await call(tokens.owner!, 'DELETE', `/rooms/${room.id}/seats/${first!.id}`)).status,
    ).toBe(204);
    const after = await call(tokens.owner!, 'GET', `/rooms/${room.id}`);
    expect(after.body.lead_seat_id).toBe(second!.id);
    expect((after.body.seats as Json[]).map((s) => s.name)).toEqual(['الثاني']);
    // Nobody leads when the manager says so; a seat that is not in the room cannot lead.
    expect(
      (await call(tokens.owner!, 'PATCH', `/rooms/${room.id}`, { lead_seat_id: null })).body
        .lead_seat_id,
    ).toBeNull();
    expect(
      (await call(tokens.owner!, 'PATCH', `/rooms/${room.id}`, { lead_seat_id: first!.id })).status,
    ).toBe(404);
  });

  it('clones a room: the same seats and settings, no messages, a new code', async () => {
    const { room } = await newRoom('أصل', [seat('المراجع', { instructions: 'دقيق' })]);
    await call(tokens.owner!, 'POST', `/rooms/${room.id}/messages`, {
      content: [{ type: 'text', text: 'x' }],
    });
    const cloned = await call(tokens.owner!, 'POST', `/rooms/${room.id}/clone`, { name: 'نسخة' });
    expect(cloned.status).toBe(201);
    expect(cloned.body).toMatchObject({ name: 'نسخة', last_active_at: null });
    expect(cloned.body.invite_code).not.toBe(room.invite_code);
    expect((cloned.body.seats as Json[]).map((s) => [s.name, s.instructions])).toEqual([
      ['المراجع', 'دقيق'],
    ]);
    const messages = await call(tokens.owner!, 'GET', `/rooms/${String(cloned.body.id)}/messages`);
    expect(messages.body.items).toEqual([]);
  });

  it('deletes a room for good', async () => {
    const { room } = await newRoom('زائلة');
    expect((await call(tokens.owner!, 'DELETE', `/rooms/${room.id}`)).status).toBe(204);
    expect((await call(tokens.owner!, 'GET', `/rooms/${room.id}`)).status).toBe(404);
    expect((await call(tokens.sara!, 'GET', `/room-invites/${room.invite_code}`)).status).toBe(404);
  });
});

describe('seat presets', () => {
  it('saves, lists, edits and deletes a preset, and says when its agent cannot run', async () => {
    const made = await call(tokens.owner!, 'POST', '/seat-presets', {
      name: 'مراجع',
      seat: seat('المراجع', { instructions: 'راجع' }),
    });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: 'مراجع', agent_id: AGENT, available: true });
    const offline = await call(tokens.owner!, 'POST', '/seat-presets', {
      name: 'مطفأ',
      seat: { agent_id: OFFLINE, name: 'X' },
    });
    expect(offline.body).toMatchObject({ available: false, validation_error: 'not_installed' });
    const edited = await call(tokens.owner!, 'PATCH', `/seat-presets/${String(made.body.id)}`, {
      name: 'مراجع دقيق',
    });
    expect(edited.body.name).toBe('مراجع دقيق');
    const list = await call(tokens.owner!, 'GET', '/seat-presets');
    expect((list.body.items as Json[]).map((p) => p.name)).toEqual(['مراجع دقيق', 'مطفأ']);
    expect(
      (await call(tokens.owner!, 'DELETE', `/seat-presets/${String(made.body.id)}`)).status,
    ).toBe(204);
    expect(
      (await call(tokens.owner!, 'DELETE', `/seat-presets/${String(made.body.id)}`)).status,
    ).toBe(404);
  });
});

describe('rooms: live', () => {
  let baseUrl = '';
  const sockets: Socket[] = [];
  beforeAll(async () => {
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const address = hub.app.server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });
  afterAll(() => {
    for (const socket of sockets) socket.disconnect();
  });

  function socketFor(token: string): Promise<Socket> {
    const socket = connect(`${baseUrl}/rt/rooms`, {
      path: SOCKET_PATH,
      transports: ['websocket'],
      auth: { token, profile: 'default' },
    });
    sockets.push(socket);
    return new Promise((resolve, reject) => {
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
    });
  }
  const emit = (socket: Socket, event: string, payload: unknown) =>
    new Promise<Json>((resolve) => socket.emit(event, payload, (ack: Json) => resolve(ack)));
  const next = (socket: Socket, event: string) =>
    new Promise<Json>((resolve) => socket.once(event, (envelope: Json) => resolve(envelope)));

  it('members hear the room; a stranger cannot enter; presence and typing follow the sockets', async () => {
    const { room } = await newRoom('حيّة');
    await call(tokens.sara!, 'POST', `/room-invites/${room.invite_code}/join`, {});
    const owner = await socketFor(tokens.owner!);
    const sara = await socketFor(tokens.sara!);
    expect(await emit(owner, 'join', { room_id: room.id })).toEqual({ ok: true });
    expect(await emit(sara, 'join', { room_id: room.id })).toEqual({ ok: true });

    const stranger = await socketFor(
      await (async () => {
        const made = await call(tokens.owner!, 'POST', '/auth/users', {
          username: 'nasser',
          password: 'nasser-password-1',
          role: 'member',
          profiles: ['default'],
        });
        expect(made.status).toBe(201);
        return login('nasser', 'nasser-password-1');
      })(),
    );
    expect(await emit(stranger, 'join', { room_id: room.id })).toMatchObject({
      ok: false,
      code: 'not_found',
    });

    const heard = next(sara, 'message.created');
    await call(tokens.owner!, 'POST', `/rooms/${room.id}/messages`, {
      content: [{ type: 'text', text: 'مرحبا بالجميع' }],
    });
    const envelope = await heard;
    expect(envelope).toMatchObject({
      event: 'message.created',
      namespace: '/rt/rooms',
      profile: 'default',
      payload: {
        message: { room_id: room.id, content: [{ type: 'text', text: 'مرحبا بالجميع' }] },
      },
    });

    const members = (await call(tokens.owner!, 'GET', `/rooms/${room.id}/members`)).body
      .items as Json[];
    expect(members.map((m) => m.online)).toEqual([true, true]);

    const typing = next(owner, 'member.typing');
    expect(await emit(sara, 'typing', { room_id: room.id, typing: true })).toEqual({ ok: true });
    expect((await typing).payload).toMatchObject({ room_id: room.id, name: 'sara', typing: true });

    await emit(sara, 'leave', { room_id: room.id });
    const after = (await call(tokens.owner!, 'GET', `/rooms/${room.id}/members`)).body
      .items as Json[];
    expect(after.map((m) => m.online)).toEqual([true, false]);
  });
});
