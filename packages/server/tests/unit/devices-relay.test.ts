/**
 * The way in from outside (`devices.getRelay` / `devices.setRelay`, DECISIONS §92): a hub the
 * desktop app runs asks the app (its `RelayHost`); any other hub has none. The tunnel token
 * passes through once, checked, and is never answered back or logged; a phone paired while the
 * way in is open is given its address.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  RelayHostRefusal,
  overrideDevices,
  type RelayChange,
  type RelayHost,
  type RelayHostState,
} from '../../src/modules/devices/index.js';
import { authed, capturingLogger, signedInHub, type TestHub } from './helpers.js';

type Hub = TestHub & { token: string };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  overrideDevices({});
  while (cleanups.length > 0) await cleanups.pop()!();
});

const TOKEN = Buffer.from(
  JSON.stringify({ a: 'account-tag', t: '6ff42ae2-765d-4adf-8112-31c55c1551ef', s: 'c2VjcmV0' }),
).toString('base64');

const CLOSED: RelayHostState = {
  enabled: false,
  connected: false,
  route: null,
  relay_url: null,
  hub_port: 47113,
  token_set: false,
  tunnel_id: null,
  hostname: null,
  hostnames: [],
  tailnet: null,
  error: null,
  error_detail: null,
  connected_at: null,
};

/** The desktop app as the hub sees it: records each change and answers what it was told. */
function fakeHost(initial: RelayHostState = CLOSED) {
  let state = { ...initial };
  const changes: RelayChange[] = [];
  const host: RelayHost & { changes: RelayChange[]; put(next: Partial<RelayHostState>): void } = {
    changes,
    put(next) {
      state = { ...state, ...next };
    },
    get: () => Promise.resolve(state),
    current: () => state,
    set: (change) => {
      changes.push(change);
      state = {
        ...state,
        ...(change.enabled !== undefined ? { enabled: change.enabled } : {}),
        ...(change.route ? { route: change.route } : {}),
        ...(change.token ? { token_set: true, tunnel_id: '6ff42ae2' } : {}),
        ...(change.hostname !== undefined ? { hostname: change.hostname } : {}),
      };
      return Promise.resolve(state);
    },
  };
  return host;
}

async function hubWith(host: RelayHost | null, logger?: ReturnType<typeof capturingLogger>) {
  const hub = await signedInHub(
    {},
    { relayHost: host, ...(logger ? { logger: logger.logger } : {}) },
  );
  cleanups.push(() => hub.close());
  return hub as Hub;
}

const getRelay = (hub: Hub) => authed(hub, hub.token, { method: 'GET', url: '/api/v1/relay' });
const setRelay = (hub: Hub, payload: unknown) =>
  authed(hub, hub.token, { method: 'PUT', url: '/api/v1/relay', payload });

describe('way in from outside: a hub nobody started', () => {
  it('has none to open, and says so rather than 501', async () => {
    const hub = await hubWith(null);
    const read = await getRelay(hub);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({ available: false, enabled: false, connected: false });
    const write = await setRelay(hub, { enabled: true, route: 'tailscale' });
    expect(write.statusCode, write.body).toBe(409);
    expect(write.json()).toMatchObject({ details: { reason: 'relay_unavailable' } });
  });
});

