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
import { Link } from 'react-router';
import { useI18n } from '../i18n/context.js';
import { routeOf } from '../navigation/manifest.js';
import { Notice } from '../ui/Notice.js';

export interface RunFailure {
  code: string;
  error: string;
}

/** The Defaults tab of the Models screen, by name — no client invents a path. */
export const DEFAULTS_ROUTE = `${routeOf('models')}?tab=auxiliary`;

export function RunFailureNotice({ failure }: { failure: RunFailure }) {
  const { t } = useI18n();
  if (failure.code !== 'provider_not_configured') {
    return (
      <Notice tone="danger">
        {t('chat.run_failed', { error: failure.error, code: failure.code })}
      </Notice>
    );
  }
  return (
    <Notice tone="danger" className="space-y-1">
      <p data-testid="run-failed-reason">{t('chat.no_provider')}</p>
      <p>
        <Link to={DEFAULTS_ROUTE} className="link underline" data-testid="run-failed-action">
          {t('chat.no_provider_action')}
        </Link>
      </p>
      <p className="text-xs opacity-80" data-testid="run-failed-detail">
        {failure.error}
      </p>
    </Notice>
  );
}
