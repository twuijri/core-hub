import { describe, expect, it } from 'vitest';
import { activeRun, hydrate, initialChat, isBusy, reduce, textOf } from '../src/chat/transcript.js';
import type { Envelope } from '../src/realtime/envelope.js';
import type { Approval, Message, Run, SessionDetail } from '../src/types.js';

const S = '01J8QK3ZR2W7M5N4P6T8V9X0YA';
const M = '01J8QK3ZR2W7M5N4P6T8V9X0MB';
const R = '01J8QK3ZR2W7M5N4P6T8V9X0RN';
let seq = 0;
const env = (event: string, payload: Record<string, unknown>): Envelope => ({
  event,
  namespace: '/rt/sessions',
  profile: 'default',
  ts: '2026-09-21T10:00:00Z',
  seq: ++seq,
  payload,
});
const message = (over: Partial<Message> = {}): Message => ({
  id: M,
  profile: 'default',
  owner_id: 'u',
  created_at: 't',
  updated_at: 't',
  session_id: S,
  room_id: null,
  seq: 2,
  role: 'assistant',
  author: { kind: 'agent', id: null, name: 'Hermes', avatar: null },
  content: [],
  reasoning: null,
  tool_calls: [],
  run_id: R,
  status: 'streaming',
  mentions: [],
  handoff: null,
  usage: null,
  reply_to_message_id: null,
  ...over,
});
const run = (status: Run['status']): Run => ({
  id: R,
  profile: 'default',
  owner_id: 'u',
  created_at: 't',
  updated_at: 't',
  session_id: S,
  room_id: null,
  seat_id: null,
  job_id: 'j',
  status,
  queue_position: null,
  trigger: { kind: 'user', id: 'u' },
  input_message_id: null,
  output_message_id: M,
  model: null,
  provider: null,
  reasoning_effort: null,
  interrupted: false,
  error: status === 'failed' ? { error: 'boom', code: 'agent_error' } : null,
  usage: null,
  started_at: null,
  finished_at: null,
});

describe('transcript reducer', () => {
  it('streams deltas into the assistant shell, folds tools and reasoning, ends with the final message', () => {
    let state = initialChat();
    state = reduce(state, env('message.created', { message: message() }), S);
    state = reduce(state, env('run.started', { run: run('running') }), S);
    expect(isBusy(state)).toBe(true);
    state = reduce(
      state,
      env('reasoning.delta', { session_id: S, message_id: M, run_id: R, delta: 'أفكر' }),
      S,
    );
    state = reduce(
      state,
      env('message.delta', { session_id: S, message_id: M, run_id: R, delta: 'مرحبا ' }),
      S,
    );
    state = reduce(
      state,
      env('message.delta', { session_id: S, message_id: M, run_id: R, delta: 'بك' }),
      S,
    );
    const call = {
      id: 'c1',
      name: 'shell',
      status: 'running',
      preview: 'ls',
      arguments: null,
      output: null,
      output_truncated: false,
      duration_ms: null,
      subagent_id: null,
      started_at: null,
      finished_at: null,
    } as const;
    state = reduce(
      state,
      env('tool.started', { session_id: S, message_id: M, run_id: R, tool_call: call }),
      S,
    );
    state = reduce(
      state,
      env('tool.completed', {
        session_id: S,
        message_id: M,
        run_id: R,
        tool_call: { ...call, status: 'succeeded', output: 'ok', duration_ms: 12 },
      }),
      S,
    );
    expect(textOf(state.messages[0]!)).toBe('مرحبا بك');
    expect(state.messages[0]!.reasoning?.text).toBe('أفكر');
    expect(state.messages[0]!.tool_calls).toHaveLength(1);
    expect(state.messages[0]!.tool_calls[0]!.status).toBe('succeeded');
    const final = message({ status: 'complete', content: [{ type: 'text', text: 'مرحبا بك' }] });
    state = reduce(state, env('run.completed', { run: run('succeeded'), message: final }), S);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.status).toBe('complete');
    expect(isBusy(state)).toBe(false);
    expect(state.lastSeq).toBe(seq);
  });

  it('ignores envelopes of other sessions but still advances the cursor', () => {
    const state = reduce(
      initialChat(),
      env('message.delta', { session_id: 'other', message_id: 'x', run_id: 'y', delta: 'no' }),
      S,
    );
    expect(state.messages).toEqual([]);
    expect(state.lastSeq).toBe(seq);
  });

  it('creates a shell for a delta whose message.created was missed', () => {
    const state = reduce(
      initialChat(),
      env('message.delta', { session_id: S, message_id: M, run_id: R, delta: 'late' }),
      S,
    );
    expect(textOf(state.messages[0]!)).toBe('late');
    expect(state.messages[0]!.status).toBe('streaming');
  });

  it('tracks pending approvals until resolved and marks failed/cancelled runs on the message', () => {
    const approval = {
      id: 'a1',
      status: 'pending',
      session_id: S,
      kind: 'tool_call',
      title: 'x',
      choices: [],
      allow_always: true,
      answer_mode: 'choice',
      agent: { id: 'ag', name: 'Hermes' },
    } as unknown as Approval;
    let state = reduce(initialChat(), env('message.created', { message: message() }), S);
    state = reduce(state, env('approval.requested', { approval }), S);
    expect(Object.keys(state.approvals)).toEqual(['a1']);
    state = reduce(
      state,
      env('approval.resolved', { approval: { ...approval, status: 'approved' } }),
      S,
    );
    expect(state.approvals).toEqual({});
    state = reduce(state, env('run.failed', { run: run('failed') }), S);
    expect(state.messages[0]!.status).toBe('failed');
    expect(activeRun(state)).toBeNull();
  });

  it('hydrates from the session document and messages, keeping the cursor', () => {
    const detail = {
      id: S,
      status: 'waiting',
      active_run_id: R,
      context: null,
      runs: [run('waiting')],
      pending_approvals: [],
    } as unknown as SessionDetail;
    const state = hydrate({ ...initialChat(), lastSeq: 40 }, detail, [
      message({ seq: 2 }),
      message({ id: 'first', seq: 1, role: 'user' }),
    ]);
    expect(state.lastSeq).toBe(40);
    expect(state.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(activeRun(state)?.status).toBe('waiting');
    expect(state.session?.id).toBe(S);
  });
});

describe('plainPreview', async () => {
  const { plainPreview } = await import('../src/sessions/SessionList.js');
  it('strips markdown syntax from the sidebar preview', () => {
    expect(plainPreview('# مرحبا\n\nهذا **رد** `x` [رابط](http://a)')).toBe('مرحبا هذا رد x رابط');
    expect(plainPreview(null)).toBe('');
  });
});
