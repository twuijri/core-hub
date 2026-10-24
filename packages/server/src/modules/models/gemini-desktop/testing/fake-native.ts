/**
 * A stand-in for Gemini Desktop's native service, for tests (DECISIONS §155): a plain-text HTTP/2
 * server on loopback that speaks the same gRPC framing, answers `GetUserStatus` with a scripted
 * status and `ProcessQuery` with growing snapshots and the conversation ids, and keeps
 * conversations the way the live service did on 2026-10-24 — template field 4 `{c_, r_, rc_}`
 * continues (or branches) a conversation, anything else starts one.
 */
import http2, { type Http2Server, type ServerHttp2Stream } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { msg, nested, num, parseWire } from '../protobuf.js';
import type { SessionOpener } from '../transport.js';

export interface FakeRequest {
  method: string;
  token: string;
  text: string;
  category: number;
  variantId: string | null;
  resume: { conversation: string; response: string; choice: string } | null;
}

export interface FakeTurn {
  conversation: string;
  response: string;
  choice: string;
  /** The response this turn followed, or null for the first. */
  parent: string | null;
  text: string;
  answer: string;
}

export interface FakeNative {
  opener: SessionOpener;
  requests: FakeRequest[];
  turns: FakeTurn[];
  /** The status `GetUserStatus` answers; the default offers two modes. */
  status: Buffer;
  /** Tokens the service accepts; others answer UNAUTHENTICATED. Empty: any. */
  tokens: Set<string>;
  /** Refuse a continuation with this gRPC code (Google forgot the conversation). */
  refuseResume: number | null;
  /** Answer ProcessQuery with this gRPC code before any text. */
  failWith: number | null;
  gzip: boolean;
  /** Hold the answer after its first snapshot until released (cancellation tests). */
  hold: boolean;
  release(): void;
  answer(request: FakeRequest): string;
  close(): Promise<void>;
}

/** A status message with mode policies (field 34 → 2 → 1). */
export function statusWith(
  modes: {
    title: string;
    category: number;
    disabled?: boolean;
    variantId?: string;
    short?: string;
  }[],
  legacy: { id: string; title: string; category: number }[] = [],
): Buffer {
  const configs = modes.map((mode) =>
    msg(
      1,
      Buffer.concat([
        num(3, mode.category),
        num(4, mode.disabled ? 1 : 0),
        msg(14, mode.title),
        ...(mode.short ? [msg(6, mode.short)] : []),
        ...(mode.variantId ? [msg(5, mode.variantId)] : []),
      ]),
    ),
  );
  return Buffer.concat([
    ...legacy.map((old) =>
      msg(17, Buffer.concat([msg(1, old.id), msg(19, old.title), num(23, old.category)])),
    ),
    ...(modes.length > 0 ? [msg(34, msg(2, Buffer.concat(configs)))] : []),
  ]);
}

function readRequest(method: string, token: string, frames: Buffer[]): FakeRequest {
  const template = nested(frames[0] ?? Buffer.alloc(0), 1000, 1001, 1)[0] ?? Buffer.alloc(0);
  let category = 0;
  let variantId: string | null = null;
  let resume: FakeRequest['resume'] = null;
  for (const item of parseWire(template)) {
    if (item.field === 47) category = Number(item.int);
    if (item.field === 66) variantId = item.bytes.toString('utf8');
    if (item.field === 4) {
      const ids = parseWire(item.bytes);
      const get = (field: number) =>
        ids.find((one) => one.field === field)?.bytes.toString('utf8') ?? '';
      resume = { conversation: get(1), response: get(2), choice: get(3) };
    }
  }
  const text = nested(frames[1] ?? Buffer.alloc(0), 1007, 1)[0]?.toString('utf8') ?? '';
  return { method, token, text, category, variantId, resume };
}

function answerFrame(
  choice: string,
  text: string,
  ids: { c: string; r: string } | null,
  title: string | null,
): Buffer {
  const candidate = msg(1, Buffer.concat([msg(1, choice), msg(2, msg(1, text))]));
  const parts = [candidate];
  parts.push(
    msg(2, ids ? Buffer.concat([msg(1, ids.c), msg(2, ids.r)]) : Buffer.concat([msg(1), msg(2)])),
  );
  if (title) parts.push(msg(4, msg(1, title)));
  parts.push(msg(30, 'Used Fake model'));
  return msg(1003, msg(1, Buffer.concat(parts)));
}

