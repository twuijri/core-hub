/**
 * What the two live Settings tools share: whether the tab is on screen (both stop asking
 * the hub while it is hidden), the sparkline's geometry, and the Logs screen's pure rules —
 * appending a tail without duplicates, and the text a download saves.
 */
import { useEffect, useState } from 'react';

/** True while the document is visible; the tools poll only then. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden',
  );
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}

/**
 * The points of a sparkline in a `width` × `height` box: oldest at the start, newest at the
 * end, a missing value leaving a gap. `max` fixes the top (100 for a percentage); without
 * it the highest value is the top. Returns one polyline per unbroken run.
 */
export function sparklineRuns(
  values: ReadonlyArray<number | null>,
  width: number,
  height: number,
  max?: number,
): string[] {
  const known = values.filter((value): value is number => value !== null);
  if (known.length === 0) return [];
  const top = max ?? Math.max(...known);
  const scale = top > 0 ? top : 1;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const runs: string[] = [];
  let current: string[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 0) runs.push(current.join(' '));
      current = [];
      return;
    }
    const x = values.length > 1 ? index * step : width;
    const y = height - (Math.min(value, scale) / scale) * height;
    current.push(`${round(x)},${round(y)}`);
  });
  if (current.length > 0) runs.push(current.join(' '));
  return runs;
}

const round = (value: number) => Math.round(value * 10) / 10;

export interface LogLine {
  seq: number;
  at: string;
  level: 'error' | 'warn' | 'info' | 'debug';
  source: 'hub' | 'hermes';
  profile: string | null;
  message: string;
}

/** Adds a tail to what is shown: no line twice, oldest first, the newest `limit` kept. */
export function appendTail(
  shown: readonly LogLine[],
  tail: readonly LogLine[],
  limit: number,
): LogLine[] {
  const last = shown.at(-1)?.seq ?? 0;
  const merged = [...shown, ...tail.filter((line) => line.seq > last)];
  return merged.length > limit ? merged.slice(merged.length - limit) : merged;
}

/** One line of a downloaded log: time, level, where it came from, what it said. */
export function logText(lines: readonly LogLine[]): string {
  return lines
    .map((line) => {
      const where = line.source === 'hub' ? 'hub' : `hermes/${line.profile ?? 'default'}`;
      return `${line.at} ${line.level.toUpperCase().padEnd(5)} [${where}] ${line.message}`;
    })
    .join('\n')
    .concat(lines.length > 0 ? '\n' : '');
}

/** Saves `text` as a file through a temporary link. */
export function saveText(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}
