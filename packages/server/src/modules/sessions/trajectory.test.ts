/**
 * The trajectory (contract decision §43), built from a replayed run: the reducer records the
 * model's turns as the events arrive, and `buildTrajectory` turns stored rows into steps and
 * metrics. Every clock value is chosen by the test, so durations are asserted exactly.
 */
import { describe, expect, it } from 'vitest';
import type { UsageTotals } from '../audit/index.js';
import type { MessageRow, RunRow, ToolCallRow } from './mappers.js';
import type { AgentEvent } from './ports.js';
import { initialRunState, reduceRun, type RunInput, type RunState } from './run-reducer.js';
import { buildTrajectory, unionMs, type TrajectorySource } from './trajectory.js';

const T0 = Date.parse('2026-09-25T10:00:00.000Z');
const SESSION = '01J8QK3ZR2W7M5N4P6T8V9X0YA';

/** Replay `[ms after T0, input]` pairs through the reducer. */
function replay(inputs: Array<[number, RunInput | AgentEvent]>): RunState {
  let state = initialRunState('msg-a');
  let id = 0;
  for (const [ms, input] of inputs) {
    const wrapped: RunInput =
      'type' in input &&
      ['accepted', 'interrupt', 'approval_resolved', 'stream_ended', 'timeout', 'abort'].includes(
        input.type,
      )
        ? (input as RunInput)
        : { type: 'agent', event: input as AgentEvent };
    state = reduceRun(state, wrapped, { now: T0 + ms, newId: () => `id-${++id}` }).state;
  }
  return state;
}

function messageRow(
  id: string,
  seq: number,
  role: MessageRow['role'],
  content: string,
  runId: string | null,
  atMs: number,
  reasoning: string | null = null,
): MessageRow {
  return {
    id,
    seq,
    role,
    content,
    runId,
    reasoning,
    sessionId: SESSION,
    createdAt: new Date(T0 + atMs),
    updatedAt: new Date(T0 + atMs),
  } as MessageRow;
}

function runRow(id: string, status: RunRow['status'], state: RunState | null): RunRow {
  return {
    id,
    status,
    sessionId: SESSION,
    startedAt: state?.startedAt ? new Date(state.startedAt) : null,
    finishedAt: state?.finishedAt ? new Date(state.finishedAt) : null,
    timing: state ? { turns: state.turns } : null,
  } as RunRow;
}

/** The rows the engine would have written for the state's tool calls. */
function toolRows(state: RunState): ToolCallRow[] {
  return state.toolCalls.map(
    (call) =>
      ({
        id: call.id,
        runId: 'run-1',
        seq: call.seq,
        name: call.name,
        title: call.title,
        input: call.input,
        output: call.output,
        outputTruncated: call.outputTruncated,
        subagentId: call.subagentId,
        status: call.status,
        startedAt: new Date(call.startedAt),
        finishedAt: call.finishedAt === null ? null : new Date(call.finishedAt),
        durationMs: call.finishedAt === null ? null : call.finishedAt - call.startedAt,
      }) as ToolCallRow,
  );
}

const usage = (partial: Partial<UsageTotals>): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costMicroUsd: 0,
  hasCost: false,
  ...partial,
});

function source(partial: Partial<TrajectorySource>): TrajectorySource {
  return {
    sessionId: SESSION,
    messages: [],
    runs: [],
    toolCalls: new Map(),
    usage: new Map(),
    live: new Map(),
    now: T0 + 60_000,
    ...partial,
  };
}

/** Say something, call a tool that fails, then answer. */
const ONE_RUN: Array<[number, RunInput | AgentEvent]> = [
  [0, { type: 'accepted' }],
  [100, { type: 'reasoning_delta', text: 'I should look.' }],
  [250, { type: 'message_delta', text: 'Let me check.' }],
  [300, { type: 'tool_started', ref: 't1', name: 'shell', input: { command: 'pnpm test' } }],
  [1300, { type: 'tool_failed', ref: 't1', output: '2 failed' }],
  [1500, { type: 'message_delta', text: ' Two tests fail.' }],
  [1900, { type: 'usage', inputTokens: 900, outputTokens: 50 }],
  [2000, { type: 'completed' }],
];

