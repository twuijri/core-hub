/**
 * Settings → Performance, live (`audit.getLivePerformance`, contract decision §51).
 *
 * The hub measures when asked, so this screen asks every five seconds while it is on
 * screen and not at all while the tab is hidden. Each figure has a sparkline of the minutes
 * somebody was watching. A number the host cannot give (no `/proc`) reads as "—", never 0.
 */
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/context.js';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { Badge, Card, Notice, Spinner, Table, type Column } from '../ui/index.js';
import { Sparkline } from './Sparkline.js';
import { usePageVisible } from './live.js';

interface HermesProcess {
  kind: 'tui_gateway' | 'dashboard' | 'gateway';
  profile: string | null;
  pid: number | null;
  state: string;
  cpu_percent: number | null;
  rss_bytes: number | null;
  uptime_seconds: number | null;
}

interface ProfileRow {
  profile: string;
  active_runs: number;
  sessions: number;
  sockets: number;
}

interface HistoryPoint {
  at: string;
  host_cpu_percent: number | null;
  host_memory_used_bytes: number;
  hub_cpu_percent: number | null;
  hub_rss_bytes: number;
  event_loop_lag_ms: number | null;
  hermes_rss_bytes: number | null;
}

export interface LivePerformance {
  at: string;
  interval_seconds: number;
  host: {
    platform: string;
    measured_from: 'proc' | 'os';
    cpu_count: number;
    cpu_percent: number | null;
    memory_total_bytes: number;
    memory_used_bytes: number;
    load: number[] | null;
  };
  hub: {
    pid: number;
    cpu_percent: number | null;
    rss_bytes: number;
    heap_used_bytes: number;
    event_loop_lag_ms: number | null;
    uptime_seconds: number;
    node_version: string;
  };
  processes: HermesProcess[];
  profiles: ProfileRow[];
  history: HistoryPoint[];
}

const INTERVAL_MS = 5_000;

export function PerformanceTool() {
  const { t, language } = useI18n();
  const { client, session } = useAuth();
  const visible = usePageVisible();
  const live = useQuery({
    queryKey: ['audit', 'performance', 'live'],
    queryFn: async () =>
      (await client.request('get', '/audit/performance/live', {})).data as LivePerformance,
    enabled: !!session,
    refetchInterval: visible ? INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });

  const format = useFormat(language);

  if (live.isPending) return <Spinner label={t('common.loading')} />;
  if (live.isError && !live.data) {
    return <Notice tone="danger">{describeError(live.error, t)}</Notice>;
  }
  const data = live.data!;
  const history = data.history;
  const { host, hub } = data;

  return (
    <div className="flex flex-col gap-4" data-testid="performance-live">
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Badge tone={visible ? 'success' : 'neutral'} testId="performance-state">
          {visible ? t('perf.live') : t('perf.paused')}
        </Badge>
        <span>{t('perf.every', { count: format.number(data.interval_seconds) })}</span>
        <time dateTime={data.at}>{t('perf.at', { time: format.time(data.at) })}</time>
      </p>
      {live.isError && <Notice tone="warning">{describeError(live.error, t)}</Notice>}
      {host.measured_from === 'os' && <Notice>{t('perf.no_proc')}</Notice>}

      <div className="ch-perf-grid">
        <Card as="section" aria-labelledby="perf-host" testId="performance-host">
          <h3 id="perf-host" className="ch-perf-title">
            {t('perf.host')}
          </h3>
          <Metric
            label={t('perf.cpu')}
            value={format.percent(host.cpu_percent)}
            hint={t('perf.cores', { count: format.number(host.cpu_count) })}
            series={history.map((point) => point.host_cpu_percent)}
            max={100}
            testId="perf-host-cpu"
          />
          <Metric
            label={t('perf.memory')}
            value={t('perf.of', {
              used: format.bytes(host.memory_used_bytes),
              total: format.bytes(host.memory_total_bytes),
            })}
            series={history.map((point) => point.host_memory_used_bytes)}
            max={host.memory_total_bytes}
            testId="perf-host-memory"
          />
          <Metric
            label={t('perf.load')}
            value={host.load ? host.load.map((value) => format.decimal(value)).join(' · ') : '—'}
            hint={t('perf.load_hint')}
          />
        </Card>

        <Card as="section" aria-labelledby="perf-hub" testId="performance-hub">
          <h3 id="perf-hub" className="ch-perf-title">
            {t('perf.hub')}
          </h3>
          <Metric
            label={t('perf.cpu')}
            value={format.percent(hub.cpu_percent)}
            hint={t('perf.one_core')}
            series={history.map((point) => point.hub_cpu_percent)}
            testId="perf-hub-cpu"
          />
          <Metric
            label={t('perf.rss')}
            value={format.bytes(hub.rss_bytes)}
            hint={t('perf.heap', { size: format.bytes(hub.heap_used_bytes) })}
            series={history.map((point) => point.hub_rss_bytes)}
            testId="perf-hub-rss"
          />
          <Metric
            label={t('perf.lag')}
            value={
              hub.event_loop_lag_ms === null
                ? '—'
                : t('perf.ms', { count: format.decimal(hub.event_loop_lag_ms) })
            }
            series={history.map((point) => point.event_loop_lag_ms)}
            testId="perf-hub-lag"
          />
          <Metric
            label={t('perf.uptime')}
            value={format.duration(hub.uptime_seconds)}
            hint={`PID ${hub.pid} · Node ${hub.node_version}`}
          />
        </Card>
      </div>

      <HermesTable processes={data.processes} history={history} format={format} />
      <ProfilesTable profiles={data.profiles} format={format} />
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  series,
  max,
  testId,
}: {
  label: string;
  value: string;
  hint?: string;
  series?: ReadonlyArray<number | null>;
  max?: number;
  testId?: string;
}) {
  return (
    <div className="ch-perf-metric" data-testid={testId}>
      <div className="flex flex-col">
        <span className="text-xs text-muted">{label}</span>
        <span className="ch-perf-value">{value}</span>
        {hint && <span className="text-xs text-faint">{hint}</span>}
      </div>
      {series && (
        <Sparkline
          values={series}
          label={label}
          {...(max !== undefined ? { max } : {})}
          {...(testId ? { testId: `${testId}-spark` } : {})}
        />
      )}
    </div>
  );
}

