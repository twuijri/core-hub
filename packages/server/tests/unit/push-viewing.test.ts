/**
 * No push for a conversation the person is looking at (DECISIONS §149; the owner, 2026-10-01:
 * «اي رد يوصلني تنبيه على جوالي… اني انا فاتح الصفحة المفروض ما يرسلي تنبيه»).
 *
 * A client on `/rt/sessions` says `viewing { session_id }`; a finished reply, a failure or an
 * approval in that conversation is written to the inbox but not pushed. Another conversation
 * still pushes; `viewing { session_id: null }`, a closed socket or 45 s without a repeat end it;
 * a client that never says it is pushed to as before.
 */
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOCKET_PATH } from '../../src/app/sockets.js';
import { requireSqlite } from '../../src/lib/db.js';
import { pushFor } from '../../src/modules/devices/index.js';
import { notifierPort } from '../../src/modules/index.js';
import { ViewingRegistry, VIEWING_TTL_MS } from '../../src/modules/sessions/viewing.js';
import { authed, signedInHub, type TestHub } from './helpers.js';

type Hub = TestHub & { token: string; userId: string };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function started(): Promise<{ hub: Hub; url: string; workspace: string }> {
  const hub = (await signedInHub()) as Hub;
  cleanups.push(() => hub.close());
  await hub.app.listen({ port: 0, host: '127.0.0.1' });
  const address = hub.app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const workspace = (
    requireSqlite(hub.app.hub.database)
      .$client.prepare("select id from workspaces where slug = 'default'")
      .get() as { id: string }
  ).id;
  return { hub, url: `http://127.0.0.1:${port}/rt/sessions`, workspace };
}

async function socketOf(url: string, token: string): Promise<Socket> {
  const socket = connect(url, {
    path: SOCKET_PATH,
    transports: ['websocket'],
    auth: { token, profile: 'default' },
    reconnection: false,
  });
  cleanups.push(() => void socket.close());
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  return socket;
}

const viewing = (socket: Socket, sessionId: string | null) =>
  new Promise<{ ok: boolean; code?: string }>((resolve) =>
    socket.emit('viewing', { session_id: sessionId }, resolve),
  );

describe('push while the person is looking at the conversation', () => {
  it('writes the notice but does not push it; another conversation, or looking away, pushes again', async () => {
    const { hub, url, workspace } = await started();
    const sent = vi.spyOn(pushFor(hub.app), 'sendToUser').mockResolvedValue([]);
    const notifier = notifierPort(hub.app);
    const finished = (sessionId: string) =>
      notifier.runFinished({
        workspace,
        profile: 'default',
        userId: hub.userId,
        sessionId,
        sessionTitle: 'خطة الإطلاق',
        agentName: 'Hermes',
        outcome: 'succeeded',
        reason: null,
        replyPreview: 'تم',
      });
    const notices = async () =>
      (
        (await authed(hub, hub.token, { method: 'GET', url: '/api/v1/notify/notices' })).json() as {
          items: unknown[];
        }
      ).items.length;

    // A client that never says what it looks at (an older app): pushed as before.
    finished('S1');
    expect(sent).toHaveBeenCalledTimes(1);

    const socket = await socketOf(url, hub.token);
    expect(await viewing(socket, 'S1')).toMatchObject({ ok: true });
    finished('S1');
    expect(sent).toHaveBeenCalledTimes(1);
    // …and still in the inbox, unread.
    expect(await notices()).toBe(2);

    // Another conversation still pushes; so do a failure and an approval elsewhere.
    finished('S2');
    expect(sent).toHaveBeenCalledTimes(2);
    notifier.approvalRequested({
      workspace,
      profile: 'default',
      userId: hub.userId,
      sessionId: 'S1',
      agentName: 'Hermes',
      what: 'shell',
    });
    // An approval in the conversation being looked at is not pushed either.
    expect(sent).toHaveBeenCalledTimes(2);

    // Looking away (the tab hidden): pushed again.
    await viewing(socket, null);
    finished('S1');
    expect(sent).toHaveBeenCalledTimes(3);

    // A closed socket forgets what it was looking at.
    await viewing(socket, 'S1');
    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    finished('S1');
    expect(sent).toHaveBeenCalledTimes(4);
  });

  it('refuses a malformed viewing, and another person looking does not silence mine', async () => {
    const { hub, url } = await started();
    const socket = await socketOf(url, hub.token);
    expect(await viewing(socket, '' as never)).toMatchObject({ ok: false, code: 'bad_request' });
    const other = new ViewingRegistry();
    other.set('sock-a', 'someone-else', 'S1');
    expect(other.isViewing(hub.userId, 'S1')).toBe(false);
  });

  it('lasts 45 seconds unless the client says it again', () => {
    let now = 1_000;
    const registry = new ViewingRegistry(() => now);
    registry.set('sock-1', 'u1', 'S1');
    now += VIEWING_TTL_MS - 1;
    expect(registry.isViewing('u1', 'S1')).toBe(true);
    // The heartbeat renews it.
    registry.set('sock-1', 'u1', 'S1');
    now += VIEWING_TTL_MS - 1;
    expect(registry.isViewing('u1', 'S1')).toBe(true);
    now += 2;
    expect(registry.isViewing('u1', 'S1')).toBe(false);
    // Two screens: one looking away leaves the other.
    registry.set('sock-1', 'u1', 'S1');
    registry.set('sock-2', 'u1', 'S1');
    registry.set('sock-1', 'u1', null);
    expect(registry.isViewing('u1', 'S1')).toBe(true);
    registry.forget('sock-2');
    expect(registry.isViewing('u1', 'S1')).toBe(false);
  });
});
