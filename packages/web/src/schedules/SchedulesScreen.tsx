/**
 * The Schedules section: what runs on its own, when it runs next, and what it did.
 *
 * A schedule for **Hermes** lives in Hermes's own scheduler, which fires it; every other
 * schedule is fired by the hub itself. Both run on their own time, and "Run now" starts the
 * same run at once: a prompt schedule's conversation can be opened from its history, a
 * workflow schedule's run from its line — and a run that waits for a person is answered
 * where it is shown (`ScheduleRuns.tsx`), or from the inbox, which opens it here
 * (`?workflow_run=<id>&profile=<slug>`).
 */
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/context.js';
import { HubApiError } from '@majlis/contracts';
import { describeError } from '../auth/client.js';
import { useAgents } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { termKey } from '../navigation/manifest.js';
import { useRealtime } from '../realtime/context.js';
import { SCHEDULE_EVENTS, isEnvelope } from '../realtime/envelope.js';
import { AppShell } from '../shell/AppShell.js';
import { ProfileBadge } from '../shell/ProfileBadge.js';
import { useManyProfiles, useProfileInLink, useProfileName } from '../shell/profiles.js';
import { chatHref } from '../chat/anchor.js';
import { ScheduleHistory, WorkflowRunDialog } from './ScheduleRuns.js';
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
  /** The profile it belongs to: the page shows every profile (ADR 0016). */
  profile: string;
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

/**
 * One page for every profile the person may enter, with no profile filter (ADR 0016, owner
 * 2026-09-24: «الكرون جوب والمهام المفروض تطلع كل البروفايلات بدون تصنيف»). The hub decides
 * which profiles; the key is never a profile, so the top selector does not change the page.
 */
const KEY = ['schedules', 'all'] as const;

/** Enough pages for any page a person reads; the list is one keyset, newest first. */
const PAGE_LIMIT = 200;
const MAX_PAGES = 10;

function useSchedules() {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: KEY,
    queryFn: async () => {
      // The hub pages the list (`cursor`, one order over every profile); the page shows
      // all of it, so it follows the cursor to the end.
      const items: Schedule[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const { data } = await client.request('get', '/schedules', {
          query: { profiles: 'all', limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
        });
        const body = data as unknown as { items: Schedule[]; next_cursor: string | null };
        items.push(...body.items);
        cursor = body.next_cursor;
        if (!cursor) break;
      }
      return { items };
    },
    enabled: !!session,
  });
}

/**
 * The page follows `/rt/schedules`, which hears every profile the person may enter
 * (`profiles: 'all'`, realtime/context.tsx): a schedule made, changed or fired anywhere —
 * another tab, Hermes — redraws it.
 */
function useScheduleEvents(): void {
  const realtime = useRealtime();
  const queryClient = useQueryClient();
  useEffect(() => {
    const socket = realtime.socket('schedules');
    const handler = (raw: unknown) => {
      if (!isEnvelope(raw)) return;
      void queryClient.invalidateQueries({ queryKey: ['schedules'] });
    };
    for (const name of SCHEDULE_EVENTS) socket.on(name, handler);
    if (!socket.connected) socket.connect();
    return () => {
      for (const name of SCHEDULE_EVENTS) socket.off(name, handler);
    };
  }, [queryClient, realtime.epoch]);
}

/** Every write goes to the schedule's own profile, whichever one the top selector shows. */
const inWorkspace = (profile: string) => ({ headers: { 'X-Hub-Profile': profile } });

function useScheduleWrite() {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['schedules'] });
  return {
    create: useMutation({
      mutationFn: async ({ body, profile }: { body: Record<string, unknown>; profile: string }) =>
        (
          await client.request('post', '/schedules', {
            body: body as never,
            ...inWorkspace(profile),
          })
        ).data,
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: async ({
        schedule,
        patch,
      }: {
        schedule: Schedule;
        patch: Record<string, unknown>;
      }) =>
        (
          await client.request('patch', '/schedules/{schedule_id}', {
            params: { schedule_id: schedule.id },
            body: patch as never,
            ...inWorkspace(schedule.profile),
          })
        ).data,
      onSuccess: refresh,
    }),
    run: useMutation({
      mutationFn: async (schedule: Schedule) =>
        (
          await client.request('post', '/schedules/{schedule_id}/run', {
            params: { schedule_id: schedule.id },
            ...inWorkspace(schedule.profile),
          })
        ).data as unknown as Fired,
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: async (schedule: Schedule) => {
        await client.request('delete', '/schedules/{schedule_id}', {
          params: { schedule_id: schedule.id },
          ...inWorkspace(schedule.profile),
        });
        return schedule.id;
      },
      onSuccess: refresh,
    }),
  };
}

