import { describe, expect, it } from 'vitest';
import {
  belongsToSession,
  initialState,
  reduce,
  textOf,
  type TranscriptOptions,
} from '../src/chat/transcript.js';
import { createTranslator } from '../src/i18n/index.js';
import { PLAIN } from '../src/output.js';
import type { Envelope } from '../src/realtime.js';
import type { Approval, Message, Run, ToolCall } from '../src/types.js';

const SESSION = '01J8QK3ZR2W7M5N4P6T8V9X0YA';
const OTHER = '01J8QK3ZR2W7M5N4P6T8V9X0YB';
const MESSAGE = '01J8QK3ZR2W7M5N4P6T8V9X0MB';
const RUN = '01J8QK3ZR2W7M5N4P6T8V9X0RN';
const scoped = {
  profile: 'default',
  owner_id: '01J8QK3ZR2W7M5N4P6T8V9X0HM',
  created_at: '2026-09-21T10:15:00Z',
  updated_at: '2026-09-21T10:15:00Z',
};

let seq = 0;
const env = (event: string, payload: Record<string, unknown>): Envelope => ({
  event,
  namespace: '/rt/sessions',
  profile: 'default',
  ts: '2026-09-21T10:15:04Z',
  seq: (seq += 1),
  payload,
});

const run = (status: Run['status'], extra: Partial<Run> = {}): Run => ({
  ...scoped,
  id: RUN,
  session_id: SESSION,
  room_id: null,
  seat_id: null,
  job_id: '01J8QK3ZR2W7M5N4P6T8V9X0JB',
  status,
  queue_position: null,
  trigger: { kind: 'user', id: scoped.owner_id },
  input_message_id: null,
  output_message_id: MESSAGE,
  model: null,
  provider: null,
  reasoning_effort: null,
  interrupted: false,
  error: null,
  usage: null,
  started_at: null,
  finished_at: null,
  ...extra,
});

const message = (
  role: Message['role'],
  status: Message['status'],
  text: string,
  id = MESSAGE,
): Message => ({
  ...scoped,
  id,
  session_id: SESSION,
  room_id: null,
  seq: 1,
  role,
  author: {
    kind: role === 'assistant' ? 'agent' : 'user',
    id: null,
    name: role === 'assistant' ? 'Hermes' : 'Tariq',
    avatar: null,
  },
  content: text ? [{ type: 'text', text }] : [],
  reasoning: null,
  tool_calls: [],
  run_id: RUN,
  status,
  mentions: [],
  handoff: null,
  usage: null,
  reply_to_message_id: null,
});

const tool = (status: ToolCall['status'], output: string | null = null): ToolCall => ({
  id: '01J8QK3ZR2W7M5N4P6T8V9X0TC',
  name: 'shell',
  status,
  preview: 'pnpm test',
  arguments: { command: 'pnpm test' },
  output,
  output_truncated: false,
  duration_ms: status === 'running' ? null : 1200,
  subagent_id: null,
  started_at: null,
  finished_at: null,
});

const approval: Approval = {
  ...scoped,
  id: '01J8QK3ZR2W7M5N4P6T8V9X0AP',
  kind: 'tool_call',
  status: 'pending',
  session_id: SESSION,
  run_id: RUN,
  message_id: MESSAGE,
  room_id: null,
  workflow_run_id: null,
  node_id: null,
  agent: { id: '01J8QK3ZR2W7M5N4P6T8V9X0AG', name: 'Hermes' },
  title: 'تنفيذ أمر',
  description: null,
  command: 'rm -rf build',
  choices: [],
  allow_always: true,
  answer_mode: 'choice',
  response: null,
  expires_at: null,
};

const options: TranscriptOptions = {
  sessionId: SESSION,
  t: createTranslator('en'),
  style: PLAIN,
  showReasoning: false,
  ownMessageIds: new Set(['01J8QK3ZR2W7M5N4P6T8V9X0MA']),
  ownTexts: new Set(['typed here']),
};

function play(envelopes: Envelope[], opts: TranscriptOptions = options) {
  let state = initialState();
  const out: string[] = [];
  const special: string[] = [];
  for (const e of envelopes) {
    const step = reduce(state, e, opts);
    state = step.state;
    for (const chunk of step.chunks) {
      if (chunk.kind === 'text') out.push(chunk.text);
      else if (chunk.kind === 'line') out.push(`${chunk.text}\n`);
      else special.push(chunk.kind === 'run' ? `run:${chunk.status}` : chunk.kind);
    }
  }
  return { text: out.join(''), special, state };
}

describe('belongsToSession', () => {
  it('reads the session id from flat payloads and from nested entities', () => {
    expect(belongsToSession(env('message.delta', { session_id: SESSION }), SESSION)).toBe(true);
    expect(belongsToSession(env('run.started', { run: run('running') }), OTHER)).toBe(false);
    expect(belongsToSession(env('session.updated', { session: { id: SESSION } }), SESSION)).toBe(
      true,
    );
    expect(belongsToSession(env('approval.requested', { approval }), SESSION)).toBe(true);
  });
});

