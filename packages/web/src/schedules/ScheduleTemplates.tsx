/**
 * Help writing a schedule's time: a "Common schedules" menu that fills in the cron or the
 * interval, and the next three times it would run, shown in the schedule's own timezone.
 *
 * The times are the hub's (`schedules.previewTrigger`, DECISIONS §57): the same calculation
 * that sets a saved schedule's `next_run_at`, so what the form promises is what the hub will
 * do — a browser's own cron reader could disagree with it on a day-of-month and weekday pair,
 * or a zone's summer time. A time the hub cannot read says so here, before it is saved.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { HubApiError } from '@corehub/contracts';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { Button, Menu, MenuItem, Skeleton } from '../ui/index.js';
import { IconSchedules } from '../ui/icons.js';

export type TriggerKind = 'cron' | 'interval' | 'once';

/** The owner's six (2026-09-25). "Every 15 minutes" is an interval; the rest are cron. */
export const SCHEDULE_TEMPLATES: ReadonlyArray<{ id: string; kind: TriggerKind; value: string }> = [
  { id: 'every_hour', kind: 'cron', value: '0 * * * *' },
  { id: 'daily_8', kind: 'cron', value: '0 8 * * *' },
  { id: 'weekdays_9', kind: 'cron', value: '0 9 * * 1-5' },
  { id: 'monday_9', kind: 'cron', value: '0 9 * * 1' },
  { id: 'monthly_1', kind: 'cron', value: '0 9 1 * *' },
  { id: 'every_15', kind: 'interval', value: '15' },
];

/** The menu that fills the form's kind and value from one of the templates. */
export function ScheduleTemplateMenu({
  onPick,
}: {
  onPick(template: { kind: TriggerKind; value: string }): void;
}) {
  const { t } = useI18n();
  return (
    <Menu
      trigger={
        <Button
          variant="secondary"
          size="sm"
          icon={<IconSchedules size={14} />}
          data-testid="schedule-templates"
        >
          {t('schedules.templates.label')}
        </Button>
      }
      testId="schedule-templates-menu"
    >
      {SCHEDULE_TEMPLATES.map((template) => (
        <MenuItem key={template.id} onSelect={() => onPick(template)}>
          {t(`schedules.templates.${template.id}`)}
        </MenuItem>
      ))}
    </Menu>
  );
}

/** The value after it stopped changing for a moment, so typing does not ask on every key. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

interface Trigger {
  kind: TriggerKind;
  expression: string | null;
  every_minutes: number | null;
  run_at: string | null;
  timezone: string;
}

/** Why the hub would refuse this time, in the person's language. */
function refusal(
  error: unknown,
  t: (key: string, p?: Record<string, string | number>) => string,
): string {
  const details =
    error instanceof HubApiError
      ? (error.body as { details?: Record<string, unknown> } | undefined)?.details
      : undefined;
  switch (details?.reason) {
    case 'cron_invalid':
      return t('schedules.preview.cron_invalid', { message: String(details.message ?? '') });
    case 'cron_required':
    case 'interval_required':
    case 'run_at_required':
      return t('schedules.preview.incomplete');
    case 'timezone_unknown':
      return t('schedules.preview.timezone_unknown', { zone: String(details.timezone ?? '') });
    default:
      return describeError(error, t);
  }
}

/** The next three times the hub would run this trigger, in its own timezone. */
export function NextRuns({ trigger, profile }: { trigger: Trigger; profile: string }) {
  const { t, language } = useI18n();
  const { client } = useAuth();
  // A string, so a trigger rebuilt on every render with the same fields is the same value.
  const settled = JSON.parse(useSettled(JSON.stringify(trigger), 300)) as Trigger;
  const incomplete =
    (settled.kind === 'cron' && !settled.expression?.trim()) ||
    (settled.kind === 'interval' && !settled.every_minutes) ||
    (settled.kind === 'once' && !settled.run_at);
  const preview = useQuery({
    queryKey: ['schedules', 'preview', profile, settled],
    queryFn: async () =>
      (
        await client.request('post', '/schedules/preview', {
          body: { trigger: settled, count: 3 } as never,
          headers: { 'X-Hub-Profile': profile },
        })
      ).data as unknown as { timezone: string; next_runs: string[] },
    enabled: !incomplete,
    retry: false,
    staleTime: 30_000,
  });
  const nextRuns = preview.data?.next_runs ?? [];
  const zone = preview.data?.timezone ?? settled.timezone;
  const format = (at: string) => {
    const options: Intl.DateTimeFormatOptions = {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    };
    try {
      return new Intl.DateTimeFormat(language === 'ar' ? 'ar' : 'en', {
        ...options,
        timeZone: zone,
      }).format(Date.parse(at));
    } catch {
      return new Intl.DateTimeFormat(language === 'ar' ? 'ar' : 'en', options).format(
        Date.parse(at),
      );
    }
  };

  return (
    <div
      className="flex flex-col gap-1 rounded-md bg-surface-2 p-2 text-xs"
      aria-live="polite"
      data-testid="schedule-next-runs"
    >
      <p className="font-medium">{t('schedules.preview.title', { zone: settled.timezone })}</p>
      {incomplete && <p className="text-muted">{t('schedules.preview.incomplete')}</p>}
      {!incomplete && preview.isPending && <Skeleton height="2.75rem" radius="sm" />}
      {!incomplete && preview.isError && (
        <p className="text-danger-soft-text" dir="auto" data-testid="schedule-next-runs-error">
          {refusal(preview.error, t)}
        </p>
      )}
      {!incomplete && preview.data && nextRuns.length === 0 && (
        <p className="text-muted" data-testid="schedule-next-runs-none">
          {t('schedules.preview.none')}
        </p>
      )}
      {!incomplete && nextRuns.length > 0 && (
        <ol className="flex flex-col gap-0.5">
          {nextRuns.map((at) => (
            <li key={at} data-testid="schedule-next-run" data-at={at}>
              {format(at)}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