describe('the run reducer records the model turns', () => {
  it('opens a turn at the start and after the last tool, and closes it when a tool starts', () => {
    const state = replay(ONE_RUN);
    expect(state.turns).toEqual([
      {
        startedAt: T0,
        endedAt: T0 + 300,
        firstTokenAt: T0 + 100,
        textStart: 0,
        textEnd: 'Let me check.'.length,
        reasoningStart: 0,
        reasoningEnd: 'I should look.'.length,
        reasoningStartedAt: T0 + 100,
        reasoningEndedAt: T0 + 250,
      },
      {
        startedAt: T0 + 1300,
        endedAt: T0 + 2000,
        firstTokenAt: T0 + 1500,
        textStart: 'Let me check.'.length,
        textEnd: 'Let me check. Two tests fail.'.length,
        reasoningStart: 'I should look.'.length,
        reasoningEnd: 'I should look.'.length,
        reasoningStartedAt: null,
        reasoningEndedAt: null,
      },
    ]);
  });

  it('takes waiting on a person out of the model time, and drops an empty last instant', () => {
    const state = replay([
      [0, { type: 'accepted' }],
      [40, { type: 'tool_started', ref: 'c1', name: 'clarify' }],
      [
        50,
        {
          type: 'approval_requested',
          ref: 'q1',
          kind: 'question',
          title: 'Which one?',
          toolRef: 'c1',
        },
      ],
      [
        9000,
        {
          type: 'approval_resolved',
          approvalId: 'id-2',
          status: 'answered',
          decision: null,
          answer: 'this one',
          respondedBy: 'u1',
          remember: false,
        },
      ],
      [9100, { type: 'tool_completed', ref: 'c1', output: 'this one' }],
      [9100, { type: 'completed' }],
    ]);
    // One turn: the model called the tool at once, the person took nine seconds, and the
    // run ended the instant the tool returned.
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]).toMatchObject({ startedAt: T0, endedAt: T0 + 40, firstTokenAt: null });
  });
});

