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
import { useState } from 'react';
import { canRestart, useRestartAgent } from '../agents/useRestartAgent.js';
import { useAuth } from '../auth/context.js';
import { useAgents } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { Badge, Button } from '../ui/index.js';
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

/**
 * A check that is a thing to do, not a thing broken: the settings changed after Hermes last
 * started, and a restart applies them (owner, 2026-09-25 — the red ✕ read as a failure he
 * could not place). Amber, with its own words and the restart beside it on the Models screen.
 */
export const PENDING_RESTART: RuntimeCheck['id'] = 'gateway_reloaded';

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
      {checks.map((check) => {
        const warn = !check.ok && check.id === PENDING_RESTART;
        return (
          <li
            key={check.id}
            className={`flex items-center gap-2 ${warn ? 'text-warning-soft-text' : ''}`}
            data-check-id={check.id}
            data-tone={check.ok ? 'ok' : warn ? 'warning' : 'danger'}
          >
            <span aria-hidden="true">{check.ok ? '✓' : warn ? '⚠' : '✕'}</span>
            <span className={check.ok ? '' : 'font-medium'}>
              {t(check.ok ? `models.runtime.${check.id}.ok` : `models.runtime.${check.id}.missing`)}
            </span>
            {/* The server's `detail` is a fact, never a sentence: a count, a slug, a mode.
              It is shown next to our wording, never instead of it. */}
            {check.detail && <span className="text-xs text-muted">{check.detail}</span>}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The Runtime card on the Models screen.
 *
 * When every check passes there is nothing to read, so it is one line — «كل شيء يعمل» /
 * "Everything works" — with a toggle for whoever wants the list anyway (owner,
 * 2026-09-24). The moment a check fails it opens by itself and stays open: a failure is
 * the one thing this card exists to show, and it must not wait behind a click.
 */
export function RuntimeCard({ report }: { report: RuntimeReport }) {
  const { t } = useI18n();
  const checks = sortChecks(report.checks);
  const allOk = checks.length > 0 && checks.every((check) => check.ok);
  const [expanded, setExpanded] = useState(false);
  const open = !allOk || expanded;
  return (
    <section
      className="mb-4 rounded-md border border-line px-3 py-2"
      data-testid="runtime-report"
      data-collapsed={open ? undefined : 'true'}
      aria-label={t('models.runtime.title')}
    >
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium">{t('models.runtime.title')}</h2>
        {allOk && (
          <Badge tone="success" testId="runtime-all-ok">
            {t('models.runtime.all_ok')}
          </Badge>
        )}
        {allOk && (
          <Button
            className="ms-auto"
            size="sm"
            variant="ghost"
            aria-expanded={open}
            onClick={() => setExpanded((value) => !value)}
            data-testid="runtime-toggle"
          >
            {t(open ? 'models.runtime.hide' : 'models.runtime.show')}
          </Button>
        )}
      </div>
      {open && (
        <>
          <p className="mb-2 mt-1 text-xs text-muted">{t('models.runtime.hint')}</p>
          <RuntimeChecks report={report} />
          {report.checks.some((check) => check.id === PENDING_RESTART && !check.ok) && (
            <RestartNow />
          )}
        </>
      )}
    </section>
  );
}

/** «إعادة التشغيل الآن»: the one thing that clears a pending restart, for whoever may do it. */
function RestartNow() {
  const { t } = useI18n();
  const { user } = useAuth();
  const agents = useAgents();
  const hermes = agents.data?.find((agent) => agent.kind === 'hermes');
  const restarter = useRestartAgent(hermes?.id);
  if (!canRestart(hermes, user?.role)) return null;
  return (
    <Button
      className="mt-2"
      size="sm"
      variant="primary"
      loading={restarter.pending}
      aria-busy={restarter.pending}
      onClick={() => void restarter.restart()}
      data-testid="runtime-restart-now"
    >
      {t('models.runtime.restart_now')}
    </Button>
  );
}
