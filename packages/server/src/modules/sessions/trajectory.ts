/**
 * A conversation's trajectory (contract `Trajectory`, decision §43), as a pure function.
 *
 * It is built from what the hub stored — messages, runs with their recorded model turns,
 * tool calls and the usage ledger — plus, for a run that is still going, the engine's
 * in-memory state (its text and turns are only written when it ends). No clock and no
 * database here: the caller passes `now`, so a whole conversation can be replayed in a
 * unit test and its durations and metrics asserted exactly.
 *
 * What is inferred, and how, is written down once here:
 *
 * - **Model turns** come from `runs.timing` (`run-reducer.ts` `ModelTurnState`). A run from
 *   before the hub recorded them has one turn with no times: its steps are listed but not
 *   placed on the time axis (`timing: partial | none`).
 * - **Tool time** is wall-clock time at least one tool was running, per run; parallel calls
 *   count once. A call waiting for a person's approval is running for this purpose.
 * - **Metrics are never invented.** A metric with no data behind it is `null`, and a count
 *   that is zero because nothing was reported (tokens, cache reads) is `null` too.
 */
import type { UsageTotals } from '../audit/index.js';
import { toToolCall, type MessageRow, type RunRow, type ToolCallRow } from './mappers.js';
import type { RunState } from './run-reducer.js';
import type { RunTiming } from './schema.js';
import { toSubagent, type SubagentRecord } from './subagents.js';

/** A recorded turn, as stored on the run or held by the engine for a live one. */
type TurnRecord = RunTiming['turns'][number];

export type TrajectoryStepKind = 'input' | 'turn' | 'reasoning' | 'tool' | 'subagent';
export type TrajectoryLane = 'input' | 'model' | 'tools' | 'subagents';
export type TrajectoryStepStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface TrajectoryStep {
  id: string;
  kind: TrajectoryStepKind;
  lane: TrajectoryLane;
  exchange: number;
  run_id: string | null;
  message_id: string | null;
  status: TrajectoryStepStatus;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  text: string | null;
  tool_call_only: boolean;
  first_token_ms: number | null;
  tool_call: Record<string, unknown> | null;
  /** The subagent of a `subagent` step (§49). */
  subagent?: ReturnType<typeof toSubagent>;
}

