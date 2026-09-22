/**
 * Sessions name themselves (contract decision §26).
 *
 * The pure parts are asserted directly; the rest goes through the real routes and the
 * real `/rt/sessions` socket, because the three things that can go wrong are all about
 * timing and ownership:
 *
 * - it happens **once**, after the first reply, and never again on its own;
 * - a title a person typed is never replaced, and the agent is not even asked;
 * - the new name reaches every client as `session.updated`.
 */
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { modules as defaultModules } from '../index.js';
import { testHub, type TestHub } from '../../../tests/unit/helpers.js';
import { createSessionsModule } from './index.js';
import { FakeAgentDirectory, FakeAgentRunner, fakeHermes } from './testing/fake-runner.js';
import { cleanTitle, fallbackTitle, titlePrompt, trimToWords } from './titles.js';

const AGENT_ID = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
const PROFILE = 'default';
const SOCKET_PATH = '/rt';

describe('a title out of whatever the agent said (pure)', () => {
  it('keeps the words and drops the manners', () => {
    // Everything a model wraps a title in, one case each.
    expect(cleanTitle('"Launch plan"')).toBe('Launch plan');
    expect(cleanTitle('«خطة الإطلاق».')).toBe('خطة الإطلاق');
    expect(cleanTitle('## Launch plan')).toBe('Launch plan');
    expect(cleanTitle('- خطة الإطلاق،')).toBe('خطة الإطلاق');
    expect(cleanTitle('`streaming, explained`')).toBe('streaming, explained');
    // A model that explains itself: the title is the first line, the rest is manners.
    expect(cleanTitle('Launch plan\n\nLet me know if you want another.')).toBe('Launch plan');
    // Nothing usable is `null`, not an empty title.
    expect(cleanTitle('   ')).toBeNull();
    expect(cleanTitle('"..."')).toBeNull();
    expect(cleanTitle(null)).toBeNull();
  });

  it('caps the length on a word boundary', () => {
    const long = 'a plan for the launch of the product in three separate and careful stages';
    const title = cleanTitle(long);
    expect(title!.length).toBeLessThanOrEqual(60);
    // Cut between words, never inside one.
    expect(long.startsWith(`${title!} `)).toBe(true);
    // A single word longer than the cap is truncated rather than reduced to nothing.
    expect(trimToWords('x'.repeat(80), 10)).toBe('x'.repeat(10));
  });

  it('falls back to the person’s own first words, without the markup', () => {
    expect(fallbackTitle('اشرح لي كيف يعمل البث اللحظي')).toBe('اشرح لي كيف يعمل البث اللحظي');
    expect(fallbackTitle('fix this:\n```ts\nconst a = 1;\n```')).toBe('fix this:');
    expect(fallbackTitle('   ')).toBeNull();
    expect(fallbackTitle(undefined)).toBeNull();
  });

  it('asks for the title in the conversation’s own language and nothing else', () => {
    const prompt = titlePrompt({ user: 'مرحبا', assistant: 'أهلًا' });
    expect(prompt).toContain('مرحبا');
    expect(prompt).toContain('أهلًا');
    expect(prompt).toContain('same language');
  });
});

// ------------------------------------------------------------------ the hub

interface Named {
  hub: TestHub;
  socket: Socket;
  updates: Array<Record<string, unknown>>;
  runner: FakeAgentRunner;
  close(): Promise<void>;
}

let live: Named | undefined;
afterEach(async () => {
  await live?.close();
  live = undefined;
});

