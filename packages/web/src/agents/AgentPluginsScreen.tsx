/**
 * An agent's plugins, in the selected profile, as Hermes itself lists them.
 *
 * **Hermes's words, not ours.** A plugin is `enabled` (on Hermes's allow list), `disabled` (on
 * its deny list, which wins) or `not enabled` (on neither: Hermes plugins are opt-in, so it
 * does not load). Hermes ships some (`bundled` — its kanban board is one) and a profile can
 * have more installed into it. The switch writes Hermes's lists in this profile only; Hermes
 * applies them in its next session.
 *
 * **Installing is Hermes's install.** A name from Hermes's curated catalog, a Git URL or
 * `owner/repo`: Hermes fetches it, scans it, refuses what its catalog withdrew, and installs it
 * switched off — turning it on is a second, deliberate step. It is a job, because a clone
 * takes as long as it takes. Only what was installed into the profile can be removed; what
 * Hermes ships is switched off instead.
 */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useAgents } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { AppShell } from '../shell/AppShell.js';
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Notice,
  Skeleton,
  SkeletonGroup,
  Switch,
  useConfirm,
} from '../ui/index.js';
import { IconTool, IconTrash } from '../ui/icons.js';
import type { Job } from '../types.js';
import {
  useInstallPlugin,
  usePlugins,
  useRefreshPlugins,
  useRemovePlugin,
  useSetPlugin,
  type AgentPlugin,
} from './plugins.js';
import { useJob } from './skills.js';
import { describeToolError } from './toolErrors.js';
import { useJobs } from './useJobs.js';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** The newer of what the socket said and what the last read said. */
function latest(a: Job | undefined, b: Job | undefined): Job | undefined {
  if (!a) return b;
  if (!b) return a;
  if (TERMINAL.has(a.status) !== TERMINAL.has(b.status)) return TERMINAL.has(a.status) ? a : b;
  return a.updated_at >= b.updated_at ? a : b;
}

export function AgentPluginsScreen() {
  const { t } = useI18n();
  const { agentId } = useParams<{ agentId: string }>();
  const agents = useAgents();
  const plugins = usePlugins(agentId);
  const setPlugin = useSetPlugin(agentId);
  const removePlugin = useRemovePlugin(agentId);

  const agent = agents.data?.find((entry) => entry.id === agentId);
  const title = agent ? t('agent_plugins.title_of', { name: agent.name }) : t('nav.plugins');
  const items = plugins.data?.items ?? [];
  const failure = setPlugin.error ?? removePlugin.error;

  return (
    <AppShell title={title}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{title}</h1>
          {items.length > 0 && <Badge>{String(items.length)}</Badge>}
        </div>
        <p className="text-xs text-muted">{t('agent_plugins.note')}</p>

        <InstallForm agentId={agentId} />

        {plugins.isPending && (
          <SkeletonGroup label={t('common.loading')}>
            <Skeleton height="4rem" radius="md" />
            <Skeleton height="4rem" radius="md" />
          </SkeletonGroup>
        )}
        {plugins.isError && (
          <Notice tone="danger">
            <span data-testid="agent-plugins-error">{describeToolError(plugins.error, t)}</span>
          </Notice>
        )}
        {(setPlugin.isError || removePlugin.isError) && (
          <Notice tone="danger">
            <span data-testid="agent-plugin-action-error" dir="auto">
              {describeToolError(failure, t)}
            </span>
          </Notice>
        )}
        {(plugins.data?.warnings ?? []).map((warning) => (
          <Notice key={warning} tone="warning">
            <span dir="auto">{warning}</span>
          </Notice>
        ))}
        {plugins.data && items.length === 0 && (
          <EmptyState
            icon={<IconTool size={20} />}
            title={t('agent_plugins.none')}
            body={t('agent_plugins.none_body')}
          />
        )}

        <ul className="flex flex-col gap-2" data-testid="agent-plugins">
          {items.map((plugin) => (
            <li key={plugin.key}>
              <PluginRow
                plugin={plugin}
                busy={
                  (setPlugin.isPending && setPlugin.variables?.key === plugin.key) ||
                  (removePlugin.isPending && removePlugin.variables === plugin.key)
                }
                onSwitch={(enabled) => setPlugin.mutate({ key: plugin.key, enabled })}
                onRemove={() => removePlugin.mutate(plugin.key)}
              />
            </li>
          ))}
        </ul>
      </div>
    </AppShell>
  );
}

