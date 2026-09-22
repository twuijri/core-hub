/**
 * The three reports behind Logs, Usage and Performance (`audit.getReport`).
 *
 * One screen for three kinds, because they are one call with one shape: a period, a
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
import { Badge, Notice, Segmented, Spinner, Table, type Column } from '../ui/index.js';

type Kind = 'usage' | 'logs' | 'performance';

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
          {kind === 'usage' && <UsageBody data={report.data.data} number={number} />}
          {kind === 'logs' && <LogsBody data={report.data.data} />}
          {kind === 'performance' && <PerformanceBody data={report.data.data} number={number} />}
        </>
      )}
    </div>
  );
}

interface Totals {
  input_tokens: number;
  output_tokens: number;
  runs: number;
  sessions: number;
  cost: { amount: string; currency: string };
  cost_source: string;
}

function UsageBody({
  data,
  number,
}: {
  data: Record<string, unknown>;
  number: (value: number) => string;
}) {
  const { t } = useI18n();
  const totals = data.totals as Totals;
  const byModel = (data.by_model ?? []) as Array<Record<string, unknown>>;
  const columns: Array<Column<Record<string, unknown>>> = [
    { key: 'model', header: t('audit.model'), cell: (row) => String(row.model) },
    { key: 'runs', header: t('audit.runs'), cell: (row) => number(Number(row.runs)) },
    {
      key: 'tokens',
      header: t('audit.tokens'),
      cell: (row) => number(Number(row.input_tokens) + Number(row.output_tokens)),
    },
    {
      key: 'cost',
      header: t('audit.cost'),
      cell: (row) => (row.cost as { amount: string }).amount,
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-wrap gap-2" data-testid="usage-totals">
        <li>
          <Badge>{t('audit.runs_n', { count: number(totals.runs) })}</Badge>
        </li>
        <li>
          <Badge>{t('audit.sessions_n', { count: number(totals.sessions) })}</Badge>
        </li>
        <li>
          <Badge>
            {t('audit.tokens_n', {
              count: number(totals.input_tokens + totals.output_tokens),
            })}
          </Badge>
        </li>
        <li>
          {/* The number is an estimate from published prices unless the provider said
              otherwise, and the badge says which. */}
          <Badge tone={totals.cost_source === 'estimated' ? 'warning' : 'neutral'}>
            {totals.cost_source === 'unknown'
              ? t('audit.cost_unknown')
              : `${totals.cost_source === 'estimated' ? '≈ ' : ''}${totals.cost.amount} ${totals.cost.currency}`}
          </Badge>
        </li>
      </ul>
      {byModel.length > 0 && (
        <Table
          caption={t('audit.by_model')}
          columns={columns}
          rows={byModel}
          rowKey={(row) => String(row.model)}
          testId="usage-by-model"
        />
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