describe('reduce', () => {
  it('renders a whole run: prefix, streamed text, tool lines, usage, terminal chunk', () => {
    const { text, special, state } = play([
      env('message.created', {
        message: message('user', 'complete', 'hi', '01J8QK3ZR2W7M5N4P6T8V9X0MA'),
      }),
      env('run.queued', { run: run('queued') }),
      env('message.created', { message: message('assistant', 'streaming', '') }),
      env('run.started', { run: run('running') }),
      env('reasoning.delta', {
        session_id: SESSION,
        message_id: MESSAGE,
        run_id: RUN,
        delta: 'thinking',
      }),
      env('message.delta', {
        session_id: SESSION,
        message_id: MESSAGE,
        run_id: RUN,
        delta: 'سأشغّل ',
      }),
      env('message.delta', {
        session_id: SESSION,
        message_id: MESSAGE,
        run_id: RUN,
        delta: 'الاختبارات.',
      }),
      env('tool.started', {
        session_id: SESSION,
        message_id: MESSAGE,
        run_id: RUN,
        tool_call: tool('running'),
      }),
      env('tool.completed', {
        session_id: SESSION,
        message_id: MESSAGE,
        run_id: RUN,
        tool_call: tool('succeeded', '30 passed\nmore'),
      }),
      env('message.delta', { session_id: SESSION, message_id: MESSAGE, run_id: RUN, delta: 'تم.' }),
      env('run.completed', {
        run: run('succeeded', {
          usage: {
            input_tokens: 2300,
            output_tokens: 410,
            cost: { amount: '0.0131', currency: 'USD' },
          },
        }),
        message: message('assistant', 'complete', 'سأشغّل الاختبارات. تم.'),
      }),
    ]);
    expect(text).toBe(
      'Hermes: سأشغّل الاختبارات.\n' +
        '  * tool shell pnpm test\n' +
        '  = tool shell finished (1.2 s)\n' +
        '    30 passed\n' +
        'تم.\n' +
        '2300 in · 410 out · 0.0131 USD\n',
    );
    expect(special).toEqual(['run:succeeded']);
    expect(state.lastSeq).toBe(seq);
    expect(state.textOpen).toBe(false);
  });

  it('shows reasoning only when asked, dimmed and on its own line', () => {
    const envelopes = [
      env('message.created', { message: message('assistant', 'streaming', '') }),
      env('reasoning.delta', {
        session_id: SESSION,
        message_id: MESSAGE,
        run_id: RUN,
        delta: 'plan',
      }),
      env('message.delta', { session_id: SESSION, message_id: MESSAGE, run_id: RUN, delta: 'ok' }),
    ];
    expect(play(envelopes).text).toBe('Hermes: ok');
    expect(play(envelopes, { ...options, showReasoning: true }).text).toBe('Hermes: \n~ plan\nok');
  });

  it('ignores other sessions but still advances lastSeq', () => {
    const { text, state } = play([
      env('message.delta', { session_id: OTHER, message_id: MESSAGE, run_id: RUN, delta: 'no' }),
    ]);
    expect(text).toBe('');
    expect(state.lastSeq).toBe(seq);
  });

  it('does not echo the messages this client sent, but shows peers and the system', () => {
    const { text } = play([
      env('message.created', {
        message: message('user', 'complete', 'mine', '01J8QK3ZR2W7M5N4P6T8V9X0MA'),
      }),
      env('message.created', {
        message: message('user', 'complete', 'from the phone', '01J8QK3ZR2W7M5N4P6T8V9X0MC'),
      }),
    ]);
    expect(text).toBe('you: from the phone\n');
  });

  it('hands approvals, failures, cancellations and deletion to the caller', () => {
    const failed = play([
      env('message.delta', {
        session_id: SESSION,
        message_id: MESSAGE,
        run_id: RUN,
        delta: 'half',
      }),
      env('approval.requested', { approval }),
      env('run.failed', { run: run('failed', { error: { error: 'boom', code: 'agent_error' } }) }),
    ]);
    expect(failed.text).toBe('half\nrun failed: boom [agent_error]\n');
    expect(failed.special).toEqual(['approval', 'run:failed']);
    const cancelled = play([
      env('run.cancelled', { run: run('cancelled', { interrupted: true }) }),
    ]);
    expect(cancelled.text).toBe('run cancelled\n');
    expect(cancelled.special).toEqual(['run:cancelled']);
    expect(play([env('session.deleted', { session_id: SESSION })]).special).toEqual(['deleted']);
  });
});

describe('textOf', () => {
  it('joins text blocks and names attachments', () => {
    expect(
      textOf({
        content: [
          { type: 'text', text: 'a' },
          {
            type: 'image',
            attachment_id: '01J8QK3ZR2W7M5N4P6T8V9X0AT',
            name: 'x.png',
            mime: 'image/png',
            size_bytes: 1,
            url: '',
          },
        ],
      } as Pick<Message, 'content'>),
    ).toBe('a\n[image x.png]');
  });
});
