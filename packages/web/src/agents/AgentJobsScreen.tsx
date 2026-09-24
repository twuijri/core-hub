/**
 * An agent's jobs: what runs on its own for this agent, in the selected profile.
 *
 * **For Hermes, a job is a job in Hermes's own scheduler** (its cron: a prompt on a schedule,
 * run by Hermes itself). The Schedules page already shows those beside every other schedule of
 * every profile; this page is the same list narrowed to one agent and one profile, read from
 * the same place (`schedules.list`), so the two can never disagree. It runs a job now, pauses
 * or resumes it, and deletes it; making or editing one happens on the Schedules page, which
 * this page links to rather than repeating its form. Hermes has no other kind of job it
 * exposes: its background processes live and die inside a conversation.
 */
import { Link, useParams } from 'react-router';
import { useState } from 'react';
import { HubApiError } from '@majlis/contracts';
import { describeError } from '../auth/client.js';
import { useAgents } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { routeOf } from '../navigation/manifest.js';
import { AppShell } from '../shell/AppShell.js';
import {
  Badge,
  Button,
  EmptyState,
  Notice,
  Skeleton,
  SkeletonGroup,
  Switch,
  useConfirm,
} from '../ui/index.js';
import { IconSchedules, IconTrash } from '../ui/icons.js';
import { useAgentJobEvents, useAgentJobWrite, useAgentJobs, type AgentJob } from './plugins.js';

type Translate = (key: string, p?: Record<string, string | number>) => string;

/** Hermes's refusal in Hermes's words; the rest as every screen says it. */
function describeJobError(error: unknown, t: Translate): string {
  const details =
    error instanceof HubApiError
      ? (error.body as { details?: { reason?: string; message?: string } } | undefined)?.details
      : undefined;
  if (details?.reason === 'hermes_refused') {
    return t('schedules.hermes.refused', { message: details.message ?? '' });
  }
  if (details?.reason === 'hermes_unreachable') return t('schedules.hermes.unreachable');
  return describeError(error, t);
}

export function AgentJobsScreen() {
  const { t, language } = useI18n();
  const { agentId } = useParams<{ agentId: string }>();
  const agents = useAgents();
  const jobs = useAgentJobs(agentId);
  useAgentJobEvents();
  const { pause, run, remove } = useAgentJobWrite();
  const { ask, dialog } = useConfirm();
  const [fired, setFired] = useState<string | null>(null);

  const agent = agents.data?.find((entry) => entry.id === agentId);
  const title = agent ? t('agent_jobs.title_of', { name: agent.name }) : t('nav.jobs');
  const items = jobs.data?.items ?? [];
  const when = (at: string | null) =>
    at
      ? new Intl.DateTimeFormat(language === 'ar' ? 'ar' : 'en', {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(Date.parse(at))
      : t('schedules.never');
  const scheduleOf = (job: AgentJob) =>
    job.trigger.kind === 'cron'
      ? `${job.trigger.expression ?? ''} · ${job.trigger.timezone}`
      : job.trigger.kind === 'interval'
        ? t('schedules.every', { minutes: job.trigger.every_minutes ?? 0 })
        : when(job.trigger.run_at);
  const failure = pause.error ?? run.error ?? remove.error;

  return (
    <AppShell title={title}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{title}</h1>
          {items.length > 0 && <Badge>{String(items.length)}</Badge>}
          <Link
            className="ms-auto text-sm font-medium text-accent hover:underline"
            to={routeOf('schedules')}
            data-testid="agent-jobs-schedules"
          >
            {t('agent_jobs.open_schedules')}
          </Link>
        </div>
        <p className="text-xs text-muted">{t('agent_jobs.note')}</p>

        {jobs.isPending && (
          <SkeletonGroup label={t('common.loading')}>
            <Skeleton height="4.5rem" radius="md" />
            <Skeleton height="4.5rem" radius="md" />
          </SkeletonGroup>
        )}
        {jobs.isError && <Notice tone="danger">{describeError(jobs.error, t)}</Notice>}
        {(pause.isError || run.isError || remove.isError) && (
          <Notice tone="danger">
            <span data-testid="agent-jobs-error" dir="auto">
              {describeJobError(failure, t)}
            </span>
          </Notice>
        )}
        {fired && (
          <Notice tone="success">
            <span data-testid="agent-jobs-fired">{t('schedules.hermes.fired')}</span>
          </Notice>
        )}
        {jobs.data && items.length === 0 && (
          <EmptyState
            icon={<IconSchedules size={20} />}
            title={t('agent_jobs.none')}
            body={t('agent_jobs.none_body')}
          />
        )}

        <ul className="flex flex-col gap-2" data-testid="agent-jobs">
          {items.map((job) => {
            const fromHermes = job.external?.source === 'hermes';
            return (
              <li key={job.id}>
                <div
                  className="skill-row"
                  data-enabled={job.enabled || undefined}
                  data-testid="agent-job"
                  data-job={job.name}
                >
                  <Switch
                    checked={job.enabled}
                    label={t('agent_jobs.active')}
                    labelHidden
                    testId={`agent-job-enabled-${job.id}`}
                    onChange={(next) => pause.mutate({ job, enabled: next })}
                  />
                  <span className="skill-open skill-static">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium" dir="auto">
                        {job.name}
                      </span>
                      <Badge tone={job.state === 'scheduled' ? 'accent' : 'neutral'}>
                        {t(`schedules.state.${job.state}`)}
                      </Badge>
                      {fromHermes && <Badge>{t('agent_jobs.in_hermes')}</Badge>}
                    </span>
                    <span className="skill-description" dir="auto">
                      {scheduleOf(job)} · {t('schedules.next', { at: when(job.next_run_at) })}
                    </span>
                    {job.target.prompt && (
                      <span className="skill-description" dir="auto">
                        {job.target.prompt}
                      </span>
                    )}
                    {job.last_error && (
                      <span className="text-xs text-danger-soft-text" dir="auto">
                        {t('schedules.last_error', { error: job.last_error })}
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-1">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!fromHermes}
                      {...(fromHermes ? {} : { tooltip: t('schedules.run_unavailable') })}
                      loading={run.isPending && run.variables?.id === job.id}
                      onClick={() => run.mutate(job, { onSuccess: () => setFired(job.id) })}
                      data-testid={`agent-job-run-${job.id}`}
                    >
                      {t('schedules.run_now')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      tooltip={t('common.delete')}
                      aria-label={t('common.delete')}
                      icon={<IconTrash size={14} />}
                      onClick={() => {
                        void ask({
                          title: t('schedules.confirm_delete', { name: job.name }),
                          ...(fromHermes ? { body: t('agent_jobs.delete_body') } : {}),
                          confirmLabel: t('common.delete'),
                        }).then((sure) => {
                          if (sure) remove.mutate(job);
                        });
                      }}
                      data-testid={`agent-job-delete-${job.id}`}
                    />
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      {dialog}
    </AppShell>
  );
}