async function hubThatNames(options: { answer?: string | null } = {}): Promise<Named> {
  const runner = new FakeAgentRunner({
    script: [{ type: 'message_delta', text: 'البث اللحظي يعمل هكذا…' }, { type: 'completed' }],
    // `undefined` leaves the runner without an `ask` at all — an adapter with no
    // one-shot surface, which is what proves the fallback.
    ...(options.answer === undefined ? {} : { answer: options.answer }),
  });
  const sessions = createSessionsModule({
    agents: new FakeAgentDirectory([fakeHermes(AGENT_ID)]),
    runner,
  });
  const hub = await testHub(
    {},
    { modules: defaultModules.map((m) => (m.name === 'sessions' ? sessions : m)) },
  );
  await hub.app.listen({ port: 0, host: '127.0.0.1' });
  const address = hub.app.server.address();
  const baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  const socket = connect(`${baseUrl}/rt/sessions`, {
    path: SOCKET_PATH,
    transports: ['websocket'],
    auth: { profile: PROFILE },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  const updates: Array<Record<string, unknown>> = [];
  socket.on('session.updated', (envelope: { payload: { session: Record<string, unknown> } }) =>
    updates.push(envelope.payload.session),
  );
  return {
    hub,
    socket,
    updates,
    runner,
    async close() {
      socket.close();
      await hub.close();
    },
  };
}

async function api(
  hub: TestHub,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const res = await hub.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { 'x-hub-profile': PROFILE },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return res.body ? (res.json() as Record<string, unknown>) : {};
}

const titleOf = (hub: TestHub, id: string) => async () =>
  (await api(hub, 'GET', `/sessions/${id}`)).title;

async function say(hub: TestHub, id: string, text: string): Promise<void> {
  await api(hub, 'POST', `/sessions/${id}/runs`, { content: [{ type: 'text', text }] });
}

describe('a session names itself after its first reply', () => {
  it('asks its own agent once, applies the answer, and announces it on /rt/sessions', async () => {
    live = await hubThatNames({ answer: '«كيف يعمل البث اللحظي».' });
    const id = (await api(live.hub, 'POST', '/sessions', { agent_id: AGENT_ID })).id as string;
    // Every session starts nameless; "New chat" is the client's word for `null`.
    expect(await titleOf(live.hub, id)()).toBeNull();

    await say(live.hub, id, 'اشرح لي كيف يعمل البث اللحظي');
    await expect.poll(titleOf(live.hub, id)).toBe('كيف يعمل البث اللحظي');

    // It was one question, to this session's own agent, carrying both sides of the turn.
    expect(live.runner.asked).toHaveLength(1);
    expect(live.runner.asked[0]).toMatchObject({ agentId: AGENT_ID, sessionId: id });
    expect(live.runner.asked[0]!.prompt).toContain('اشرح لي كيف يعمل البث اللحظي');

    // The clients hear about it: the last `session.updated` carries the new name.
    await expect.poll(() => live!.updates.at(-1)?.title).toBe('كيف يعمل البث اللحظي');

    // A second turn does not ask again: the session already has a name.
    await say(live.hub, id, 'وأضف مثالًا');
    await expect
      .poll(async () => (await api(live!.hub, 'GET', `/sessions/${id}`)).message_count)
      .toBe(4);
    expect(live.runner.asked).toHaveLength(1);
    expect(await titleOf(live.hub, id)()).toBe('كيف يعمل البث اللحظي');
  });

  it('falls back to the first message when the adapter cannot be asked', async () => {
    // No `answer`: this runner declares no `ask`, like an adapter with no one-shot surface.
    live = await hubThatNames();
    const id = (await api(live.hub, 'POST', '/sessions', { agent_id: AGENT_ID })).id as string;
    await say(live.hub, id, 'اشرح لي كيف يعمل البث اللحظي');
    await expect.poll(titleOf(live.hub, id)).toBe('اشرح لي كيف يعمل البث اللحظي');
  });

  it('falls back when the agent answers with nothing usable', async () => {
    live = await hubThatNames({ answer: '   ' });
    const id = (await api(live.hub, 'POST', '/sessions', { agent_id: AGENT_ID })).id as string;
    await say(live.hub, id, 'أصلح هذا الخطأ من فضلك');
    await expect.poll(titleOf(live.hub, id)).toBe('أصلح هذا الخطأ من فضلك');
  });

  it('never overwrites a title the person typed, and does not even ask', async () => {
    live = await hubThatNames({ answer: 'عنوان من الوكيل' });
    const id = (await api(live.hub, 'POST', '/sessions', { agent_id: AGENT_ID })).id as string;
    await api(live.hub, 'PATCH', `/sessions/${id}`, { title: 'خطة الإطلاق' });

    await say(live.hub, id, 'اشرح لي كيف يعمل البث اللحظي');
    await expect
      .poll(async () => (await api(live!.hub, 'GET', `/sessions/${id}`)).message_count)
      .toBe(2);
    expect(await titleOf(live.hub, id)()).toBe('خطة الإطلاق');
    expect(live.runner.asked).toHaveLength(0);
  });

  it('retitles on request: clearing the title hands the naming back to the hub', async () => {
    live = await hubThatNames({ answer: 'عنوان من الوكيل' });
    const id = (await api(live.hub, 'POST', '/sessions', { agent_id: AGENT_ID })).id as string;
    await api(live.hub, 'PATCH', `/sessions/${id}`, { title: 'اسم كتبته بنفسي' });
    await say(live.hub, id, 'اشرح لي كيف يعمل البث اللحظي');
    await expect
      .poll(async () => (await api(live!.hub, 'GET', `/sessions/${id}`)).message_count)
      .toBe(2);
    expect(await titleOf(live.hub, id)()).toBe('اسم كتبته بنفسي');

    // "Retitle": `title: null` is the whole of the gesture, and the hub names it again.
    const cleared = await api(live.hub, 'PATCH', `/sessions/${id}`, { title: null });
    expect(cleared.title).toBeNull();
    await expect.poll(titleOf(live.hub, id)).toBe('عنوان من الوكيل');
    expect(live.runner.asked).toHaveLength(1);
  });
});
