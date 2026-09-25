/**
 * What a failed run says to the person.
 *
 * Two shapes, decided by the envelope's `code` and nothing else:
 *
 * - `provider_not_configured` — the one failure the hub knows the way out of. Our own
 *   sentence and a link straight to Settings → Models → Defaults come first, and the
 *   agent's own words stay underneath. They are never replaced and never hidden: they are
 *   what says *which* provider refused, and a person who reads them can act on them even
 *   when our guess about the cause is wrong.
 * - everything else — the existing one line, the agent's message with its code.
 *
 * A component of its own because the choice between them is the whole point of the
 * change of 2026-09-22 and deserves a test that does not have to boot a chat screen.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useI18n } from '../i18n/context.js';
import { RuntimeChecks } from '../models/RuntimeChecks.js';
import { routeOf } from '../navigation/manifest.js';
import type { Message, Run, RuntimeReport } from '../types.js';
import { Button } from '../ui/index.js';
import { IconClose } from '../ui/icons.js';
import { Notice } from '../ui/Notice.js';
import { sideOf } from './turns.js';
import { textOf } from './transcript.js';

export interface RunFailure {
  code: string;
  error: string;
}

/** The Defaults tab of the Models screen, by name — no client invents a path. */
export const DEFAULTS_ROUTE = `${routeOf('models')}?tab=auxiliary`;

/**
 * Which message each failed run's notice hangs under (owner, 2026-09-25: «الخطا يبتل ما
 * يروح» — a failure stayed above the composer after the next run had succeeded).
 *
 * A failure belongs to the turn that failed, never to the conversation: it is drawn under
 * that run's reply, or — when the run failed before the agent wrote anything — under the
 * person's message that started it. A later run, failed or not, leaves it where it is and
 * adds nothing near the composer. `runs` is every run known: the session's live ones and
 * its failed history (`sessions.listRuns?status=failed`), so a reload keeps it in place.
 *
 * A failed reply that already says something in the agent's own words needs no second
 * line — except `provider_not_configured`, whose way out the agent's text never gives.
 */
export function failuresByMessage(
  messages: readonly Message[],
  runs: Iterable<Run>,
): Map<string, { runId: string; failure: RunFailure }> {
  const out = new Map<string, { runId: string; failure: RunFailure }>();
  for (const run of runs) {
    if (run.status !== 'failed' || !run.error) continue;
    const reply = messages.findLast(
      (m) => sideOf(m) === 'agent' && (m.id === run.output_message_id || m.run_id === run.id),
    );
    const target =
      reply ??
      messages.findLast(
        (m) => sideOf(m) === 'user' && (m.id === run.input_message_id || m.run_id === run.id),
      );
    // Not in the transcript held (an older page): nothing is drawn, and nothing elsewhere.
    if (!target) continue;
    const { code, error } = run.error;
    if (code !== 'provider_not_configured' && reply && textOf(reply).trim() !== '') continue;
    out.set(target.id, { runId: run.id, failure: { code, error } });
  }
  return out;
}

export function RunFailureNotice({
  failure,
  runtime,
  onDismiss,
}: {
  failure: RunFailure;
  /**
   * Which step of propagation is missing, read now rather than remembered from when the
   * run failed — the person may already have fixed half of it in another tab. Passed in
   * rather than fetched here so this component stays a pure rendering of one decision.
   */
  runtime?: RuntimeReport | undefined;
  /** Hides it in this view; the failed turn shows it again after a reload. */
  onDismiss?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const dismiss: ReactNode = onDismiss ? (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      className="float-end -me-1 -mt-0.5"
      aria-label={t('ui.dismiss')}
      tooltip={t('ui.dismiss')}
      icon={<IconClose size={14} />}
      onClick={onDismiss}
      data-testid="run-failed-dismiss"
    />
  ) : null;
  if (failure.code !== 'provider_not_configured') {
    return (
      <Notice tone="danger" className="run-failure">
        {dismiss}
        {t('chat.run_failed', { error: failure.error, code: failure.code })}
      </Notice>
    );
  }
  return (
    <Notice tone="danger" className="run-failure space-y-1">
      {dismiss}
      <p data-testid="run-failed-reason">{t('chat.no_provider')}</p>
      <p>
        <Link to={DEFAULTS_ROUTE} className="link underline" data-testid="run-failed-action">
          {t('chat.no_provider_action')}
        </Link>
      </p>
      {runtime && <RuntimeChecks report={runtime} only="failing" />}
      <p className="text-xs opacity-80" data-testid="run-failed-detail">
        {failure.error}
      </p>
    </Notice>
  );
}
