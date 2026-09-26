// The Tailscale route's forwarder (DECISIONS §95, §96). The hub believes `X-Forwarded-For` from
// loopback, and the forwarder connects from loopback, so the forwarder must never pass on what a
// tailnet peer says about itself: it drops the peer's own claims and names the peer it saw.
import { createServer as createHttp, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TRUST_PROXY,
  clientAddressFrom,
  compileTrust,
} from '../../../../packages/server/src/lib/client-address.js';
import { Forwarder } from '../../src/main/tailnet.js';

const SPOOFED = '6.6.6.6';
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
});

/** A stand-in hub that records what it was sent, answers requests and echoes a WebSocket. */
async function fakeHub() {
  const seen: Array<{ headers: IncomingHttpHeaders; peer: string | undefined }> = [];
  const hub: Server = createHttp((req, res) => {
    seen.push({ headers: req.headers, peer: req.socket.remoteAddress });
    res.end('hub says hello');
  });
  const upgraded: Array<{ destroy(): void }> = [];
  hub.on('upgrade', (req, socket) => {
    upgraded.push(socket);
    seen.push({ headers: req.headers, peer: req.socket.remoteAddress });
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
    );
    socket.on('data', (chunk) => socket.write(chunk));
  });
  await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    for (const socket of upgraded) socket.destroy();
    hub.closeAllConnections();
    await new Promise((resolve) => hub.close(resolve));
  });
  return { seen, port: (hub.address() as AddressInfo).port };
}

/** The forwarder on a free loopback port; 127.0.0.1 plays the tailnet address here. */
async function forwarderTo(hubPort: number): Promise<number> {
  const probe = createHttp();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
  const forwarder = new Forwarder(() => hubPort);
  await forwarder.listen('127.0.0.1', port);
  cleanup.push(() => forwarder.close());
  return port;
}

/** The address the hub would count for what it received (its own rule, default trust). */
function hubCounts(entry: { headers: IncomingHttpHeaders; peer: string | undefined }): string {
  return clientAddressFrom(
    entry.peer,
    entry.headers['x-forwarded-for'],
    compileTrust(DEFAULT_TRUST_PROXY),
  );
}

describe('the tailnet forwarder', () => {
  it('drops what a peer says about itself and names the peer it saw', async () => {
    const hub = await fakeHub();
    const port = await forwarderTo(hub.port);
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
      headers: {
        'x-forwarded-for': SPOOFED,
        forwarded: `for=${SPOOFED}`,
        'x-real-ip': SPOOFED,
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
      },
    });
    expect(await response.text()).toBe('hub says hello');
    const [entry] = hub.seen;
    expect(entry?.headers['x-forwarded-for']).toBe('127.0.0.1');
    for (const name of ['forwarded', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-proto'])
      expect(entry?.headers[name]).toBeUndefined();
    expect(hubCounts(entry!)).toBe('127.0.0.1');
    expect(hubCounts(entry!)).not.toBe(SPOOFED);
  });

  it('carries a WebSocket upgrade both ways, with the same header rule', async () => {
    const hub = await fakeHub();
    const port = await forwarderTo(hub.port);
    const socket = connect(port, '127.0.0.1');
    cleanup.push(async () => {
      socket.destroy();
    });
    let received = '';
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
    });
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write(
      [
        'GET /rt/?EIO=4&transport=websocket HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        `X-Forwarded-For: ${SPOOFED}`,
        '',
        '',
      ].join('\r\n'),
    );
    const until = async (text: string) => {
      for (let i = 0; i < 100 && !received.includes(text); i += 1)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(received).toContain(text);
    };
    await until('101 Switching Protocols');
    socket.write('ping-through-the-tunnel');
    await until('ping-through-the-tunnel');
    const [entry] = hub.seen;
    expect(entry?.headers['x-forwarded-for']).toBe('127.0.0.1');
    expect(entry?.headers.upgrade).toBe('websocket');
    expect(hubCounts(entry!)).not.toBe(SPOOFED);
  });
});
