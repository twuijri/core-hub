/**
 * Who is speaking, and where one turn ends.
 *
 * Pure functions, so the layout rule that matters most — the person on the right, the
 * agent on the left, grouped while the speaker does not change — is unit-tested without a
 * DOM (tests/turns.test.ts).
 */
import { textOf, type ChatState } from './transcript.js';
import type { Message, Run, ToolCall } from '../types.js';

/** The physical side a message is drawn on. Never derived from the content's language. */
export type Side = 'user' | 'agent' | 'system';

export function sideOf(message: Pick<Message, 'role'>): Side {
  if (message.role === 'user' || message.role === 'command') return 'user';
  if (message.role === 'system') return 'system';
  return 'agent';
}

/** The name shown above an agent's turn; the empty author of a delta shell has none yet. */
export function speakerOf(message: Pick<Message, 'role' | 'author'>): string {
  return sideOf(message) === 'agent' ? message.author.name.trim() : '';
}

/**
 * The hub opens a run by creating an empty assistant message (the "shell", `engine.ts`),
 * which then fills with deltas. Until text or a tool lands in it there is nothing to draw:
 * an empty bubble says no more than the live indicator above the composer already says —
 * reasoning included, which while the run is alive *is* that indicator. And the shell
 * wedges itself between two messages from the same speaker, so they stop grouping.
 * A silent shell is therefore not a turn yet.
 */
export function isSilentShell(message: Message): boolean {
  return (
    sideOf(message) === 'agent' &&
    message.status === 'streaming' &&
    message.tool_calls.length === 0 &&
    textOf(message) === ''
  );
}

export interface Turn {
  message: Message;
  side: Side;
  /**
   * True when the message continues the turn above it: same side, same speaker. The name
   * and the avatar are drawn once per turn, and the gap above a grouped message is the
   * tighter one.
   */
  grouped: boolean;
}

/** Walk the transcript once, drop what has nothing to say, and mark where each turn begins. */
export function turnsOf(messages: readonly Message[]): Turn[] {
  const out: Turn[] = [];
  for (const message of messages) {
    if (isSilentShell(message)) continue;
    const side = sideOf(message);
    const previous = out[out.length - 1];
    const grouped =
      previous !== undefined &&
      side !== 'system' &&
      previous.side === side &&
      speakerOf(previous.message) === speakerOf(message);
    out.push({ message, side, grouped });
  }
  return out;
}

/* ------------------------------------------------------------------ a live run */

export interface RunProgress {
  runId: string;
  /** Epoch ms the hub says the run started, or null when it has not started yet. */
  startedAtMs: number | null;
  /** What the agent says it is doing right now — a tool name — or null. */
  step: string | null;
  /** A tool name is an identifier and is set in the mono face; a phrase is not. */
  stepIsIdentifier: boolean;
  /** Queued behind another run: it is alive, but it is not thinking yet. */
  queued: boolean;
}

function msOf(timestamp: string | null): number | null {
  if (!timestamp) return null;
  const value = Date.parse(timestamp);
  return Number.isNaN(value) ? null : value;
}

/** The tool the agent is inside right now, if any: the last one still running. */
export function currentTool(state: ChatState, runId: string): ToolCall | null {
  let found: ToolCall | null = null;
  for (const message of state.messages) {
    if (message.run_id !== runId) continue;
    for (const call of message.tool_calls)
      if (call.status === 'running' || call.status === 'awaiting_approval') found = call;
  }
  return found;
}

/** What the status line above the composer should say, or null when nothing is running. */
export function runProgress(state: ChatState, run: Run | null): RunProgress | null {
  if (!run) return null;
  const tool = currentTool(state, run.id);
  return {
    runId: run.id,
    startedAtMs: msOf(run.started_at),
    step: tool?.name ?? null,
    stepIsIdentifier: tool !== null,
    queued: run.status === 'queued',
  };
}

/**
 * How long the agent thought, in whole seconds. The adapter's own measurement first
 * (`reasoning.duration_ms`); otherwise the run's own start and finish, which every hub
 * records. Null when neither is known — better no number than an invented one.
 */
export function thoughtSeconds(
  message: Pick<Message, 'reasoning' | 'run_id'>,
  runs: Record<string, Run>,
): number | null {
  const declared = message.reasoning?.duration_ms ?? null;
  if (declared !== null) return Math.max(1, Math.round(declared / 1000));
  const run = message.run_id ? runs[message.run_id] : undefined;
  const start = msOf(run?.started_at ?? null);
  const end = msOf(run?.finished_at ?? null);
  if (start === null || end === null || end < start) return null;
  return Math.max(1, Math.round((end - start) / 1000));
}
