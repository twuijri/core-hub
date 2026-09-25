/**
 * The Usage and Skills usage pages (contract decision §50).
 *
 * The pure rules first — which series a chart has, which days the table lists, how money
 * reads — then the pages: cards that say "not reported" instead of zeros, the cost only while
 * `show_cost` is on, an agent that reports no usage said to be one, the daily chart and its
 * keyboard readout, and the Skills usage cards, table and "counting started" line. Last, the
 * whole Usage page against a scripted hub: switching the period asks again for that period.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { createTranslator } from '../src/i18n/index.js';
import { SkillsUsageBody } from '../src/settings/usage/SkillsUsagePage.js';
import { UsageBody, UsagePage } from '../src/settings/usage/UsagePage.js';
import {
  activeDays,
  formatsFor,
  skillBars,
  skillSeries,
  usageSeries,
  type SkillUsageReport,
  type UsageReport,
} from '../src/settings/usage/report.js';
import { StackedBarChart } from '../src/ui/index.js';

const HERMES = '01J8QK3ZR2W7M5N4P6T8V9X0A1';
const CODER = '01J8QK3ZR2W7M5N4P6T8V9X0A2';
const t = createTranslator('en');
const en = formatsFor('en');

function day(date: string, over: Partial<UsageReport['by_day'][number]> = {}) {
  return {
    date,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 0,
    runs: 0,
    conversations: 0,
    cost: null,
    ...over,
  };
}

function usage(over: Partial<UsageReport> = {}, totals: Partial<UsageReport['totals']> = {}) {
  return {
    period: { from: '2026-09-23', to: '2026-09-25', days: 3 },
    generated_at: '2026-09-25T09:00:00Z',
    profiles: ['default'],
    agents: [
      { agent_id: CODER, name: 'Claude Code', reports_usage: false },
      { agent_id: HERMES, name: 'Hermes', reports_usage: true },
    ],
    totals: {
      input_tokens: 1_200,
      output_tokens: 300,
      cache_read_tokens: null,
      cache_write_tokens: null,
      reasoning_tokens: 0,
      total_tokens: 1_500,
      cache_hit_rate: null,
      runs: 5,
      unreported_runs: 2,
      conversations: 3,
      conversations_per_day: 1.33,
      cost: { amount: '0.012000', currency: 'USD' },
      cost_source: 'estimated',
      ...totals,
    },
    by_day: [
      day('2026-09-23', {
        input_tokens: 200,
        output_tokens: 100,
        total_tokens: 300,
        runs: 1,
        conversations: 1,
      }),
      day('2026-09-24'),
      day('2026-09-25', {
        input_tokens: 1_000,
        output_tokens: 200,
        total_tokens: 1_200,
        runs: 4,
        conversations: 2,
      }),
    ],
    by_model: [
      {
        model: 'gpt-5.1',
        input_tokens: 1_200,
        output_tokens: 300,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_tokens: 1_500,
        share: 1,
        runs: 3,
        cost: { amount: '0.012000', currency: 'USD' },
      },
    ],
    by_agent: [
      {
        agent_id: HERMES,
        name: 'Hermes',
        reports_usage: true,
        runs: 3,
        conversations: 2,
        input_tokens: 1_200,
        output_tokens: 300,
        total_tokens: 1_500,
        share: 1,
        cost: { amount: '0.012000', currency: 'USD' },
      },
      {
        agent_id: CODER,
        name: 'Claude Code',
        reports_usage: false,
        runs: 2,
        conversations: 1,
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        share: null,
        cost: null,
      },
    ],
    ...over,
  } as UsageReport;
}

function skills(over: Partial<SkillUsageReport> = {}): SkillUsageReport {
  return {
    period: { from: '2026-09-24', to: '2026-09-25', days: 2 },
    generated_at: '2026-09-25T09:00:00Z',
    profiles: ['default'],
    counting_since: '2026-09-20T08:00:00Z',
    agents: [{ agent_id: HERMES, name: 'Hermes', reports_usage: true }],
    totals: {
      uses: 9,
      distinct_skills: 2,
      top_skill: { skill: 'arxiv', uses: 7 },
      never_used_count: null,
    },
    top_series: ['arxiv', 'github-pr-workflow'],
    by_day: [
      { date: '2026-09-24', uses: 4, skills: { arxiv: 3, 'github-pr-workflow': 1 }, other: 0 },
      { date: '2026-09-25', uses: 5, skills: { arxiv: 4, 'github-pr-workflow': 1 }, other: 0 },
    ],
    top_skills: [
      { skill: 'arxiv', uses: 7, share: 0.7778, last_used_at: '2026-09-25T08:40:00Z' },
      { skill: 'github-pr-workflow', uses: 2, share: 0.2222, last_used_at: '2026-09-24T17:02:00Z' },
    ],
    never_used: null,
    ...over,
  };
}

const withI18n = (children: ReactNode, language: 'ar' | 'en' = 'en') => (
  <ThemeProvider>
    <I18nProvider language={language}>{children}</I18nProvider>
  </ThemeProvider>
);

afterEach(cleanup);

describe('what a report draws', () => {
  it('has a cache series only where the cache was reported', () => {
    expect(usageSeries(usage(), t).map((s) => s.key)).toEqual(['input_tokens', 'output_tokens']);
    const cached = usage({}, { cache_read_tokens: 40, cache_write_tokens: 10 });
    expect(usageSeries(cached, t).map((s) => s.key)).toEqual([
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_write_tokens',
    ]);
  });

  it('lists the days anything happened, newest first', () => {
    expect(activeDays(usage()).map((d) => d.date)).toEqual(['2026-09-25', '2026-09-23']);
  });

  it('keeps each top skill in its own slot, and adds "other" only when there is some', () => {
    expect(skillSeries(skills(), t).map((s) => [s.key, s.tone])).toEqual([
      ['arxiv', 1],
      ['github-pr-workflow', 2],
    ]);
    const withOther = skills({
      by_day: [{ date: '2026-09-25', uses: 3, skills: { arxiv: 2 }, other: 1 }],
    });
    expect(skillSeries(withOther, t).at(-1)).toMatchObject({ key: '__other__', tone: 'other' });
    expect(skillBars(withOther, en)[0]!.values).toEqual({ arxiv: 2, __other__: 1 });
  });

  it('writes an estimate as one, and the provider’s own figure plainly', () => {
    expect(en.money({ amount: '0.012000', currency: 'USD' }, true)).toBe('≈ $0.012');
    expect(en.money({ amount: '1.500000', currency: 'USD' }, false)).toBe('$1.50');
    expect(en.day('2026-09-25')).toBe('Sep 25');
  });
});

describe('the Usage page', () => {
  it('says "not reported" for a cache nobody reported, never 0', () => {
    render(withI18n(<UsageBody report={usage()} formats={en} showCost={false} />));
    const cache = screen.getByTestId('usage-card-cache');
    expect(within(cache).getByText('Not reported')).toBeTruthy();
    expect(
      within(screen.getByTestId('usage-card-hit-rate')).getByText('Not reported'),
    ).toBeTruthy();
    expect(within(screen.getByTestId('usage-card-tokens')).getByText('1.5K')).toBeTruthy();
    expect(screen.getByText('1.2K in · 300 out')).toBeTruthy();
  });

  it('shows a reported cache and its hit rate as numbers', () => {
    const report = usage({}, { cache_read_tokens: 600, cache_hit_rate: 0.3333 });
    render(withI18n(<UsageBody report={report} formats={en} showCost={false} />));
    expect(within(screen.getByTestId('usage-card-cache')).getByText('600')).toBeTruthy();
    expect(within(screen.getByTestId('usage-card-hit-rate')).getByText('33.3%')).toBeTruthy();
  });

  it('shows the cost only while "show cost" is on, as an estimate', () => {
    const { rerender } = render(
      withI18n(<UsageBody report={usage()} formats={en} showCost={false} />),
    );
    expect(screen.queryByTestId('usage-card-cost')).toBeNull();
    rerender(withI18n(<UsageBody report={usage()} formats={en} showCost />));
    expect(within(screen.getByTestId('usage-card-cost')).getByText('≈ $0.012')).toBeTruthy();
  });

  it('says so when nothing was priced, rather than showing $0', () => {
    const report = usage({}, { cost: null, cost_source: 'unknown' });
    render(withI18n(<UsageBody report={report} formats={en} showCost />));
    const card = screen.getByTestId('usage-card-cost');
    expect(within(card).getByText('Not reported')).toBeTruthy();
    expect(within(card).queryByText(/\$0/)).toBeNull();
  });

  it('names an agent that reports no usage, and counts its runs without tokens', () => {
    render(withI18n(<UsageBody report={usage()} formats={en} showCost={false} />));
    expect(screen.getByTestId('usage-unreported').textContent).toContain('2 runs');
    const agents = screen.getByTestId('usage-by-agent');
    expect(within(agents).getByText('Claude Code')).toBeTruthy();
    expect(within(agents).getByText(/Reports no usage/)).toBeTruthy();
    expect(within(agents).getByText('100% · 1,500 tokens')).toBeTruthy();
    expect(within(screen.getByTestId('usage-by-model')).getByText('gpt-5.1')).toBeTruthy();
  });

  it('draws one bar a day and a table of the active days', () => {
    render(withI18n(<UsageBody report={usage()} formats={en} showCost={false} />));
    expect(screen.getAllByTestId('usage-chart-bar')).toHaveLength(3);
    const rows = within(screen.getByTestId('usage-days')).getAllByRole('row');
    expect(rows).toHaveLength(3); // the header and two active days
    expect(rows[1]!.textContent).toContain('Sep 25');
  });

  it('is an honest empty page when nothing ran', () => {
    const empty = usage(
      { by_day: [day('2026-09-25')], by_model: [], by_agent: [], agents: [] },
      {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        runs: 0,
        unreported_runs: 0,
        conversations: 0,
        conversations_per_day: 0,
        cost: null,
        cost_source: 'unknown',
      },
    );
    render(withI18n(<UsageBody report={empty} formats={en} showCost={false} />));
    expect(screen.getAllByText('Nothing ran in this period.').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('usage-unreported')).toBeNull();
  });
});

describe('the daily chart', () => {
  const series = [
    { key: 'a', label: 'Input', tone: 1 as const },
    { key: 'b', label: 'Output', tone: 2 as const },
  ];
  const bars = [
    { key: '1', label: 'Sep 23', values: { a: 1, b: 1 } },
    { key: '2', label: 'Sep 24', values: { a: 0, b: 0 } },
    { key: '3', label: 'Sep 25', values: { a: 5, b: 2 } },
  ];

  it('reads out the last day with data, and moves with the arrow keys', () => {
    render(
      withI18n(
        <StackedBarChart label="Tokens" series={series} bars={bars} format={String} testId="c" />,
      ),
    );
    const readout = screen.getByTestId('c-readout');
    expect(readout.textContent).toContain('Sep 25');
    expect(readout.textContent).toContain('Input 5');
    const plot = screen.getByRole('group', { name: 'Tokens' }).querySelector('.ch-chart-plot')!;
    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    expect(readout.textContent).toContain('Sep 24');
    fireEvent.mouseEnter(screen.getAllByTestId('c-bar')[0]!);
    expect(readout.textContent).toContain('Sep 23');
    // A legend is always there: colour is never the only way to tell the series apart.
    expect(screen.getByText('Output')).toBeTruthy();
  });

  it('draws nothing for a day with nothing, and never a zero-height segment', () => {
    render(withI18n(<StackedBarChart label="T" series={series} bars={bars} format={String} />));
    const cols = document.querySelectorAll('.ch-chart-col');
    expect(cols[1]!.querySelectorAll('.ch-chart-seg')).toHaveLength(0);
    expect(cols[2]!.querySelectorAll('.ch-chart-seg')).toHaveLength(2);
  });
});

describe('the Skills usage page', () => {
  it('shows the four cards, the ranking and from when it has counted', () => {
    render(withI18n(<SkillsUsageBody report={skills()} formats={en} />));
    expect(within(screen.getByTestId('skills-card-uses')).getByText('9')).toBeTruthy();
    expect(within(screen.getByTestId('skills-card-distinct')).getByText('2')).toBeTruthy();
    const top = screen.getByTestId('skills-card-top');
    expect(within(top).getByText('arxiv')).toBeTruthy();
    expect(within(top).getByText('7 uses')).toBeTruthy();
    // The hub cannot see the installed skills: unknown, not "0 never used".
    expect(within(screen.getByTestId('skills-card-never')).getByText('Unknown')).toBeTruthy();
    expect(screen.getByTestId('skills-counting-since').textContent).toMatch(/Counting started on/);
    const rows = within(screen.getByTestId('skills-table')).getAllByRole('row');
    expect(rows[1]!.textContent).toContain('arxiv');
    expect(rows[1]!.textContent).toContain('77.8%');
    expect(screen.getAllByTestId('skills-chart-bar')).toHaveLength(2);
  });

  it('lists the skills never used when the hub can see them', () => {
    const report = skills({
      totals: {
        uses: 9,
        distinct_skills: 2,
        top_skill: { skill: 'arxiv', uses: 7 },
        never_used_count: 1,
      },
      never_used: ['ocr-and-documents'],
    });
    render(withI18n(<SkillsUsageBody report={report} formats={en} />));
    expect(within(screen.getByTestId('skills-card-never')).getByText('1')).toBeTruthy();
    expect(
      within(screen.getByTestId('skills-never-used')).getByText('ocr-and-documents'),
    ).toBeTruthy();
  });

  it('says nothing was loaded instead of drawing an empty chart', () => {
    const report = skills({
      totals: { uses: 0, distinct_skills: 0, top_skill: null, never_used_count: 3 },
      top_series: [],
      by_day: [{ date: '2026-09-25', uses: 0, skills: {}, other: 0 }],
      top_skills: [],
    });
    render(withI18n(<SkillsUsageBody report={report} formats={en} />, 'ar'));
    expect(screen.queryByTestId('skills-chart')).toBeNull();
    expect(screen.getAllByText('لم تُحمَّل أي مهارة في هذه المدة.').length).toBeGreaterThan(0);
    expect(within(screen.getByTestId('skills-card-top')).getByText('لا شيء')).toBeTruthy();
  });
});

describe('the Usage page against the hub', () => {
  function memoryStorage(): Storage {
    const map = new Map<string, string>();
    return {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
      clear: () => map.clear(),
      key: () => null,
      length: 0,
    };
  }

  it('asks for the period chosen, in the person’s calendar, across every profile', async () => {
    const store = new SessionStore(memoryStorage());
    store.save({
      profile: 'default',
      token: 't',
      refresh_token: null,
      expires_at: null,
      user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
    });
    const asked: URL[] = [];
    const json = (body: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const fetchImpl: typeof fetch = (input) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname.endsWith('/audit/usage')) {
        asked.push(url);
        return json(usage());
      }
      if (url.pathname.endsWith('/auth/me/preferences')) return json({ show_cost: true });
      if (url.pathname.endsWith('/profiles')) return json({ items: [] });
      return json({});
    };
    render(
      <ThemeProvider>
        <I18nProvider language="en">
          <QueryClientProvider
            client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
          >
            <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
              <UsagePage />
            </AuthProvider>
          </QueryClientProvider>
        </I18nProvider>
      </ThemeProvider>,
    );
    await screen.findByTestId('usage-totals');
    expect(asked[0]!.searchParams.get('days')).toBe('30');
    expect(asked[0]!.searchParams.get('profiles')).toBe('all');
    expect(asked[0]!.searchParams.get('utc_offset_minutes')).toBe(
      String(-new Date().getTimezoneOffset()),
    );
    expect(await screen.findByTestId('usage-card-cost')).toBeTruthy();

    fireEvent.click(screen.getByTestId('report-days-7'));
    await waitFor(() => expect(asked.at(-1)!.searchParams.get('days')).toBe('7'));
  });
});
