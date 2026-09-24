import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REALTIME_NAMESPACES } from '../../src/lib/module.js';
import { SOCKET_PATH } from '../../src/app/sockets.js';
import { signedInHub, type TestHub } from './helpers.js';

describe('realtime composition', () => {
  let hub: TestHub & { token: string };
  let baseUrl: string;
  beforeAll(async () => {
    hub = await signedInHub();
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const address = hub.app.server.address();
    baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  });
  afterAll(async () => {
    await hub.close();
  });

  it('exposes exactly the namespaces from ARCHITECTURE §Realtime plus /rt/jobs', () => {
    expect(hub.app.hub.namespaces).toEqual([
      '/rt/devices',
      '/rt/jobs',
      '/rt/rooms',
      '/rt/schedules',
      '/rt/sessions',
      '/rt/tasks',
    ]);
    expect(Object.values(REALTIME_NAMESPACES).sort()).toEqual(hub.app.hub.namespaces);
  });

  it('accepts a client on /rt/sessions over the /rt engine path', async () => {
    const socket = connect(`${baseUrl}${REALTIME_NAMESPACES.sessions}`, {
      path: SOCKET_PATH,
      transports: ['websocket'],
      auth: { token: hub.token, profile: 'default' },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    expect(socket.connected).toBe(true);
    socket.disconnect();
  });
});
