/**
 * The connection the footer reports, across a reload (owner, 2026-09-23): «اذا سويت رفرش
 * للصفحة يعطيني تحت يسار اوفلاين لزم اضغط على اي محادثه ثانية علشان يرجع كونكت».
 *
 * A page opened from the address bar asks for its socket in its own effect, before the
 * provider's; the provider must not tear that socket down on its first render.
 *
 * And a page that asks for no socket at all — any Settings page, where the sidebar is the
 * settings list — still has the footer (owner, 2026-09-23: «اذا دخلت الاعدادات وحدثت الصفحة
 * يعطيني اوفلاين»): the provider opens the socket the footer reports on its own.
 *
 * Every namespace needs a valid token (2026-09-24, realtime auth scope): a handshake the hub
 * refuses for its token is not retried by socket.io, so the provider gets a new token and
 * brings the socket back with it.
 */
import { act, cleanup, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Options {
  onAuthRefused?: (socket: FakeSocket, used: string | undefined) => void;
}
const sockets: FakeSocket[] = [];
const options: Options[] = [];
class FakeSocket {
  connected = false;
  disconnected = false;
  /** False once the hub refused the handshake: socket.io will not retry on its own. */
  active = true;
  connects = 0;
  connect() {
    this.connects += 1;
    this.active = true;
  }
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
  connectNamespace: (given: Options) => {
    const socket = new FakeSocket();
    sockets.push(socket);
    options.push(given);
    return socket;
  },
}));

const refresh = vi.fn(async () => true);
const signedIn = (token = 't') => ({
  baseUrl: '',
  session: { token, user: { id: 'u1' } },
  profile: 'default',
  refresh,
});
let auth = signedIn();
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

/** What the footer does on a Settings page: read the state, ask for nothing. */
function Footer({ onState }: { onState: (state: string) => void }) {
  onState(useRealtime().state);
  return null;
}

afterEach(() => {
  cleanup();
  sockets.length = 0;
  options.length = 0;
  refresh.mockClear();
  auth = signedIn();
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

  it('opens the socket the footer reports on a page that never asks for one', () => {
    let state = '';
    render(
      <RealtimeProvider>
        <Footer onState={(next) => (state = next)} />
      </RealtimeProvider>,
    );
    expect(sockets).toHaveLength(1);
    expect(state).toBe('connecting');
    act(() => sockets[0]!.emit('connect'));
    expect(state).toBe('connected');
  });

  it('says offline when the hub cannot be reached, and connected once it can', () => {
    let state = '';
    render(
      <RealtimeProvider>
        <Footer onState={(next) => (state = next)} />
      </RealtimeProvider>,
    );
    act(() => sockets[0]!.emit('connect_error'));
    expect(state).toBe('offline');
    act(() => sockets[0]!.emit('connect'));
    expect(state).toBe('connected');
  });

  it('opens it again after the workspace changes, still with no page asking', () => {
    const view = render(
      <RealtimeProvider>
        <Footer onState={() => undefined} />
      </RealtimeProvider>,
    );
    auth = { ...auth, profile: 'labs' };
    view.rerender(
      <RealtimeProvider>
        <Footer onState={() => undefined} />
      </RealtimeProvider>,
    );
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.disconnected).toBe(true);
    expect(sockets[1]!.disconnected).toBe(false);
  });

  it('asks for a new token once when the hub refuses the old one, and comes back with it', () => {
    let state = '';
    const view = render(
      <RealtimeProvider>
        <Footer onState={(next) => (state = next)} />
      </RealtimeProvider>,
    );
    const socket = sockets[0]!;
    socket.active = false;
    act(() => {
      socket.emit('connect_error');
      options[0]!.onAuthRefused!(socket, 't');
      options[0]!.onAuthRefused!(socket, 't');
    });
    expect(state).toBe('offline');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(socket.connects).toBe(0);

    auth = signedIn('t2');
    view.rerender(
      <RealtimeProvider>
        <Footer onState={(next) => (state = next)} />
      </RealtimeProvider>,
    );
    expect(socket.connects).toBe(1);
    expect(sockets).toHaveLength(1);
    act(() => socket.emit('connect'));
    expect(state).toBe('connected');
  });

  it('comes back at once when a newer token is already there', () => {
    render(
      <RealtimeProvider>
        <Footer onState={() => undefined} />
      </RealtimeProvider>,
    );
    const socket = sockets[0]!;
    socket.active = false;
    act(() => options[0]!.onAuthRefused!(socket, 'an-older-token'));
    expect(refresh).not.toHaveBeenCalled();
    expect(socket.connects).toBe(1);
  });

  it('leaves alone a socket that is connected, or still retrying on its own', () => {
    const view = render(
      <RealtimeProvider>
        <Footer onState={() => undefined} />
      </RealtimeProvider>,
    );
    auth = signedIn('t2');
    view.rerender(
      <RealtimeProvider>
        <Footer onState={() => undefined} />
      </RealtimeProvider>,
    );
    expect(sockets[0]!.connects).toBe(0);
  });
});
