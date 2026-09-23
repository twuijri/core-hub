/**
 * The Schedules section: what runs on its own, and when it would run next.
 *
 * The screen is honest about the hub it talks to. A schedule for **Hermes** lives in
 * Hermes's own scheduler, which fires it — so it runs, and "Run now" works. Any other
 * schedule waits for the hub's worker, which does not exist yet: its "Run now" is present,
 * disabled, and says why in its tooltip rather than being hidden. Someone who came to run
 * something deserves to know the hub cannot yet, not to wonder where the button went.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/context.js';
import { HubApiError } from '@majlis/contracts';
import { describeError } from '../auth/client.js';
import { useAgents } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { termKey } from '../navigation/manifest.js';
import { AppShell } from '../shell/AppShell.js';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Notice,
  Select,
  Skeleton,
  SkeletonGroup,
  Switch,
  useConfirm,
} from '../ui/index.js';
import { agentMark } from '../ui/brand/marks.js';
import { IconSchedules, IconTrash } from '../ui/icons.js';
import { Tooltip } from '../ui/Tooltip.js';

interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  state: 'scheduled' | 'running' | 'paused' | 'exhausted';
  next_run_at: string | null;
  trigger: {
    kind: 'cron' | 'interval' | 'once';
    expression: string | null;
    every_minutes: number | null;
    run_at: string | null;
    timezone: string;
  };
  delivery?: { kind: string; channel: string | null; address: string | null };
  last_error?: string | null;
  /** Set when the schedule lives in an agent's own scheduler (Hermes's cron). */
  external?: { source: 'hermes'; id: string } | null;
}

const key = (profile: string) => ['schedules', profile] as const;

function useSchedules() {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: key(profile),
    queryFn: async () =>
      (await client.request('get', '/schedules')).data as unknown as { items: Schedule[] },
    enabled: !!session,
  });
}

function useScheduleWrite() {
  const { client, profile } = useAuth();
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: key(profile) });
  return {
    create: useMutation({
      mutationFn: async (body: Record<string, unknown>) =>
        (await client.request('post', '/schedules', { body: body as never })).data,
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: async ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
        (
          await client.request('patch', '/schedules/{schedule_id}', {
            params: { schedule_id: id },
            body: patch as never,
          })
        ).data,
      onSuccess: refresh,
    }),
    run: useMutation({
      mutationFn: async (id: string) =>
        (
          await client.request('post', '/schedules/{schedule_id}/run', {
            params: { schedule_id: id },
          })
        ).data,
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: async (id: string) => {
        await client.request('delete', '/schedules/{schedule_id}', {
          params: { schedule_id: id },
        });
        return id;
      },
      onSuccess: refresh,
    }),
  };
}

/** A whole object, because the contract marks every field of a trigger required. */
function triggerOf(kind: 'cron' | 'interval' | 'once', value: string, zone: string | null) {
  return {
    kind,
    expression: kind === 'cron' ? value : null,
    every_minutes: kind === 'interval' ? Number(value) || 1 : null,
    run_at: kind === 'once' ? value : null,
    // The person's own zone: a cron they typed means the hours they live in — unless they
    // chose the zone Hermes runs its cron in.
    timezone: zone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
  };
}

type Translate = (key: string, p?: Record<string, string | number>) => string;

function detailsOf(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof HubApiError)) return null;
  return (error.body as { details?: Record<string, unknown> } | undefined)?.details ?? null;
}

/** Hermes's refusals in Hermes's words; its limits in the person's language. */
function describeScheduleError(error: unknown, t: Translate): string {
  const details = detailsOf(error);
  switch (details?.reason) {
    case 'hermes_refused':
      return t('schedules.hermes.refused', { message: String(details.message ?? '') });
    case 'hermes_unreachable':
      return t('schedules.hermes.unreachable');
    case 'hermes_timezone':
      return t('schedules.hermes.timezone', { zone: String(details.timezone ?? '') });
    case 'hermes_delivery':
      return t('schedules.hermes.delivery');
    case 'hermes_prompt_required':
      return t('schedules.hermes.prompt_required');
    default:
      return describeError(error, t);
  }
}

