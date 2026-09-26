/**
 * Linked hubs (ADR 0026), with two real hubs in one process: hub A at https://a.test and hub B
 * at https://b.test, their hub-to-hub calls routed to each other's `inject`. Pairing (invite,
 * request, approval), the invite's single use and expiry, signatures and replays, an unshared
 * agent, the ask limit, revoking, and the audit log on both sides. Every answer is checked
 * against the contract's schema.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOpenApiDocument } from '@corehub/contracts';
import { authed, signedInHub, type TestHub } from '../../../tests/unit/helpers.js';
import { ajvFor } from '../../../tests/contract/schema.js';
import { overrideDevices } from './index.js';
import {
  canonical,
  fingerprint,
  generateKeys,
  signText,
  signedHeaders,
  verifyText,
} from './peer-crypto.js';

type Hub = TestHub & { token: string };
const doc = loadOpenApiDocument()!;
const schemas = ajvFor(doc);
const schema = (name: string) => ({ $ref: `#/components/schemas/${name}` });

interface Recorded {
  to: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | undefined;
}

let hubs: Record<string, Hub> = {};
let clock = Date.now();
let sent: Recorded[] = [];
let asked: Array<{ agentId: string; prompt: string }> = [];

/** Routes `https://<name>.test/...` to hub `<name>`, as a real network would. */
const network: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const name = url.hostname.replace(/\.test$/, '');
  const target = hubs[name];
  if (!target || url.protocol !== 'https:') throw new TypeError('fetch failed');
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const body = typeof init?.body === 'string' ? init.body : undefined;
  sent.push({ to: name, method: init?.method ?? 'GET', path: url.pathname, headers, body });
  const res = await target.app.inject({
    method: (init?.method ?? 'GET') as 'GET',
    url: `${url.pathname}${url.search}`,
    headers: { ...headers, host: url.host, 'x-forwarded-proto': 'https' },
    ...(body !== undefined ? { payload: body } : {}),
  });
  return new Response(res.statusCode === 204 ? null : res.body, {
    status: res.statusCode,
    headers: { 'content-type': 'application/json' },
  });
};

beforeEach(() => {
  clock = Date.now();
  sent = [];
  asked = [];
  overrideDevices({
    peerFetch: network,
    now: () => clock,
    peerAsk: async (input) => {
      asked.push({ agentId: input.agentId, prompt: input.prompt });
      return `answer to: ${input.prompt}`;
    },
  });
});
afterEach(async () => {
  overrideDevices({});
  for (const hub of Object.values(hubs)) await hub.close();
  hubs = {};
});

async function boot(...names: string[]): Promise<void> {
  for (const name of names) hubs[name] = (await signedInHub()) as Hub;
}

/** An admin's call on hub `name`, reached at https://<name>.test. */
function call(
  name: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  const hub = hubs[name]!;
  return authed(hub, hub.token, {
    method,
    url: `/api/v1${url}`,
    ...(payload !== undefined ? { payload } : {}),
    headers: { host: `${name}.test`, 'x-forwarded-proto': 'https' },
  });
}

async function invite(name: string): Promise<string> {
  const res = await call(name, 'POST', '/peer-invites');
  expect(res.statusCode, res.body).toBe(201);
  expect(schemas.validate(schema('PeerInvite'), res.json())).toEqual([]);
  return (res.json() as { url: string }).url;
}

async function peersOf(name: string) {
  const res = await call(name, 'GET', '/peers');
  expect(res.statusCode, res.body).toBe(200);
  for (const item of (res.json() as { items: unknown[] }).items) {
    expect(schemas.validate(schema('Peer'), item)).toEqual([]);
  }
  return (res.json() as { items: Array<Record<string, unknown> & { id: string }> }).items;
}

async function eventsOf(name: string, peerId: string) {
  const res = await call(name, 'GET', `/peers/${peerId}/events`);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { items: Array<{ kind: string; ok: boolean; detail: string | null }> })
    .items;
}

