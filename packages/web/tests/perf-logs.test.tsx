// Settings → Performance and Logs, live (DECISIONS §51): what each screen asks the hub,
// what it draws from the answer, and the pure rules under them — the sparkline's geometry,
// a tail appended without duplicates, the text a download saves.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { RealtimeProvider } from '../src/realtime/context.js';
import { LogsTool } from '../src/settings/LogsTool.js';
import { PerformanceTool, type LivePerformance } from '../src/settings/PerformanceTool.js';
import { appendTail, logText, sparklineRuns, type LogLine } from '../src/settings/live.js';

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

function mount(node: React.ReactElement, fetchImpl: typeof fetch) {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
  });
  return render(
    <ThemeProvider>
      <I18nProvider language="en">
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <RealtimeProvider>
              <MemoryRouter>{node}</MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

const json = (value: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  cleanup();
  setHidden(false);
  vi.useRealTimers();
});

describe('the pure rules', () => {
  it('draws a sparkline oldest to newest, leaves a gap for a missing value, caps at max', () => {
    expect(sparklineRuns([0, 50, null, 100, 200], 40, 10, 100)).toEqual(['0,10 10,5', '30,0 40,0']);
    expect(sparklineRuns([null, null], 40, 10)).toEqual([]);
    // One point sits at the end, where "now" is read.
    expect(sparklineRuns([5], 40, 10)).toEqual(['40,0']);
  });

  it('appends a tail without a line twice, keeping the newest up to the limit', () => {
    const line = (seq: number): LogLine => ({
      seq,
      at: '2026-09-25T10:00:00.000Z',
      level: 'info',
      source: 'hub',
      profile: null,
      message: `m${seq}`,
    });
    const shown = [line(1), line(2), line(3)];
    expect(appendTail(shown, [line(3), line(4), line(5)], 4).map((l) => l.seq)).toEqual([
      2, 3, 4, 5,
    ]);
  });

  it('saves a line as time, level, where it came from and what it said', () => {
    expect(
      logText([
        {
          seq: 1,
          at: '2026-09-25T10:00:00.000Z',
          level: 'warn',
          source: 'hermes',
          profile: 'work',
          message: 'slow',
        },
      ]),
    ).toBe('2026-09-25T10:00:00.000Z WARN  [hermes/work] slow\n');
  });
});

const PERFORMANCE: LivePerformance = {
  at: '2026-09-25T10:00:05.000Z',
  interval_seconds: 5,
  host: {
    platform: 'linux',
    measured_from: 'proc',
    cpu_count: 8,
    cpu_percent: 12.5,
    memory_total_bytes: 16 * 1024 ** 3,
    memory_used_bytes: 6 * 1024 ** 3,
    load: [0.42, 0.51, 0.6],
  },
  hub: {
    pid: 1,
    cpu_percent: 1.8,
    rss_bytes: 176 * 1024 ** 2,
    heap_used_bytes: 68 * 1024 ** 2,
    event_loop_lag_ms: 1.2,
    uptime_seconds: 90_061,
    node_version: 'v24.8.0',
  },
  processes: [
    {
      kind: 'tui_gateway',
      profile: null,
      pid: 58,
      state: 'running',
      cpu_percent: 0.4,
      rss_bytes: 217 * 1024 ** 2,
      uptime_seconds: 3_600,
    },
    {
      kind: 'gateway',
      profile: 'work',
      pid: null,
      state: 'error',
      cpu_percent: null,
      rss_bytes: null,
      uptime_seconds: null,
    },
  ],
  profiles: [{ profile: 'default', active_runs: 1, sessions: 42, sockets: 2 }],
  history: [
    {
      at: '2026-09-25T10:00:00.000Z',
      host_cpu_percent: 10,
      host_memory_used_bytes: 6 * 1024 ** 3,
      hub_cpu_percent: 1.5,
      hub_rss_bytes: 176 * 1024 ** 2,
      event_loop_lag_ms: 1.1,
      hermes_rss_bytes: 217 * 1024 ** 2,
    },
    {
      at: '2026-09-25T10:00:05.000Z',
      host_cpu_percent: 12.5,
      host_memory_used_bytes: 6 * 1024 ** 3,
      hub_cpu_percent: 1.8,
      hub_rss_bytes: 176 * 1024 ** 2,
      event_loop_lag_ms: 1.2,
      hermes_rss_bytes: 217 * 1024 ** 2,
    },
  ],
};

