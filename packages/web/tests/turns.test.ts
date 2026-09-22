/**
 * Who is speaking, where a turn begins, and what the status line should say.
 *
 * The layout rule the owner cares most about — the person on the right, the agent on the
 * left, grouped while the speaker does not change — is decided by these pure functions, so
 * it is tested here without a DOM. `tests/message-layout.test.tsx` then checks that the
 * rendering honours them in both locales.
 */
import { describe, expect, it } from 'vitest';
import { initialChat, type ChatState } from '../src/chat/transcript.js';
import {
  currentTool,
  isSilentShell,
  runProgress,
  sideOf,
  speakerOf,
  thoughtSeconds,
  turnsOf,
} from '../src/chat/turns.js';
import type { Message, Run, ToolCall } from '../src/types.js';

function message(partial: Partial<Message> & Pick<Message, 'id' | 'role'>): Message {
  return {
    profile: 'default',
    owner_id: 'u1',
    created_at: '2026-09-22T10:00:00Z',
    updated_at: '2026-09-22T10:00:00Z',
    session_id: 's1',
    room_id: null,
    seq: 1,
    author: { kind: 'user', id: null, name: '', avatar: null },
    content: [],
    reasoning: null,
    tool_calls: [],
    run_id: null,
    status: 'complete',
    mentions: [],
    handoff: null,
    usage: null,
    reply_to_message_id: null,
    ...partial,
  } as Message;
}

const agent = (id: string, name: string, extra: Partial<Message> = {}) =>
  message({
    id,
    role: 'assistant',
    author: { kind: 'agent', id: null, name, avatar: null },
    ...extra,
  });

function run(partial: Partial<Run> & Pick<Run, 'id' | 'status'>): Run {
  return {
    profile: 'default',
    owner_id: 'u1',
    created_at: '2026-09-22T10:00:00Z',
    updated_at: '2026-09-22T10:00:00Z',
    session_id: 's1',
    room_id: null,
    seat_id: null,
    job_id: 'j1',
    queue_position: null,
    trigger: { kind: 'user', id: null },
    input_message_id: null,
    output_message_id: null,
    model: null,
    provider: null,
    reasoning_effort: null,
    interrupted: false,
    error: null,
    usage: null,
    started_at: null,
    finished_at: null,
    ...partial,
  } as Run;
}

const tool = (partial: Partial<ToolCall> & Pick<ToolCall, 'id' | 'name' | 'status'>): ToolCall =>
  ({
    preview: null,
    arguments: null,
    output: null,
    output_truncated: false,
    duration_ms: null,
    subagent_id: null,
    started_at: null,
    finished_at: null,
    ...partial,
  }) as ToolCall;

describe('which side a message is on', () => {
  it('puts the person and their slash commands together, and the agent apart', () => {
    expect(sideOf({ role: 'user' })).toBe('user');
    expect(sideOf({ role: 'command' })).toBe('user');
    expect(sideOf({ role: 'assistant' })).toBe('agent');
    expect(sideOf({ role: 'system' })).toBe('system');
  });

  it('never looks at the content to decide: the side is the role, not the language', () => {
    // Two messages, one Arabic and one English, from the same role: the same side.
    const arabic = message({ id: 'a', role: 'user', content: [{ type: 'text', text: 'مرحبا' }] });
    const english = message({ id: 'b', role: 'user', content: [{ type: 'text', text: 'hello' }] });
    expect(sideOf(arabic)).toBe(sideOf(english));
  });
});

describe('grouping consecutive messages', () => {
  it('opens a turn on the first message and groups what follows from the same speaker', () => {
    const turns = turnsOf([
      message({ id: 'u1', role: 'user' }),
      message({ id: 'u2', role: 'user' }),
      agent('a1', 'Hermes'),
      agent('a2', 'Hermes'),
      message({ id: 'u3', role: 'user' }),
    ]);
    expect(turns.map((turn) => turn.grouped)).toEqual([false, true, false, true, false]);
    expect(turns.map((turn) => turn.side)).toEqual(['user', 'user', 'agent', 'agent', 'user']);
  });

  it('opens a new turn when the agent changes, even on the same side', () => {
    const turns = turnsOf([agent('a1', 'Hermes'), agent('a2', 'Claude Code')]);
    expect(turns.map((turn) => turn.grouped)).toEqual([false, false]);
  });

  it('drops the empty shell the hub opens a run with, so the turns still group', () => {
    // `engine.ts` creates the assistant message at run start; until something lands in it
    // there is nothing to draw, and it would otherwise sit between two queued messages
    // from the same person and break their grouping.
    const shell = agent('a0', '', { status: 'streaming' });
    expect(isSilentShell(shell)).toBe(true);
    const turns = turnsOf([
      message({ id: 'u1', role: 'user' }),
      shell,
      message({ id: 'u2', role: 'user' }),
    ]);
    expect(turns.map((turn) => turn.message.id)).toEqual(['u1', 'u2']);
    expect(turns[1]?.grouped).toBe(true);
  });

  it('keeps a shell the moment it has anything to say', () => {
    expect(
      isSilentShell(
        agent('a1', '', {
          status: 'streaming',
          content: [{ type: 'text', text: 'hi' }],
        }),
      ),
    ).toBe(false);
    expect(
      isSilentShell(
        agent('a2', '', {
          status: 'streaming',
          tool_calls: [tool({ id: 't1', name: 'shell', status: 'running' })],
        }),
      ),
    ).toBe(false);
    // A finished message with no text is still a turn: it says the run produced nothing.
    expect(isSilentShell(agent('a3', '', { status: 'interrupted' }))).toBe(false);
  });

  it('never groups a system line: it divides the conversation, it does not join it', () => {
    const turns = turnsOf([
      message({ id: 's1', role: 'system' }),
      message({ id: 's2', role: 'system' }),
    ]);
    expect(turns.map((turn) => turn.grouped)).toEqual([false, false]);
  });

  it('names the speaker of an agent turn only', () => {
    expect(speakerOf(agent('a1', 'Hermes'))).toBe('Hermes');
    expect(speakerOf(message({ id: 'u1', role: 'user' }))).toBe('');
  });
});

