/**
 * What a turn's tool calls show, decided once and the same on every client
 * (DECISIONS §111; the iOS and Android twins are `ToolActivity` in their apps).
 *
 * - **While the turn runs**, the last `window` calls are shown (4 on the web, 2 on a phone).
 *   A call that is still running or waits for approval is always shown, and so is one that
 *   failed, until the turn ends: an error must not scroll out of sight while the agent carries
 *   on. The rest are counted into one "+k earlier steps" line.
 * - **When the turn has ended**, every call folds into one summary row: how many steps, how long
 *   they took, how many failed and the latest tools' names. It opens to the full list.
 *
 * Pure: calls and a live flag in, what to draw out. No clock, no DOM.
 */
import type { ToolCall } from '../types.js';

/** How many calls a live turn shows on the web before "earlier" folds the rest away. */
export const WEB_LIVE_WINDOW = 4;
/** How many tool names the folded row shows as chips. */
export const SUMMARY_NAMES = 3;

export interface ToolActivitySummary {
  count: number;
  failed: number;
  /** Wall-clock time from the first start to the last finish, else the calls' durations summed. */
  durationMs: number | null;
  /** The latest distinct tool names, most recent first. */
  names: string[];
}

export interface ToolActivity {
  /** True once the turn has ended and nothing is still running or waiting. */
  folded: boolean;
  /** The calls a live turn shows, in order; empty when folded (the row opens to all of them). */
  visible: ToolCall[];
  /** How many calls the "+k earlier steps" line (live) or the folded row stands for. */
  hidden: number;
  summary: ToolActivitySummary;
}

const isBusy = (call: ToolCall) => call.status === 'running' || call.status === 'awaiting_approval';

/** A live call that stays on screen whatever the window: running, waiting, or failed. */
const isPinned = (call: ToolCall) => isBusy(call) || call.status === 'failed';

function totalDuration(calls: readonly ToolCall[]): number | null {
  const starts = calls.map((call) => (call.started_at ? Date.parse(call.started_at) : NaN));
  const ends = calls.map((call) => (call.finished_at ? Date.parse(call.finished_at) : NaN));
  if (calls.length > 0 && starts.every(Number.isFinite) && ends.every(Number.isFinite)) {
    return Math.max(0, Math.max(...ends) - Math.min(...starts));
  }
  const durations = calls
    .map((call) => call.duration_ms)
    .filter((ms): ms is number => typeof ms === 'number');
  return durations.length > 0 ? durations.reduce((sum, ms) => sum + ms, 0) : null;
}

function latestNames(calls: readonly ToolCall[], max: number): string[] {
  const names: string[] = [];
  for (let i = calls.length - 1; i >= 0 && names.length < max; i -= 1) {
    const name = calls[i]!.name;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export function summarizeTools(
  calls: readonly ToolCall[],
  maxNames = SUMMARY_NAMES,
): ToolActivitySummary {
  return {
    count: calls.length,
    failed: calls.filter((call) => call.status === 'failed').length,
    durationMs: totalDuration(calls),
    names: latestNames(calls, maxNames),
  };
}

export function toolActivity(
  calls: readonly ToolCall[],
  live: boolean,
  window = WEB_LIVE_WINDOW,
  maxNames = SUMMARY_NAMES,
): ToolActivity {
  const summary = summarizeTools(calls, maxNames);
  const folded = !live && !calls.some(isBusy);
  if (folded) return { folded, visible: [], hidden: calls.length, summary };
  const start = Math.max(0, calls.length - window);
  const visible = calls.filter((call, index) => index >= start || isPinned(call));
  return { folded, visible, hidden: calls.length - visible.length, summary };
}

/**
 * The folded row's time: whole seconds under a minute, else minutes and two-digit seconds
 * ("1m 05s"). Never below one second, so a quick turn does not read "0s".
 */
export function durationParts(ms: number): { minutes: number; seconds: number } {
  const total = Math.max(1, Math.round(ms / 1000));
  return { minutes: Math.floor(total / 60), seconds: total % 60 };
}