/** A links to B: A invites, B redeems, A approves. Returns both rows' ids. */
async function link(): Promise<{ onA: string; onB: string }> {
  const url = await invite('a');
  const requested = await call('b', 'POST', '/peers', { url });
  expect(requested.statusCode, requested.body).toBe(201);
  expect(schemas.validate(schema('Peer'), requested.json())).toEqual([]);
  const onB = (requested.json() as { id: string }).id;
  const [pending] = await peersOf('a');
  expect(pending).toMatchObject({ direction: 'inbound', status: 'pending', url: 'https://b.test' });
  const approved = await call('a', 'PATCH', `/peers/${pending!.id}`, { approve: true });
  expect(approved.statusCode, approved.body).toBe(200);
  return { onA: pending!.id, onB };
}

/** A shares its Hermes in the default profile; returns the agent's id there. */
async function shareHermes(shared = true): Promise<string> {
  const list = await call('a', 'GET', '/peer-shares');
  expect(list.statusCode, list.body).toBe(200);
  const items = (
    list.json() as {
      items: Array<{ profile: string; agent_id: string; name: string; shared: boolean }>;
    }
  ).items;
  for (const item of items) expect(schemas.validate(schema('PeerShare'), item)).toEqual([]);
  expect(items.every((item) => item.shared === false)).toBe(true);
  const hermes = items.find((item) => item.profile === 'default' && /hermes/i.test(item.name))!;
  const set = await call('a', 'PUT', '/peer-shares', {
    profile: 'default',
    agent_id: hermes.agent_id,
    shared,
    description: 'The office agent',
  });
  expect(set.statusCode, set.body).toBe(200);
  return hermes.agent_id;
}

describe('signatures', () => {
  it('bind the method, path, time, nonce, body and recipient', () => {
    const keys = generateKeys();
    const base = {
      method: 'POST',
      path: '/api/v1/peer-link/ask',
      timestamp: '1000',
      nonce: 'n1',
      body: '{"prompt":"hi"}',
      recipient: 'HUB-A',
    };
    const signature = signText(keys.privateKey, canonical(base));
    expect(verifyText(keys.publicKey, canonical(base), signature)).toBe(true);
    for (const change of [
      { method: 'GET' },
      { path: '/api/v1/peer-link/agents' },
      { timestamp: '1001' },
      { nonce: 'n2' },
      { body: '{"prompt":"bye"}' },
      { recipient: 'HUB-C' },
    ]) {
      expect(verifyText(keys.publicKey, canonical({ ...base, ...change }), signature)).toBe(false);
    }
    expect(verifyText(generateKeys().publicKey, canonical(base), signature)).toBe(false);
    expect(fingerprint(keys.publicKey)).toMatch(/^([0-9A-F]{4}-){7}[0-9A-F]{4}$/);
  });
});