describe('buildTrajectory', () => {
  it('lists the input, the turns, the reasoning and the failed call in time order', () => {
    const state = replay(ONE_RUN);
    const trajectory = buildTrajectory(
      source({
        messages: [
          messageRow('msg-u', 1, 'user', 'Run the tests', 'run-1', -50),
          messageRow('msg-a', 2, 'assistant', state.text, 'run-1', 0, state.reasoning),
        ],
        runs: [runRow('run-1', 'succeeded', state)],
        toolCalls: new Map([['run-1', toolRows(state)]]),
        usage: new Map([['run-1', usage({ inputTokens: 900, outputTokens: 50 })]]),
      }),
    );

    expect(trajectory.timing).toBe('full');
    expect(trajectory.live).toBe(false);
    expect(trajectory.steps.map((s) => [s.kind, s.lane, s.status, s.duration_ms])).toEqual([
      ['input', 'input', 'succeeded', 0],
      ['reasoning', 'model', 'succeeded', 150],
      ['turn', 'model', 'succeeded', 300],
      ['tool', 'tools', 'failed', 1000],
      ['turn', 'model', 'succeeded', 700],
    ]);
    const [input, reasoning, first, tool, second] = trajectory.steps;
    expect(input?.text).toBe('Run the tests');
    expect(reasoning?.text).toBe('I should look.');
    expect(first).toMatchObject({ text: 'Let me check.', first_token_ms: 100 });
    expect(second).toMatchObject({ text: ' Two tests fail.', first_token_ms: 200 });
    expect(tool?.tool_call).toMatchObject({
      name: 'shell',
      status: 'failed',
      arguments: { command: 'pnpm test' },
      output: '2 failed',
    });
    // Milliseconds are kept: a 300 ms turn must not round to a second.
    expect(first?.started_at).toBe('2026-09-25T10:00:00.000Z');
    expect(first?.ended_at).toBe('2026-09-25T10:00:00.300Z');
    expect(trajectory.started_at).toBe('2026-09-25T09:59:59.950Z');
    expect(trajectory.ended_at).toBe('2026-09-25T10:00:02.000Z');

    expect(trajectory.metrics).toEqual({
      exchanges: 1,
      turns: 2,
      steps: 5,
      tool_calls: 1,
      failed_tool_calls: 1,
      model_ms: 1000,
      tool_ms: 1000,
      avg_first_token_ms: 150,
      // 50 output tokens over one second of model time.
      output_tokens_per_second: 50,
      // No provider reported a cache read: no rate, rather than a made-up 0 %.
      cache_hit_pct: null,
      input_tokens: 900,
      output_tokens: 50,
    });
  });

  it('marks a silent turn that only handed over to a tool', () => {
    const state = replay([
      [0, { type: 'accepted' }],
      [400, { type: 'tool_started', ref: 't1', name: 'read_file' }],
      [500, { type: 'tool_completed', ref: 't1', output: '# README' }],
      [700, { type: 'message_delta', text: 'Read it.' }],
      [800, { type: 'completed' }],
    ]);
    const trajectory = buildTrajectory(
      source({
        messages: [
          messageRow('msg-u', 1, 'user', 'read', 'run-1', 0),
          messageRow('msg-a', 2, 'assistant', state.text, 'run-1', 0),
        ],
        runs: [runRow('run-1', 'succeeded', state)],
        toolCalls: new Map([['run-1', toolRows(state)]]),
      }),
    );
    const turns = trajectory.steps.filter((s) => s.kind === 'turn');
    expect(turns.map((s) => [s.text, s.tool_call_only])).toEqual([
      ['', true],
      ['Read it.', false],
    ]);
    // No usage was reported: no token counts and no rate, not zeros.
    expect(trajectory.metrics.input_tokens).toBeNull();
    expect(trajectory.metrics.output_tokens).toBeNull();
    expect(trajectory.metrics.output_tokens_per_second).toBeNull();
  });

  it('counts parallel tool calls once in the tool time', () => {
    expect(
      unionMs([
        [0, 1000],
        [500, 1500],
        [3000, 3100],
      ]),
    ).toBe(1600);
  });

  it('computes the cache hit rate from the cache reads the provider reported', () => {
    const state = replay(ONE_RUN);
    const trajectory = buildTrajectory(
      source({
        messages: [messageRow('msg-a', 1, 'assistant', state.text, 'run-1', 0)],
        runs: [runRow('run-1', 'succeeded', state)],
        usage: new Map([
          ['run-1', usage({ inputTokens: 100, cacheReadTokens: 300, outputTokens: 10 })],
        ]),
      }),
    );
    expect(trajectory.metrics.cache_hit_pct).toBe(75);
  });

  it('lists an older conversation without times, and says so', () => {
    const trajectory = buildTrajectory(
      source({
        messages: [
          messageRow('msg-u', 1, 'user', 'hi', 'run-old', 0),
          messageRow('msg-a', 2, 'assistant', 'hello', 'run-old', 10, 'greeting'),
        ],
        runs: [runRow('run-old', 'succeeded', null)],
        toolCalls: new Map(),
        usage: new Map([['run-old', usage({})]]),
      }),
    );
    expect(trajectory.timing).toBe('none');
    const agentSteps = trajectory.steps.filter((s) => s.kind !== 'input');
    expect(agentSteps.map((s) => [s.kind, s.text, s.started_at, s.duration_ms])).toEqual([
      ['reasoning', 'greeting', null, null],
      ['turn', 'hello', null, null],
    ]);
    expect(trajectory.metrics).toMatchObject({
      turns: 1,
      model_ms: null,
      tool_ms: null,
      avg_first_token_ms: null,
      output_tokens_per_second: null,
      input_tokens: null,
      output_tokens: null,
    });
  });

  it('is partial when older runs sit next to recorded ones', () => {
    const state = replay(ONE_RUN);
    const trajectory = buildTrajectory(
      source({
        messages: [
          messageRow('msg-u0', 1, 'user', 'hi', 'run-old', -9000),
          messageRow('msg-a0', 2, 'assistant', 'hello', 'run-old', -8000),
          messageRow('msg-u', 3, 'user', 'Run the tests', 'run-1', -50),
          messageRow('msg-a', 4, 'assistant', state.text, 'run-1', 0),
        ],
        runs: [runRow('run-old', 'succeeded', null), runRow('run-1', 'succeeded', state)],
      }),
    );
    expect(trajectory.timing).toBe('partial');
    expect(trajectory.metrics.exchanges).toBe(2);
    expect(trajectory.steps.filter((s) => s.exchange === 2).length).toBeGreaterThan(1);
  });

  it('reads a live run from the engine, with its open turn still running', () => {
    const state = replay(ONE_RUN.slice(0, 4)); // stopped while the tool runs
    const trajectory = buildTrajectory(
      source({
        now: T0 + 800,
        messages: [
          messageRow('msg-u', 1, 'user', 'Run the tests', 'run-1', -50),
          // The stored message is still empty: the text lives in the engine until the end.
          messageRow('msg-a', 2, 'assistant', '', 'run-1', 0),
        ],
        runs: [runRow('run-1', 'streaming', null)],
        toolCalls: new Map([['run-1', toolRows(state)]]),
        live: new Map([['run-1', state]]),
      }),
    );
    expect(trajectory.live).toBe(true);
    expect(trajectory.timing).toBe('full');
    const tool = trajectory.steps.find((s) => s.kind === 'tool');
    expect(tool).toMatchObject({ status: 'running', ended_at: null, duration_ms: null });
    expect(trajectory.steps.find((s) => s.kind === 'turn')?.text).toBe('Let me check.');
    expect(trajectory.ended_at).toBeNull();
    // The running call counts up to `now`.
    expect(trajectory.metrics.tool_ms).toBe(500);
  });

  it('shows a failed run’s last turn as failed', () => {
    const state = replay([
      [0, { type: 'accepted' }],
      [100, { type: 'message_delta', text: 'Trying' }],
      [200, { type: 'failed', message: 'provider down' }],
    ]);
    const trajectory = buildTrajectory(
      source({
        messages: [messageRow('msg-a', 1, 'assistant', state.text, 'run-1', 0)],
        runs: [runRow('run-1', 'failed', state)],
      }),
    );
    expect(trajectory.steps.map((s) => s.status)).toEqual(['failed']);
  });
});
