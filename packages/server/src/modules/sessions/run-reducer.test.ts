// The run state machine (docs/domain/README.md §run), asserted arrow by arrow.
// Pure input -> (state, actions): no database, no sockets, no real clock.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  initialRunState,
  isTerminal,
  reduceRun,
  type ReduceContext,
  type RunAction,
  type RunInput,
  type RunState,
} from './run-reducer.js';

const MESSAGE_ID = '01J8QK3ZR2W7M5N4P6T8V9X0MB';

function ctx(now = 1_000): ReduceContext {
  let counter = 0;
  return {
    now,
    newId: () => `01J8QK3ZR2W7M5N4P6T8V9X${String(counter++).padStart(2, '0')}`,
  };
}

/** Fold a list of inputs, collecting every action in order. */
function run(
  inputs: RunInput[],
  context: ReduceContext = ctx(),
): {
  state: RunState;
  actions: RunAction[];
} {
  let state = initialRunState(MESSAGE_ID);
  const actions: RunAction[] = [];
  for (const input of inputs) {
    const result = reduceRun(state, input, context);
    state = result.state;
    actions.push(...result.actions);
  }
  return { state, actions };
}

const agent = (event: Parameters<typeof reduceRun>[1] extends { event: infer E } ? E : never) =>
  ({ type: 'agent', event }) as RunInput;

describe('run reducer: the happy path', () => {
  it('walks queued -> starting -> streaming -> succeeded and emits the deltas in order', () => {
    const { state, actions } = run([
      { type: 'accepted' },
      agent({ type: 'reasoning_delta', text: 'thinking' }),
      agent({ type: 'message_delta', text: 'Hello' }),
      agent({ type: 'message_delta', text: ' world' }),
      agent({ type: 'usage', modelLabel: 'hermes-4', inputTokens: 10, outputTokens: 4 }),
      agent({ type: 'context', usedTokens: 1200, windowTokens: 128_000 }),
      agent({ type: 'completed' }),
    ]);

    expect(actions).toEqual([
      { type: 'status', from: 'queued', to: 'starting' },
      { type: 'status', from: 'starting', to: 'streaming' },
      { type: 'reasoning_delta', delta: 'thinking' },
      { type: 'message_delta', delta: 'Hello' },
      { type: 'message_delta', delta: ' world' },
      { type: 'usage', modelLabel: 'hermes-4' },
      { type: 'context' },
      { type: 'status', from: 'streaming', to: 'succeeded' },
      { type: 'finished', status: 'succeeded' },
    ]);
    expect(state.text).toBe('Hello world');
    expect(state.reasoning).toBe('thinking');
    expect(state.context).toEqual({ usedTokens: 1200, windowTokens: 128_000, estimated: false });
    expect(isTerminal(state.status)).toBe(true);
  });

  it('keeps usage cumulative per model rather than adding reports up', () => {
    const { state } = run([
      { type: 'accepted' },
      agent({ type: 'usage', modelLabel: 'hermes-4', inputTokens: 10, outputTokens: 2 }),
      agent({ type: 'usage', modelLabel: 'hermes-4', inputTokens: 10, outputTokens: 9 }),
      agent({ type: 'usage', modelLabel: 'claude-sonnet-4-5', inputTokens: 5, outputTokens: 1 }),
    ]);
    expect(state.usage).toEqual([
      expect.objectContaining({ modelLabel: 'hermes-4', inputTokens: 10, outputTokens: 9 }),
      expect.objectContaining({ modelLabel: 'claude-sonnet-4-5', outputTokens: 1 }),
    ]);
  });

  it('ignores everything after a terminal state', () => {
    const { state, actions } = run([
      { type: 'accepted' },
      agent({ type: 'completed' }),
      agent({ type: 'message_delta', text: 'too late' }),
    ]);
    expect(state.text).toBe('');
    expect(actions.filter((a) => a.type === 'message_delta')).toEqual([]);
  });
});

