/**
 * Skills usage (`audit.getSkillUsage`, decision §47): which skills the agents loaded in a
 * period, how often, and which enabled skills no run loaded.
 *
 * The hub records a use when a run loads a skill (Hermes's `skill_view`); nothing before that
 * was recorded, so the page says from when it has counted rather than implying the skills
 * were never used before. Coding agents do not say which skill they load and are not counted.
 */
import { useState } from 'react';
import { describeError } from '../../auth/client.js';
import { useI18n } from '../../i18n/context.js';
import {
  Badge,
  Card,
  Notice,
  Spinner,
  StackedBarChart,
  Table,
  type Column,
} from '../../ui/index.js';
import { ReportFilters } from './ReportFilters.js';
import { StatCard } from './UsagePage.js';
import {
  DEFAULT_FILTERS,
  formatsFor,
  skillBars,
  skillSeries,
  useSkillUsageReport,
  type Formats,
  type SkillUsageReport,
} from './report.js';

export function SkillsUsagePage() {
  const { t, language } = useI18n();
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const report = useSkillUsageReport(filters);
  return (
    <div className="flex flex-col gap-4" data-testid="skills-usage-page">
      <ReportFilters value={filters} onChange={setFilters} agents={report.data?.agents ?? []} />
      {report.isPending && <Spinner label={t('common.loading')} />}
      {report.isError && <Notice tone="danger">{describeError(report.error, t)}</Notice>}
      {report.data && <SkillsUsageBody report={report.data} formats={formatsFor(language)} />}
    </div>
  );
}

type Row = SkillUsageReport['top_skills'][number];

export function SkillsUsageBody({
  report,
  formats,
}: {
  report: SkillUsageReport;
  formats: Formats;
}) {
  const { t } = useI18n();
  const { totals } = report;
  const unknown = (
    <span className="text-base font-normal text-muted">{t('skills_usage.unknown')}</span>
  );

  const columns: Array<Column<Row>> = [
    {
      key: 'skill',
      header: t('skills_usage.skill'),
      cell: (row) => (
        <span dir="auto" className="font-medium">
          {row.skill}
        </span>
      ),
    },
    {
      key: 'uses',
      header: t('skills_usage.uses'),
      numeric: true,
      cell: (row) => formats.number(row.uses),
    },
    {
      key: 'share',
      header: t('skills_usage.share'),
      numeric: true,
      cell: (row) => formats.percent(row.share),
    },
    {
      key: 'last',
      header: t('skills_usage.last_used'),
      secondary: true,
      cell: (row) => formats.dateTime(row.last_used_at),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted" data-testid="skills-counting-since">
        {report.counting_since
          ? t('skills_usage.counting_since', { date: formats.dateTime(report.counting_since) })
          : t('skills_usage.not_counting')}{' '}
        {t('skills_usage.not_counted_acp')}
      </p>

      <ul className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="skills-totals">
        <StatCard
          label={t('skills_usage.total_uses')}
          value={formats.number(totals.uses)}
          testId="skills-card-uses"
        />
        <StatCard
          label={t('skills_usage.distinct')}
          value={formats.number(totals.distinct_skills)}
          testId="skills-card-distinct"
        />
        <StatCard
          label={t('skills_usage.top')}
          value={
            totals.top_skill ? (
              <span dir="auto">{totals.top_skill.skill}</span>
            ) : (
              <span className="text-muted">{t('skills_usage.none')}</span>
            )
          }
          hint={
            totals.top_skill
              ? t('skills_usage.uses_n', { count: formats.number(totals.top_skill.uses) })
              : undefined
          }
          testId="skills-card-top"
        />
        <StatCard
          label={t('skills_usage.never_used')}
          value={
            totals.never_used_count === null ? unknown : formats.number(totals.never_used_count)
          }
          hint={totals.never_used_count === null ? t('skills_usage.unknown_hint') : undefined}
          testId="skills-card-never"
        />
      </ul>

      <Card as="section" className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">{t('skills_usage.daily')}</h3>
        {totals.uses === 0 ? (
          <p className="text-sm text-muted">{t('skills_usage.nothing')}</p>
        ) : (
          <StackedBarChart
            label={t('skills_usage.daily')}
            series={skillSeries(report, t)}
            bars={skillBars(report, formats)}
            format={formats.number}
            testId="skills-chart"
          />
        )}
      </Card>

      <Card as="section" className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">{t('skills_usage.table')}</h3>
        <Table
          caption={t('skills_usage.table')}
          columns={columns}
          rows={report.top_skills}
          rowKey={(row) => row.skill}
          empty={<p className="text-sm text-muted">{t('skills_usage.nothing')}</p>}
          testId="skills-table"
        />
      </Card>

      {report.never_used && report.never_used.length > 0 && (
        <Card as="section" className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">{t('skills_usage.never_used_list')}</h3>
          <ul className="flex flex-wrap gap-2" data-testid="skills-never-used">
            {report.never_used.map((name) => (
              <li key={name}>
                <Badge>
                  <span dir="auto">{name}</span>
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
