/**
 * Rooms, part 2 (DECISIONS §57): agents answering in the room — who a message wakes, what a
 * seat is told, the reply streaming into the room, handoffs with their loop guard and depth
 * cap, continuing a stopped chain, stopping a seat and clearing the context. `sessions` runs
 * the turns on a scripted runner whose script is chosen by the seat the prompt addresses.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { modules as defaultModules } from '../../src/modules/index.js';
import { principalScopeResolver } from '../../src/modules/auth/index.js';
import { conductorFor } from '../../src/modules/rooms/index.js';
import { createSessionsModule } from '../../src/modules/sessions/index.js';
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
let runner: FakeAgentRunner;
/** What each seat says, by name; a function sees the prompt it was given. */
let replies: Record<string, ScriptStep[] | ((prompt: string) => ScriptStep[])> = {};
const prompts: Array<{ seat: string; prompt: string }> = [];

const say = (text: string): ScriptStep[] => [
  { type: 'reasoning_delta', text: 'أفكّر' },
  { type: 'message_delta', text },
  { type: 'usage', inputTokens: 10, outputTokens: 5 },
  { type: 'completed' },
];

function seatOf(prompt: string): string {
  return /^You are @(.+?), one of the agents/.exec(prompt)?.[1] ?? '';
}

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const res = await authed(hub, hub.token, {
    method,
    url: `/api/v1${url}`,
    ...(payload === undefined ? {} : { payload }),
  });
  return { status: res.statusCode, body: (res.body ? res.json() : {}) as Json };
}

async function room(names: string[], extra: Json = {}) {
  const res = await call('POST', '/rooms', {
    name: `غرفة ${names.join('-')}`,
    seats: names.map((name) => ({ agent_id: AGENT, name })),
    ...extra,
  });
  expect(res.status).toBe(201);
  const made = res.body.room as Json & {
    id: string;
    seats: Array<Json & { id: string; name: string }>;
  };
  const seat = (name: string) => made.seats.find((s) => s.name === name)!;
  return { id: made.id, seat };
}