describe('run reducer: tool calls', () => {
  it('tracks a call from running to succeeded and keeps the agent reference', () => {
    const { state, actions } = run([
      { type: 'accepted' },
      agent({
        type: 'tool_started',
        ref: 't1',
        name: 'shell',
        kind: 'shell',
        input: { cmd: 'ls' },
      }),
      agent({ type: 'tool_completed', ref: 't1', output: 'README.md', exitCode: 0 }),
      agent({ type: 'completed' }),
    ]);
    const call = state.toolCalls[0];
    expect(call).toMatchObject({
      ref: 't1',
      seq: 1,
      name: 'shell',
      kind: 'shell',
      status: 'succeeded',
      output: 'README.md',
      outputTruncated: false,
      exitCode: 0,
    });
    expect(actions.map((a) => a.type)).toContain('tool_started');
    expect(actions.map((a) => a.type)).toContain('tool_completed');
  });

  it('reports a failed call as failed, not as a failed run', () => {
    const { state } = run([
      { type: 'accepted' },
      agent({ type: 'tool_started', ref: 't1', name: 'shell' }),
      agent({ type: 'tool_failed', ref: 't1', output: 'command not found', exitCode: 127 }),
      agent({ type: 'completed' }),
    ]);
    expect(state.toolCalls[0]?.status).toBe('failed');
    expect(state.status).toBe('succeeded');
  });

  it('truncates output over the limit and says so', () => {
    const big = 'x'.repeat(DEFAULT_MAX_OUTPUT_BYTES + 100);
    const { state } = run([
      { type: 'accepted' },
      agent({ type: 'tool_started', ref: 't1', name: 'shell' }),
      agent({ type: 'tool_completed', ref: 't1', output: big }),
    ]);
    expect(state.toolCalls[0]?.output?.length).toBe(DEFAULT_MAX_OUTPUT_BYTES);
    expect(state.toolCalls[0]?.outputTruncated).toBe(true);
  });

  it('ignores a second tool_started for the same reference', () => {
    const { state } = run([
      { type: 'accepted' },
      agent({ type: 'tool_started', ref: 't1', name: 'shell' }),
      agent({ type: 'tool_started', ref: 't1', name: 'shell' }),
    ]);
    expect(state.toolCalls).toHaveLength(1);
  });

  it('closes a call still running when the run ends', () => {
    const { state } = run([
      { type: 'accepted' },
      agent({ type: 'tool_started', ref: 't1', name: 'shell' }),
      agent({ type: 'failed', message: 'the model stopped' }),
    ]);
    expect(state.toolCalls[0]?.status).toBe('failed');
    expect(state.status).toBe('failed');
    expect(state.error).toEqual({ code: 'agent_error', message: 'the model stopped' });
  });
});