export interface TrajectoryMetrics {
  exchanges: number;
  turns: number;
  steps: number;
  tool_calls: number;
  failed_tool_calls: number;
  model_ms: number | null;
  tool_ms: number | null;
  avg_first_token_ms: number | null;
  output_tokens_per_second: number | null;
  cache_hit_pct: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

export interface Trajectory {
  session_id: string;
  generated_at: string;
  live: boolean;
  timing: 'full' | 'partial' | 'none';
  started_at: string | null;
  ended_at: string | null;
  steps: TrajectoryStep[];
  metrics: TrajectoryMetrics;
}

export interface TrajectorySource {
  sessionId: string;
  /** Every message of the session, in `seq` order. */
  messages: readonly MessageRow[];
  runs: readonly RunRow[];
  /** Tool calls per run id, in `seq` order. */
  toolCalls: ReadonlyMap<string, readonly ToolCallRow[]>;
  /** Usage per run id; a run with no entry reported none. */
  usage: ReadonlyMap<string, UsageTotals>;
  /** The engine's state of each run that is still active. */
  live: ReadonlyMap<string, RunState>;
  /** The conversation's subagents (§49); none when absent. */
  subagents?: readonly SubagentRecord[];
  now: number;
}

/** Milliseconds matter here (a tool call of 200 ms), so timestamps keep them. */
const isoMs = (value: number | null): string | null =>
  value === null ? null : new Date(value).toISOString();

const TERMINAL: ReadonlySet<RunRow['status']> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

/** One run's pieces before they become steps. */
interface Piece {
  step: TrajectoryStep;
  /** When it started, for runs recorded before turns knew their place among the tools. */
  at: number | null;
  /**
   * Its place in what happened: tool `n` is `2n`, a turn opened after `k` tools is `2k + 1`.
   * Two events can share a millisecond, so order is taken from the events, not the clock.
   */
  place: number | null;
  order: number;
}

interface RunFacts {
  /** Model time of the run's timed turns; `null` when the run has none. */
  modelMs: number | null;
  firstTokenMs: number[];
  toolIntervals: Array<[number, number]>;
  timed: boolean;
}

export function buildTrajectory(source: TrajectorySource): Trajectory {
  const runsById = new Map(source.runs.map((run) => [run.id, run]));
  const steps: TrajectoryStep[] = [];
  const facts = new Map<string, RunFacts>();
  const seenRuns = new Set<string>();
  let exchange = 0;
  let untimedTurns = 0;

  for (const message of source.messages) {
    if (message.role === 'user' || message.role === 'command') {
      exchange += 1;
      const at = message.createdAt.getTime();
      steps.push({
        id: message.id,
        kind: 'input',
        lane: 'input',
        exchange,
        run_id: message.runId ?? null,
        message_id: message.id,
        status: 'succeeded',
        started_at: isoMs(at),
        ended_at: isoMs(at),
        duration_ms: 0,
        text: message.content,
        tool_call_only: false,
        first_token_ms: null,
        tool_call: null,
      });
      continue;
    }
    if (message.role !== 'assistant') continue;
    const at = Math.max(exchange, 1);
    const run = message.runId ? runsById.get(message.runId) : undefined;
    if (!run) {
      // A reply with no run: copied into a fork, or its run was purged. One untimed turn.
      untimedTurns += 1;
      if (message.reasoning) steps.push(untimedReasoning(message, null, at));
      steps.push(untimedTurn(message, null, at, message.content, 'succeeded'));
      continue;
    }
    if (seenRuns.has(run.id)) continue;
    seenRuns.add(run.id);
    const built = runSteps(source, run, message, at);
    facts.set(run.id, built.facts);
    if (!built.facts.timed) untimedTurns += 1;
    steps.push(...built.steps);
  }

  placeSubagents(steps, source.subagents ?? [], Math.max(exchange, 1));

  const timedRuns = [...facts.values()].filter((f) => f.timed).length;
  const timing: Trajectory['timing'] =
    timedRuns === 0 ? 'none' : untimedTurns > 0 ? 'partial' : 'full';

  let axisStart: number | null = null;
  let axisEnd: number | null = null;
  let open = false;
  for (const step of steps) {
    if (step.started_at === null) continue;
    const start = Date.parse(step.started_at);
    axisStart = axisStart === null ? start : Math.min(axisStart, start);
    if (step.ended_at === null) {
      open = true;
      continue;
    }
    const end = Date.parse(step.ended_at);
    axisEnd = axisEnd === null ? end : Math.max(axisEnd, end);
  }

  return {
    session_id: source.sessionId,
    generated_at: isoMs(source.now) as string,
    live: source.runs.some((run) => !TERMINAL.has(run.status)),
    timing,
    started_at: isoMs(axisStart),
    ended_at: open ? null : isoMs(axisEnd),
    steps,
    metrics: metricsOf(steps, facts, source.usage, exchange),
  };
}

function runSteps(
  source: TrajectorySource,
  run: RunRow,
  message: MessageRow,
  exchange: number,
): { steps: TrajectoryStep[]; facts: RunFacts } {
  const live = source.live.get(run.id);
  const text = live ? live.text : message.content;
  const reasoning = live ? live.reasoning : (message.reasoning ?? '');
  const turns: readonly TurnRecord[] | null = live ? live.turns : (run.timing?.turns ?? null);
  const finished = TERMINAL.has(run.status) && !live;
  const endStatus: TrajectoryStepStatus =
    run.status === 'failed' || run.status === 'timed_out'
      ? 'failed'
      : run.status === 'cancelled'
        ? 'cancelled'
        : 'succeeded';
  const tools = source.toolCalls.get(run.id) ?? [];
  const pieces: Piece[] = [];
  let order = 0;
  const facts: RunFacts = {
    modelMs: null,
    firstTokenMs: [],
    toolIntervals: [],
    timed: turns !== null,
  };

  if (turns === null) {
    if (reasoning) {
      pieces.push({
        step: untimedReasoning(message, run, exchange, reasoning),
        at: null,
        place: null,
        order,
      });
      order += 1;
    }
    pieces.push({
      step: untimedTurn(message, run, exchange, text, finished ? endStatus : 'running'),
      at: null,
      place: null,
      order,
    });
    order += 1;
  } else {
    turns.forEach((turn, index) => {
      const last = index === turns.length - 1;
      const ended = turn.endedAt;
      const status: TrajectoryStepStatus =
        ended === null ? 'running' : last && finished ? endStatus : 'succeeded';
      const said = text.slice(turn.textStart, turn.textEnd ?? text.length);
      const place = turn.toolsBefore === undefined ? null : turn.toolsBefore * 2 + 1;
      const thought = reasoning.slice(turn.reasoningStart, turn.reasoningEnd ?? reasoning.length);
      if (thought.trim() !== '') {
        const rStart = turn.reasoningStartedAt ?? turn.startedAt;
        const rEnd = turn.reasoningEndedAt;
        pieces.push({
          step: {
            id: `${run.id}.r${index + 1}`,
            kind: 'reasoning',
            lane: 'model',
            exchange,
            run_id: run.id,
            message_id: message.id,
            status: rEnd === null ? 'running' : 'succeeded',
            started_at: isoMs(rStart),
            ended_at: isoMs(rEnd),
            duration_ms: rEnd === null ? null : Math.max(0, rEnd - rStart),
            text: thought,
            tool_call_only: false,
            first_token_ms: null,
            tool_call: null,
          },
          at: turn.startedAt,
          place,
          order: order++,
        });
      }
      const until = ended ?? source.now;
      facts.modelMs = (facts.modelMs ?? 0) + Math.max(0, until - turn.startedAt);
      if (turn.firstTokenAt !== null) {
        facts.firstTokenMs.push(Math.max(0, turn.firstTokenAt - turn.startedAt));
      }
      pieces.push({
        step: {
          id: `${run.id}.t${index + 1}`,
          kind: 'turn',
          lane: 'model',
          exchange,
          run_id: run.id,
          message_id: message.id,
          status,
          started_at: isoMs(turn.startedAt),
          ended_at: isoMs(ended),
          duration_ms: ended === null ? null : Math.max(0, ended - turn.startedAt),
          text: said,
          tool_call_only: false,
          first_token_ms:
            turn.firstTokenAt === null ? null : Math.max(0, turn.firstTokenAt - turn.startedAt),
          tool_call: null,
        },
        at: turn.startedAt,
        place,
        order: order++,
      });
    });
  }

  for (const call of tools) {
    const start = call.startedAt?.getTime() ?? null;
    const end = call.finishedAt?.getTime() ?? null;
    const status = toolStatus(call.status, finished);
    if (start !== null) {
      const until = end ?? (finished ? start : source.now);
      facts.toolIntervals.push([start, Math.max(start, until)]);
    }
    pieces.push({
      step: {
        id: call.id,
        kind: 'tool',
        lane: 'tools',
        exchange,
        run_id: run.id,
        message_id: message.id,
        status,
        started_at: isoMs(start),
        ended_at: isoMs(end),
        duration_ms:
          call.durationMs ?? (start !== null && end !== null ? Math.max(0, end - start) : null),
        text: null,
        tool_call_only: false,
        first_token_ms: null,
        tool_call: toToolCall(call),
      },
      // An untimed run lists its tools after its one turn, as the transcript shows them.
      at: turns === null ? null : start,
      place: turns === null ? null : call.seq * 2,
      order: order++,
    });
  }

  if (turns !== null && pieces.every((piece) => piece.place !== null)) {
    // In the order things happened: each turn after the tools that started before it.
    pieces.sort((a, b) => (a.place as number) - (b.place as number) || a.order - b.order);
  } else if (turns !== null) {
    // Turns recorded without their place: by time, a turn first at the same instant.
    const rank: Record<TrajectoryStepKind, number> = {
      input: 0,
      reasoning: 1,
      turn: 2,
      tool: 3,
      subagent: 4,
    };
    pieces.sort(
      (a, b) =>
        (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER) ||
        rank[a.step.kind] - rank[b.step.kind] ||
        a.order - b.order,
    );
  }
  const steps = pieces.map((piece) => piece.step);
  // A turn in which the model said nothing and handed straight over to a tool.
  steps.forEach((step, index) => {
    if (step.kind !== 'turn' || (step.text ?? '').trim() !== '') return;
    const next = steps.slice(index + 1).find((s) => s.kind !== 'reasoning');
    step.tool_call_only = next?.kind === 'tool';
  });
  return { steps, facts };
}

function toolStatus(status: ToolCallRow['status'], runFinished: boolean): TrajectoryStepStatus {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
    case 'denied':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'pending':
    case 'running':
      // A run that ended with the call still open never got its answer.
      return runFinished ? 'cancelled' : 'running';
  }
}