describe('two hubs', () => {
  it('link with both owners, list shared agents and ask one, with an audit log on both sides', async () => {
    await boot('a', 'b');
    const url = await invite('a');
    expect(url).toMatch(/^https:\/\/a\.test\/peer-invite\/[0-9A-Z]{26}\?fp=[0-9A-F]{32}$/);
    const requested = await call('b', 'POST', '/peers', { url, name: 'Office' });
    expect(requested.statusCode, requested.body).toBe(201);
    expect(requested.json()).toMatchObject({
      name: 'Office',
      direction: 'outbound',
      status: 'waiting',
      url: 'https://a.test',
    });
    const onB = (requested.json() as { id: string }).id;
    const [onA] = await peersOf('a');
    expect(onA).toMatchObject({ direction: 'inbound', status: 'pending' });
    // The fingerprints each side shows are of the other's key, and they agree.
    expect((requested.json() as { fingerprint: string }).fingerprint).toBe(
      url.split('fp=')[1]!.match(/.{4}/g)!.join('-'),
    );

    // Before A's owner approves, B is refused.
    const early = await call('b', 'GET', `/peers/${onB}/agents`);
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({
      details: { reason: 'peer_refused', peer_code: 'peer_pending' },
    });

    const approved = await call('a', 'PATCH', `/peers/${onA!.id}`, { approve: true });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({ status: 'linked' });
    // A told B, signed; B's row is linked too.
    expect((await peersOf('b'))[0]).toMatchObject({ status: 'linked' });

    // Nothing is shared yet.
    const none = await call('b', 'GET', `/peers/${onB}/agents`);
    expect(none.statusCode, none.body).toBe(200);
    expect((none.json() as { items: unknown[] }).items).toEqual([]);

    const agentId = await shareHermes();
    const listed = await call('b', 'GET', `/peers/${onB}/agents`);
    expect(listed.statusCode, listed.body).toBe(200);
    const items = (listed.json() as { items: Array<{ id: string; name: string }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ description: 'The office agent' });
    for (const item of items) expect(schemas.validate(schema('PeerAgent'), item)).toEqual([]);
    // The agent's own id never leaves A.
    expect(listed.body).not.toContain(agentId);

    const asked1 = await call('b', 'POST', `/peers/${onB}/agents/${items[0]!.id}/ask`, {
      prompt: 'what is on today?',
    });
    expect(asked1.statusCode, asked1.body).toBe(200);
    expect(schemas.validate(schema('PeerAnswer'), asked1.json())).toEqual([]);
    expect(asked1.json()).toEqual({ answer: 'answer to: what is on today?' });
    expect(asked).toEqual([{ agentId, prompt: 'what is on today?' }]);

    const kindsA = (await eventsOf('a', onA!.id)).map((e) => e.kind);
    expect(kindsA).toEqual(expect.arrayContaining(['joined', 'approved', 'list_in', 'ask_in']));
    const kindsB = (await eventsOf('b', onB)).map((e) => e.kind);
    expect(kindsB).toEqual(
      expect.arrayContaining(['requested', 'approved_by_peer', 'list_out', 'ask_out']),
    );
    // The question's words are not kept in either log.
    for (const name of ['a', 'b']) {
      const id = name === 'a' ? onA!.id : onB;
      const res = await call(name, 'GET', `/peers/${id}/events`);
      expect(res.body).not.toContain('what is on today');
      for (const item of (res.json() as { items: unknown[] }).items) {
        expect(schemas.validate(schema('PeerEvent'), item)).toEqual([]);
      }
    }
  });

  it('takes an invite once, and not after 10 minutes', async () => {
    await boot('a', 'b', 'c');
    const url = await invite('a');
    const first = await call('b', 'POST', '/peers', { url });
    expect(first.statusCode, first.body).toBe(201);
    const second = await call('c', 'POST', '/peers', { url });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ details: { reason: 'invite_refused' } });

    const late = await invite('a');
    clock += 10 * 60_000 + 1_000;
    const expired = await call('c', 'POST', '/peers', { url: late });
    expect(expired.statusCode).toBe(409);
    expect(expired.json()).toMatchObject({ details: { reason: 'invite_refused' } });
    expect(await peersOf('a')).toHaveLength(1);
  });

  it('refuses an invite whose key is not the one in the link, and plain http', async () => {
    await boot('a', 'b');
    const url = await invite('a');
    const forged = url.replace(/fp=[0-9A-F]{32}/, `fp=${'0'.repeat(32)}`);
    const res = await call('b', 'POST', '/peers', { url: forged });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ details: { reason: 'fingerprint_mismatch' } });
    expect(await peersOf('b')).toEqual([]);

    const http = await call('b', 'POST', '/peers', { url: url.replace('https:', 'http:') });
    expect(http.statusCode).toBe(400);
    expect(http.json()).toMatchObject({ details: { reason: 'https_required' } });

    // A hub reached over plain http cannot invite.
    const plain = await authed(hubs.a!, hubs.a!.token, {
      method: 'POST',
      url: '/api/v1/peer-invites',
      headers: { host: 'a.test', 'x-forwarded-proto': 'http' },
    });
    expect(plain.statusCode).toBe(400);
    expect(plain.json()).toMatchObject({ details: { reason: 'own_url_not_https' } });
  });

  it('refuses a forged signature, a replay, a tampered body and a stale call', async () => {
    await boot('a', 'b');
    const { onA, onB } = await link();
    await shareHermes();
    const listed = await call('b', 'GET', `/peers/${onB}/agents`);
    const shareId = (listed.json() as { items: Array<{ id: string }> }).items[0]!.id;
    sent = [];
    const ok = await call('b', 'POST', `/peers/${onB}/agents/${shareId}/ask`, { prompt: 'hi' });
    expect(ok.statusCode, ok.body).toBe(200);
    const captured = sent.find((r) => r.to === 'a' && r.path.endsWith('/peer-link/ask'))!;
    const replay = (headers: Record<string, string>, body = captured.body) =>
      hubs.a!.app.inject({
        method: 'POST',
        url: captured.path,
        headers: {
          'content-type': 'application/json',
          ...headers,
          host: 'a.test',
          'x-forwarded-proto': 'https',
        },
        ...(body !== undefined ? { payload: body } : {}),
      });

    const again = await replay(captured.headers);
    expect(again.statusCode).toBe(401);
    expect(again.json()).toMatchObject({
      code: 'unauthorized',
      details: { reason: 'peer_replay' },
    });

    const tampered = await replay(
      { ...captured.headers, 'x-peer-nonce': 'fresh-nonce-1' },
      captured.body!.replace('hi', 'ho'),
    );
    expect(tampered.statusCode).toBe(401);
    expect(tampered.json()).toMatchObject({ details: { reason: 'peer_signature_invalid' } });

    // Signed by a key that is not B's, under B's hub id.
    const stranger = generateKeys();
    const forged = await replay(
      signedHeaders({
        hubId: captured.headers['x-peer-hub']!,
        privateKey: stranger.privateKey,
        method: 'POST',
        path: captured.path,
        body: captured.body!,
        recipient: 'whatever',
        now: clock,
      }),
    );
    expect(forged.statusCode).toBe(401);
    expect(forged.json()).toMatchObject({ details: { reason: 'peer_signature_invalid' } });

    clock += 6 * 60_000;
    const stale = await replay({ ...captured.headers, 'x-peer-nonce': 'fresh-nonce-2' });
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toMatchObject({ details: { reason: 'peer_clock_skew' } });

    const unsigned = await hubs.a!.app.inject({
      method: 'GET',
      url: '/api/v1/peer-link/agents',
      headers: { host: 'a.test' },
    });
    expect(unsigned.statusCode).toBe(401);

    const refusals = (await eventsOf('a', onA)).filter((e) => e.kind === 'refused');
    expect(refusals.map((e) => e.detail)).toEqual(
      expect.arrayContaining(['peer_replay', 'peer_signature_invalid', 'peer_clock_skew']),
    );
  });

  it('refuses an agent that is not shared, and one that was shared and is not any more', async () => {
    await boot('a', 'b');
    const { onA, onB } = await link();
    const agentId = await shareHermes(true);
    const listed = await call('b', 'GET', `/peers/${onB}/agents`);
    const shareId = (listed.json() as { items: Array<{ id: string }> }).items[0]!.id;
    const unshare = await call('a', 'PUT', '/peer-shares', {
      profile: 'default',
      agent_id: agentId,
      shared: false,
    });
    expect(unshare.statusCode, unshare.body).toBe(200);
    const refused = await call('b', 'POST', `/peers/${onB}/agents/${shareId}/ask`, {
      prompt: 'hello',
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      details: { reason: 'peer_refused', peer_code: 'agent_not_shared' },
    });
    const unknown = await call('b', 'POST', `/peers/${onB}/agents/01J8QK3ZR2W7M5N4P6T8V9X0ZZ/ask`, {
      prompt: 'hello',
    });
    expect(unknown.json()).toMatchObject({ details: { peer_code: 'agent_not_shared' } });
    expect(asked).toEqual([]);
    expect(
      (await eventsOf('a', onA)).some(
        (e) => e.kind === 'refused' && e.detail?.startsWith('agent_not_shared'),
      ),
    ).toBe(true);
  });

  it('holds a peer to its asks per hour', async () => {
    await boot('a', 'b');
    const { onA, onB } = await link();
    await shareHermes();
    const limit = await call('a', 'PATCH', `/peers/${onA}`, { asks_per_hour: 1 });
    expect(limit.statusCode, limit.body).toBe(200);
    const listed = await call('b', 'GET', `/peers/${onB}/agents`);
    const shareId = (listed.json() as { items: Array<{ id: string }> }).items[0]!.id;
    const first = await call('b', 'POST', `/peers/${onB}/agents/${shareId}/ask`, { prompt: 'one' });
    expect(first.statusCode, first.body).toBe(200);
    const second = await call('b', 'POST', `/peers/${onB}/agents/${shareId}/ask`, {
      prompt: 'two',
    });
    expect(second.statusCode).toBe(429);
    expect(asked.map((a) => a.prompt)).toEqual(['one']);
    clock += 60 * 60_000 + 1_000;
    const later = await call('b', 'POST', `/peers/${onB}/agents/${shareId}/ask`, {
      prompt: 'three',
    });
    expect(later.statusCode, later.body).toBe(200);
  });

  it('stops both ways when disabled, and forgets the key when deleted', async () => {
    await boot('a', 'b');
    const { onA, onB } = await link();
    await shareHermes();
    const listed = await call('b', 'GET', `/peers/${onB}/agents`);
    expect(listed.statusCode).toBe(200);
    sent = [];
    await call('b', 'GET', `/peers/${onB}/agents`);
    const captured = sent.find((r) => r.to === 'a')!;

    const off = await call('a', 'PATCH', `/peers/${onA}`, { enabled: false });
    expect(off.statusCode).toBe(200);
    const refused = await call('b', 'GET', `/peers/${onB}/agents`);
    expect(refused.json()).toMatchObject({ details: { peer_code: 'peer_disabled' } });
    const outward = await call('a', 'GET', `/peers/${onA}/agents`);
    expect(outward.json()).toMatchObject({ details: { reason: 'peer_disabled' } });
    await call('a', 'PATCH', `/peers/${onA}`, { enabled: true });

    const removed = await call('a', 'DELETE', `/peers/${onA}`);
    expect(removed.statusCode).toBe(204);
    expect(await peersOf('a')).toEqual([]);
    // A told B: B forgot A too (the notice is sent after the answer; wait for it).
    for (let i = 0; i < 50 && (await peersOf('b')).length > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await peersOf('b')).toEqual([]);
    // A call signed by B's key is now from nobody A knows.
    const after = await hubs.a!.app.inject({
      method: 'GET',
      url: captured.path,
      headers: { ...captured.headers, 'x-peer-nonce': 'after-delete', host: 'a.test' },
    });
    expect(after.statusCode).toBe(401);
    expect(after.json()).toMatchObject({ details: { reason: 'peer_unknown' } });
    // The audit lines stay.
    const kept = await call('a', 'GET', `/peers/${onA}/events`);
    expect(kept.statusCode).toBe(200);
    expect((kept.json() as { items: Array<{ kind: string }> }).items.map((e) => e.kind)).toContain(
      'unlinked',
    );
  });

  it('is for admins only', async () => {
    await boot('a');
    const member = await call('a', 'POST', '/auth/users', {
      username: 'member1',
      password: 'member-password-1',
      role: 'member',
      profiles: ['default'],
    });
    expect(member.statusCode, member.body).toBe(201);
    const login = await hubs.a!.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'member1', password: 'member-password-1' },
    });
    const token = (login.json() as { access_token: string }).access_token;
    for (const [method, url] of [
      ['GET', '/peers'],
      ['POST', '/peer-invites'],
      ['GET', '/peer-shares'],
    ] as const) {
      const res = await authed(hubs.a!, token, {
        method,
        url: `/api/v1${url}`,
        headers: { host: 'a.test', 'x-forwarded-proto': 'https' },
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });
});
