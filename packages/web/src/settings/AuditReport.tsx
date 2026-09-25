/**
 * The two reports behind Logs and Performance (`audit.getReport`). Usage and Skills usage
 * are typed reports with pages of their own (`usage/`, decision §50).
 *
 * One screen for both kinds, because they are one call with one shape: a period, a
 * generated-at, and a `data` block the report defines. What differs is how the block is
 * read, and that is the only thing this file switches on.
 *
 * **A period with nothing in it is a report of zeros**, drawn as such — not an empty
 * state, because "nothing happened in the last thirty days" is an answer, and hiding it
 * behind "no data" would make a working hub look broken.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { Badge, Notice, Segmented, Spinner } from '../ui/index.js';

type Kind = 'logs' | 'performance';

interface Report {
  kind: Kind;
  period: { from: string; to: string };
  generated_at: string;
  data: Record<string, unknown>;
}

const DAYS = [7, 30, 90] as const;

function useReport(kind: Kind, days: number) {
  const { client, profile, session } = useAuth();
  return useQuery({
    queryKey: ['audit', profile, kind, days],
    queryFn: async () =>
      (
        await client.request('get', '/audit/reports/{kind}', {
          params: { kind },
          query: { days },
        })
      ).data as unknown as Report,
    enabled: !!session,
  });
}

export function AuditReport({ kind }: { kind: Kind }) {
  const { t, language } = useI18n();
  const [days, setDays] = useState<number>(30);
  const report = useReport(kind, days);
  const number = (value: number) =>
    new Intl.NumberFormat(language === 'ar' ? 'ar' : 'en').format(value);

  return (
    <div className="flex flex-col gap-3">
      <Segmented
        className="self-start"
        size="sm"
        label={t('audit.period')}
        value={String(days)}
        onChange={(value) => setDays(Number(value))}
        options={DAYS.map((count) => ({
          value: String(count),
          label: t('audit.days', { count }),
          itemProps: { 'data-testid': `audit-days-${count}` },
        }))}
      />
      {report.isPending && <Spinner label={t('common.loading')} />}
      {report.isError && <Notice tone="danger">{describeError(report.error, t)}</Notice>}
      {report.data && (
        <>
          <p className="text-xs text-muted">
            {t('audit.between', { from: report.data.period.from, to: report.data.period.to })}
          </p>
          {kind === 'logs' && <LogsBody data={report.data.data} />}
          {kind === 'performance' && <PerformanceBody data={report.data.data} number={number} />}
        </>
      )}
    </div>
  );
}

function LogsBody({ data }: { data: Record<string, unknown> }) {
  const { t } = useI18n();
  const entries = (data.entries ?? []) as Array<Record<string, unknown>>;
  if (entries.length === 0) return <p className="text-sm text-muted">{t('audit.no_entries')}</p>;
  return (
    <ul className="flex flex-col gap-1" data-testid="log-entries">
      {entries.map((entry, index) => (
        <li key={`${String(entry.at)}-${index}`} className="log-entry">
          <Badge
            tone={
              entry.level === 'error' ? 'danger' : entry.level === 'warn' ? 'warning' : 'neutral'
            }
          >
            {String(entry.level)}
          </Badge>
          <time className="log-entry-time">{String(entry.at).slice(0, 19).replace('T', ' ')}</time>
          <span className="truncate" dir="auto">
            {String(entry.message || entry.action)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function PerformanceBody({
  data,
  number,
}: {
  data: Record<string, unknown>;
  number: (value: number) => string;
}) {
  const { t } = useI18n();
  const current = data.current as Record<string, unknown>;
  const samples = (data.samples ?? []) as Array<Record<string, unknown>>;
  const mb = (bytes: number) => `${number(Math.round(bytes / 1_048_576))} MB`;
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted">{t('audit.uptime')}</dt>
        <dd>{t('audit.seconds', { count: number(Number(current.uptime_seconds)) })}</dd>
        <dt className="text-muted">{t('audit.memory')}</dt>
        <dd>{mb(Number(current.rss_bytes))}</dd>
        <dt className="text-muted">{t('audit.node')}</dt>
        <dd dir="ltr">{String(current.node_version)}</dd>
      </dl>
      <p className="text-xs text-muted">
        {samples.length === 0
          ? t('audit.no_samples')
          : t('audit.samples_n', { count: number(samples.length) })}
      </p>
    </div>
  );
}
