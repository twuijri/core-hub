// The way in from outside (DECISIONS §92), the app's half: settings with the token sealed,
// cloudflared started and stopped with the hub, the Tailscale listener on the tailnet address
// only, and the page's state — never with the token in it.
import { createServer as createHttp, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { CloudflaredError } from '../../src/main/cloudflared.js';
import { RelayManager, RelayRefusal } from '../../src/main/relay.js';
import { Forwarder } from '../../src/main/tailnet.js';
import {
  DEFAULT_RELAY,
  parseCloudflaredLine,
  parseRelayConfig,
  parseTunnelToken,
  relayUrlFor,
  serviceMatches,
  tailnetAddress,
  tailscaleDnsName,
  type RelayConfig,
} from '../../src/shared/relay.js';
import { parseConfig } from '../../src/shared/config.js';

const TOKEN = Buffer.from(
  JSON.stringify({ a: 'acct', t: '6ff42ae2-765d-4adf-8112-31c55c1551ef', s: 'secret' }),
).toString('base64');

function fakeTunnel() {
  const made: Array<{ token: string; program: string; started: boolean; stopped: boolean }> = [];
  const factory = (options: { token: string; program: string; onChange: () => void }) => {
    const record = {
      token: options.token,
      program: options.program,
      started: false,
      stopped: false,
    };
    made.push(record);
    return {
      connected: false,
      connectedAt: null as string | null,
      routes: [{ hostname: 'hub.example.com', service: 'http://localhost:47113' }],
      error: null,
      async start() {
        record.started = true;
        this.connected = true;
        this.connectedAt = '2026-09-27T08:00:00.000Z';
      },
      async stop() {
        record.stopped = true;
        this.connected = false;
      },
    };
  };
  return { made, factory };
}

function manager(extra: Partial<ConstructorParameters<typeof RelayManager>[0]> = {}) {
  let config: RelayConfig = { ...DEFAULT_RELAY };
  const tunnels = fakeTunnel();
  const states: unknown[] = [];
  const relay = new RelayManager({
    load: () => config,
    save: (next) => {
      config = next;
    },
    seal: (text) => `sealed:${Buffer.from(text).toString('hex')}`,
    unseal: (text) => Buffer.from(text.slice(7), 'hex').toString(),
    hubPort: () => 47113,
    toolsDir: '/tmp/tools',
    platform: 'linux',
    arch: 'x64',
    onChange: (state) => states.push(state),
    ensure: async () => '/tmp/tools/cloudflared-x/cloudflared',
    tunnel: tunnels.factory as never,
    detectTailnet: async () => null,
    ...extra,
  });
  return { relay, tunnels, states, config: () => config };
}

describe('the settings', () => {
  it('keeps the token sealed, shows only the tunnel id, and opens the tunnel with the hub', async () => {
    const { relay, tunnels, config } = manager();
    await relay.resume();
    const state = await relay.set({
      enabled: true,
      route: 'cloudflare',
      token: TOKEN,
      hostname: 'hub.example.com',
    });
    expect(config().token).toMatch(/^sealed:/);
    expect(JSON.stringify(config())).not.toContain(TOKEN);
    expect(tunnels.made).toEqual([
      expect.objectContaining({
        token: TOKEN,
        program: '/tmp/tools/cloudflared-x/cloudflared',
        started: true,
      }),
    ]);
    expect(state).toMatchObject({
      enabled: true,
      connected: true,
      route: 'cloudflare',
      relay_url: 'https://hub.example.com',
      hub_port: 47113,
      token_set: true,
      tunnel_id: '6ff42ae2-765d-4adf-8112-31c55c1551ef',
      hostnames: [
        { hostname: 'hub.example.com', service: 'http://localhost:47113', matches: true },
      ],
      error: null,
      connected_at: '2026-09-27T08:00:00.000Z',
    });
    expect(JSON.stringify(state)).not.toContain(TOKEN);
  });

  it('refuses to open a tunnel with no token or no route, and a token that is not one', async () => {
    const { relay } = manager();
    await expect(relay.set({ enabled: true, route: 'cloudflare' })).rejects.toEqual(
      new RelayRefusal('token_required'),
    );
    await expect(relay.set({ enabled: true })).rejects.toEqual(new RelayRefusal('route_required'));
    await expect(relay.set({ token: 'not a token at all, surely' })).rejects.toEqual(
      new RelayRefusal('token_invalid'),
    );
  });

  it('runs nothing until the hub runs, and closes with it', async () => {
    const { relay, tunnels } = manager();
    await relay.set({ enabled: true, route: 'cloudflare', token: TOKEN });
    expect(tunnels.made).toEqual([]);
    expect((await relay.state()).connected).toBe(false);
    await relay.resume();
    expect(tunnels.made).toHaveLength(1);
    await relay.suspend();
    expect(tunnels.made[0]!.stopped).toBe(true);
  });

  it('restarts the tunnel for a new token, closes it when turned off or the token is forgotten', async () => {
    const { relay, tunnels } = manager();
    await relay.resume();
    await relay.set({ enabled: true, route: 'cloudflare', token: TOKEN });
    const other = Buffer.from(JSON.stringify({ a: 'a', t: 'other', s: 's' })).toString('base64');
    await relay.set({ token: other });
    expect(tunnels.made.map((t) => [t.token === TOKEN, t.stopped])).toEqual([
      [true, true],
      [false, false],
    ]);
    await relay.set({ enabled: false });
    expect(tunnels.made[1]!.stopped).toBe(true);
    const state = await relay.set({ forget_token: true });
    expect(state).toMatchObject({ token_set: false, tunnel_id: null, relay_url: null });
  });

  it('says why cloudflared is not there', async () => {
    const { relay } = manager({
      ensure: async () => {
        throw new CloudflaredError('checksum_mismatch', 'SHA-256 abc, expected def');
      },
    });
    await relay.resume();
    const state = await relay.set({ enabled: true, route: 'cloudflare', token: TOKEN });
    expect(state).toMatchObject({
      connected: false,
      error: 'checksum_mismatch',
      error_detail: 'SHA-256 abc, expected def',
    });
  });
});

describe('the Tailscale route', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop()!;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('says so when this computer is on no tailnet', async () => {
    const { relay } = manager();
    await relay.resume();
    const state = await relay.set({ enabled: true, route: 'tailscale' });
    expect(state).toMatchObject({ connected: false, error: 'not_on_tailnet', relay_url: null });
  });

  it('listens on the tailnet address and port only, and gives that address to phones', async () => {
    const listened: Array<[string, number]> = [];
    const { relay } = manager({
      detectTailnet: async () => ({ address: '100.101.102.103', dns_name: 'desk.tail1234.ts.net' }),
      forwarder: () => ({
        listening: true,
        listen: async (host: string, port: number) => {
          listened.push([host, port]);
        },
        close: async () => {},
      }),
    });
    await relay.resume();
    const state = await relay.set({ enabled: true, route: 'tailscale' });
    expect(listened).toEqual([['100.101.102.103', 47113]]);
    expect(state).toMatchObject({
      connected: true,
      relay_url: 'http://100.101.102.103:47113',
      tailnet: { address: '100.101.102.103', dns_name: 'desk.tail1234.ts.net' },
      error: null,
    });
  });

  it('passes each connection through to the hub', async () => {
    const hub = createHttp((_request, response) => response.end('hub says hello'));
    servers.push(hub);
    await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
    const hubPort = (hub.address() as { port: number }).port;
    const forwarder = new Forwarder(() => hubPort);
    // 127.0.0.1 plays the tailnet address here.
    const probe = createHttp();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise((resolve) => probe.close(resolve));
    await forwarder.listen('127.0.0.1', port);
    expect(forwarder.listening).toBe(true);
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/meta`);
    expect(await response.text()).toBe('hub says hello');
    await forwarder.close();
    expect(forwarder.listening).toBe(false);
  });
});

describe('what the pure parts read', () => {
  it('reads a tunnel token and nothing that only looks like one', () => {
    expect(parseTunnelToken(` ${TOKEN}\n`)).toEqual({
      accountTag: 'acct',
      tunnelId: '6ff42ae2-765d-4adf-8112-31c55c1551ef',
    });
    expect(parseTunnelToken(`cloudflared service install ${TOKEN}`)).toBeNull();
    expect(parseTunnelToken(Buffer.from('{"a":"x"}').toString('base64'))).toBeNull();
  });

  it('reads the routes and the errors in cloudflared’s JSON log', () => {
    const config = JSON.stringify({
      ingress: [
        { hostname: 'hub.example.com', service: 'http://localhost:47113' },
        { service: 'http_status:404' },
      ],
    });
    expect(
      parseCloudflaredLine(
        JSON.stringify({ level: 'info', message: 'Updated to new configuration', config }),
      ),
    ).toEqual({
      kind: 'ingress',
      routes: [{ hostname: 'hub.example.com', service: 'http://localhost:47113' }],
    });
    expect(
      parseCloudflaredLine(
        JSON.stringify({ level: 'error', message: 'Failed to serve', error: 'EOF' }),
      ),
    ).toEqual({ kind: 'error', message: 'Failed to serve: EOF' });
    expect(parseCloudflaredLine('2026-09-27T08:00:00Z INF plain text')).toEqual({ kind: 'other' });
  });

  it('knows a route that ends at the hub from one that does not', () => {
    expect(serviceMatches('http://localhost:47113', 47113)).toBe(true);
    expect(serviceMatches('http://127.0.0.1:47113/', 47113)).toBe(true);
    expect(serviceMatches('http://localhost:8080', 47113)).toBe(false);
    expect(serviceMatches('http://192.168.1.5:47113', 47113)).toBe(false);
    expect(serviceMatches('http_status:404', 47113)).toBe(false);
  });

  it('finds the tailnet address among the interfaces, and the MagicDNS name', () => {
    expect(
      tailnetAddress({
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
        eth0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
        tailscale0: [
          { address: 'fd7a:115c:a1e0::1', family: 'IPv6', internal: false },
          { address: '100.101.102.103', family: 'IPv4', internal: false },
        ],
      }),
    ).toBe('100.101.102.103');
    expect(
      tailnetAddress({ eth0: [{ address: '100.10.0.1', family: 'IPv4', internal: false }] }),
    ).toBeNull();
    expect(tailscaleDnsName('{"Self":{"DNSName":"desk.tail1234.ts.net."}}')).toBe(
      'desk.tail1234.ts.net',
    );
    expect(tailscaleDnsName('not json')).toBeNull();
  });

  it('gives each route its address', () => {
    const input = {
      hostname: null,
      detected: ['auto.example.com'],
      tailnet: '100.64.0.9',
      port: 47113,
    };
    expect(relayUrlFor('cloudflare', { ...input, hostname: 'hub.example.com' })).toBe(
      'https://hub.example.com',
    );
    expect(relayUrlFor('cloudflare', input)).toBe('https://auto.example.com');
    expect(relayUrlFor('tailscale', input)).toBe('http://100.64.0.9:47113');
    expect(relayUrlFor(null, input)).toBeNull();
  });

  it('reads its settings back, keeping nothing half-valid', () => {
    expect(parseRelayConfig({ enabled: true, route: 'nope', token: 'x' })).toEqual({
      enabled: false,
      route: null,
      token: 'x',
      hostname: null,
    });
    const config = parseConfig(
      { relay: { enabled: true, route: 'tailscale' }, localHubPort: 47113, legacyAppAsked: true },
      () => 'device-key-1',
    );
    expect(config.relay).toEqual({
      enabled: true,
      route: 'tailscale',
      token: null,
      hostname: null,
    });
    expect(config.localHubPort).toBe(47113);
    expect(config.legacyAppAsked).toBe(true);
    expect(parseConfig(null, () => 'device-key-1').relay).toEqual(DEFAULT_RELAY);
  });
});
