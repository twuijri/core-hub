/**
 * The Schedules section: what runs on its own, and when it would run next.
 *
 * The screen is honest about the hub it talks to. Three of the module's operations answer
 * `501` — anything that would *start* a run — so "Run now" is present, disabled, and says
 * why in its tooltip rather than being hidden. Someone who came to run something deserves
 * to know the hub cannot yet, not to wonder where the button went.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
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
import { IconSchedules, IconTrash } from '../ui/icons.js';

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
function triggerOf(kind: 'cron' | 'interval' | 'once', value: string) {
  return {
    kind,
    expression: kind === 'cron' ? value : null,
    every_minutes: kind === 'interval' ? Number(value) || 1 : null,
    run_at: kind === 'once' ? value : null,
    // The person's own zone: a cron they typed means the hours they live in.
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  };
}

export function SchedulesScreen() {
  const { t, language } = useI18n();
  const title = t(termKey('schedules'));
  const schedules = useSchedules();
  const { create, update, remove } = useScheduleWrite();
  const { ask, dialog } = useConfirm();
  const [name, setName] = useState('');
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
          {create.isError && <Notice tone="danger">{describeError(create.error, t)}</Notice>}
          <Button
            className="self-start"
            disabled={name.trim() === ''}
            loading={create.isPending}
            onClick={() =>
              create.mutate(
                {
                  name: name.trim(),
                  trigger: triggerOf(kind, value),
                  target: {
                    kind: 'agent_prompt',
                    agent_id: null,
                    prompt: prompt.trim() || null,
                    model: null,
                    provider: null,
                    skills: [],
                    workflow_id: null,
                    input: null,
                  },
                },
                { onSuccess: () => setName('') },
              )
            }
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
      {schedules.data && items.length === 0 && (
        <EmptyState icon={<IconSchedules size={20} />} title={t('schedules.empty')} />
      )}

      <ul className="flex flex-col gap-3" data-testid="schedule-list">
        {items.map((schedule) => (
          <li key={schedule.id}>
            <Card testId="schedule-card">
              <CardHeader
                title={schedule.name}
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
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Switch
                  checked={schedule.enabled}
                  onChange={(next) => update.mutate({ id: schedule.id, patch: { enabled: next } })}
                  label={t('schedules.enabled')}
                  testId="schedule-enabled"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled
                  tooltip={t('schedules.run_unavailable')}
                  data-testid="schedule-run"
                >
                  {t('schedules.run_now')}
                </Button>
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
        ))}
      </ul>
      {dialog}
    </AppShell>
  );
}
