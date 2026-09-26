/**
 * Who is asking (DECISIONS §96). The hub used to believe `X-Forwarded-For` from anyone
 * (`trustProxy: true`), so a client on the internet could write a new address on every
 * attempt and never meet the sign-in lockout. Now the header counts only when it comes from
 * a proxy the hub trusts (`COREHUB_TRUST_PROXY`, by default loopback and the private ranges),
 * and the client is the right-most address that is not such a proxy.
 */
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseTrustProxy } from '../../src/app/config.js';
import { SOCKET_PATH } from '../../src/app/sockets.js';
import {
  DEFAULT_TRUST_PROXY,
  clientAddressFrom,
  compileTrust,
} from '../../src/lib/client-address.js';
import { LOCKOUT_MAX_FAILURES } from '../../src/modules/auth/lockouts.js';
import { authed, signedInHub, type TestHub } from './helpers.js';

/** Documentation addresses (RFC 5737): what "somewhere on the internet" looks like here. */
const INTERNET_CLIENT = '203.0.113.7';
const REAL_CLIENT = '198.51.100.9';
const OTHER_CLIENT = '198.51.100.44';
/** Caddy / Traefik as another container on the stack's Docker network. */
const DOCKER_PROXY = '172.18.0.5';

type Hub = TestHub & { token: string };
const hubs: Hub[] = [];

async function hubWith(env: Record<string, string> = {}): Promise<Hub> {
  const hub = await signedInHub(env);
  hubs.push(hub);
  return hub;
}

afterEach(async () => {
  while (hubs.length > 0) await hubs.pop()!.close();
});

/** A wrong password for the owner, as `remoteAddress` saying `forwardedFor`. */
function wrongPassword(hub: Hub, remoteAddress: string, forwardedFor?: string) {
  return hub.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress,
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
    payload: { username: 'admin', password: 'not-the-password' },
  });
}

async function lockedAddresses(hub: Hub): Promise<string[]> {
  const res = await authed(hub, hub.token, { method: 'GET', url: '/api/v1/auth/lockouts' });
  expect(res.statusCode).toBe(200);
  return (res.json() as { items: { ip: string }[] }).items.map((item) => item.ip).sort();
}

describe('trust proxy: the client address', () => {
  it('ignores X-Forwarded-For from a client on the internet: a new address per try still locks', async () => {
    const hub = await hubWith();
    for (let attempt = 1; attempt <= LOCKOUT_MAX_FAILURES; attempt += 1) {
      const res = await wrongPassword(hub, INTERNET_CLIENT, `198.51.100.${attempt}`);
      expect(res.statusCode).toBe(401);
    }
    const next = await wrongPassword(hub, INTERNET_CLIENT, '198.51.100.200');
    expect(next.statusCode).toBe(429);
    expect(await lockedAddresses(hub)).toEqual([INTERNET_CLIENT]);
  });

  it('believes a trusted proxy on the Docker network, and only its own right-most entry', async () => {
    const hub = await hubWith();
    // The client wrote a fake address first; the proxy appended the one it really saw.
    for (let attempt = 1; attempt <= LOCKOUT_MAX_FAILURES; attempt += 1) {
      await wrongPassword(hub, DOCKER_PROXY, `1.2.3.${attempt}, ${REAL_CLIENT}`);
    }
    expect(await lockedAddresses(hub)).toEqual([REAL_CLIENT]);
  });

  it('locks the real client behind the proxy, not the proxy nor everyone else', async () => {
    const hub = await hubWith();
    for (let attempt = 1; attempt <= LOCKOUT_MAX_FAILURES; attempt += 1) {
      await wrongPassword(hub, DOCKER_PROXY, REAL_CLIENT);
    }
    expect((await wrongPassword(hub, DOCKER_PROXY, REAL_CLIENT)).statusCode).toBe(429);
    // Another person through the same proxy is still asked for the password.
    expect((await wrongPassword(hub, DOCKER_PROXY, OTHER_CLIENT)).statusCode).toBe(401);
    // Someone on the internet cannot borrow the locked address, or free themselves with it.
    expect((await wrongPassword(hub, INTERNET_CLIENT, REAL_CLIENT)).statusCode).toBe(401);
  });

  it('with COREHUB_TRUST_PROXY=false, nobody is believed, not even loopback', async () => {
    const hub = await hubWith({ COREHUB_TRUST_PROXY: 'false' });
    for (let attempt = 1; attempt <= LOCKOUT_MAX_FAILURES; attempt += 1) {
      await wrongPassword(hub, '127.0.0.1', `198.51.100.${attempt}`);
    }
    expect(await lockedAddresses(hub)).toEqual(['127.0.0.1']);
  });

  it('with a list, only the proxies on it are believed', async () => {
    const hub = await hubWith({ COREHUB_TRUST_PROXY: '192.0.2.10' });
    for (let attempt = 1; attempt <= LOCKOUT_MAX_FAILURES; attempt += 1) {
      await wrongPassword(hub, '192.0.2.10', REAL_CLIENT);
      // Not on the list, even though it is a private address.
      await wrongPassword(hub, DOCKER_PROXY, `198.51.100.${attempt}`);
    }
    expect(await lockedAddresses(hub)).toEqual([DOCKER_PROXY, REAL_CLIENT].sort());
  });

  it('a socket handshake counts the same address as HTTP does', async () => {
    const hub = await hubWith();
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const address = hub.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const sockets: Socket[] = [];
    try {
      for (let attempt = 1; attempt <= LOCKOUT_MAX_FAILURES; attempt += 1) {
        const socket = connect(`http://127.0.0.1:${port}/rt/sessions`, {
          path: SOCKET_PATH,
          transports: ['websocket'],
          reconnection: false,
          auth: { token: 'hub_at_not-a-real-token' },
          // cloudflared on the same machine: loopback, so its header is believed.
          extraHeaders: { 'x-forwarded-for': `1.2.3.${attempt}, ${REAL_CLIENT}` },
        });
        sockets.push(socket);
        const refused = await new Promise<boolean>((resolve) => {
          socket.once('connect', () => resolve(false));
          socket.once('connect_error', () => resolve(true));
        });
        expect(refused).toBe(true);
      }
    } finally {
      for (const socket of sockets) socket.disconnect();
    }
    expect(await lockedAddresses(hub)).toEqual([REAL_CLIENT]);
  });
});