describe('Performance', () => {
  function performanceHub(body: LivePerformance = PERFORMANCE) {
    const calls: string[] = [];
    const fetchImpl = ((url: string) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      if (path.endsWith('/audit/performance/live')) return json(body);
      return json({ error: 'nope', code: 'not_found' }, 404);
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it('shows the host, the hub, every Hermes process and every profile, with sparklines', async () => {
    const { fetchImpl } = performanceHub();
    mount(<PerformanceTool />, fetchImpl);
    await waitFor(() => expect(screen.getByTestId('performance-live')).toBeTruthy());
    expect(within(screen.getByTestId('perf-host-cpu')).getByText('12.5%')).toBeTruthy();
    expect(
      within(screen.getByTestId('perf-host-memory')).getByText(
        '\u20666 GB\u2069 of \u206616 GB\u2069',
      ),
    ).toBeTruthy();
    expect(within(screen.getByTestId('perf-hub-lag')).getByText('1.2 ms')).toBeTruthy();
    expect(screen.getByTestId('perf-host-cpu-spark').getAttribute('data-points')).toBe('2');

    const hermes = screen.getByTestId('perf-hermes');
    expect(within(hermes).getByText('TUI gateway (conversations)')).toBeTruthy();
    expect(within(hermes).getByText('Messaging gateway · work')).toBeTruthy();
    expect(within(hermes).getByText('\u2066217 MB\u2069')).toBeTruthy();
    // A gateway that is not running has no numbers: a dash, never a zero.
    expect(within(hermes).getAllByText('—').length).toBeGreaterThanOrEqual(3);

    const profiles = screen.getByTestId('perf-profiles');
    expect(within(profiles).getByText('42')).toBeTruthy();
  });

  it('says so where the host has no /proc, and when the hub runs no Hermes', async () => {
    const { fetchImpl } = performanceHub({
      ...PERFORMANCE,
      host: { ...PERFORMANCE.host, measured_from: 'os', platform: 'darwin' },
      processes: [],
    });
    mount(<PerformanceTool />, fetchImpl);
    await waitFor(() => expect(screen.getByText(/no \/proc/)).toBeTruthy());
    expect(screen.getByTestId('perf-hermes-none')).toBeTruthy();
  });

  it('stops asking while the tab is hidden', async () => {
    const { fetchImpl } = performanceHub();
    mount(<PerformanceTool />, fetchImpl);
    await waitFor(() => expect(screen.getByTestId('performance-state').textContent).toBe('Live'));
    act(() => setHidden(true));
    await waitFor(() =>
      expect(screen.getByTestId('performance-state').textContent).toBe(
        'Paused while this tab is hidden',
      ),
    );
  });
});

describe('Logs', () => {
  const at = '2026-09-25T10:00:01.000Z';
  function logsHub() {
    const queries: URLSearchParams[] = [];
    let extra: LogLine[] = [];
    const base: LogLine[] = [
      { seq: 1, at, level: 'info', source: 'hub', profile: null, message: 'core hub listening' },
      {
        seq: 2,
        at,
        level: 'error',
        source: 'hermes',
        profile: 'work',
        message: 'ERROR bridge exited',
      },
    ];
    const fetchImpl = ((url: string) => {
      const parsed = new URL(String(url));
      if (!parsed.pathname.endsWith('/audit/logs/lines')) {
        return json({ error: 'nope', code: 'not_found' }, 404);
      }
      const params = parsed.searchParams;
      queries.push(params);
      const after = Number(params.get('after') ?? 0);
      const q = params.get('q')?.toLowerCase();
      const all = [...base, ...extra];
      const lines = all.filter(
        (line) =>
          line.seq > after &&
          (!q || line.message.toLowerCase().includes(q)) &&
          (params.get('source') !== 'errors' || line.level === 'error'),
      );
      return json({
        lines,
        last_seq: all.at(-1)!.seq,
        capacity: 5000,
        sources: [
          { source: 'hub', profile: null, lines: 1 },
          { source: 'hermes', profile: 'work', lines: 1 },
        ],
      });
    }) as unknown as typeof fetch;
    return {
      fetchImpl,
      queries,
      add: (line: LogLine) => {
        extra = [...extra, line];
      },
    };
  }

  it('shows each line with its level and where it came from', async () => {
    const { fetchImpl, queries } = logsHub();
    mount(<LogsTool />, fetchImpl);
    await waitFor(() => expect(screen.getByTestId('logs-lines')).toBeTruthy());
    const list = screen.getByTestId('logs-lines');
    expect(within(list).getByText('core hub listening')).toBeTruthy();
    expect(within(list).getByText('Hermes · work')).toBeTruthy();
    expect(within(list).getByText('ERROR')).toBeTruthy();
    expect(queries[0]!.get('source')).toBe('all');
    expect(queries[0]!.get('limit')).toBe('200');
    expect(queries[0]!.get('level')).toBe('debug');
  });

  it('asks the hub with the search, the source and the line count', async () => {
    const { fetchImpl, queries } = logsHub();
    mount(<LogsTool />, fetchImpl);
    await waitFor(() => expect(screen.getByTestId('logs-lines')).toBeTruthy());

    await userEvent.type(screen.getByTestId('logs-search'), 'BRIDGE');
    await waitFor(() => expect(queries.at(-1)!.get('q')).toBe('BRIDGE'));
    await waitFor(() =>
      expect(within(screen.getByTestId('logs-lines')).queryByText('core hub listening')).toBeNull(),
    );

    await userEvent.click(screen.getByTestId('logs-source-errors'));
    await waitFor(() => expect(queries.at(-1)!.get('source')).toBe('errors'));
    // "Errors only" is its own level; the level choice is not sent with it.
    expect(queries.at(-1)!.has('level')).toBe(false);

    await userEvent.click(screen.getByTestId('logs-limit-5000'));
    await waitFor(() => expect(queries.at(-1)!.get('limit')).toBe('5000'));
  });

  it('tails: asks for the lines after the newest it has and appends them', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { fetchImpl, queries, add } = logsHub();
    mount(<LogsTool />, fetchImpl);
    await waitFor(() => expect(screen.getByTestId('logs-lines')).toBeTruthy());
    add({ seq: 3, at, level: 'warn', source: 'hub', profile: null, message: 'a new line' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    await waitFor(() => expect(screen.getByText('a new line')).toBeTruthy());
    expect(queries.at(-1)!.get('after')).toBe('2');
    expect(screen.getByTestId('logs-count').textContent).toBe('3 lines shown');
  });

  it('downloads what is shown, as text', async () => {
    const { fetchImpl } = logsHub();
    const saved: Blob[] = [];
    const create = vi.fn((blob: Blob) => {
      saved.push(blob);
      return 'blob:logs';
    });
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    mount(<LogsTool />, fetchImpl);
    await waitFor(() => expect(screen.getByTestId('logs-lines')).toBeTruthy());
    await userEvent.click(screen.getByTestId('logs-download'));
    expect(saved).toHaveLength(1);
    const text = await saved[0]!.text();
    expect(text).toContain('[hub] core hub listening');
    expect(text).toContain('ERROR [hermes/work] ERROR bridge exited');
  });
});
