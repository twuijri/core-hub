/**
 * The Trajectory tab's pure half (contract `Trajectory`, decision §42): which steps the
 * filters keep, and where each step sits on the shared time axis. No React, no clock of
 * its own — `now` is passed in — so every rule here is a unit test.
 *
 * **Time flows in the reading direction.** Positions are fractions from the *start* of the
 * axis and are applied with `inset-inline-start`, so in Arabic the first step is at the right
 * edge and time moves leftwards, as the text does; in English it moves rightwards. Nothing
 * here knows the direction: the stylesheet's logical properties do it.
 *
 * **Idle time is folded.** A conversation can span days, and a shared axis over days would
 * shrink every step to nothing. Wherever nothing at all was happening for longer than
 * `IDLE_MS`, the gap is drawn as a fixed `FOLD_MS` of axis time with a break mark, so the
 * bars keep their true proportions within each stretch of work.
 */
import type { Schemas } from '../types.js';

export type Trajectory = Schemas['Trajectory'];
export type TrajectoryStep = Schemas['TrajectoryStep'];
export type TrajectoryMetrics = Schemas['TrajectoryMetrics'];
export type TrajectoryLane = Schemas['TrajectoryLane'];

export const LANES: readonly TrajectoryLane[] = ['input', 'model', 'tools'];

/** Longer than this with nothing happening is folded out of the axis. */
export const IDLE_MS = 3000;
/** What a folded gap is drawn as. */
export const FOLD_MS = 600;

export interface StepFilter {
  /** Model turns (and their reasoning) only. */
  turns: boolean;
  /** Tool calls only. */
  calls: boolean;
  /** Longest first instead of in order. */
  byDuration: boolean;
  query: string;
}

export const NO_FILTER: StepFilter = { turns: false, calls: false, byDuration: false, query: '' };

/** How long a step took, a running one up to `now`; `null` when it was not recorded. */
export function durationOf(step: TrajectoryStep, now: number): number | null {
  if (step.duration_ms !== null) return step.duration_ms;
  if (step.started_at !== null && step.ended_at === null && step.status === 'running') {
    return Math.max(0, now - Date.parse(step.started_at));
  }
  return null;
}

/** The words a search looks through: what was said, the tool, its arguments and result. */
function haystackOf(step: TrajectoryStep): string {
  const call = step.tool_call;
  const parts = [step.text ?? ''];
  if (call) {
    parts.push(call.name, call.preview ?? '', call.output ?? '');
    if (call.arguments) {
      try {
        parts.push(JSON.stringify(call.arguments));
      } catch {
        // An argument object that cannot be written out is simply not searched.
      }
    }
  }
  return parts.join('\n').toLocaleLowerCase();
}

/**
 * The steps the list shows. "Turns" and "Calls" narrow it to that kind (both on: both
 * kinds); with neither, every step is shown, inputs included. "Duration" orders the result
 * longest first, and a step without a recorded duration goes last.
 */
export function filterSteps(
  steps: readonly TrajectoryStep[],
  filter: StepFilter,
  now: number,
): TrajectoryStep[] {
  const query = filter.query.trim().toLocaleLowerCase();
  const kept = steps.filter((step) => {
    if (filter.turns || filter.calls) {
      const isTurn = step.kind === 'turn' || step.kind === 'reasoning';
      const isCall = step.kind === 'tool';
      if (!((filter.turns && isTurn) || (filter.calls && isCall))) return false;
    }
    return query === '' || haystackOf(step).includes(query);
  });
  if (!filter.byDuration) return kept;
  return kept
    .map((step, index) => ({ step, index, ms: durationOf(step, now) }))
    .sort((a, b) => (b.ms ?? -1) - (a.ms ?? -1) || a.index - b.index)
    .map((entry) => entry.step);
}

export interface Axis {
  /** Position of an instant on the axis, from 0 (start) to 1 (end). */
  at(time: number): number;
  /** Where the folded gaps are, as positions on the axis. */
  folds: number[];
}

/** The time a step occupies, a running one up to `now`; `null` when it has no times. */
export function spanOf(step: TrajectoryStep, now: number): [number, number] | null {
  if (step.started_at === null) return null;
  const start = Date.parse(step.started_at);
  if (step.ended_at !== null) return [start, Math.max(start, Date.parse(step.ended_at))];
  return step.status === 'running' ? [start, Math.max(start, now)] : [start, start];
}

