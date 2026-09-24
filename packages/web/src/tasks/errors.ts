/**
 * The board's own refusals, in the person's language — and Hermes's, in Hermes's words.
 * Hermes answers in the language it speaks; the hub passes the sentence on unchanged rather
 * than guessing at a translation of it.
 */
import { HubApiError } from '@majlis/contracts';
import { describeError } from '../auth/client.js';

export function describeTaskError(
  error: unknown,
  t: (key: string, p?: Record<string, string | number>) => string,
): string {
  if (error instanceof HubApiError) {
    const details = (error.body as { details?: { reason?: string; message?: string } } | undefined)
      ?.details;
    if (details?.reason === 'hermes_refused')
      return t('tasks.hermes.refused', { message: details.message ?? '' });
    if (details?.reason === 'hermes_owns_text') return t('tasks.hermes.owns_text');
    if (details?.reason === 'hermes_owns_card') return t('tasks.hermes.owns_card');
    if (details?.reason === 'hermes_api_unavailable')
      return t('tasks.hermes.api_unavailable', { message: details.message ?? '' });
  }
  return describeError(error, t);
}
