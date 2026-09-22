/**
 * The live thinking indicator, above the composer.
 *
 * Owner decision, 2026-09-22: while a run is alive, reasoning is a *state*, not prose.
 * The old text fold read as the agent writing an essay about itself; this reads as a
 * machine that is working. It says three things at once, and never fewer:
 *
 *   ●●●  Thinking · 12s · shell
 *   └ alive   └ what   └ how long   └ the step, when the agent reports one
 *
 * "Never a spinner with no elapsed time" is the whole point: a spinner cannot tell a
 * person whether the agent is thinking or stuck. `prefers-reduced-motion` stops the dots
 * and keeps the seconds (styles/chat.css).
 *
 * `role="status"` with `aria-live="polite"`, and the seconds are *not* announced on every
 * tick — only the word and the step are in the live region, so a screen reader is not
 * read a number once a second.
 */
import { useI18n } from '../i18n/context.js';
import { useElapsedSeconds } from './useElapsed.js';
import type { RunProgress } from './turns.js';

export function RunStatus({ progress }: { progress: RunProgress }) {
  const { t } = useI18n();
  const seconds = useElapsedSeconds(progress.startedAtMs, true);
  const word = progress.queued ? t('chat.queued') : t('chat.thinking');
  return (
    <div className="run-status" data-testid="run-status" data-step={progress.step ?? undefined}>
      <span className="run-dots" aria-hidden>
        <span className="run-dot" />
        <span className="run-dot" />
        <span className="run-dot" />
      </span>
      <span className="run-status-word" role="status">
        {word}
      </span>
      {/* The clock is written out, not announced: `aria-hidden` here, and the same
          duration is said once in the summary when the run ends. */}
      <span className="run-status-time" data-testid="run-elapsed" aria-hidden>
        {t('chat.seconds', { seconds })}
      </span>
      {progress.step !== null && (
        <span
          className="run-status-step"
          data-mono={progress.stepIsIdentifier ? 'true' : undefined}
          data-testid="run-step"
          dir="auto"
        >
          {progress.step}
        </span>
      )}
    </div>
  );
}
