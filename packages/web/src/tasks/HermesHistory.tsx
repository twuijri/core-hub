/**
 * A Hermes card's own history (contract decision §103), read from Hermes when the card opens:
 * each attempt Hermes's dispatcher made at it, and what happened on it, newest first.
 *
 * The words are Hermes's. An event or a run state this client knows is named in the person's
 * language; one it does not know yet is shown as Hermes wrote it, never hidden.
 */
import { exactTime } from '../devices/format.js';
import { useI18n } from '../i18n/context.js';
import { Badge, type BadgeTone } from '../ui/index.js';
import type { HermesCardEvent, HermesCardRun } from './queries.js';

/** The events this client names; any other kind is shown as Hermes's own word. */
const KNOWN_EVENTS = new Set([
  'created',
  'assigned',
  'claimed',
  'spawned',
  'heartbeat',
  'completed',
  'blocked',
  'unblocked',
  'commented',
  'edited',
  'reprioritized',
  'status',
  'archived',
  'reclaimed',
  'timed_out',
  'review_requested',
  'review_reopened',
  'changes_requested',
  'scheduled',
  'promoted',
  'promoted_manual',
  'gave_up',
  'attached',
  'linked',
  'unlinked',
  'specified',
]);
const KNOWN_RUNS = new Set([
  'running',
  'done',
  'completed',
  'blocked',
  'review',
  'review_requested',
  'reclaimed',
  'crashed',
  'timed_out',
  'scheduled',
  'changes_requested',
]);

const RUN_TONE: Record<string, BadgeTone> = {
  running: 'success',
  done: 'success',
  completed: 'success',
  blocked: 'danger',
  crashed: 'danger',
  timed_out: 'danger',
  reclaimed: 'warning',
  scheduled: 'warning',
};

export function HermesHistory({
  history,
}: {
  history: { events: HermesCardEvent[]; runs: HermesCardRun[] };
}) {
  const { t, language } = useI18n();
  const eventWord = (kind: string) =>
    KNOWN_EVENTS.has(kind) ? t(`tasks.hermes.history.event.${kind}`) : kind;
  const runWord = (state: string) =>
    KNOWN_RUNS.has(state) ? t(`tasks.hermes.history.run.${state}`) : state;
  return (
    <section
      aria-label={t('tasks.hermes.history.title')}
      className="flex flex-col gap-2"
      data-testid="task-hermes-history"
    >
      <h3 className="text-sm font-medium">{t('tasks.hermes.history.title')}</h3>
      <h4 className="text-xs text-muted">{t('tasks.hermes.history.runs')}</h4>
      {history.runs.length === 0 ? (
        <p className="text-xs text-muted">{t('tasks.hermes.history.no_runs')}</p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="task-hermes-runs">
          {history.runs.map((run) => {
            const state = run.outcome ?? run.status;
            return (
              <li key={run.id} className="task-comment" data-testid="task-hermes-run">
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <Badge tone={RUN_TONE[state] ?? 'neutral'}>{runWord(state)}</Badge>
                  {run.profile && <span dir="auto">{run.profile}</span>}
                  <time dateTime={run.started_at}>{exactTime(run.started_at, language)}</time>
                </span>
                {run.summary && (
                  <p className="text-sm whitespace-pre-wrap" dir="auto">
                    {run.summary}
                  </p>
                )}
                {run.error && (
                  <p className="text-sm whitespace-pre-wrap text-danger-soft-text" dir="auto">
                    {run.error}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <h4 className="text-xs text-muted">{t('tasks.hermes.history.events')}</h4>
      {history.events.length === 0 ? (
        <p className="text-xs text-muted">{t('tasks.hermes.history.no_events')}</p>
      ) : (
        <ol className="flex flex-col gap-1" data-testid="task-hermes-events">
          {history.events.map((event) => (
            <li
              key={event.id}
              className="flex flex-wrap items-center gap-2 text-sm"
              data-testid="task-hermes-event"
              data-kind={event.kind}
            >
              <span dir="auto">{eventWord(event.kind)}</span>
              {event.run_id !== null && (
                <span className="text-xs text-muted">
                  {t('tasks.hermes.history.attempt', { id: event.run_id })}
                </span>
              )}
              <time className="text-xs text-muted" dateTime={event.created_at}>
                {exactTime(event.created_at, language)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
