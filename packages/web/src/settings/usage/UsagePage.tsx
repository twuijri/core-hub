/**
 * Usage (`audit.getUsage`, decision §50): tokens, the cache, the estimated cost and the
 * conversations of a period, by day, by model and by agent.
 *
 * **Only what was measured is drawn as a number.** A cache no provider reported says "not
 * reported" instead of 0 %, a period with nothing priced has no cost, and an agent that ran
 * without reporting usage (coding agents over ACP) is listed as such, never as zeros.
 * The cost is shown only while the person's `show_cost` preference is on — the same switch
 * the chat's cost line follows.
 */
import { useState, type ReactNode } from 'react';
import { describeError } from '../../auth/client.js';
import { usePreferences, useSavePreferences } from '../../hub/queries.js';
import { useI18n } from '../../i18n/context.js';
import {
  Badge,
  Card,
  Notice,
  ShareBars,
  Spinner,
  StackedBarChart,
  Switch,
  Table,
  type Column,
} from '../../ui/index.js';
import { ReportFilters } from './ReportFilters.js';
import {
  DEFAULT_FILTERS,
  activeDays,
  formatsFor,
  usageBars,
  usageSeries,
  useUsageReport,
  type Formats,
  type UsageReport,
} from './report.js';

export function StatCard({
  label,
  value,
  hint,
  testId,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  testId?: string | undefined;
}) {
  return (
    <Card as="li" padding="sm" className="flex flex-col gap-1" {...(testId ? { testId } : {})}>
      <span className="text-xs text-muted">{label}</span>
      <span className="text-xl font-semibold tabular-nums">{value}</span>
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </Card>
  );
}

export function UsagePage() {
  const { t, language } = useI18n();
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const report = useUsageReport(filters);
  const preferences = usePreferences();
  const save = useSavePreferences();
  const showCost = preferences.data?.show_cost ?? false;
  const formats = formatsFor(language);

  return (
    <div className="flex flex-col gap-4" data-testid="usage-page">
      <ReportFilters value={filters} onChange={setFilters} agents={report.data?.agents ?? []}>
        {preferences.data && (
          <Switch
            checked={showCost}
            onChange={(next) => save.mutate({ ...preferences.data!, show_cost: next })}
            label={t('usage.show_cost')}
            hint={t('usage.show_cost_hint')}
            testId="usage-show-cost"
          />
        )}
      </ReportFilters>
      {report.isPending && <Spinner label={t('common.loading')} />}
      {report.isError && <Notice tone="danger">{describeError(report.error, t)}</Notice>}
      {report.data && <UsageBody report={report.data} formats={formats} showCost={showCost} />}
    </div>
  );
}

