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

/**
 * What the hub's model gateway is doing, in words (DECISIONS §148): waiting out a provider's
 * refusal, or trying the chain's next model. `null` when it is doing nothing to tell.
 */
export function modelStatusWords(
  progress: Pick<RunProgress, 'modelStatus'>,
  t: (key: string, values?: Record<string, string | number>) => string,
  nowMs: number,
): string | null {
  const status = progress.modelStatus;
  if (!status) return null;
  const model = status.provider ? `${status.provider} · ${status.model}` : status.model;
  if (status.phase === 'trying') return t('chat.model_status.trying', { model });
  const left =
    status.seconds === null
      ? null
      : Math.max(0, Math.ceil(status.seconds - (nowMs - status.atMs) / 1000));
  const key = status.reason === 'no_capacity' ? 'waiting_capacity' : 'waiting_limit';
  return left === null || left === 0
    ? t(`chat.model_status.${key}_now`, { model })
    : t(`chat.model_status.${key}`, { model, seconds: left });
}

export function RunStatus({ progress }: { progress: RunProgress }) {
  const { t } = useI18n();
  const seconds = useElapsedSeconds(progress.startedAtMs, true);
  const word = progress.queued ? t('chat.queued') : t('chat.thinking');
  // Re-read each second with the clock above, so a wait counts down.
  const gateway = modelStatusWords(progress, t, Date.now());
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
      {gateway !== null && progress.step === null && (
        <span className="run-status-step" data-testid="run-model-status" dir="auto" role="status">
          {gateway}
        </span>
      )}
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
