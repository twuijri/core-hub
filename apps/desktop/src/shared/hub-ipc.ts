/**
 * What the app and the hub it runs (local mode) say to each other over the child's IPC channel,
 * besides "listening" and "stop" (`main/local-hub.ts`, `hub/entry.ts`): the way in from outside
 * (DECISIONS §95). The hub asks (`relay`), the app answers (`relay-answer`) and also tells the
 * hub when the state changes on its own (`relay-state`), so a pairing started a second later
 * already gets the tunnel's address.
 */
import type { RelayChange, RelayState } from './relay.js';

export type HubToApp = { type: 'relay'; id: number; op: 'get' | 'set'; change?: RelayChange };

export type AppToHub =
  | { type: 'relay-answer'; id: number; ok: true; state: RelayState }
  | { type: 'relay-answer'; id: number; ok: false; reason: string | null; message: string }
  | { type: 'relay-state'; state: RelayState };

export function isHubToApp(message: unknown): message is HubToApp {
  const m = message as Partial<HubToApp> | null;
  return (
    !!m && m.type === 'relay' && typeof m.id === 'number' && (m.op === 'get' || m.op === 'set')
  );
}

/** The hub's side: a `RelayHost` (packages/server `devices/outside.ts`) over `process.send`. */
export function ipcRelayHost(input: {
  send: (message: HubToApp) => void;
  /** Subscribes to what the app sends; the hub entry passes `process.on('message')`. */
  listen: (listener: (message: unknown) => void) => void;
  refusal: (reason: string, message: string) => Error;
  timeoutMs?: number;
}) {
  let current: RelayState | null = null;
  let next = 1;
  const pending = new Map<
    number,
    { resolve: (state: RelayState) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  input.listen((raw) => {
    const message = raw as AppToHub | null;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'relay-state') {
      current = message.state;
      return;
    }
    if (message.type !== 'relay-answer') return;
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.ok) {
      current = message.state;
      waiting.resolve(message.state);
    } else if (message.reason) waiting.reject(input.refusal(message.reason, message.message));
    else waiting.reject(new Error(message.message));
  });
  const ask = (op: 'get' | 'set', change?: RelayChange) =>
    new Promise<RelayState>((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('the desktop app did not answer'));
      }, input.timeoutMs ?? 15_000);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      input.send(change ? { type: 'relay', id, op, change } : { type: 'relay', id, op });
    });
  return {
    get: () => ask('get'),
    set: (change: RelayChange) => ask('set', change),
    current: () => current,
  };
}
