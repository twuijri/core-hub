/**
 * A conversation's subagents (contract decision §56), the pure half: how a live change joins
 * the list, how the running ones are ordered as a tree, and how long each has been going.
 * No React and no clock of its own, so every rule here is a unit test.
 */
import type { Subagent } from '../types.js';

/** Puts one subagent's latest state into the list, in place, or adds it. */
export function upsertSubagent(list: readonly Subagent[], next: Subagent): Subagent[] {
  const at = list.findIndex((item) => item.id === next.id);
  if (at < 0) return [...list, next];
  const copy = [...list];
  copy[at] = next;
  return copy;
}

export interface SubagentRow {
  subagent: Subagent;
  /** How far in it is drawn: a subagent under the one that started it. */
  indent: number;
}

/**
 * The running ones as a tree — each after the one that started it, siblings in the order they
 * started — and the finished ones, newest first. A subagent whose parent is not running is
 * drawn at its own `depth`, never lost.
 */
export function splitSubagents(items: readonly Subagent[]): {
  running: SubagentRow[];
  finished: Subagent[];
} {
  const running = items
    .filter((item) => item.status === 'running')
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
  const ids = new Set(running.map((item) => item.id));
  const children = new Map<string, Subagent[]>();
  const roots: Subagent[] = [];
  for (const item of running) {
    if (item.parent_id && ids.has(item.parent_id) && item.parent_id !== item.id) {
      const list = children.get(item.parent_id) ?? [];
      list.push(item);
      children.set(item.parent_id, list);
    } else {
      roots.push(item);
    }
  }
  const rows: SubagentRow[] = [];
  const seen = new Set<string>();
  const walk = (item: Subagent, indent: number) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    rows.push({ subagent: item, indent });
    for (const child of children.get(item.id) ?? []) walk(child, indent + 1);
  };
  for (const root of roots) walk(root, root.parent_id ? Math.max(0, root.depth) : 0);
  const finished = items
    .filter((item) => item.status !== 'running')
    .sort((a, b) => (b.finished_at ?? b.started_at).localeCompare(a.finished_at ?? a.started_at));
  return { running: rows, finished };
}

/** How long it ran, or has been running up to `now`. */
export function elapsedMs(
  item: { started_at: string | null; finished_at: string | null },
  now: number,
): number | null {
  if (!item.started_at) return null;
  const start = Date.parse(item.started_at);
  const end = item.finished_at ? Date.parse(item.finished_at) : now;
  return Math.max(0, end - start);
}

/** `1:05`, `12:40`, `1:02:03` — a clock, the same in both languages' digits. */
export function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`;
}