/** What "Run now" started (`ScheduleRunAccepted`). */
interface Fired {
  schedule_run_id: string;
  session_id: string | null;
  workflow_run_id: string | null;
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
    case 'target_unavailable':
      return t('schedules.target_unavailable', { message: String(details.message ?? '') });
    default:
      return describeError(error, t);
  }
}

export function SchedulesScreen() {
  const { t, language } = useI18n();
  const title = t(termKey('schedules'));
  // A new schedule is made in the profile the person is in — the top selector — and the
  // agents offered are that profile's. One control decides where things are made, so the
  // form has no second picker to disagree with it (ADR 0016).
  const { homeProfile } = useAuth();
  const many = useManyProfiles();
  const profileName = useProfileName();
  const schedules = useSchedules();
  useScheduleEvents();
  const { create, update, run, remove } = useScheduleWrite();
  const agents = useAgents();
  const target = homeProfile;
  const { ask, dialog } = useConfirm();
  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState<string | null>(null);
  const [zone, setZone] = useState<string | null>(null);
  const [fired, setFired] = useState<{ schedule: Schedule; started: Fired } | null>(null);
  const [history, setHistory] = useState<Set<string>>(() => new Set());
  const inLink = useProfileInLink();
  // A workflow run opened from a line of history, or from the inbox by its address.
  const [params, setParams] = useSearchParams();
  const openRun = params.get('workflow_run');
  const openRunProfile = params.get('profile') ?? homeProfile;
  const showRun = (id: string, profile: string) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set('workflow_run', id);
      next.set('profile', profile);
      return next;
    });
  const closeRun = () =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('workflow_run');
      next.delete('profile');
      return next;
    });
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
        profile: target,
        body: {
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
          {many && (
            <p
              className="text-xs text-muted"
              data-testid="schedule-new-profile"
              data-profile={target}
            >
              {t('schedules.in_profile', { name: profileName(target) })}
            </p>
          )}
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
      {fired && (
        <Notice tone="success">
          <span className="flex flex-wrap items-center gap-2" data-testid="schedule-fired">
            {fired.schedule.external?.source === 'hermes'
              ? t('schedules.hermes.fired')
              : t('schedules.fired', { name: fired.schedule.name })}
            {fired.started.session_id && (
              <Link
                to={chatHref(
                  fired.started.session_id,
                  null,
                  undefined,
                  inLink(fired.schedule.profile),
                )}
                data-testid="schedule-fired-session"
              >
                {t('schedules.history.open_session')}
              </Link>
            )}
            {fired.started.workflow_run_id && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => showRun(fired.started.workflow_run_id!, fired.schedule.profile)}
                data-testid="schedule-fired-run"
              >
                {t('schedules.history.open_run')}
              </Button>
            )}
          </span>
        </Notice>
      )}
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
                    <span className="flex items-center gap-1">
                      {/* Whose schedule this is, once there is more than one profile. */}
                      {many && (
                        <ProfileBadge profile={schedule.profile} testId="schedule-profile" />
                      )}
                      <Badge tone={schedule.state === 'scheduled' ? 'accent' : 'neutral'}>
                        {t(`schedules.state.${schedule.state}`)}
                      </Badge>
                    </span>
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
                    onChange={(next) => update.mutate({ schedule, patch: { enabled: next } })}
                    label={t('schedules.enabled')}
                    testId="schedule-enabled"
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={run.isPending && run.variables?.id === schedule.id}
                    onClick={() => {
                      setFired(null);
                      run.mutate(schedule, {
                        onSuccess: (started) => {
                          setFired({ schedule, started });
                          // The run is in the history now: show it.
                          setHistory((open) => new Set(open).add(schedule.id));
                        },
                      });
                    }}
                    data-testid="schedule-run"
                  >
                    {t('schedules.run_now')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={history.has(schedule.id)}
                    onClick={() =>
                      setHistory((open) => {
                        const next = new Set(open);
                        if (next.has(schedule.id)) next.delete(schedule.id);
                        else next.add(schedule.id);
                        return next;
                      })
                    }
                    data-testid="schedule-history-toggle"
                  >
                    {t(history.has(schedule.id) ? 'schedules.history.hide' : 'schedules.history.show')}
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
                        if (sure) remove.mutate(schedule);
                      });
                    }}
                    data-testid="schedule-delete"
                  />
                </div>
                {history.has(schedule.id) && (
                  <div className="mt-3">
                    <ScheduleHistory
                      scheduleId={schedule.id}
                      profile={schedule.profile}
                      onOpenRun={(id) => showRun(id, schedule.profile)}
                    />
                  </div>
                )}
              </Card>
            </li>
          );
        })}
      </ul>
      {openRun && (
        <WorkflowRunDialog runId={openRun} profile={openRunProfile} onClose={closeRun} />
      )}
      {dialog}
    </AppShell>
  );
}