describe('run reducer: approvals', () => {
  const askToRunLs: RunInput = agent({
    type: 'approval_requested',
    ref: 'a1',
    kind: 'tool_call',
    title: 'Run a command',
    command: 'ls -la',
    toolRef: 't1',
    allowAlways: true,
  });

  it('blocks on waiting_approval and resumes on approval', () => {
    let state = initialRunState(MESSAGE_ID);
    const context = ctx();
    for (const input of [
      { type: 'accepted' } as RunInput,
      agent({ type: 'tool_started', ref: 't1', name: 'shell' }),
      askToRunLs,
    ]) {
      state = reduceRun(state, input, context).state;
    }
    expect(state.status).toBe('waiting_approval');
    expect(state.toolCalls[0]?.status).toBe('pending');
    const approvalId = state.approvals[0]?.id as string;
    expect(state.toolCalls[0]?.approvalId).toBe(approvalId);

    const resolved = reduceRun(
      state,
      {
        type: 'approval_resolved',
        approvalId,
        status: 'approved',
        decision: 'approve_session',
        answer: null,
        respondedBy: 'user-1',
        remember: true,
      },
      context,
    );
    expect(resolved.state.status).toBe('streaming');
    expect(resolved.state.toolCalls[0]?.status).toBe('running');
    expect(resolved.state.rememberedTools).toEqual(['shell']);
    expect(resolved.actions).toEqual([
      { type: 'approval_resolved', approvalId },
      { type: 'status', from: 'waiting_approval', to: 'streaming' },
    ]);
  });

  it('denies the gated tool call when the approval is denied', () => {
    const context = ctx();
    let state = initialRunState(MESSAGE_ID);
    for (const input of [
      { type: 'accepted' } as RunInput,
      agent({ type: 'tool_started', ref: 't1', name: 'shell' }),
      askToRunLs,
    ]) {
      state = reduceRun(state, input, context).state;
    }
    const approvalId = state.approvals[0]?.id as string;
    const result = reduceRun(
      state,
      {
        type: 'approval_resolved',
        approvalId,
        status: 'denied',
        decision: 'deny',
        answer: null,
        respondedBy: 'user-1',
        remember: false,
      },
      context,
    );
    expect(result.state.toolCalls[0]?.status).toBe('denied');
    expect(result.actions).toContainEqual({ type: 'tool_failed', toolCallId: expect.any(String) });
    expect(result.state.rememberedTools).toEqual([]);
  });

  it('a question blocks on waiting_input, not waiting_approval', () => {
    const { state } = run([
      { type: 'accepted' },
      agent({
        type: 'approval_requested',
        ref: 'q1',
        kind: 'question',
        title: 'Which branch?',
        choices: [{ value: 'main', label: 'main' }],
      }),
    ]);
    expect(state.status).toBe('waiting_input');
    expect(state.approvals[0]?.answerMode).toBe('both');
  });

  it('stays blocked while a second approval is still pending', () => {
    const context = ctx();
    let state = initialRunState(MESSAGE_ID);
    for (const input of [
      { type: 'accepted' } as RunInput,
      agent({ type: 'approval_requested', ref: 'a1', kind: 'tool_call', title: 'one' }),
      agent({ type: 'approval_requested', ref: 'a2', kind: 'tool_call', title: 'two' }),
    ]) {
      state = reduceRun(state, input, context).state;
    }
    const first = state.approvals[0]?.id as string;
    const after = reduceRun(
      state,
      {
        type: 'approval_resolved',
        approvalId: first,
        status: 'approved',
        decision: 'approve_once',
        answer: null,
        respondedBy: 'u',
        remember: false,
      },
      context,
    );
    expect(after.state.status).toBe('waiting_approval');
  });

  it('cancels an approval nobody answered when the run ends', () => {
    const { state } = run([
      { type: 'accepted' },
      agent({ type: 'approval_requested', ref: 'a1', kind: 'tool_call', title: 'one' }),
      { type: 'abort', code: 'cancelled', message: 'stopped' },
    ]);
    expect(state.approvals[0]?.status).toBe('cancelled');
    expect(state.status).toBe('cancelled');
  });
});

describe('run reducer: the unhappy arrows', () => {
  it('interrupt then completed ends as cancelled, not succeeded', () => {
    const { state, actions } = run([
      { type: 'accepted' },
      agent({ type: 'message_delta', text: 'half an ans' }),
      { type: 'interrupt' },
      agent({ type: 'completed' }),
    ]);
    expect(state.status).toBe('cancelled');
    expect(state.interruptRequested).toBe(true);
    expect(state.text).toBe('half an ans');
    expect(actions.at(-1)).toEqual({ type: 'finished', status: 'cancelled' });
  });

  it('a stream that just stops is a failure, unless it was interrupted', () => {
    expect(run([{ type: 'accepted' }, { type: 'stream_ended' }]).state).toMatchObject({
      status: 'failed',
      error: { code: 'agent_error' },
    });
    expect(
      run([{ type: 'accepted' }, { type: 'interrupt' }, { type: 'stream_ended' }]).state.status,
    ).toBe('cancelled');
  });

  it('silence past the timeout ends the run as timed_out', () => {
    const { state, actions } = run([
      { type: 'accepted' },
      agent({ type: 'tool_started', ref: 't1', name: 'shell' }),
      { type: 'timeout' },
    ]);
    expect(state.status).toBe('timed_out');
    expect(state.error).toEqual({ code: 'timeout', message: 'agent timeout' });
    expect(state.toolCalls[0]?.status).toBe('cancelled');
    expect(actions.at(-1)).toEqual({ type: 'finished', status: 'timed_out' });
  });

  it('a failure after an interrupt is reported as cancelled', () => {
    const { state } = run([
      { type: 'accepted' },
      { type: 'interrupt' },
      agent({ type: 'failed', code: 'aborted', message: 'killed' }),
    ]);
    expect(state.status).toBe('cancelled');
  });

  it('an agent frame revives a run that never left queued', () => {
    const { actions } = run([agent({ type: 'message_delta', text: 'hi' })]);
    expect(actions.slice(0, 2)).toEqual([
      { type: 'status', from: 'queued', to: 'starting' },
      { type: 'status', from: 'starting', to: 'streaming' },
    ]);
  });
});