async function post(roomId: string, text: string, mentions: Json[] = []) {
  const res = await call('POST', `/rooms/${roomId}/messages`, {
    content: [{ type: 'text', text }],
    mentions,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return res.body as { message_id: string; runs: Array<{ seat_id: string; run_id: string }> };
}

async function settled() {
  await conductorFor(hub.app).idle();
}

async function messages(roomId: string) {
  return (await call('GET', `/rooms/${roomId}/messages?limit=100`)).body.items as Array<
    Json & { content: Array<{ text: string }> }
  >;
}

const textOf = (m: { content: Array<{ text: string }> }) => m.content.map((b) => b.text).join('');

beforeAll(async () => {
  runner = new FakeAgentRunner({
    scriptFor(_request, prompt) {
      const seat = seatOf(prompt);
      prompts.push({ seat, prompt });
      const reply = replies[seat];
      if (!reply) return say(`${seat}: تم.`);
      return typeof reply === 'function' ? reply(prompt) : reply;
    },
  });
  const sessions = createSessionsModule({
    agents: new FakeAgentDirectory([fakeHermes(AGENT)]),
    runner,
    agentTimeoutMs: 5_000,
    scopes: principalScopeResolver,
  });
  hub = await signedInHub(
    {},
    { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
  );
});

afterAll(async () => {
  await hub?.close();
});

beforeEach(() => {
  replies = {};
  prompts.length = 0;
});

describe('who answers', () => {
  it('a mentioned seat answers; its reply streams into the room and ends complete', async () => {
    const { id, seat } = await room(['المخطِّط', 'المبرمج']);
    replies['المخطِّط'] = say('نبدأ بالواجهة.');
    const accepted = await post(id, '@المخطِّط ما الخطوة التالية؟', [
      { kind: 'seat', seat_id: seat('المخطِّط').id },
    ]);
    expect(accepted.runs.map((r) => r.seat_id)).toEqual([seat('المخطِّط').id]);
    await settled();
    const all = await messages(id);
    expect(all.map((m) => [m.role, m.status, textOf(m)])).toEqual([
      ['user', 'complete', '@المخطِّط ما الخطوة التالية؟'],
      ['assistant', 'complete', 'نبدأ بالواجهة.'],
    ]);
    expect(all[1]).toMatchObject({
      seat_id: seat('المخطِّط').id,
      run_id: accepted.runs[0]!.run_id,
      author: { kind: 'agent', name: 'المخطِّط' },
      reply_to_message_id: accepted.message_id,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    // The seat was told where it is, who else is there, how to pass the turn, and the message.
    const told = prompts.find((p) => p.seat === 'المخطِّط')!.prompt;
    expect(told).toContain('in the room "غرفة المخطِّط-المبرمج"');
    expect(told).toContain('Other agents here: @المبرمج.');
    expect(told).toContain('[Admin] @المخطِّط ما الخطوة التالية؟');
    const detail = await call('GET', `/rooms/${id}`);
    expect(detail.body).toMatchObject({ total_tokens: 15, runs: [] });
    expect((detail.body.seats as Json[]).map((s) => s.status)).toEqual(['idle', 'idle']);
  });

  it('a message that mentions nobody goes to the lead seat, and to nobody without one', async () => {
    const { id, seat } = await room(['القائد', 'الآخر']);
    const first = await post(id, 'صباح الخير');
    expect(first.runs.map((r) => r.seat_id)).toEqual([seat('القائد').id]);
    await settled();
    await call('PATCH', `/rooms/${id}`, { lead_seat_id: null });
    const second = await post(id, 'هل من أحد؟');
    expect(second.runs).toEqual([]);
  });

  it('@all wakes every seat', async () => {
    const { id } = await room(['أ', 'ب', 'ج']);
    const accepted = await post(id, '@all قدّموا أنفسكم', [{ kind: 'all', seat_id: null }]);
    expect(accepted.runs).toHaveLength(3);
    await settled();
    expect((await messages(id)).filter((m) => m.role === 'assistant')).toHaveLength(3);
  });

  it('each turn shows the seat only what it has not seen, never its own words', async () => {
    const { id, seat } = await room(['الوحيد']);
    replies['الوحيد'] = (prompt) => say(prompt.includes('الثانية') ? 'ثانيًا.' : 'أولًا.');
    await post(id, 'الرسالة الأولى');
    await settled();
    await post(id, 'الرسالة الثانية', [{ kind: 'seat', seat_id: seat('الوحيد').id }]);
    await settled();
    const second = prompts.filter((p) => p.seat === 'الوحيد')[1]!.prompt;
    expect(second).toContain('[Admin] الرسالة الثانية');
    expect(second).not.toContain('الرسالة الأولى');
    expect(second).not.toContain('أولًا.');
  });
});

describe('handoffs', () => {
  it('a reply that mentions another seat passes the turn to it, and the chain completes', async () => {
    const { id, seat } = await room(['المخطِّط', 'المبرمج']);
    replies['المخطِّط'] = say('الخطة جاهزة. @المبرمج نفّذ الخطوة الأولى.');
    replies['المبرمج'] = say('نفّذت الخطوة الأولى.');
    await post(id, '@المخطِّط ضع خطة', [{ kind: 'seat', seat_id: seat('المخطِّط').id }]);
    await settled();
    const all = await messages(id);
    expect(all.map(textOf)).toEqual([
      '@المخطِّط ضع خطة',
      'الخطة جاهزة. @المبرمج نفّذ الخطوة الأولى.',
      'نفّذت الخطوة الأولى.',
    ]);
    const chains = (await call('GET', `/rooms/${id}/handoffs`)).body.items as Json[];
    expect(chains).toHaveLength(1);
    expect(chains[0]).toMatchObject({
      from_seat_id: seat('المخطِّط').id,
      to_seat_id: seat('المبرمج').id,
      status: 'completed',
      depth: 1,
    });
    expect(all[1]).toMatchObject({
      handoff: { to_seat_id: seat('المبرمج').id, chain_id: chains[0]!.id, depth: 1 },
      mentions: [{ kind: 'seat', seat_id: seat('المبرمج').id }],
    });
    // The receiving seat was shown the reply that passed the turn.
    expect(prompts.find((p) => p.seat === 'المبرمج')!.prompt).toContain(
      '[@المخطِّط] الخطة جاهزة. @المبرمج نفّذ الخطوة الأولى.',
    );
  });

  it('the loop guard stops the same pass made twice in one chain', async () => {
    const { id, seat } = await room(['أحمد', 'بدر'], {
      handoff: { enabled: true, max_depth: null },
    });
    replies['أحمد'] = say('دورك يا @بدر');
    replies['بدر'] = say('بل دورك يا @أحمد');
    await post(id, '@أحمد ابدأ', [{ kind: 'seat', seat_id: seat('أحمد').id }]);
    await settled();
    const chain = ((await call('GET', `/rooms/${id}/handoffs`)).body.items as Json[])[0]!;
    // أحمد→بدر, بدر→أحمد, then أحمد→بدر again is the loop: two passes were made.
    expect(chain).toMatchObject({ status: 'stopped', stop_reason: 'loop_detected', depth: 2 });
    expect((await messages(id)).filter((m) => m.role === 'assistant')).toHaveLength(3);
  });

  it('the depth cap stops a chain, which may go one more round once', async () => {
    const { id, seat } = await room(['أول', 'ثان'], { handoff: { enabled: true, max_depth: 1 } });
    replies['أول'] = say('إليك يا @ثان');
    replies['ثان'] = say('وإليك يا @أول');
    await post(id, '@أول ابدأ', [{ kind: 'seat', seat_id: seat('أول').id }]);
    await settled();
    let chain = ((await call('GET', `/rooms/${id}/handoffs`)).body.items as Json[])[0]!;
    // One pass is the cap: the second is refused, and the chain says how far it went.
    expect(chain).toMatchObject({ status: 'stopped', stop_reason: 'max_depth', depth: 1 });
    expect((await messages(id)).filter((m) => m.role === 'assistant')).toHaveLength(2);

    replies['أول'] = say('انتهيت.');
    const more = await call('POST', `/rooms/${id}/handoffs/${String(chain.id)}/continue`);
    expect(more.status).toBe(202);
    expect(more.body.job_id).toEqual(expect.any(String));
    await settled();
    chain = ((await call('GET', `/rooms/${id}/handoffs`)).body.items as Json[])[0]!;
    expect(chain).toMatchObject({ status: 'completed', continue_used: true, depth: 2 });
    expect((await messages(id)).at(-1)).toMatchObject({ seat_id: seat('أول').id });
    const again = await call('POST', `/rooms/${id}/handoffs/${String(chain.id)}/continue`);
    expect(again.status).toBe(409);
  });

  it('with handoffs off a mention in a reply passes nothing', async () => {
    const { id, seat } = await room(['س', 'ص'], { handoff: { enabled: false, max_depth: 3 } });
    replies['س'] = say('اسأل @ص');
    await post(id, '@س', [{ kind: 'seat', seat_id: seat('س').id }]);
    await settled();
    expect((await call('GET', `/rooms/${id}/handoffs`)).body.items).toEqual([]);
    expect((await messages(id)).filter((m) => m.role === 'assistant')).toHaveLength(1);
  });
});

describe('stopping and forgetting', () => {
  it('stop cancels the seat’s turn; the reply says it was stopped and the seat is idle', async () => {
    const { id, seat } = await room(['البطيء']);
    replies['البطيء'] = [{ type: 'message_delta', text: 'أعمل…' }, { type: 'await_input' }];
    const accepted = await post(id, 'ابدأ');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const live = await call('GET', `/rooms/${id}`);
    expect((live.body.runs as Json[]).map((r) => [r.id, r.room_id])).toEqual([
      [accepted.runs[0]!.run_id, id],
    ]);
    const stopped = await call('POST', `/rooms/${id}/seats/${seat('البطيء').id}/stop`);
    expect(stopped.status).toBe(200);
    await settled();
    const reply = (await messages(id)).at(-1)!;
    expect(reply).toMatchObject({ status: 'interrupted', seat_id: seat('البطيء').id });
    const runs = await call('GET', `/rooms/${id}/runs`);
    expect((runs.body.items as Json[]).map((r) => [r.status, r.room_id, r.seat_id])).toEqual([
      ['cancelled', id, seat('البطيء').id],
    ]);
    expect(((await call('GET', `/rooms/${id}`)).body.seats as Json[])[0]!.status).toBe('idle');
  });

  it('clearing the context keeps the messages, gives each seat a fresh conversation, and resets tokens', async () => {
    const { id, seat } = await room(['الناسي']);
    await post(id, 'تذكّر أن اللون أزرق');
    await settled();
    expect((await call('GET', `/rooms/${id}`)).body.total_tokens).toBe(15);
    const before = (await call('GET', `/rooms/${id}/runs`)).body.items as Json[];
    expect((await call('DELETE', `/rooms/${id}/context`)).status).toBe(204);
    expect((await call('GET', `/rooms/${id}`)).body.total_tokens).toBe(0);
    await post(id, 'ما اللون؟', [{ kind: 'seat', seat_id: seat('الناسي').id }]);
    await settled();
    const told = prompts.filter((p) => p.seat === 'الناسي').at(-1)!.prompt;
    expect(told).not.toContain('أزرق');
    const after = (await call('GET', `/rooms/${id}/runs`)).body.items as Json[];
    expect(after[0]!.session_id).not.toBe(before[0]!.session_id);
    expect((await messages(id)).length).toBe(4);
  });
});
