// The loopback origin: the bundled web client, and /api + /rt forwarded to the hub —
// requests, streams and WebSocket upgrades — with nothing added and nothing leaked.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isHubPath, resolveStatic, startProxy, type ProxyServer } from '../../src/main/proxy.js';

let webDir: string;
let hub: http.Server;
let hubOrigin: string;
let seen: http.IncomingHttpHeaders[] = [];
let proxy: ProxyServer;
let hubSockets: net.Socket[] = [];

beforeEach(async () => {
  webDir = mkdtempSync(path.join(os.tmpdir(), 'corehub-web-'));
  writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>web</title>');
  mkdirSync(path.join(webDir, 'assets'));
  writeFileSync(path.join(webDir, 'assets/app-1.js'), 'console.log(1)');
  seen = [];
  hub = http.createServer((req, res) => {
    seen.push(req.headers);
    if (req.url?.startsWith('/api/v1/jobs')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => res.end('data: two\n\n'), 50);
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'keep-alive' });
      res.end(JSON.stringify({ method: req.method, url: req.url, body }));
    });
  });
  hubSockets = [];
  hub.on('upgrade', (req, socket) => {
    hubSockets.push(socket as net.Socket);
    seen.push(req.headers);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    socket.on('data', (data) => socket.write(Buffer.concat([Buffer.from('echo:'), data])));
  });
  await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
  hubOrigin = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  proxy = await startProxy({ webDir, preferredPort: null });
});

afterEach(async () => {
  await proxy.close();
  hub.closeAllConnections();
  for (const socket of hubSockets) socket.destroy();
  await new Promise((resolve) => hub.close(resolve));
});

describe('paths', () => {
  it('sends only /api and /rt to the hub', () => {
    expect(isHubPath('/api/v1/meta')).toBe(true);
    expect(isHubPath('/rt/?EIO=4')).toBe(true);
    expect(isHubPath('/rt')).toBe(true);
    expect(isHubPath('/apix')).toBe(false);
    expect(isHubPath('/chat/1')).toBe(false);
  });

  it('never serves a file outside the web client', () => {
    expect(resolveStatic(webDir, '/assets/app-1.js')).toBe(path.join(webDir, 'assets/app-1.js'));
    expect(resolveStatic(webDir, '/../../etc/passwd')).toBeNull();
    expect(resolveStatic(webDir, '/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
    expect(resolveStatic(webDir, '/assets')).toBeNull();
    expect(resolveStatic(webDir, '/%E0%A4%A')).toBeNull();
  });
});

describe('the loopback origin', () => {
  it('serves the web client, with index.html for every app page', async () => {
    const page = await fetch(`${proxy.origin}/chat/01J`);
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-cache');
    expect(await page.text()).toContain('<title>web</title>');
    const asset = await fetch(`${proxy.origin}/assets/app-1.js`);
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    expect(asset.headers.get('cache-control')).toContain('immutable');
  });

  it('answers 503 in the contract envelope until a hub is chosen', async () => {
    const res = await fetch(`${proxy.origin}/api/v1/meta`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'service_unavailable' });
  });

  it('forwards requests to the hub as the hub’s own client would send them', async () => {
    proxy.setTarget(hubOrigin);
    const res = await fetch(`${proxy.origin}/api/v1/sessions?limit=2`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer abc',
        'content-type': 'application/json',
        origin: proxy.origin,
      },
      body: JSON.stringify({ title: 'x' }),
    });
    expect(await res.json()).toEqual({
      method: 'POST',
      url: '/api/v1/sessions?limit=2',
      body: '{"title":"x"}',
    });
    const headers = seen.at(-1)!;
    expect(headers.host).toBe(new URL(hubOrigin).host);
    expect(headers.origin).toBe(hubOrigin);
    expect(headers.authorization).toBe('Bearer abc');
    expect(res.headers.get('connection')).not.toBe('keep-alive, keep-alive');
  });

  it('streams server-sent events as they come', async () => {
    proxy.setTarget(hubOrigin);
    const res = await fetch(`${proxy.origin}/api/v1/jobs`);
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toBe('data: one\n\n');
    let rest = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += new TextDecoder().decode(chunk.value);
    }
    expect(rest).toBe('data: two\n\n');
  });

  it('carries a WebSocket upgrade on /rt through to the hub', async () => {
    proxy.setTarget(hubOrigin);
    const socket = net.connect(proxy.port, '127.0.0.1');
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(
      [
        'GET /rt/?EIO=4&transport=websocket HTTP/1.1',
        `Host: 127.0.0.1:${proxy.port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        `Origin: ${proxy.origin}`,
        '',
        '',
      ].join('\r\n'),
    );
    const handshake = await new Promise<string>((resolve) =>
      socket.once('data', (data) => resolve(String(data))),
    );
    expect(handshake).toMatch(/^HTTP\/1.1 101/);
    expect(seen.at(-1)!.origin).toBe(hubOrigin);
    socket.write('ping');
    const echoed = await new Promise<string>((resolve) =>
      socket.once('data', (data) => resolve(String(data))),
    );
    expect(echoed).toBe('echo:ping');
    socket.destroy();
  });

  it('refuses a request addressed to another host name (DNS rebinding)', async () => {
    proxy.setTarget(hubOrigin);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: proxy.port,
          path: '/api/v1/meta',
          headers: { host: 'evil.example' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(421);
    expect(seen).toHaveLength(0);
  });

  it('answers 503 when the hub is down', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    proxy.setTarget(`http://127.0.0.1:${port}`);
    const res = await fetch(`${proxy.origin}/api/v1/meta`);
    expect(res.status).toBe(503);
  });

  it('keeps its port across launches, and moves when the port is taken', async () => {
    const again = await startProxy({ webDir, preferredPort: proxy.port });
    expect(again.port).not.toBe(proxy.port);
    await again.close();
    const port = proxy.port;
    await proxy.close();
    proxy = await startProxy({ webDir, preferredPort: port });
    expect(proxy.port).toBe(port);
  });
});