type Format = ReturnType<typeof useFormat>;

function HermesTable({
  processes,
  history,
  format,
}: {
  processes: HermesProcess[];
  history: HistoryPoint[];
  format: Format;
}) {
  const { t } = useI18n();
  const name = (row: HermesProcess) =>
    row.kind === 'gateway'
      ? t('perf.kind_gateway', { profile: row.profile ?? 'default' })
      : t(`perf.kind_${row.kind}`);
  const columns: Array<Column<HermesProcess>> = [
    { key: 'name', header: t('perf.process'), cell: (row) => name(row) },
    { key: 'pid', header: 'PID', cell: (row) => (row.pid === null ? '—' : String(row.pid)) },
    {
      key: 'state',
      header: t('perf.state'),
      cell: (row) => (
        <Badge
          tone={row.state === 'running' ? 'success' : row.state === 'error' ? 'danger' : 'neutral'}
        >
          {row.state}
        </Badge>
      ),
    },
    { key: 'cpu', header: t('perf.cpu'), cell: (row) => format.percent(row.cpu_percent) },
    {
      key: 'rss',
      header: t('perf.rss'),
      cell: (row) => (row.rss_bytes === null ? '—' : format.bytes(row.rss_bytes)),
    },
    {
      key: 'uptime',
      header: t('perf.uptime'),
      cell: (row) => (row.uptime_seconds === null ? '—' : format.duration(row.uptime_seconds)),
    },
  ];
  return (
    <section aria-labelledby="perf-hermes" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="perf-hermes" className="ch-perf-title">
          {t('perf.hermes')}
        </h3>
        {processes.length > 0 && (
          <Sparkline
            values={history.map((point) => point.hermes_rss_bytes)}
            label={t('perf.hermes_rss')}
            testId="perf-hermes-spark"
          />
        )}
      </div>
      {processes.length === 0 ? (
        <p className="text-sm text-muted" data-testid="perf-hermes-none">
          {t('perf.hermes_none')}
        </p>
      ) : (
        <Table
          caption={t('perf.hermes')}
          columns={columns}
          rows={processes}
          rowKey={(row) => `${row.kind}:${row.profile ?? ''}:${row.pid ?? ''}`}
          testId="perf-hermes"
        />
      )}
    </section>
  );
}

function ProfilesTable({ profiles, format }: { profiles: ProfileRow[]; format: Format }) {
  const { t } = useI18n();
  const columns: Array<Column<ProfileRow>> = [
    { key: 'profile', header: t('perf.profile'), cell: (row) => row.profile },
    { key: 'runs', header: t('perf.active_runs'), cell: (row) => format.number(row.active_runs) },
    { key: 'sessions', header: t('perf.sessions'), cell: (row) => format.number(row.sessions) },
    { key: 'sockets', header: t('perf.sockets'), cell: (row) => format.number(row.sockets) },
  ];
  return (
    <section aria-labelledby="perf-profiles" className="flex flex-col gap-2">
      <h3 id="perf-profiles" className="ch-perf-title">
        {t('perf.profiles')}
      </h3>
      <Table
        caption={t('perf.profiles')}
        columns={columns}
        rows={profiles}
        rowKey={(row) => row.profile}
        testId="perf-profiles"
      />
    </section>
  );
}

function useFormat(language: string) {
  const { t } = useI18n();
  const locale = language === 'ar' ? 'ar' : 'en';
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const decimal = (value: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  return {
    number,
    decimal,
    percent: (value: number | null) =>
      value === null
        ? '—'
        : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)}%`,
    bytes(value: number) {
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let size = value;
      let unit = 0;
      while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit += 1;
      }
      // Isolated left-to-right, so "484 MB" does not read "MB 484" inside an Arabic line.
      return `\u2066${new Intl.NumberFormat(locale, { maximumFractionDigits: unit >= 3 ? 1 : 0 }).format(size)} ${units[unit]}\u2069`;
    },
    duration(seconds: number) {
      const days = Math.floor(seconds / 86_400);
      const hours = Math.floor((seconds % 86_400) / 3_600);
      const minutes = Math.floor((seconds % 3_600) / 60);
      if (days > 0) return t('perf.dh', { d: number(days), h: number(hours) });
      if (hours > 0) return t('perf.hm', { h: number(hours), m: number(minutes) });
      if (minutes > 0) return t('perf.m', { m: number(minutes) });
      return t('perf.s', { s: number(Math.floor(seconds)) });
    },
    time: (iso: string) =>
      new Intl.DateTimeFormat(locale, { timeStyle: 'medium' }).format(new Date(iso)),
  };
}
