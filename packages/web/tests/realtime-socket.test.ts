/**
 * Every realtime namespace needs a valid token (2026-09-24, realtime auth scope). A
 * handshake the hub refuses is not retried by socket.io, so `connectNamespace` says when
 * the refusal is about the token — and which token it was — for the provider to act on.
 */
import { describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => void;
class FakeIo {
  active = true;
  handlers = new Map<string, Handler[]>();
  constructor(readonly opts: { auth: (cb: (data: unknown) => void) => void }) {}
  on(event: string, handler: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }
  fire(event: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
  connect() {}
}
const made: FakeIo[] = [];
vi.mock('socket.io-client', () => ({
  io: (_url: string, opts: FakeIo['opts']) => {
    const socket = new FakeIo(opts);
    made.push(socket);
    return socket;
  },
}));

const { connectNamespace } = await import('../src/realtime/socket.js');

function open(token: string | undefined) {
  const onAuthRefused = vi.fn();
  connectNamespace({
    baseUrl: '',
    namespace: '/rt/sessions',
    token: () => token,
    profile: () => 'default',
    onAuthRefused,
  });
  const socket = made[made.length - 1]!;
  let handshake: unknown;
  socket.opts.auth((data) => (handshake = data));
  return { socket, onAuthRefused, handshake };
}

describe('connectNamespace', () => {
  it('sends the token and the workspace in the handshake', () => {
    expect(open('t1').handshake).toEqual({ token: 't1', profile: 'default' });
  });

  it('reports a refused token, with the token the handshake carried', () => {
    for (const code of ['unauthorized', 'token_expired']) {
      const { socket, onAuthRefused } = open('t1');
      socket.active = false;
      socket.fire('connect_error', new Error(code));
      expect(onAuthRefused).toHaveBeenCalledWith(socket, 't1');
    }
  });

  it('says nothing for a refusal a token cannot cure, or while socket.io still retries', () => {
    const refusedWorkspace = open('t1');
    refusedWorkspace.socket.active = false;
    refusedWorkspace.socket.fire('connect_error', new Error('profile_not_found'));
    expect(refusedWorkspace.onAuthRefused).not.toHaveBeenCalled();

    const unreachable = open('t1');
    unreachable.socket.fire('connect_error', new Error('xhr poll error'));
    expect(unreachable.onAuthRefused).not.toHaveBeenCalled();
  });
});
