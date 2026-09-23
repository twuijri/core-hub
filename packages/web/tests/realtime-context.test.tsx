/**
 * The connection the footer reports, across a reload (owner, 2026-09-23): «اذا سويت رفرش
 * للصفحة يعطيني تحت يسار اوفلاين لزم اضغط على اي محادثه ثانية علشان يرجع كونكت».
 *
 * A page opened from the address bar asks for its socket in its own effect, before the
 * provider's; the provider must not tear that socket down on its first render.
 */
import { act, cleanup, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sockets: FakeSocket[] = [];
class FakeSocket {
  connected = false;
  disconnected = false;
  private handlers = new Map<string, Array<() => void>>();
  io = { on: () => undefined };
  on(event: string, handler: () => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }
  emit(event: string) {
    for (const handler of this.handlers.get(event) ?? []) handler();
  }
  removeAllListeners() {
    this.handlers.clear();
  }
  disconnect() {
    this.disconnected = true;
  }
}

vi.mock('../src/realtime/socket.js', () => ({
  NAMESPACES: { sessions: '/sessions', jobs: '/jobs', devices: '/devices', notify: '/notify' },
  connectNamespace: () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  },
}));

let auth = { baseUrl: '', session: { token: 't', user: { id: 'u1' } }, profile: 'default' };
vi.mock('../src/auth/context.js', () => ({ useAuth: () => auth }));

const { RealtimeProvider, useRealtime } = await import('../src/realtime/context.js');

function Page({ onState }: { onState: (state: string) => void }) {
  const realtime = useRealtime();
  // What a conversation page does: take the socket in an effect, again after a drop.
  useEffect(() => {
    realtime.socket('sessions');
  }, [realtime.epoch]);
  onState(realtime.state);
  return null;
}

afterEach(() => {
  cleanup();
  sockets.length = 0;
  auth = { baseUrl: '', session: { token: 't', user: { id: 'u1' } }, profile: 'default' };
});

describe('the realtime connection', () => {
  it('keeps the socket a page opened on its first render, and reports it connected', () => {
    let state = '';
    render(
      <RealtimeProvider>
        <Page onState={(next) => (state = next)} />
      </RealtimeProvider>,
    );
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.disconnected).toBe(false);
    act(() => sockets[0]!.emit('connect'));
    expect(state).toBe('connected');
  });

  it('starts over when the workspace changes, and the page takes the new socket', () => {
    const view = render(
      <RealtimeProvider>
        <Page onState={() => undefined} />
      </RealtimeProvider>,
    );
    auth = { ...auth, profile: 'labs' };
    view.rerender(
      <RealtimeProvider>
        <Page onState={() => undefined} />
      </RealtimeProvider>,
    );
    expect(sockets[0]!.disconnected).toBe(true);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.disconnected).toBe(false);
  });
});