describe('way in from outside: a hub the desktop app runs', () => {
  it('reads the app’s state, available', async () => {
    const host = fakeHost({ ...CLOSED, tailnet: { address: '100.64.1.2', dns_name: null } });
    const hub = await hubWith(host);
    const read = await getRelay(hub);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({
      available: true,
      hub_port: 47113,
      tailnet: { address: '100.64.1.2', dns_name: null },
    });
  });

  it('hands a checked change to the app and never answers the token back or logs it', async () => {
    const host = fakeHost();
    const logger = capturingLogger();
    const hub = await hubWith(host, logger);
    const write = await setRelay(hub, {
      enabled: true,
      route: 'cloudflare',
      token: `  ${TOKEN}\n`,
      hostname: 'https://Hub.Example.com/',
    });
    expect(write.statusCode, write.body).toBe(200);
    expect(host.changes).toEqual([
      { enabled: true, route: 'cloudflare', token: TOKEN, hostname: 'hub.example.com' },
    ]);
    expect(write.json()).toMatchObject({ token_set: true, hostname: 'hub.example.com' });
    expect(write.body).not.toContain(TOKEN);
    expect(JSON.stringify(logger.lines)).not.toContain(TOKEN);
  });

  it('refuses what is not a tunnel token, or not a hostname, without asking the app', async () => {
    const host = fakeHost();
    const hub = await hubWith(host);
    const command = await setRelay(hub, { token: `cloudflared service install ${TOKEN}` });
    expect(command.statusCode).toBe(400);
    expect(command.json()).toMatchObject({ details: { reason: 'token_invalid' } });
    const junk = await setRelay(hub, { token: 'x'.repeat(40) });
    expect(junk.json()).toMatchObject({ details: { reason: 'token_invalid' } });
    const host1 = await setRelay(hub, { hostname: 'not a host' });
    expect(host1.statusCode).toBe(400);
    expect(host1.json()).toMatchObject({ details: { reason: 'hostname_invalid' } });
    expect(host.changes).toEqual([]);
  });

  it('passes on the app’s own refusal as a 400 with its reason', async () => {
    const host = fakeHost();
    host.set = () => Promise.reject(new RelayHostRefusal('token_required'));
    const hub = await hubWith(host);
    const write = await setRelay(hub, { enabled: true, route: 'cloudflare' });
    expect(write.statusCode, write.body).toBe(400);
    expect(write.json()).toMatchObject({ details: { reason: 'token_required' } });
  });

  it('says the app is not answering instead of waiting forever', async () => {
    overrideDevices({ relayHostTimeoutMs: 20 });
    const host = fakeHost();
    host.get = () => new Promise(() => {});
    const hub = await hubWith(host);
    const read = await getRelay(hub);
    expect(read.statusCode, read.body).toBe(503);
    expect(read.json()).toMatchObject({ details: { reason: 'relay_host_not_answering' } });
  });

  it('is for admins only', async () => {
    const hub = await hubWith(fakeHost());
    const anonymous = await hub.app.inject({ method: 'GET', url: '/api/v1/relay' });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('pairing a phone with a hub the desktop app runs', () => {
  const pair = (hub: Hub, connection?: 'lan' | 'relay') =>
    authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/auth/pairings',
      payload: { ttl_seconds: 120, ...(connection ? { connection } : {}) },
    });

  it('gives the phone the way in’s address while it is open', async () => {
    const host = fakeHost({
      ...CLOSED,
      enabled: true,
      connected: true,
      route: 'cloudflare',
      relay_url: 'https://hub.example.com',
    });
    const hub = await hubWith(host);
    const created = await pair(hub);
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json() as { connection: string; qr_payload: string };
    expect(body.connection).toBe('relay');
    expect(JSON.parse(body.qr_payload)).toMatchObject({ hub_url: 'https://hub.example.com' });
  });

  it('keeps its own address when the way in is closed, and refuses `relay` then', async () => {
    const host = fakeHost({ ...CLOSED, enabled: true, relay_url: 'https://hub.example.com' });
    const hub = await hubWith(host);
    const lan = await pair(hub);
    expect(lan.statusCode, lan.body).toBe(201);
    expect(lan.json()).toMatchObject({ connection: 'lan' });
    expect(JSON.parse((lan.json() as { qr_payload: string }).qr_payload).hub_url).not.toBe(
      'https://hub.example.com',
    );
    const relay = await pair(hub, 'relay');
    expect(relay.statusCode, relay.body).toBe(409);
    expect(relay.json()).toMatchObject({ details: { reason: 'relay_not_connected' } });
  });
});
