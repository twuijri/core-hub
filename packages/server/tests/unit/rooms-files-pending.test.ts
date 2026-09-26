/**
 * Rooms from a phone (contract decision §99): a person's message carries pictures and files
 * the seats receive with their turn, and what a seat asks a person (an approval, a question)
 * names its room — in the pending list (`sessions.listApprovals`) and on the room itself
 * (`RoomDetail.pending_approvals`). The seats run on the scripted runner, with the real
 * `knowledge` attachments behind them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { modules as defaultModules } from '../../src/modules/index.js';
import { principalScopeResolver } from '../../src/modules/auth/index.js';
import { attachmentsPort, knowledgeModule } from '../../src/modules/knowledge/index.js';
import { conductorFor } from '../../src/modules/rooms/index.js';
import { createSessionsModule, type AgentRunRequest } from '../../src/modules/sessions/index.js';
import {
  FakeAgentDirectory,
  FakeAgentRunner,
  fakeHermes,
  type ScriptStep,
} from '../../src/modules/sessions/testing/fake-runner.js';
import { authed, signedInHub } from './helpers.js';

type Json = Record<string, unknown>;
type Hub = Awaited<ReturnType<typeof signedInHub>>;
const AGENT = '01KAGENTXYZ000000000000000';

let hub: Hub;
let script: ScriptStep[] | null = null;
const requests: AgentRunRequest[] = [];

async function call(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) {
  const res = await authed(hub, hub.token, {
    method,
    url: `/api/v1${url}`,
    ...(payload === undefined ? {} : { payload }),
  });
  return { status: res.statusCode, body: (res.body ? res.json() : {}) as Json };
}

async function upload(name: string, body: Buffer, type: string): Promise<string> {
  const boundary = '----corehubRoomFiles';
  const res = await authed(hub, hub.token, {
    method: 'POST',
    url: '/api/v1/attachments',
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
          `Content-Type: ${type}\r\n\r\n`,
      ),
      body,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function room(name: string) {
  const res = await call('POST', '/rooms', { name, seats: [{ agent_id: AGENT, name: 'المصمم' }] });
  expect(res.status).toBe(201);
  const made = res.body.room as { id: string; seats: Array<{ id: string }> };
  return { id: made.id, seatId: made.seats[0]!.id };
}

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c6300010000050001' +
    '0d0a2db40000000049454e44ae426082',
  'hex',
);

beforeAll(async () => {
  const runner = new FakeAgentRunner({
    scriptFor(request) {
      requests.push(request);
      return script ?? [{ type: 'message_delta', text: 'وصلت.' }, { type: 'completed' }];
    },
  });
  const sessions = createSessionsModule({
    agents: new FakeAgentDirectory([fakeHermes(AGENT)]),
    runner,
    attachments: attachmentsPort,
    agentTimeoutMs: 5_000,
    scopes: principalScopeResolver,
  });
  hub = await signedInHub(
    {},
    {
      modules: defaultModules.map((m) =>
        m.name === 'sessions' ? sessions : m.name === 'knowledge' ? knowledgeModule : m,
      ),
    },
  );
});

afterAll(async () => {
  await hub?.close();
});

beforeEach(() => {
  script = null;
  requests.length = 0;
});

describe('files in a room (§99)', () => {
  it('a picture and a file go into the room, and with the seat’s turn', async () => {
    const { id } = await room('غرفة الصور');
    const picture = await upload('shot.png', PNG, 'image/png');
    const notes = await upload('notes.txt', Buffer.from('ملاحظات'), 'text/plain');
    const posted = await call('POST', `/rooms/${id}/messages`, {
      content: [
        { type: 'text', text: 'ما رأيك؟' },
        { type: 'image', attachment_id: picture },
        { type: 'file', attachment_id: notes },
      ],
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(202);
    await conductorFor(hub.app).idle();

    const items = (await call('GET', `/rooms/${id}/messages`)).body.items as Array<Json>;
    const mine = items.find((m) => m.role === 'user') as { content: Json[] };
    expect(mine.content).toEqual([
      { type: 'text', text: 'ما رأيك؟' },
      expect.objectContaining({ type: 'image', attachment_id: picture, name: 'shot.png' }),
      expect.objectContaining({ type: 'file', attachment_id: notes, name: 'notes.txt' }),
    ]);

    // The seat's turn carried both files, and its words named them.
    const turn = requests.at(-1)!;
    const files = turn.prompt.filter((block) => block.type === 'attachment');
    expect(files.map((block) => block.type === 'attachment' && block.attachmentId)).toEqual([
      picture,
      notes,
    ]);
    const words = turn.prompt.find((block) => block.type === 'text');
    expect(words && words.type === 'text' && words.text).toContain(
      'ما رأيك؟\n(attached: shot.png, notes.txt)',
    );
  });

  it('files alone are a message; an unknown file is 404 and audio is refused', async () => {
    const { id } = await room('غرفة الملفات');
    const picture = await upload('only.png', PNG, 'image/png');
    const alone = await call('POST', `/rooms/${id}/messages`, {
      content: [{ type: 'image', attachment_id: picture }],
    });
    expect(alone.status, JSON.stringify(alone.body)).toBe(202);
    await conductorFor(hub.app).idle();
    expect(requests).toHaveLength(1);

    const unknown = await call('POST', `/rooms/${id}/messages`, {
      content: [{ type: 'file', attachment_id: '01J8QK3ZR2W7M5N4P6T8V9X0ZZ' }],
    });
    expect(unknown.status).toBe(404);
    const audio = await call('POST', `/rooms/${id}/messages`, {
      content: [{ type: 'audio', attachment_id: picture }],
    });
    expect(audio.status).toBe(400);
    expect(audio.body).toMatchObject({
      code: 'validation_failed',
      details: { reason: 'unsupported_block' },
    });
  });
});

describe('what a seat asks names its room (§99)', () => {
  it('in the pending list and on the room', async () => {
    const { id } = await room('غرفة الأسئلة');
    script = [
      { type: 'approval_requested', ref: 'q1', kind: 'question', title: 'أي لون؟' },
      { type: 'await_input' },
      { type: 'message_delta', text: 'حسنًا.' },
      { type: 'completed' },
    ];
    const posted = await call('POST', `/rooms/${id}/messages`, {
      content: [{ type: 'text', text: 'صمّم الشعار' }],
    });
    expect(posted.status).toBe(202);

    let waiting: Array<Json> = [];
    for (let i = 0; i < 100 && waiting.length === 0; i += 1) {
      waiting = (await call('GET', '/approvals')).body.items as Array<Json>;
      if (waiting.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ kind: 'question', room_id: id });

    const detail = (await call('GET', `/rooms/${id}`)).body as {
      pending_approvals: Array<Json>;
    };
    expect(detail.pending_approvals.map((a) => [a.id, a.room_id])).toEqual([[waiting[0]!.id, id]]);

    const answered = await call('POST', `/approvals/${String(waiting[0]!.id)}/respond`, {
      answer: 'أخضر',
    });
    expect(answered.status).toBe(200);
    await conductorFor(hub.app).idle();
    expect(
      ((await call('GET', `/rooms/${id}`)).body as { pending_approvals: unknown[] })
        .pending_approvals,
    ).toEqual([]);
  });

  it('a chat’s own approvals name no room', async () => {
    script = [
      { type: 'approval_requested', ref: 'q2', kind: 'question', title: 'متى؟' },
      { type: 'await_input' },
      { type: 'completed' },
    ];
    const session = await call('POST', '/sessions', { agent_id: AGENT, title: 'محادثة' });
    expect(session.status).toBe(201);
    const sessionId = String(session.body.id);
    await call('POST', `/sessions/${sessionId}/runs`, {
      content: [{ type: 'text', text: 'سؤال' }],
    });
    let mine: Json | undefined;
    for (let i = 0; i < 100 && !mine; i += 1) {
      const items = (await call('GET', `/approvals?session_id=${sessionId}`)).body.items as Json[];
      mine = items[0];
      if (!mine) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(mine).toMatchObject({ session_id: sessionId, room_id: null });
    await call('POST', `/approvals/${String(mine!.id)}/respond`, { answer: 'غدًا' });
  });
});