export function SchedulesScreen() {
  const { t, language } = useI18n();
  const title = t(termKey('schedules'));
  const schedules = useSchedules();
  const { create, update, run, remove } = useScheduleWrite();
  const agents = useAgents();
  const { ask, dialog } = useConfirm();
  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState<string | null>(null);
  const [zone, setZone] = useState<string | null>(null);
  const [fired, setFired] = useState<string | null>(null);
  // Hermes is the one agent with a scheduler of its own, so it is the default.
  const agentOptions = (agents.data ?? []).map((agent) => ({ value: agent.id, label: agent.name }));
  const chosenAgent =
    agentId ??
    (agents.data ?? []).find((agent) => agent.slug === 'hermes')?.id ??
    agentOptions[0]?.value ??
    null;
  const zoneAsked = (() => {
    const details = detailsOf(create.error);
    return details?.reason === 'hermes_timezone' ? String(details.timezone ?? '') : null;
  })();
  const save = (withZone: string | null) =>
    create.mutate(
      {
        name: name.trim(),
        trigger: triggerOf(kind, value, withZone),
        target: {
          kind: 'agent_prompt',
          agent_id: chosenAgent,
          prompt: prompt.trim() || null,
          model: null,
          provider: null,
          skills: [],
          workflow_id: null,
          input: null,
        },
      },
      { onSuccess: () => setName('') },
    );
  const [kind, setKind] = useState<'cron' | 'interval' | 'once'>('cron');
  const [value, setValue] = useState('0 9 * * *');
  const [prompt, setPrompt] = useState('');

  const when = (at: string | null) =>
    at
      ? new Intl.DateTimeFormat(language === 'ar' ? 'ar' : 'en', {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(Date.parse(at))
      : t('schedules.never');

  const items = schedules.data?.items ?? [];

  return (
    <AppShell title={title}>
      <h1 className="sr-only">{title}</h1>

      <Card className="mb-4">
        <CardHeader title={t('schedules.new')} subtitle={t('schedules.new_hint')} />
        <div className="flex flex-col gap-3">
          <Field label={t('schedules.name')}>
            {(props) => (
              <Input
                {...props}
                value={name}
                onChange={(event) => setName(event.target.value)}
                data-testid="schedule-name"
              />
            )}
          </Field>
          <Field label={t('schedules.kind')}>
            {() => (
              <Select
                value={kind}
                onValueChange={(next) => {
                  const chosen = (next ?? 'cron') as 'cron' | 'interval' | 'once';
                  setKind(chosen);
                  setValue(chosen === 'cron' ? '0 9 * * *' : chosen === 'interval' ? '60' : '');
                }}
                options={[
                  { value: 'cron', label: t('schedules.kinds.cron') },
                  { value: 'interval', label: t('schedules.kinds.interval') },
                  { value: 'once', label: t('schedules.kinds.once') },
                ]}
                label={t('schedules.kind')}
                testId="schedule-kind"
              />
            )}
          </Field>
          <Field
            label={t(`schedules.value.${kind}`)}
            {...(kind === 'cron' ? { hint: t('schedules.cron_hint') } : {})}
          >
            {(props) => (
              <Input
                {...props}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                dir="ltr"
                data-testid="schedule-value"
              />
            )}
          </Field>
          {agentOptions.length > 0 && (
            <Field label={t('schedules.agent')}>
              {() => (
                <Select
                  value={chosenAgent ?? ''}
                  onValueChange={(next) => setAgentId(next ?? null)}
                  options={agentOptions}
                  label={t('schedules.agent')}
                  testId="schedule-agent"
                />
              )}
            </Field>
          )}
          <Field label={t('schedules.prompt')}>
            {(props) => (
              <Input
                {...props}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                data-testid="schedule-prompt"
              />
            )}
          </Field>
          {create.isError && (
            <Notice tone="danger">
              <span className="flex flex-wrap items-center gap-2">
                {describeScheduleError(create.error, t)}
                {zoneAsked && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setZone(zoneAsked);
                      save(zoneAsked);
                    }}
                    data-testid="schedule-use-zone"
                  >
                    {t('schedules.hermes.use_zone', { zone: zoneAsked })}
                  </Button>
                )}
              </span>
            </Notice>
          )}
          <Button
            className="self-start"
            disabled={name.trim() === ''}
            loading={create.isPending}
            onClick={() => save(zone)}
            data-testid="schedule-save"
          >
            {t('common.save')}
          </Button>
        </div>
      </Card>

      {schedules.isPending && (
        <SkeletonGroup label={t('common.loading')}>
          {[0, 1].map((i) => (
            <Skeleton key={i} height="5rem" radius="md" />
          ))}
        </SkeletonGroup>
      )}
      {schedules.isError && <Notice tone="danger">{describeError(schedules.error, t)}</Notice>}
      {(update.isError || run.isError || remove.isError) && (
        <Notice tone="danger">
          {describeScheduleError(update.error ?? run.error ?? remove.error, t)}
        </Notice>
      )}
      {fired && <Notice tone="success">{t('schedules.hermes.fired')}</Notice>}
      {schedules.data && items.length === 0 && (
        <EmptyState icon={<IconSchedules size={20} />} title={t('schedules.empty')} />
      )}

      <ul className="flex flex-col gap-3" data-testid="schedule-list">
        {items.map((schedule) => {
          const fromHermes = schedule.external?.source === 'hermes';
          return (
            <li key={schedule.id}>
              <Card testId="schedule-card" data-external={fromHermes ? 'hermes' : undefined}>
                <CardHeader
                  title={
                    <span className="inline-flex items-center gap-2">
                      {fromHermes && (
                        <Tooltip label={t('schedules.hermes.origin')}>
                          <span
                            className="inline-grid place-items-center text-muted"
                            role="img"
                            aria-label={t('schedules.hermes.origin')}
                            data-testid="schedule-origin-hermes"
                          >
                            {agentMark('hermes', 16)}
                          </span>
                        </Tooltip>
                      )}
                      <span dir="auto">{schedule.name}</span>
                    </span>
                  }
                  subtitle={
                    schedule.trigger.kind === 'cron'
                      ? `${schedule.trigger.expression ?? ''} · ${schedule.trigger.timezone}`
                      : schedule.trigger.kind === 'interval'
                        ? t('schedules.every', { minutes: schedule.trigger.every_minutes ?? 0 })
                        : when(schedule.trigger.run_at)
                  }
                  actions={
                    <Badge tone={schedule.state === 'scheduled' ? 'accent' : 'neutral'}>
                      {t(`schedules.state.${schedule.state}`)}
                    </Badge>
                  }
                />
                <p className="text-xs text-muted">
                  {t('schedules.next', { at: when(schedule.next_run_at) })}
                  {schedule.delivery?.kind === 'channel' && schedule.delivery.channel && (
                    <> · {t('schedules.delivers_to', { channel: schedule.delivery.channel })}</>
                  )}
                </p>
                {schedule.last_error && (
                  <p className="text-xs text-danger-soft-text" dir="auto">
                    {t('schedules.last_error', { error: schedule.last_error })}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Switch
                    checked={schedule.enabled}
                    onChange={(next) =>
                      update.mutate({ id: schedule.id, patch: { enabled: next } })
                    }
                    label={t('schedules.enabled')}
                    testId="schedule-enabled"
                  />
                  {fromHermes ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={run.isPending && run.variables === schedule.id}
                      onClick={() =>
                        run.mutate(schedule.id, { onSuccess: () => setFired(schedule.id) })
                      }
                      data-testid="schedule-run"
                    >
                      {t('schedules.run_now')}
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled
                      tooltip={t('schedules.run_unavailable')}
                      data-testid="schedule-run"
                    >
                      {t('schedules.run_now')}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    className="ms-auto"
                    tooltip={t('common.delete')}
                    aria-label={t('common.delete')}
                    icon={<IconTrash size={14} />}
                    onClick={() => {
                      void ask({
                        title: t('schedules.confirm_delete', { name: schedule.name }),
                        confirmLabel: t('common.delete'),
                      }).then((sure) => {
                        if (sure) remove.mutate(schedule.id);
                      });
                    }}
                    data-testid="schedule-delete"
                  />
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
      {dialog}
    </AppShell>
  );
}
