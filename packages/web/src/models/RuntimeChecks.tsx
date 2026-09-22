/**
 * "I added a provider — did anything happen?"
 *
 * The hub writes a provider into the agent runtime's own files and restarts it
 * (ADR 0010). Every step of that used to be invisible: if one of them did not happen,
 * the only sign was a run failing later in the runtime's own words. This is that
 * sequence, shown as four checks, from `models.getRuntime`.
 *
 * It renders in two places and says the same thing in both: under the provider list on
 * the Models screen, and inside the chat notice when a run failed for want of a
 * provider. One source, so the screen cannot disagree with the failure.
 */
import { useI18n } from '../i18n/context.js';
import type { RuntimeCheck, RuntimeReport } from '../types.js';

/** The order the steps actually happen in, which is the order to read them in. */
const ORDER: RuntimeCheck['id'][] = [
  'runtime_writable',
  'provider_keys',
  'provider_verified',
  'model_selected',
  'gateway_reloaded',
];

export function sortChecks(checks: readonly RuntimeCheck[] | undefined): RuntimeCheck[] {
  // A client never crashes on a payload it did not expect: a report with no checks is an
  // empty strip, which reads as "nothing to say", not as a blank screen.
  if (!Array.isArray(checks)) return [];
  return [...checks].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
}

export function failingChecks(report: RuntimeReport | undefined): RuntimeCheck[] {
  return report ? sortChecks(report.checks).filter((check) => !check.ok) : [];
}

export function RuntimeChecks({
  report,
  only = 'all',
}: {
  report: RuntimeReport;
  /** `failing` is the chat notice: the person is already looking at a failure. */
  only?: 'all' | 'failing';
}) {
  const { t } = useI18n();
  const checks = only === 'failing' ? failingChecks(report) : sortChecks(report.checks);
  if (checks.length === 0) return null;
  return (
    <ul className="space-y-1 text-sm" data-testid="runtime-checks" data-ready={report.ready}>
      {checks.map((check) => (
        <li key={check.id} className="flex items-center gap-2" data-check-id={check.id}>
          <span aria-hidden="true">{check.ok ? '✓' : '✕'}</span>
          <span className={check.ok ? '' : 'font-medium'}>
            {t(check.ok ? `models.runtime.${check.id}.ok` : `models.runtime.${check.id}.missing`)}
          </span>
          {/* The server's `detail` is a fact, never a sentence: a count, a slug, a mode.
              It is shown next to our wording, never instead of it. */}
          {check.detail && <span className="text-xs text-muted">{check.detail}</span>}
        </li>
      ))}
    </ul>
  );
}