function untimedTurn(
  message: MessageRow,
  run: RunRow | null,
  exchange: number,
  text: string,
  status: TrajectoryStepStatus,
): TrajectoryStep {
  return {
    id: run ? `${run.id}.t1` : `${message.id}.t1`,
    kind: 'turn',
    lane: 'model',
    exchange,
    run_id: run?.id ?? null,
    message_id: message.id,
    status,
    started_at: null,
    ended_at: null,
    duration_ms: null,
    text,
    tool_call_only: false,
    first_token_ms: null,
    tool_call: null,
  };
}

function untimedReasoning(
  message: MessageRow,
  run: RunRow | null,
  exchange: number,
  reasoning = message.reasoning ?? '',
): TrajectoryStep {
  return {
    id: run ? `${run.id}.r1` : `${message.id}.r1`,
    kind: 'reasoning',
    lane: 'model',
    exchange,
    run_id: run?.id ?? null,
    message_id: message.id,
    status: 'succeeded',
    started_at: null,
    ended_at: null,
    duration_ms: null,
    text: reasoning,
    tool_call_only: false,
    first_token_ms: null,
    tool_call: null,
  };
}

/** Length of the union of intervals: parallel tool calls count once. */
export function unionMs(intervals: ReadonlyArray<readonly [number, number]>): number {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let current: [number, number] | null = null;
  for (const [start, end] of sorted) {
    if (!current || start > current[1]) {
      if (current) total += current[1] - current[0];
      current = [start, end];
    } else {
      current[1] = Math.max(current[1], end);
    }
  }
  if (current) total += current[1] - current[0];
  return total;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

function metricsOf(
  steps: readonly TrajectoryStep[],
  facts: ReadonlyMap<string, RunFacts>,
  usage: ReadonlyMap<string, UsageTotals>,
  exchanges: number,
): TrajectoryMetrics {
  const tools = steps.filter((step) => step.kind === 'tool');
  let modelMs: number | null = null;
  let toolMs: number | null = null;
  const firstTokens: number[] = [];
  let rateTokens = 0;
  let rateMs = 0;
  for (const [runId, run] of facts) {
    if (run.modelMs !== null) modelMs = (modelMs ?? 0) + run.modelMs;
    if (run.toolIntervals.length > 0) toolMs = (toolMs ?? 0) + unionMs(run.toolIntervals);
    firstTokens.push(...run.firstTokenMs);
    const output = usage.get(runId)?.outputTokens ?? 0;
    if (output > 0 && run.modelMs !== null && run.modelMs > 0) {
      rateTokens += output;
      rateMs += run.modelMs;
    }
  }
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const runId of facts.keys()) {
    const totals = usage.get(runId);
    if (!totals) continue;
    input += totals.inputTokens;
    output += totals.outputTokens;
    cacheRead += totals.cacheReadTokens;
    cacheWrite += totals.cacheWriteTokens;
  }
  // Input tokens are those not served from the cache (the adapters' convention), so the
  // whole prompt is all three together.
  const prompt = input + cacheRead + cacheWrite;
  return {
    exchanges,
    turns: steps.filter((step) => step.kind === 'turn').length,
    steps: steps.length,
    tool_calls: tools.length,
    failed_tool_calls: tools.filter((step) => step.status === 'failed').length,
    model_ms: modelMs === null ? null : Math.round(modelMs),
    tool_ms: toolMs === null ? null : Math.round(toolMs),
    avg_first_token_ms:
      firstTokens.length === 0
        ? null
        : Math.round(firstTokens.reduce((sum, ms) => sum + ms, 0) / firstTokens.length),
    output_tokens_per_second: rateMs > 0 ? round1((rateTokens / rateMs) * 1000) : null,
    cache_hit_pct: cacheRead > 0 && prompt > 0 ? round1((cacheRead / prompt) * 100) : null,
    input_tokens: input > 0 ? input : null,
    output_tokens: output > 0 ? output : null,
  };
}