export function UsageBody({
  report,
  formats,
  showCost,
}: {
  report: UsageReport;
  formats: Formats;
  showCost: boolean;
}) {
  const { t } = useI18n();
  const { totals } = report;
  const estimated = totals.cost_source === 'estimated';
  const notReported = (
    <span className="text-base font-normal text-muted">{t('usage.not_reported')}</span>
  );
  const tokens = (value: number) => t('audit.tokens_n', { count: formats.number(value) });
  const days = activeDays(report);

  const dayColumns: Array<Column<UsageReport['by_day'][number]>> = [
    { key: 'date', header: t('usage.date'), cell: (day) => formats.day(day.date) },
    {
      key: 'input',
      header: t('usage.input'),
      numeric: true,
      cell: (day) => formats.number(day.input_tokens),
    },
    {
      key: 'output',
      header: t('usage.output'),
      numeric: true,
      cell: (day) => formats.number(day.output_tokens),
    },
    ...(totals.cache_read_tokens !== null
      ? [
          {
            key: 'cache_read',
            header: t('usage.cache_read'),
            numeric: true,
            secondary: true,
            cell: (day: UsageReport['by_day'][number]) => formats.number(day.cache_read_tokens),
          },
        ]
      : []),
    ...(totals.cache_write_tokens !== null
      ? [
          {
            key: 'cache_write',
            header: t('usage.cache_write'),
            numeric: true,
            secondary: true,
            cell: (day: UsageReport['by_day'][number]) => formats.number(day.cache_write_tokens),
          },
        ]
      : []),
    {
      key: 'conversations',
      header: t('usage.conversations'),
      numeric: true,
      cell: (day) => formats.number(day.conversations),
    },
    ...(showCost
      ? [
          {
            key: 'cost',
            header: t('audit.cost'),
            numeric: true,
            cell: (day: UsageReport['by_day'][number]) =>
              day.cost ? formats.money(day.cost, estimated) : '—',
          },
        ]
      : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted">
        {t('audit.between', {
          from: formats.day(report.period.from),
          to: formats.day(report.period.to),
        })}
      </p>
      {totals.unreported_runs > 0 && (
        <div data-testid="usage-unreported">
          <Notice>
            {t('usage.unreported_notice', { count: formats.number(totals.unreported_runs) })}
          </Notice>
        </div>
      )}

      <ul
        className="grid grid-cols-2 gap-3 md:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]"
        data-testid="usage-totals"
      >
        <StatCard
          label={t('usage.total_tokens')}
          value={formats.compact(totals.total_tokens)}
          hint={t('usage.input_output', {
            input: formats.compact(totals.input_tokens),
            output: formats.compact(totals.output_tokens),
          })}
          testId="usage-card-tokens"
        />
        <StatCard
          label={t('usage.cache_read')}
          value={
            totals.cache_read_tokens === null
              ? notReported
              : formats.compact(totals.cache_read_tokens)
          }
          hint={
            totals.cache_write_tokens !== null
              ? `${t('usage.cache_write')}: ${formats.compact(totals.cache_write_tokens)}`
              : totals.cache_read_tokens === null
                ? t('usage.cache_not_reported_hint')
                : undefined
          }
          testId="usage-card-cache"
        />
        <StatCard
          label={t('usage.cache_hit_rate')}
          value={
            totals.cache_hit_rate === null ? notReported : formats.percent(totals.cache_hit_rate)
          }
          testId="usage-card-hit-rate"
        />
        {showCost && (
          <StatCard
            label={estimated ? t('usage.cost_estimated') : t('audit.cost')}
            value={totals.cost ? formats.money(totals.cost, estimated) : notReported}
            hint={
              totals.cost
                ? estimated
                  ? t('usage.show_cost_hint')
                  : undefined
                : t('usage.cost_unpriced')
            }
            testId="usage-card-cost"
          />
        )}
        <StatCard
          label={t('usage.conversations')}
          value={formats.number(totals.conversations)}
          hint={t('audit.runs_n', { count: formats.number(totals.runs) })}
          testId="usage-card-conversations"
        />
        <StatCard
          label={t('usage.per_day')}
          value={formats.number(totals.conversations_per_day)}
          testId="usage-card-per-day"
        />
      </ul>

      <Card as="section" className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">{t('usage.daily')}</h3>
        <StackedBarChart
          label={t('usage.daily')}
          series={usageSeries(report, t)}
          bars={usageBars(report, formats)}
          format={formats.compact}
          testId="usage-chart"
        />
        <h4 className="text-sm font-medium">{t('usage.day_table')}</h4>
        <Table
          caption={t('usage.day_table')}
          columns={dayColumns}
          rows={days}
          rowKey={(day) => day.date}
          empty={<p className="text-sm text-muted">{t('usage.nothing')}</p>}
          testId="usage-days"
        />
        {days.length > 0 && <p className="text-xs text-muted">{t('usage.only_active_days')}</p>}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card as="section" className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">{t('audit.by_model')}</h3>
          {report.by_model.length === 0 ? (
            <p className="text-sm text-muted">{t('usage.nothing')}</p>
          ) : (
            <ShareBars
              label={t('audit.by_model')}
              percent={formats.percent}
              testId="usage-by-model"
              rows={report.by_model.map((row) => ({
                key: row.model,
                label: row.model,
                share: row.share,
                value: `${tokens(row.total_tokens)}${
                  showCost && row.cost ? ` · ${formats.money(row.cost, estimated)}` : ''
                }`,
              }))}
            />
          )}
        </Card>
        <Card as="section" className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">{t('usage.by_agent')}</h3>
          {report.by_agent.length === 0 ? (
            <p className="text-sm text-muted">{t('usage.nothing')}</p>
          ) : (
            <ShareBars
              label={t('usage.by_agent')}
              percent={formats.percent}
              testId="usage-by-agent"
              rows={report.by_agent.map((row) => ({
                key: row.agent_id,
                label: row.name ?? t('usage.removed_agent'),
                share: row.share,
                value:
                  row.total_tokens === null
                    ? ''
                    : `${tokens(row.total_tokens)}${
                        showCost && row.cost ? ` · ${formats.money(row.cost, estimated)}` : ''
                      }`,
                note: (
                  <Badge tone="warning">
                    {t('usage.no_usage_reported')} ·{' '}
                    {t('audit.runs_n', { count: formats.number(row.runs) })}
                  </Badge>
                ),
              }))}
            />
          )}
        </Card>
      </div>
    </div>
  );
}