describe('what the live status line says', () => {
  const state = (messages: Message[]): ChatState => ({ ...initialChat(), messages });

  it('says nothing when no run is alive', () => {
    expect(runProgress(state([]), null)).toBeNull();
  });

  it('carries the hub start time, so the clock is the run and not the render', () => {
    const progress = runProgress(
      state([]),
      run({ id: 'r1', status: 'running', started_at: '2026-09-22T10:00:00Z' }),
    );
    expect(progress?.startedAtMs).toBe(Date.parse('2026-09-22T10:00:00Z'));
    expect(progress?.queued).toBe(false);
  });

  it('has no start time to show while the run is only queued', () => {
    const progress = runProgress(state([]), run({ id: 'r1', status: 'queued' }));
    expect(progress?.startedAtMs).toBeNull();
    expect(progress?.queued).toBe(true);
  });

  it('names the tool the agent is inside right now, and drops it once it finishes', () => {
    const running = state([
      agent('a1', 'Hermes', {
        run_id: 'r1',
        tool_calls: [
          tool({ id: 't1', name: 'read_file', status: 'succeeded' }),
          tool({ id: 't2', name: 'shell', status: 'running' }),
        ],
      }),
    ]);
    expect(currentTool(running, 'r1')?.name).toBe('shell');
    const progress = runProgress(running, run({ id: 'r1', status: 'running' }));
    expect(progress?.step).toBe('shell');
    expect(progress?.stepIsIdentifier).toBe(true);

    const done = state([
      agent('a1', 'Hermes', {
        run_id: 'r1',
        tool_calls: [tool({ id: 't2', name: 'shell', status: 'succeeded' })],
      }),
    ]);
    expect(runProgress(done, run({ id: 'r1', status: 'running' }))?.step).toBeNull();
  });

  it('counts a tool waiting for approval as the current step: it is where the run is', () => {
    const waiting = state([
      agent('a1', 'Hermes', {
        run_id: 'r1',
        tool_calls: [tool({ id: 't1', name: 'write_file', status: 'awaiting_approval' })],
      }),
    ]);
    expect(runProgress(waiting, run({ id: 'r1', status: 'waiting' }))?.step).toBe('write_file');
  });

  it('ignores the tools of another run in the same session', () => {
    const mixed = state([
      agent('a1', 'Hermes', {
        run_id: 'r0',
        tool_calls: [tool({ id: 't0', name: 'old', status: 'running' })],
      }),
    ]);
    expect(currentTool(mixed, 'r1')).toBeNull();
  });
});

describe('how long the agent thought', () => {
  it('prefers the adapter’s own measurement', () => {
    const seconds = thoughtSeconds(
      { reasoning: { text: '…', duration_ms: 12_400 }, run_id: 'r1' },
      {},
    );
    expect(seconds).toBe(12);
  });

  it('falls back to the run the hub timed', () => {
    const runs = {
      r1: run({
        id: 'r1',
        status: 'succeeded',
        started_at: '2026-09-22T10:00:00Z',
        finished_at: '2026-09-22T10:00:08Z',
      }),
    };
    expect(
      thoughtSeconds({ reasoning: { text: '…', duration_ms: null }, run_id: 'r1' }, runs),
    ).toBe(8);
  });

  it('never rounds a real thought down to zero seconds', () => {
    expect(thoughtSeconds({ reasoning: { text: '…', duration_ms: 120 }, run_id: null }, {})).toBe(
      1,
    );
  });

  it('says nothing rather than invent a number', () => {
    expect(thoughtSeconds({ reasoning: { text: '…', duration_ms: null }, run_id: null }, {})).toBe(
      null,
    );
    expect(
      thoughtSeconds(
        { reasoning: { text: '…', duration_ms: null }, run_id: 'r1' },
        {
          r1: run({ id: 'r1', status: 'running', started_at: '2026-09-22T10:00:00Z' }),
        },
      ),
    ).toBe(null);
  });
});
