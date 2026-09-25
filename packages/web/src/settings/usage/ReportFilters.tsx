/**
 * The one row of filters above both reports: the period, the profile (every one, or one) and
 * the agent. The agents offered are the report's own `agents` — every agent active in the
 * period, whatever the report is narrowed to — so a choice can always be taken back.
 */
import type { ReactNode } from 'react';
import { useProfiles } from '../../hub/queries.js';
import { useI18n } from '../../i18n/context.js';
import { ALL_PROFILES } from '../../shell/profiles.js';
import { Segmented, Select } from '../../ui/index.js';
import { PERIODS, type ReportFilters as Filters } from './report.js';

const ALL_AGENTS = '*';

export function ReportFilters({
  value,
  onChange,
  agents,
  children,
}: {
  value: Filters;
  onChange(next: Filters): void;
  agents: ReadonlyArray<{ agent_id: string; name: string | null }>;
  /** Anything else the row carries (the cost switch). */
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const profiles = useProfiles().data ?? [];
  const agentOptions = [
    { value: ALL_AGENTS, label: t('usage.all_agents') },
    ...agents.map((agent) => ({
      value: agent.agent_id,
      label: agent.name ?? t('usage.removed_agent'),
    })),
  ];
  // An agent chosen before the period changed may not be active in the new one; it stays
  // choosable rather than silently dropping the filter.
  if (value.agent && !agents.some((agent) => agent.agent_id === value.agent)) {
    agentOptions.push({ value: value.agent, label: t('usage.removed_agent') });
  }

  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="report-filters">
      <Segmented
        size="sm"
        label={t('audit.period')}
        value={String(value.days)}
        onChange={(days) => onChange({ ...value, days: Number(days) })}
        options={PERIODS.map((count) => ({
          value: String(count),
          label: t('audit.days', { count }),
          itemProps: { 'data-testid': `report-days-${count}` },
        }))}
      />
      {profiles.length > 1 && (
        <Select
          label={t('usage.profile')}
          value={value.profile}
          onValueChange={(profile) => onChange({ ...value, profile: profile ?? ALL_PROFILES })}
          options={[
            { value: ALL_PROFILES, label: t('usage.all_profiles') },
            ...profiles.map((profile) => ({ value: profile.slug, label: profile.name })),
          ]}
          testId="report-profile"
        />
      )}
      <Select
        label={t('usage.agent')}
        value={value.agent ?? ALL_AGENTS}
        onValueChange={(agent) =>
          onChange({ ...value, agent: agent && agent !== ALL_AGENTS ? agent : null })
        }
        options={agentOptions}
        testId="report-agent"
      />
      {children}
    </div>
  );
}
