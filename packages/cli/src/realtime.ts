// The realtime side: Socket.IO namespaces under the `/rt` engine path (ARCHITECTURE
// §Realtime), the event envelope of packages/contracts/events, and a validator that checks an
// incoming envelope against the JSON Schema of its event (`--strict`, and always in tests).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import { contractsRoot } from '@corehub/contracts';
import { io, type Socket } from 'socket.io-client';

/** Engine path of every namespace (docs/ARCHITECTURE.md §Realtime). */
export const SOCKET_PATH = '/rt';
export const SESSIONS_NAMESPACE = '/rt/sessions';
export const DEVICES_NAMESPACE = '/rt/devices';

export interface Envelope<P = Record<string, unknown>> {
  event: string;
  namespace: string;
  profile: string | null;
  ts: string;
  seq: number;
  payload: P;
}

export function isEnvelope(value: unknown): value is Envelope {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.event === 'string' &&
    typeof e.namespace === 'string' &&
    typeof e.seq === 'number' &&
    typeof e.ts === 'string' &&
    !!e.payload &&
    typeof e.payload === 'object'
  );
}

export interface ConnectOptions {
  server: string;
  namespace: string;
  token?: string | undefined;
  profile?: string | undefined;
}

/** Reconnects with backoff capped at 30 s, as events/README.md §Reconnection asks. */
export function connectNamespace(options: ConnectOptions): Socket {
  return io(`${options.server}${options.namespace}`, {
    path: SOCKET_PATH,
    transports: ['websocket', 'polling'],
    auth: {
      ...(options.token ? { token: options.token } : {}),
      ...(options.profile ? { profile: options.profile } : {}),
    },
    reconnection: true,
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 30_000,
    timeout: 10_000,
  });
}

export interface SubscribeAck {
  ok: boolean;
  replayed?: number;
  truncated?: boolean;
  error?: string;
  code?: string;
}

export function subscribe(
  socket: Socket,
  sessionId: string,
  afterSeq: number,
  timeoutMs = 10_000,
): Promise<SubscribeAck> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('subscribe timed out')), timeoutMs);
    socket.emit(
      'subscribe',
      afterSeq > 0 ? { session_id: sessionId, after_seq: afterSeq } : { session_id: sessionId },
      (ack: SubscribeAck) => {
        clearTimeout(timer);
        resolve(ack);
      },
    );
  });
}

export class EnvelopeValidator {
  private readonly ajv: Ajv2020;
  private readonly compiled = new Map<string, ReturnType<Ajv2020['compile']>>();

  constructor(private readonly eventsDir: string = path.join(contractsRoot(), 'events')) {
    this.ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
    // ajv-formats is CommonJS: the callable lives on module.exports and on .default.
    const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
      addFormatsModule) as FormatsPlugin;
    addFormats(this.ajv);
  }

  /** Problems found, empty when the envelope matches its schema. */
  problems(envelope: unknown): string[] {
    if (!isEnvelope(envelope)) return ['not an event envelope'];
    if (!envelope.namespace.startsWith(`${SOCKET_PATH}/`))
      return [`unknown namespace ${envelope.namespace}`];
    const dir = envelope.namespace.slice(SOCKET_PATH.length + 1);
    if (!/^[a-z]+$/.test(dir) || !/^[a-z_]+\.[a-z_]+$/.test(envelope.event))
      return [`unknown event ${envelope.namespace} ${envelope.event}`];
    const key = `${dir}/${envelope.event}`;
    let validate = this.compiled.get(key);
    if (!validate) {
      const file = path.join(this.eventsDir, dir, `${envelope.event}.schema.json`);
      let schema: object;
      try {
        schema = JSON.parse(readFileSync(file, 'utf8')) as object;
      } catch {
        return [`no schema for ${envelope.namespace} ${envelope.event}`];
      }
      validate = this.ajv.compile(schema);
      this.compiled.set(key, validate);
    }
    if (validate(envelope)) return [];
    return (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`);
  }
}
