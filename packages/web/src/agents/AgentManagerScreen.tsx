import type { Translator } from '../i18n/index.js';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { useAgents } from '../hub/queries.js';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { agentMenu, routeOf, termKey } from '../navigation/manifest.js';
import { AppShell } from '../shell/AppShell.js';
import type { Agent, Job } from '../types.js';
import { Notice, Spinner } from '../ui/Notice.js';
import { useJobs } from './useJobs.js';

/** A capability's label, falling back to the raw name the catalog declared. */
function capabilityLabel(t: Translator, capability: string): string {
  const key = `agents.capability.${capability}`;
  const label = t(key);
  return label === key ? capability : label;
}

const STATUS_TONE: Record<Agent['status'], string> = {
  available: 'bg-success-soft text-success-soft-text',
  not_installed: '',
  installing: 'bg-info-soft text-info-soft-text',
  updating: 'bg-info-soft text-info-soft-text',
  error: 'bg-danger-soft text-danger-soft-text',
  limited: 'bg-warning-soft text-warning-soft-text',
  disabled: '',
};

export function AgentManagerScreen() {
  const { t } = useI18n();
  const agents = useAgents();
  const jobs = useJobs();
  const title = t(termKey('agent_manager'));
  return (
    <AppShell title={title} wide>
      <h1 className="sr-only">{title}</h1>
      {agents.isPending && <Spinner label={t('common.loading')} />}
      {agents.isError && <Notice tone="danger">{describeError(agents.error, t)}</Notice>}
      {agents.data && agents.data.length === 0 && <Notice>{t('agents.empty')}</Notice>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {agents.data?.map((agent) => (
          <AgentCard key={agent.id} agent={agent} jobs={jobs} />
        ))}
      </div>
    </AppShell>
  );
}

function AgentCard({ agent, jobs }: { agent: Agent; jobs: Record<string, Job> }) {
  const { t } = useI18n();
  const { client, user, profile } = useAuth();
  const queryClient = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const job = jobId ? jobs[jobId] : undefined;
  const running = job ? job.status === 'queued' || job.status === 'running' : false;
  const managed = agent.install.source === 'managed' || agent.install.source === 'none';
  const installed = agent.status !== 'not_installed' && agent.install.source !== 'none';

  const act = async (kind: 'install' | 'uninstall' | 'restart') => {
    setError(null);
    try {
      const params = { agent_id: agent.id };
      const { data } =
        kind === 'install'
          ? await client.request('post', '/agents/{agent_id}/install', { params })
          : kind === 'uninstall'
            ? await client.request('delete', '/agents/{agent_id}/install', { params })
            : await client.request('post', '/agents/{agent_id}/restart', { params });
      setJobId(data.job_id);
      void queryClient.invalidateQueries({ queryKey: ['agents', profile] });
    } catch (err) {
      setError(err);
    }
  };
  const menu = agentMenu(agent.capabilities, user?.role ?? 'member');

  return (
    <article
      className="card flex flex-col gap-2"
      data-testid="agent-card"
      data-agent-slug={agent.slug}
    >
      <header className="flex items-center gap-2">
        <span
          className="inline-grid size-9 place-items-center rounded-md bg-accent-soft text-accent-soft-text"
          aria-hidden
        >
          {agent.name.slice(0, 1)}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold" dir="auto">
            {agent.name}
          </h2>
          <p className="truncate text-xs text-muted">
            {agent.vendor ?? '—'} · {agent.kind}
            {agent.install.version ? ` · ${agent.install.version}` : ''}
          </p>
        </div>
        <span className={`chip ${STATUS_TONE[agent.status]}`}>
          {t(`agents.status.${agent.status}`)}
        </span>
      </header>
      {agent.limited && <Notice tone="warning">{t('agents.limited')}</Notice>}
      {agent.runtime.error && <Notice tone="danger">{agent.runtime.error}</Notice>}
      {agent.install.error && <Notice tone="danger">{agent.install.error}</Notice>}
      <p className="flex flex-wrap gap-1">
        {agent.capabilities.map((c) => (
          <span key={c} className="chip">
            {capabilityLabel(t, c)}
          </span>
        ))}
      </p>
      {job && (
        <div aria-live="polite" data-testid="job-progress">
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full bg-accent transition-ui"
              style={{ inlineSize: `${job.progress.percent ?? (running ? 30 : 100)}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-muted">
            {t(`jobs.status.${job.status}`)}
            {job.progress.message ? ` · ${job.progress.message}` : ''}
            {job.error ? ` · ${job.error.error}` : ''}
          </p>
        </div>
      )}
      {error !== null && <Notice tone="danger">{describeError(error, t)}</Notice>}
      <div className="flex flex-wrap gap-2">
        {agent.kind === 'hermes' ? (
          <button
            type="button"
            className="btn"
            disabled={running}
            onClick={() => void act('restart')}
          >
            {t('agents.restart')}
          </button>
        ) : installed && managed ? (
          <button
            type="button"
            className="btn btn-danger"
            disabled={running}
            onClick={() => void act('uninstall')}
          >
            {t('agents.remove')}
          </button>
        ) : !installed ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={running}
            onClick={() => void act('install')}
            data-testid="install"
          >
            {t('agents.install')}
          </button>
        ) : null}
        {agent.install.update_available && (
          <span className="chip">
            {t('agents.update_available', { version: agent.install.latest_version ?? '' })}
          </span>
        )}
      </div>
      {menu.length > 0 && (
        <nav
          aria-label={t('agents.under_agent')}
          className="flex flex-wrap gap-1 border-t border-line pt-2 text-xs"
          data-testid="agent-menu"
        >
          {menu.map((d) => (
            <Link
              key={d.id}
              to={routeOf(d.id).replace(':agentId', agent.id)}
              className="chip hover:bg-surface-3"
              data-nav-id={d.id}
            >
              {t(termKey(d.id))}
            </Link>
          ))}
        </nav>
      )}
    </article>
  );
}
