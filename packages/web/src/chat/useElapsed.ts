/**
 * Seconds since something began, ticking once a second.
 *
 * The point of the thinking indicator is that the person can see the agent is alive *and*
 * how long it has been — a spinner alone cannot tell the two apart (owner decision,
 * 2026-09-22). So this is deliberately not suppressed under `prefers-reduced-motion`: the
 * dots stop moving, the count keeps counting, because the count is information.
 *
 * When the hub has not told us when the run started (`started_at` is still null on a
 * queued run) the clock starts at the moment this screen first saw it, which is the
 * honest answer to "how long have I been waiting".
 */
import { useEffect, useRef, useState } from 'react';

export function useElapsedSeconds(startedAtMs: number | null, active: boolean): number {
  const fallback = useRef<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  if (active && fallback.current === null) fallback.current = Date.now();
  if (!active && fallback.current !== null) fallback.current = null;

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  if (!active) return 0;
  const start = startedAtMs ?? fallback.current ?? now;
  return Math.max(0, Math.floor((now - start) / 1000));
}
