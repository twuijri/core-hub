/**
 * The Trajectory tab (contract decision §42; owner, 2026-09-25).
 *
 * The pure rules first — filters, search, the shared time axis with idle time folded,
 * parallel calls on their own rows — then the view against a scripted hub: the lanes and
 * their bars, a failed call in the danger state, a step that expands to its tool's
 * arguments and result, and a metrics footer that shows only what the hub sent.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { TrajectoryView } from '../src/chat/TrajectoryView.js';
import {
  NO_FILTER,
  axisOf,
  filterSteps,
  formatMs,
  packRows,
  revisionOf,
  type Trajectory,
  type TrajectoryStep,
} from '../src/chat/trajectory.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { PaneProvider } from '../src/shell/pane.js';

const SESSION = '01J8QK3ZR2W7M5N4P6T8V9X0YA';
const T0 = Date.parse('2026-09-25T10:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

function step(id: string, over: Partial<TrajectoryStep>): TrajectoryStep {
  return {
    id,
    kind: 'turn',
    lane: 'model',
    exchange: 1,
    run_id: null,
    message_id: null,
    status: 'succeeded',
    started_at: null,
    ended_at: null,
    duration_ms: null,
    text: null,
    tool_call_only: false,
    first_token_ms: null,
    tool_call: null,
    ...over,
  };
}

const INPUT = step('in', {
  kind: 'input',
  lane: 'input',
  text: 'Run the tests',
  started_at: at(0),
  ended_at: at(0),
  duration_ms: 0,
});
const TURN = step('t1', {
  text: 'Let me check.',
  started_at: at(100),
  ended_at: at(400),
  duration_ms: 300,
  first_token_ms: 120,
});
const TOOL = step('tool-1', {
  kind: 'tool',
  lane: 'tools',
  status: 'failed',
  started_at: at(400),
  ended_at: at(2400),
  duration_ms: 2000,
  tool_call: {
    id: 'tool-1',
    name: 'shell',
    status: 'failed',
    preview: 'pnpm test',
    arguments: { command: 'pnpm test' },
    output: '2 failed, 118 passed',
    output_truncated: false,
    duration_ms: 2000,
    subagent_id: null,
    started_at: at(400),
    finished_at: at(2400),
  },
});
const ANSWER = step('t2', {
  text: 'Two tests fail.',
  started_at: at(2400),
  ended_at: at(2900),
  duration_ms: 500,
});
const STEPS = [INPUT, TURN, TOOL, ANSWER];

describe('the trajectory rules', () => {
  it('narrows to turns or calls, searches arguments and results, and sorts by duration', () => {
    const ids = (filter: Partial<typeof NO_FILTER>) =>
      filterSteps(STEPS, { ...NO_FILTER, ...filter }, T0).map((s) => s.id);
    expect(ids({})).toEqual(['in', 't1', 'tool-1', 't2']);
    expect(ids({ turns: true })).toEqual(['t1', 't2']);
    expect(ids({ calls: true })).toEqual(['tool-1']);
    expect(ids({ turns: true, calls: true })).toEqual(['t1', 'tool-1', 't2']);
    expect(ids({ query: '118 PASSED' })).toEqual(['tool-1']);
    expect(ids({ query: 'command' })).toEqual(['tool-1']);
    expect(ids({ byDuration: true })).toEqual(['tool-1', 't2', 't1', 'in']);
  });

  it('places steps on one axis and folds a long idle gap', () => {
    // Two stretches of work an hour apart: the hour is drawn as one fold, not an hour.
    const axis = axisOf(
      [
        [0, 1000],
        [3_600_000, 3_601_000],
      ],
      3000,
      500,
    );
    expect(axis.at(0)).toBe(0);
    expect(axis.at(1000)).toBeCloseTo(1000 / 2500);
    expect(axis.at(3_600_000)).toBeCloseTo(1500 / 2500);
    expect(axis.at(3_601_000)).toBe(1);
    expect(axis.folds).toHaveLength(1);
    // A short pause is time, not a fold.
    expect(
      axisOf([
        [0, 1000],
        [2000, 3000],
      ]).folds,
    ).toEqual([]);
  });

  it('gives parallel calls their own rows', () => {
    expect(
      packRows([
        [0, 1000],
        [500, 1500],
        [1200, 2000],
      ]),
    ).toEqual([0, 1, 0]);
  });

  it('writes durations as people read them', () => {
    const units = { ms: 'ms', s: 's', min: 'min' };
    expect(formatMs(850, units)).toBe('850 ms');
    expect(formatMs(4200, units)).toBe('4.2 s');
    expect(formatMs(192_000, units)).toBe('3 min 12 s');
  });

  it('changes its revision when a tool call finishes or text arrives', () => {
    const message = (status: string, text: string) => ({
      id: 'm',
      status: 'streaming',
      content: [{ type: 'text', text }],
      tool_calls: [{ status }],
    });
    const base = revisionOf([message('running', 'a')], { r: { status: 'running' } });
    expect(revisionOf([message('succeeded', 'a')], { r: { status: 'running' } })).not.toBe(base);
    expect(revisionOf([message('running', 'ab')], { r: { status: 'running' } })).not.toBe(base);
    expect(revisionOf([message('running', 'a')], { r: { status: 'running' } })).toBe(base);
  });
});

// ------------------------------------------------------------------------ view

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

function trajectory(over: Partial<Trajectory> = {}): Trajectory {
  return {
    session_id: SESSION,
    generated_at: at(3000),
    live: false,
    timing: 'full',
    started_at: at(0),
    ended_at: at(2900),
    steps: STEPS,
    metrics: {
      exchanges: 1,
      turns: 2,
      steps: 4,
      tool_calls: 1,
      failed_tool_calls: 1,
      model_ms: 800,
      tool_ms: 2000,
      avg_first_token_ms: 120,
      output_tokens_per_second: null,
      cache_hit_pct: null,
      input_tokens: 900,
      output_tokens: null,
    },
    ...over,
  };
}

function mount(document: Trajectory) {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
  });
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify(document), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  render(
    <ThemeProvider>
      <I18nProvider language="en">
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <PaneProvider>
              <TrajectoryView sessionId={SESSION} revision="r1" />
            </PaneProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

afterEach(cleanup);

describe('the Trajectory tab', () => {
  it('draws three lanes, the failed call in danger, and expands a call to its details', async () => {
    mount(trajectory());
    const timeline = await screen.findByTestId('trajectory-timeline');
    for (const lane of ['input', 'model', 'tools']) {
      expect(within(timeline).getByTestId(`trajectory-lane-${lane}`)).toBeInTheDocument();
    }
    const tools = within(screen.getByTestId('trajectory-lane-tools'));
    const bar = tools.getByTestId('trajectory-bar');
    expect(bar).toHaveAttribute('data-status', 'failed');
    expect(bar).toHaveAttribute('aria-label', '3. shell · 2.0 s');

    const rows = screen.getAllByTestId('trajectory-step');
    expect(rows).toHaveLength(4);
    const toolRow = rows[2]!;
    expect(toolRow).toHaveAttribute('data-status', 'failed');
    expect(toolRow.textContent).toContain('pnpm test');
    expect(toolRow.textContent).toContain('2 failed, 118 passed');
    fireEvent.click(within(toolRow).getByTestId('trajectory-step-toggle'));
    const body = within(toolRow).getByTestId('trajectory-step-body');
    expect(body.textContent).toContain('"command": "pnpm test"');
    expect(body.textContent).toContain('Result');
  });

  it('filters by kind and by words', async () => {
    mount(trajectory());
    await screen.findByTestId('trajectory-steps');
    fireEvent.click(screen.getByTestId('trajectory-filter-calls'));
    expect(screen.getAllByTestId('trajectory-step')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('trajectory-filter-calls'));
    fireEvent.change(screen.getByTestId('trajectory-search'), { target: { value: 'nothing' } });
    expect(screen.getByTestId('trajectory-no-match')).toBeInTheDocument();
  });

  it('shows only the metrics the hub has, never a zero in place of a missing one', async () => {
    mount(trajectory());
    const footer = await screen.findByTestId('trajectory-metrics');
    const shown = [...footer.querySelectorAll('[data-metric]')].map((node) =>
      node.getAttribute('data-metric'),
    );
    expect(shown).toEqual([
      'turns',
      'steps',
      'model_time',
      'tool_time',
      'first_token',
      'input_tokens',
    ]);
  });

  it('lists an older conversation without a timeline, and says why', async () => {
    const untimed = STEPS.map((s) => ({
      ...s,
      started_at: null,
      ended_at: null,
      duration_ms: null,
    }));
    mount(
      trajectory({
        timing: 'none',
        started_at: null,
        ended_at: null,
        steps: untimed,
        metrics: {
          ...trajectory().metrics,
          model_ms: null,
          tool_ms: null,
          avg_first_token_ms: null,
          input_tokens: null,
        },
      }),
    );
    expect(await screen.findByTestId('trajectory-untimed')).toBeInTheDocument();
    expect(screen.queryByTestId('trajectory-timeline')).toBeNull();
    expect(screen.getAllByTestId('trajectory-step')).toHaveLength(4);
    const footer = screen.getByTestId('trajectory-metrics');
    expect(footer.querySelectorAll('[data-metric]')).toHaveLength(2);
  });
});
