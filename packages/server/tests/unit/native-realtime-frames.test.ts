/**
 * The native clients (apps/ios; apps/android may do the same) speak Socket.IO without the
 * socket.io-client library: raw Engine.IO v4 / Socket.IO v5 text frames over one WebSocket
 * at `/rt/`. This test sends the hub exactly the frames the iOS app writes
 * (apps/ios/CoreHub/Realtime/SocketIOPacket.swift, pinned by its EngineIOTests) and checks
 * what comes back, so a change on the hub that would break a phone breaks here first.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { modules as defaultModules } from '../../src/modules/index.js';
import { principalScopeResolver } from '../../src/modules/auth/index.js';
import { createSessionsModule } from '../../src/modules/sessions/index.js';
import {
  FakeAgentDirectory,
  FakeAgentRunner,
  fakeHermes,
} from '../../src/modules/sessions/testing/fake-runner.js';
import { authed, signedInHub, type TestHub } from './helpers.js';

const AGENT_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
const NO_SUCH_SESSION = '01J8QK3ZR2W7M5N4P6T8V9X0ZZ';

let hub: TestHub & { token: string };
let wsUrl: string;
const sockets: WebSocket[] = [];

/** A raw socket that answers pings the way the app does and keeps every frame it hears. */
async function open(): Promise<{
  socket: WebSocket;
  frames: string[];
  next: (match: RegExp) => Promise<string>;
}> {
  const socket = new WebSocket(wsUrl);
  sockets.push(socket);
  const frames: string[] = [];
  const waiting: { match: RegExp; resolve: (frame: string) => void }[] = [];
  socket.addEventListener('message', (event) => {
    const frame = String(event.data);
    if (frame === '2') socket.send('3');
    frames.push(frame);
    for (const w of [...waiting])
      if (w.match.test(frame)) {
        waiting.splice(waiting.indexOf(w), 1);
        w.resolve(frame);
      }
  });
  const next = (match: RegExp) =>
    new Promise<string>((resolve, reject) => {
      const seen = frames.find((f) => match.test(f));
      if (seen) {
        frames.splice(frames.indexOf(seen), 1);
        return resolve(seen);
      }
      const timer = setTimeout(() => reject(new Error(`no frame matching ${match}`)), 5_000);
      waiting.push({
        match,
        resolve: (frame) => {
          clearTimeout(timer);
          frames.splice(frames.indexOf(frame), 1);
          resolve(frame);
        },
      });
    });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket failed')), { once: true });
  });
  return { socket, frames, next };
}

beforeAll(async () => {
  const sessions = createSessionsModule({
    agents: new FakeAgentDirectory([fakeHermes(AGENT_ID)]),
    runner: new FakeAgentRunner({
      script: [{ type: 'message_delta', text: 'مرحبا' }, { type: 'completed' }],
    }),
    scopes: principalScopeResolver,
  });
  hub = await signedInHub(
    {},
    { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
  );
  await hub.app.listen({ port: 0, host: '127.0.0.1' });
  const address = hub.app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  wsUrl = `ws://127.0.0.1:${port}/rt/?EIO=4&transport=websocket`;
});

afterAll(async () => {
  for (const socket of sockets) socket.close();
  await hub.close();
});

describe('realtime as the native clients speak it', () => {
  it('opens Engine.IO, admits a namespace with the bearer, and says why it refuses one', async () => {
    const { socket, next } = await open();
    const handshake = JSON.parse((await next(/^0\{/)).slice(1)) as { pingInterval: number };
    expect(handshake.pingInterval).toBeGreaterThan(0);

    socket.send('40/rt/sessions,{"token":"not-a-jwt","profile":"default"}');
    const refused = await next(/^44\/rt\/sessions,/);
    const body = JSON.parse(refused.slice('44/rt/sessions,'.length)) as {
      message: string;
      data?: { code?: string };
    };
    expect(body.message).toBe('unauthorized');
    expect(body.data?.code).toBe('unauthorized');

    socket.send(
      `40/rt/sessions,${JSON.stringify({ token: hub.token, profile: 'default', profiles: 'all' })}`,
    );
    expect(await next(/^40\/rt\/sessions,\{"sid":/)).toBeTruthy();
  });

  it('acknowledges subscribe with the id it was sent, and streams a run as event frames', async () => {
    const { socket, next } = await open();
    await next(/^0\{/);
    socket.send(`40/rt/sessions,${JSON.stringify({ token: hub.token, profile: 'default' })}`);
    await next(/^40\/rt\/sessions,/);

    socket.send(`42/rt/sessions,7["subscribe",{"session_id":"${NO_SUCH_SESSION}"}]`);
    const refusal = await next(/^43\/rt\/sessions,7\[/);
    expect(JSON.parse(refusal.slice('43/rt/sessions,7'.length))[0]).toMatchObject({
      ok: false,
      code: 'not_found',
    });

    const created = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { agent_id: AGENT_ID },
    });
    expect(created.statusCode).toBe(201);
    const sessionId = (created.json() as { id: string }).id;
    socket.send(`42/rt/sessions,8["subscribe",{"session_id":"${sessionId}"}]`);
    const ack = await next(/^43\/rt\/sessions,8\[/);
    expect(JSON.parse(ack.slice('43/rt/sessions,8'.length))[0]).toMatchObject({ ok: true });

    const run = await authed(hub, hub.token, {
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/runs`,
      payload: { content: [{ type: 'text', text: 'hi' }] },
    });
    expect(run.statusCode).toBe(202);
    const delta = await next(/^42\/rt\/sessions,\["message\.delta",/);
    const [name, envelope] = JSON.parse(delta.slice('42/rt/sessions,'.length)) as [
      string,
      { event: string; seq: number; profile: string; payload: { delta: string } },
    ];
    expect(name).toBe('message.delta');
    expect(envelope.event).toBe('message.delta');
    expect(envelope.profile).toBe('default');
    expect(envelope.payload.delta).toBe('مرحبا');
    expect(await next(/^42\/rt\/sessions,\["run\.completed",/)).toBeTruthy();
  });
});

describe('a POST with nothing to send', () => {
  it('is refused when it still claims a JSON body, and served when it does not', async () => {
    // Why apps/ios drops `Content-Type` on a bodiless request (BodilessRequests in
    // HubAPI.swift): renewing a device's app token is a POST with no body.
    const created = await authed(hub, hub.token, {
      method: 'POST',
      url: '/api/v1/auth/app-tokens',
      payload: { name: 'phone', scopes: ['read'] },
    });
    expect(created.statusCode).toBe(201);
    const appToken = (created.json() as { token: string }).token;
    const claimed = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${appToken}`, 'content-type': 'application/json' },
      payload: '',
    });
    expect(claimed.statusCode).toBe(400);
    const plain = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${appToken}` },
    });
    expect(plain.statusCode).toBe(200);
    expect((plain.json() as { refresh_token: string | null }).refresh_token).toBeNull();
  });
});