function PluginRow({
  plugin,
  busy,
  onSwitch,
  onRemove,
}: {
  plugin: AgentPlugin;
  busy: boolean;
  onSwitch: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  return (
    <div
      className="skill-row"
      data-enabled={plugin.enabled || undefined}
      data-testid="agent-plugin"
      data-plugin={plugin.key}
      data-status={plugin.status}
    >
      <Switch
        checked={plugin.enabled}
        disabled={!plugin.manageable || busy}
        label={t('agent_plugins.enabled')}
        labelHidden
        testId={`agent-plugin-toggle-${plugin.key}`}
        onChange={onSwitch}
      />
      <span className="skill-open skill-static">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium" dir="ltr">
            {plugin.name}
          </span>
          {plugin.version && (
            <span className="text-xs text-muted" dir="ltr">
              {plugin.version}
            </span>
          )}
          <Badge tone={plugin.source === 'bundled' ? 'neutral' : 'accent'}>
            {t(`agent_plugins.source.${plugin.source}`)}
          </Badge>
          <Badge
            tone={
              plugin.status === 'enabled'
                ? 'success'
                : plugin.status === 'disabled'
                  ? 'warning'
                  : 'neutral'
            }
          >
            {t(`agent_plugins.status.${plugin.status}`)}
          </Badge>
        </span>
        {plugin.description && (
          <span className="skill-description" dir="auto">
            {plugin.description}
          </span>
        )}
      </span>
      {plugin.removable && (
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          disabled={busy}
          tooltip={t('agent_plugins.remove')}
          aria-label={t('agent_plugins.remove')}
          icon={<IconTrash size={14} />}
          data-testid={`agent-plugin-remove-${plugin.key}`}
          onClick={() => {
            void ask({
              title: t('agent_plugins.remove_title', { name: plugin.name }),
              body: t('agent_plugins.remove_body'),
              confirmLabel: t('agent_plugins.remove'),
            }).then((yes) => {
              if (yes) onRemove();
            });
          }}
        />
      )}
      {dialog}
    </div>
  );
}

/** Hermes's install, as a job: the line it is on while it runs, its outcome when it ends. */
function InstallForm({ agentId }: { agentId: string | undefined }) {
  const { t } = useI18n();
  const install = useInstallPlugin(agentId);
  const refresh = useRefreshPlugins(agentId);
  const jobs = useJobs();
  const [identifier, setIdentifier] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const polled = useJob(jobId);
  const job = jobId ? latest(jobs[jobId], polled.data) : undefined;
  const running = install.isPending || (!!job && !TERMINAL.has(job.status)) || (!!jobId && !job);
  const result = (job?.result ?? {}) as { name?: string | null };
  const value = identifier.trim();
  const bad = value !== '' && (/\s/.test(value) || value.startsWith('-'));

  useEffect(() => {
    if (job && TERMINAL.has(job.status)) refresh();
  }, [job?.status]);

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (value === '' || bad || running) return;
        setJobId(null);
        install.mutate(value, {
          onSuccess: (data) => {
            setJobId(data.job_id);
            setIdentifier('');
          },
        });
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-96 flex-1"
          inputSize="sm"
          dir="ltr"
          placeholder={t('agent_plugins.install_placeholder')}
          aria-label={t('agent_plugins.install_label')}
          value={identifier}
          invalid={bad}
          onChange={(event) => setIdentifier(event.target.value)}
          data-testid="agent-plugin-identifier"
        />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={value === '' || bad}
          loading={running}
          data-testid="agent-plugin-install"
        >
          {t('agent_plugins.install')}
        </Button>
      </div>
      <p className="text-xs text-muted">{t('agent_plugins.install_hint')}</p>
      {install.isError && (
        <Notice tone="danger">
          <span data-testid="agent-plugin-install-result" data-ok="false" dir="auto">
            {describeToolError(install.error, t)}
          </span>
        </Notice>
      )}
      {job && !TERMINAL.has(job.status) && job.progress.message && (
        <Notice>
          <span data-testid="agent-plugin-install-progress">{job.progress.message}</span>
        </Notice>
      )}
      {job?.status === 'succeeded' && (
        <Notice tone="success">
          <span data-testid="agent-plugin-install-result" data-ok="true">
            {t('agent_plugins.installed', { name: result.name ?? '' })}
          </span>
        </Notice>
      )}
      {job?.status === 'failed' && (
        <Notice tone="danger">
          <span data-testid="agent-plugin-install-result" data-ok="false" dir="auto">
            {t('agents.tools.refused', { message: job.error?.error ?? '' })}
          </span>
        </Notice>
      )}
    </form>
  );
}
