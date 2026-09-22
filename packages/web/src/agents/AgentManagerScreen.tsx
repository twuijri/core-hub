// The Agent Manager: one card per agent in the catalog, with its health, its capabilities
// and the one action it can take right now.
//
// Assembled from the kit (`src/ui/`): the card, its header with the avatar, the status
// badge, the capability badges, the buttons and the empty state all come from there, so
// this screen decides *what* is on it and nothing about how a card is painted.
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
import { SettingsBack } from '../settings/SettingsBack.js';
import type { Agent, Job } from '../types.js';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardFooter,
  CardHeader,
  EmptyState,
  Notice,
  Separator,
  Skeleton,
  SkeletonGroup,
  type BadgeTone,
} from '../ui/index.js';
import { IconAgents } from '../ui/icons.js';
import { useJobs } from './useJobs.js';

/** A capability's label, falling back to the raw name the catalog declared. */
function capabilityLabel(t: Translator, capability: string): string {
  const key = `agents.capability.${capability}`;
  const label = t(key);
  return label === key ? capability : label;
}

const STATUS_TONE: Record<Agent['status'], BadgeTone> = {
  available: 'success',
  not_installed: 'neutral',
  installing: 'info',
  updating: 'info',
  error: 'danger',
  limited: 'warning',
  disabled: 'neutral',
};

export function AgentManagerScreen() {
  const { t } = useI18n();
  const agents = useAgents();
  const jobs = useJobs();
  const title = t(termKey('agent_manager'));
  return (
    <AppShell title={title} wide>
      <SettingsBack />
      <h1 className="sr-only">{title}</h1>
      {agents.isPending && (
        <SkeletonGroup label={t('common.loading')}>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height="11rem" radius="md" />
            ))}
          </div>
        </SkeletonGroup>
      )}
      {agents.isError && <Notice tone="danger">{describeError(agents.error, t)}</Notice>}
      {agents.data && agents.data.length === 0 && (
        <EmptyState icon={<IconAgents size={20} />} title={t('agents.empty')} />
      )}
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
    <Card
      as="article"
      tone="raised"
      testId="agent-card"
      className="agent-card"
      data-agent-slug={agent.slug}
    >
      <CardHeader
        title={agent.name}
        subtitle={`${agent.vendor ?? '—'} · ${agent.kind}${agent.install.version ? ` · ${agent.install.version}` : ''}`}
        media={<Avatar name={agent.name} size="md" />}
        actions={
          <Badge tone={STATUS_TONE[agent.status] ?? 'neutral'} dot={running}>
            {t(`agents.status.${agent.status}`)}
          </Badge>
        }
      />
      {agent.limited && <Notice tone="warning">{t('agents.limited')}</Notice>}
      {agent.runtime.error && <Notice tone="danger">{agent.runtime.error}</Notice>}
      {agent.install.error && <Notice tone="danger">{agent.install.error}</Notice>}
      <ul className="flex flex-wrap gap-1">
        {agent.capabilities.map((c) => (
          <li key={c}>
            <Badge>{capabilityLabel(t, c)}</Badge>
          </li>
        ))}
      </ul>
      {job && (
        <div aria-live="polite" data-testid="job-progress">
          <div className="agent-progress">
            <div
              className="agent-progress-bar"
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
      <CardFooter>
        {agent.kind === 'hermes' ? (
          <Button disabled={running} onClick={() => void act('restart')}>
            {t('agents.restart')}
          </Button>
        ) : installed && managed ? (
          <Button variant="danger" disabled={running} onClick={() => void act('uninstall')}>
            {t('agents.remove')}
          </Button>
        ) : !installed ? (
          <Button
            variant="primary"
            disabled={running}
            onClick={() => void act('install')}
            data-testid="install"
          >
            {t('agents.install')}
          </Button>
        ) : null}
        {agent.install.update_available && (
          <Badge tone="info">
            {t('agents.update_available', { version: agent.install.latest_version ?? '' })}
          </Badge>
        )}
      </CardFooter>
      {menu.length > 0 && (
        <>
          <Separator />
          <nav
            aria-label={t('agents.under_agent')}
            className="flex flex-wrap gap-1"
            data-testid="agent-menu"
          >
            {menu.map((d) => (
              <Link
                key={d.id}
                to={routeOf(d.id).replace(':agentId', agent.id)}
                className="agent-menu-link"
                data-nav-id={d.id}
              >
                {t(termKey(d.id))}
              </Link>
            ))}
          </nav>
        </>
      )}
    </Card>
  );
}
