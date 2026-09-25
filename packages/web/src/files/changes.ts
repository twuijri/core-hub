/**
 * The files each run changed (contract `sessions.listChanges` / `getRunChangeDiff`, decision
 * §49), for drawing: which reply carries a run's card, a diff's tab key, and the unified diff
 * the hub recorded, read into lines with their numbers — one column, or two side by side.
 */

/** A diff opens as a tab of the file panel, beside the files themselves. */
const DIFF_PREFIX = 'diff:';

export function diffKey(runId: string, path: string): string {
  return `${DIFF_PREFIX}${runId}:${path}`;
}

export function parseDiffKey(key: string): { runId: string; path: string } | null {
  if (!key.startsWith(DIFF_PREFIX)) return null;
  const rest = key.slice(DIFF_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon <= 0) return null;
  return { runId: rest.slice(0, colon), path: rest.slice(colon + 1) };
}

/**
 * The reply each run's card is drawn under: the last agent message of the run, so a run that
 * spoke twice shows it once, at its end.
 */
export function lastReplyOfRuns(
  messages: ReadonlyArray<{ id: string; role: string; run_id?: string | null }>,
): Map<string, string> {
  const last = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.run_id) continue;
    last.set(message.run_id, message.id);
  }
  return last;
}

/** Which of `sessions.listChanges`' answers is still current: a run ended since. */
export function changesRevisionOf(runs: Readonly<Record<string, { status: string }>>): string {
  return Object.entries(runs)
    .filter(([, run]) => ['succeeded', 'failed', 'cancelled'].includes(run.status))
    .map(([id]) => id)
    .sort()
    .join(',');
}

export type DiffLineKind = 'context' | 'add' | 'del' | 'note';

export interface DiffLine {
  kind: DiffLineKind;
  /** The line's number before the run (context and removed lines). */
  old: number | null;
  /** Its number after the run (context and added lines). */
  new: number | null;
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/** The hunks of a unified diff, each line with its old and new number. */
export function parseUnifiedDiff(text: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    const header = HUNK.exec(line);
    if (header) {
      current = { header: line, lines: [] };
      hunks.push(current);
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    if (!current) continue;
    const sign = line[0];
    const body = line.slice(1);
    if (sign === '+') {
      current.lines.push({ kind: 'add', old: null, new: newLine, text: body });
      newLine += 1;
    } else if (sign === '-') {
      current.lines.push({ kind: 'del', old: oldLine, new: null, text: body });
      oldLine += 1;
    } else if (sign === '\\') {
      current.lines.push({ kind: 'note', old: null, new: null, text: line.slice(2) });
    } else {
      current.lines.push({ kind: 'context', old: oldLine, new: newLine, text: body });
      oldLine += 1;
      newLine += 1;
    }
  }
  return hunks;
}

export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/**
 * A hunk as two columns: context on both sides, and each run of removed lines paired with the
 * added lines that follow it, row by row, the shorter side padded with empty cells.
 */
export function splitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  const lines = hunk.lines.filter((line) => line.kind !== 'note');
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (line.kind === 'context') {
      rows.push({ left: line, right: line });
      i += 1;
      continue;
    }
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (i < lines.length && lines[i]!.kind === 'del') removed.push(lines[i++]!);
    while (i < lines.length && lines[i]!.kind === 'add') added.push(lines[i++]!);
    for (let r = 0; r < Math.max(removed.length, added.length); r += 1) {
      rows.push({ left: removed[r] ?? null, right: added[r] ?? null });
    }
  }
  return rows;
}

/** The plural category a count takes in a language (Arabic has six). */
export function pluralOf(language: string, count: number): Intl.LDMLPluralRule {
  return new Intl.PluralRules(language).select(count);
}
