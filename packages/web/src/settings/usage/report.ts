/**
 * The Usage and Skills usage reports (`audit.getUsage`, `audit.getSkillUsage`, decision §50):
 * the query both pages share, and the pure rules that turn a report into what is drawn.
 *
 * The rules live here, apart from the pages, because they are the part worth a unit test:
 * which series a chart has (never a cache series nobody reported), which days the table lists,
 * and how a number is written in the person's language.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/context.js';
import { ALL_PROFILES } from '../../shell/profiles.js';
import type { Schemas } from '../../types.js';
import type { ChartBar, ChartSeries, ChartTone } from '../../ui/index.js';
import { intlLocale } from '../../i18n/index.js';

export type UsageReport = Schemas['UsageReport'];
export type SkillUsageReport = Schemas['SkillUsageReport'];
type Money = Schemas['Money'];

/** The periods the pages offer (the contract takes 1–365). */
export const PERIODS = [7, 30, 90, 365] as const;

export interface ReportFilters {
  days: number;
  /** A profile's slug, or `ALL_PROFILES` for every profile the person may enter. */
  profile: string;
  /** One agent, or `null` for all of them. */
  agent: string | null;
}

export const DEFAULT_FILTERS: ReportFilters = { days: 30, profile: ALL_PROFILES, agent: null };

/** Minutes east of UTC, so a day on the page is the person's own calendar day. */
export function utcOffsetMinutes(at: Date = new Date()): number {
  return -at.getTimezoneOffset();
}

function useReport<T>(path: '/audit/usage' | '/audit/skills', filters: ReportFilters) {
  const { client, profile, session } = useAuth();
  const all = filters.profile === ALL_PROFILES;
  // "All" still names a profile in the header, the one the person is in (ADR 0016).
  const scoped = all ? profile : filters.profile;
  const offset = utcOffsetMinutes();
  return useQuery({
    queryKey: ['audit', path, scoped, all, filters.days, filters.agent, offset],
    queryFn: async () =>
      (
        await client.request('get', path, {
          query: {
            days: filters.days,
            utc_offset_minutes: offset,
            ...(all ? { profiles: 'all' as const } : {}),
            ...(filters.agent ? { agent_id: filters.agent } : {}),
          },
          headers: { 'X-Hub-Profile': scoped },
        })
      ).data as unknown as T,
    enabled: !!session,
    // Switching the period keeps the last answer on screen until the next one lands.
    placeholderData: keepPreviousData,
  });
}

export const useUsageReport = (filters: ReportFilters) =>
  useReport<UsageReport>('/audit/usage', filters);
export const useSkillUsageReport = (filters: ReportFilters) =>
  useReport<SkillUsageReport>('/audit/skills', filters);

// ---------------------------------------------------------------- formatting

export interface Formats {
  number(value: number): string;
  compact(value: number): string;
  percent(share: number): string;
  day(date: string): string;
  dateTime(iso: string): string;
  money(money: Money, estimated: boolean): string;
}

export function formatsFor(language: 'ar' | 'en'): Formats {
  const locale = intlLocale(language);
  const number = new Intl.NumberFormat(locale);
  const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  // A report's dates are calendar days, not instants: read and written as UTC midnight.
  const day = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return {
    number: (value) => number.format(value),
    compact: (value) => compact.format(value),
    percent: (share) => percent.format(share),
    day: (date) => day.format(new Date(`${date}T00:00:00Z`)),
    dateTime: (iso) => dateTime.format(new Date(iso)),
    money: (money, estimated) => {
      const text = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: money.currency,
        maximumFractionDigits: 4,
      }).format(Number(money.amount));
      // An estimate from published prices says so; the provider's own figure does not.
      return estimated ? `≈ ${text}` : text;
    },
  };
}

// ------------------------------------------------------------------- usage

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** The daily chart's series: input and output always, the cache only where it was reported. */
export function usageSeries(report: UsageReport, t: Translate): ChartSeries[] {
  const series: ChartSeries[] = [
    { key: 'input_tokens', label: t('usage.input'), tone: 1 },
    { key: 'output_tokens', label: t('usage.output'), tone: 2 },
  ];
  if (report.totals.cache_read_tokens !== null)
    series.push({ key: 'cache_read_tokens', label: t('usage.cache_read'), tone: 3 });
  if (report.totals.cache_write_tokens !== null)
    series.push({ key: 'cache_write_tokens', label: t('usage.cache_write'), tone: 4 });
  return series;
}

export function usageBars(report: UsageReport, formats: Formats): ChartBar[] {
  return report.by_day.map((day) => ({
    key: day.date,
    label: formats.day(day.date),
    values: {
      input_tokens: day.input_tokens,
      output_tokens: day.output_tokens,
      cache_read_tokens: day.cache_read_tokens,
      cache_write_tokens: day.cache_write_tokens,
    },
  }));
}

/** The table under the chart: the days anything happened, newest first. */
export function activeDays(report: UsageReport): UsageReport['by_day'] {
  return report.by_day.filter((day) => day.runs > 0 || day.total_tokens > 0).reverse();
}

// ------------------------------------------------------------------ skills

const SKILL_TONES: readonly ChartTone[] = [1, 2, 3, 4, 5, 6];

/**
 * The skills chart's series: the period's six most used, each keeping its slot in that order,
 * and "other" only when a day had a skill outside them.
 */
export function skillSeries(report: SkillUsageReport, t: Translate): ChartSeries[] {
  const series: ChartSeries[] = report.top_series.map((skill, i) => ({
    key: skill,
    label: skill,
    tone: SKILL_TONES[i] ?? 'other',
  }));
  if (report.by_day.some((day) => day.other > 0))
    series.push({ key: '__other__', label: t('skills_usage.other'), tone: 'other' });
  return series;
}

export function skillBars(report: SkillUsageReport, formats: Formats): ChartBar[] {
  return report.by_day.map((day) => ({
    key: day.date,
    label: formats.day(day.date),
    values: { ...day.skills, __other__: day.other },
  }));
}