const SUBAGENT_STATUS: Record<SubagentRecord['status'], TrajectoryStepStatus> = {
  running: 'running',
  completed: 'succeeded',
  failed: 'failed',
  interrupted: 'cancelled',
};

/**
 * Subagents get a lane of their own (§49): every tool call a subagent made moves there, and each
 * subagent is one step from its start to its end, placed after the last step of its run that
 * began before it (or at the end, for one that started between runs).
 */
function placeSubagents(
  steps: TrajectoryStep[],
  subagents: readonly SubagentRecord[],
  lastExchange: number,
): void {
  for (const step of steps) {
    if (step.kind === 'tool' && step.tool_call && step.tool_call.subagent_id) {
      step.lane = 'subagents';
    }
  }
  const ordered = [...subagents].sort((a, b) => a.startedAt - b.startedAt);
  for (const record of ordered) {
    let at = -1;
    let exchange = lastExchange;
    steps.forEach((step, index) => {
      const sameRun = record.runId === null || step.run_id === record.runId;
      const before = step.started_at === null || Date.parse(step.started_at) <= record.startedAt;
      if (!sameRun || !before) return;
      at = index;
      exchange = step.exchange;
    });
    const ended = record.finishedAt;
    const step: TrajectoryStep = {
      id: `subagent:${record.id}`,
      kind: 'subagent',
      lane: 'subagents',
      exchange,
      run_id: record.runId,
      message_id: null,
      status: SUBAGENT_STATUS[record.status],
      started_at: isoMs(record.startedAt),
      ended_at: isoMs(ended),
      duration_ms: ended === null ? null : Math.max(0, ended - record.startedAt),
      text: record.goal,
      tool_call_only: false,
      first_token_ms: null,
      tool_call: null,
      subagent: toSubagent(record),
    };
    if (at < 0) {
      steps.push(step);
      continue;
    }
    // After the subagents already placed there: two started in the same instant keep the
    // order the agent reported them in.
    let slot = at + 1;
    while (steps[slot]?.kind === 'subagent') slot += 1;
    steps.splice(slot, 0, step);
  }
}