/** The axis over some spans, with idle stretches folded (see the file comment). */
export function axisOf(
  spans: ReadonlyArray<readonly [number, number]>,
  idleMs = IDLE_MS,
  foldMs = FOLD_MS,
): Axis {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  // Stretches of work: spans that touch or come within `idleMs` of each other.
  const blocks: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = blocks.at(-1);
    if (last && start - last[1] <= idleMs) last[1] = Math.max(last[1], end);
    else blocks.push([start, end]);
  }
  if (blocks.length === 0) return { at: () => 0, folds: [] };
  // Axis offset where each block begins.
  const offsets: number[] = [];
  let total = 0;
  blocks.forEach(([start, end], index) => {
    if (index > 0) total += foldMs;
    offsets.push(total);
    total += end - start;
  });
  const length = Math.max(total, 1);
  const at = (time: number): number => {
    let index = blocks.findIndex(([, end]) => time <= end);
    if (index < 0) index = blocks.length - 1;
    const [start, end] = blocks[index] as [number, number];
    const offset = offsets[index] as number;
    // An instant inside a folded gap sits at the start of the next block.
    const within = Math.min(Math.max(time, start), end) - start;
    return Math.min(1, Math.max(0, (offset + within) / length));
  };
  const folds = offsets.slice(1).map((offset) => (offset - foldMs / 2) / length);
  return { at, folds };
}

/**
 * Sub-rows for a lane, so calls that ran at the same time do not hide each other: each
 * span takes the first row whose last span has ended. Returns the row of each span.
 */
export function packRows(spans: ReadonlyArray<readonly [number, number]>): number[] {
  const rowsEnd: number[] = [];
  const order = spans.map((span, index) => ({ span, index })).sort((a, b) => a.span[0] - b.span[0]);
  const rows = new Array<number>(spans.length).fill(0);
  for (const { span, index } of order) {
    let row = rowsEnd.findIndex((end) => end <= span[0]);
    if (row < 0) {
      row = rowsEnd.length;
      rowsEnd.push(span[1]);
    } else {
      rowsEnd[row] = span[1];
    }
    rows[index] = row;
  }
  return rows;
}

/** A duration as people read it: 850 ms, 4.2 s, 3 min 12 s. */
export function formatMs(ms: number, units: { ms: string; s: string; min: string }): string {
  if (ms < 1000) return `${Math.round(ms)} ${units.ms}`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} ${units.s}`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds === 0
    ? `${minutes} ${units.min}`
    : `${minutes} ${units.min} ${seconds} ${units.s}`;
}

/** One line of a step for the list: the words, or the tool and what it was given. */
export function summaryOf(step: TrajectoryStep, max = 140): string {
  const call = step.tool_call;
  let text = step.text ?? '';
  if (call) {
    text = call.preview ?? '';
    if (!text && call.arguments) {
      try {
        text = JSON.stringify(call.arguments);
      } catch {
        text = '';
      }
    }
  }
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** The first line of a tool's result, for the list. */
export function resultOf(step: TrajectoryStep, max = 100): string | null {
  const output = step.tool_call?.output;
  if (!output) return null;
  const line = output.replace(/\s+/g, ' ').trim();
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * What changes the trajectory, read off the live transcript: a new message, a status, a
 * tool call starting or ending, text arriving. The tab reads the document again when this
 * changes (throttled), so it follows a run as it streams.
 */
export function revisionOf(
  messages: ReadonlyArray<{
    id: string;
    status: string;
    content: ReadonlyArray<unknown>;
    tool_calls: ReadonlyArray<{ status: string }>;
    reasoning?: { text: string } | null;
  }>,
  runs: Readonly<Record<string, { status: string }>>,
): string {
  const last = messages.at(-1);
  const size = last ? JSON.stringify(last.content).length + (last.reasoning?.text.length ?? 0) : 0;
  return [
    messages.length,
    last?.id ?? '',
    last?.status ?? '',
    size,
    messages.map((m) => m.tool_calls.map((c) => c.status[0]).join('')).join('|'),
    Object.values(runs)
      .map((r) => r.status)
      .join(','),
  ].join(':');
}