describe('trust proxy: the rule', () => {
  const trust = compileTrust(DEFAULT_TRUST_PROXY);

  it('walks X-Forwarded-For from the right and stops at the first untrusted address', () => {
    expect(clientAddressFrom(INTERNET_CLIENT, '10.0.0.1', trust)).toBe(INTERNET_CLIENT);
    expect(clientAddressFrom(DOCKER_PROXY, `6.6.6.6, ${REAL_CLIENT}`, trust)).toBe(REAL_CLIENT);
    // Two trusted hops (cloudflared → Caddy) before the client.
    expect(clientAddressFrom('127.0.0.1', `6.6.6.6, ${REAL_CLIENT}, 10.1.2.3`, trust)).toBe(
      REAL_CLIENT,
    );
    // Every hop trusted: the left-most is the client.
    expect(clientAddressFrom('::1', '192.168.1.20', trust)).toBe('192.168.1.20');
    expect(clientAddressFrom('::ffff:172.18.0.5', REAL_CLIENT, trust)).toBe(REAL_CLIENT);
    expect(clientAddressFrom('fd7a:115c:a1e0::1', REAL_CLIENT, trust)).toBe(REAL_CLIENT);
    expect(clientAddressFrom(DOCKER_PROXY, undefined, trust)).toBe(DOCKER_PROXY);
    // Tailscale's own addresses (100.64/10) are clients, not proxies.
    expect(clientAddressFrom('100.101.102.103', REAL_CLIENT, trust)).toBe('100.101.102.103');
  });

  it('a hop count believes that many hops, whoever they are', () => {
    const one = compileTrust({ kind: 'hops', hops: 1 });
    expect(clientAddressFrom(INTERNET_CLIENT, `6.6.6.6, ${REAL_CLIENT}`, one)).toBe(REAL_CLIENT);
  });

  it('reads COREHUB_TRUST_PROXY in the config, and refuses what it cannot understand', () => {
    expect(loadConfig({ DATA_DIR: '/tmp/x' }).trustProxy).toEqual(DEFAULT_TRUST_PROXY);
    expect(parseTrustProxy('false')).toEqual({ kind: 'none' });
    expect(parseTrustProxy('2')).toEqual({ kind: 'hops', hops: 2 });
    expect(parseTrustProxy(' 10.0.0.2 , fd00::/8 ')).toEqual({
      kind: 'addresses',
      entries: ['10.0.0.2', 'fd00::/8'],
    });
    for (const bad of ['true', 'caddy', '10.0.0.0/33', '11']) {
      expect(() => parseTrustProxy(bad)).toThrow(ConfigError);
    }
    expect(() => loadConfig({ DATA_DIR: '/tmp/x', COREHUB_TRUST_PROXY: 'yes' })).toThrow(
      ConfigError,
    );
  });
});