export async function fakeNative(): Promise<FakeNative> {
  let counter = 0;
  const id = (prefix: string) => `${prefix}_${(++counter).toString(16).padStart(16, '0')}`;
  let releaseHold: (() => void) | null = null;
  const state: Omit<FakeNative, 'opener' | 'close'> = {
    requests: [],
    turns: [],
    status: statusWith([
      { title: '3.5 Flash-Lite', category: 6 },
      { title: '3.1 Pro', category: 3, variantId: 'pro-v1' },
    ]),
    tokens: new Set(),
    refuseResume: null,
    failWith: null,
    gzip: false,
    hold: false,
    release: () => releaseHold?.(),
    answer: (request) => `echo: ${request.text.split('\n').filter(Boolean).pop() ?? ''}`,
  };
  const sessions = new Set<http2.ServerHttp2Session>();

  const send = (
    stream: ServerHttp2Stream,
    messages: Buffer[],
    status: number,
    then?: Promise<void>,
  ) => {
    stream.respond(
      {
        ':status': 200,
        'content-type': 'application/grpc',
        ...(state.gzip ? { 'grpc-encoding': 'gzip' } : {}),
      },
      { waitForTrailers: true },
    );
    stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': String(status) }));
    const write = (message: Buffer) => {
      const body = state.gzip ? gzipSync(message) : message;
      const head = Buffer.alloc(5);
      head[0] = state.gzip ? 1 : 0;
      head.writeUInt32BE(body.length, 1);
      stream.write(Buffer.concat([head, body]));
    };
    void (async () => {
      for (const [index, message] of messages.entries()) {
        if (stream.destroyed) return;
        write(message);
        if (index === 1 && then) await then;
      }
      if (!stream.destroyed) stream.end();
    })();
  };

  const server: Http2Server = http2.createServer();
  server.on('session', (session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  server.on('stream', (stream: ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      let body = Buffer.concat(chunks);
      const frames: Buffer[] = [];
      while (body.length >= 5) {
        const length = body.readUInt32BE(1);
        frames.push(body.subarray(5, 5 + length));
        body = body.subarray(5 + length);
      }
      const method = String(headers[':path']);
      const token = String(headers.authorization ?? '').replace(/^Bearer /, '');
      const request = readRequest(method, token, frames);
      state.requests.push(request);
      if (headers['content-type'] !== 'application/grpc') return send(stream, [], 3);
      if (state.tokens.size > 0 && !state.tokens.has(token)) return send(stream, [], 16);
      if (method.endsWith('/GetUserStatus')) return send(stream, [state.status], 0);
      if (state.failWith !== null) return send(stream, [], state.failWith);
      let conversation: string;
      let parent: string | null = null;
      if (request.resume) {
        const known = state.turns.find(
          (turn) =>
            turn.conversation === request.resume!.conversation &&
            turn.response === request.resume!.response &&
            turn.choice === request.resume!.choice,
        );
        if (state.refuseResume !== null || !known) return send(stream, [], state.refuseResume ?? 3);
        conversation = known.conversation;
        parent = known.response;
      } else {
        conversation = id('c');
      }
      const response = id('r');
      const choice = id('rc');
      const answer = state.answer(request);
      state.turns.push({ conversation, response, choice, parent, text: request.text, answer });
      const half = answer.slice(0, Math.ceil(answer.length / 2));
      const held = state.hold ? new Promise<void>((resolve) => (releaseHold = resolve)) : undefined;
      send(
        stream,
        [
          msg(1014, msg(1, msg(1, conversation))),
          answerFrame(choice, half, null, null),
          answerFrame(choice, answer, null, null),
          answerFrame(choice, answer, { c: conversation, r: response }, 'A fake title'),
        ],
        0,
        held,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return Object.assign(state, {
    opener: (() => Promise.resolve(http2.connect(`http://127.0.0.1:${port}`))) as SessionOpener,
    close: () =>
      new Promise<void>((resolve) => {
        for (const session of sessions) session.destroy();
        server.close(() => resolve());
      }),
  }) as FakeNative;
}
