/**
 * The live Performance screen (`audit.getLivePerformance`, contract decision §51).
 *
 * Measured when somebody asks, not on a timer: an open screen asks every five seconds, and
 * a hub nobody is watching spends nothing on it. CPU is a share of the time between two
 * samples, so the sampler keeps the previous one; when there is none recent enough to mean
 * "now" (the first look, or a look after a long pause), it takes one, waits a moment and
 * takes another. The last few minutes of samples are kept in memory for the sparklines —
 * the points taken while somebody was looking, which is exactly what a live view is.
 *
 * Linux answers from `/proc` (`procfs.ts`). Elsewhere the host's numbers come from Node's
 * `os` module and the Hermes processes are listed without numbers: `null`, not zero.
 */
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';
import { CLOCK_TICKS, ProcFs, type CpuTimes } from './procfs.js';

/** How often the screen should ask. */
export const LIVE_INTERVAL_SECONDS = 5;
/** Six minutes of five-second samples. */
export const LIVE_HISTORY_POINTS = 72;
/** A sample older than this is too old to be the "previous" of a live CPU figure. */
const BASELINE_MAX_AGE_MS = 30_000;
/** How long the first look waits between its two samples. */
const BASELINE_WAIT_MS = 250;
/** Two viewers asking within this share one sample rather than halving each other's window. */
const REUSE_WITHIN_MS = 2_000;

export type HermesProcessKind = 'tui_gateway' | 'dashboard' | 'gateway';

/** A Hermes process as its supervisor knows it; the numbers are measured here. */
export interface HermesProcessInfo {
  kind: HermesProcessKind;
  profile: string | null;
  pid: number | null;
  state: string;
}

export interface ProfileActivity {
  profile: string;
  active_runs: number;
  sessions: number;
}

/**
 * What other modules know and this one measures: the Hermes processes (`agents`) and each
 * profile's runs and conversations (`sessions`). Joined in the composition root, so this
 * module imports neither.
 */
export interface LiveSources {
  hermesProcesses?(): HermesProcessInfo[];
  profileActivity?(): ProfileActivity[];
}

let liveSourcesFactory: ((app: FastifyInstance) => LiveSources) | null = null;

/** The composition root says where the processes and the activity come from. */
export function registerLiveSources(
  factory: ((app: FastifyInstance) => LiveSources) | null,
): ((app: FastifyInstance) => LiveSources) | null {
  const previous = liveSourcesFactory;
  liveSourcesFactory = factory;
  return previous;
}

export function liveSourcesFor(app: FastifyInstance): LiveSources {
  return liveSourcesFactory?.(app) ?? {};
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
    load: [number, number, number] | null;
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
  processes: Array<
    HermesProcessInfo & {
      cpu_percent: number | null;
      rss_bytes: number | null;
      uptime_seconds: number | null;
    }
  >;
  profiles: Array<ProfileActivity & { sockets: number }>;
  history: HistoryPoint[];
}

export interface HistoryPoint {
  at: string;
  host_cpu_percent: number | null;
  host_memory_used_bytes: number;
  hub_cpu_percent: number | null;
  hub_rss_bytes: number;
  event_loop_lag_ms: number | null;
  hermes_rss_bytes: number | null;
}

/** The bits of `os` and `process` the sampler reads, so a test can hold them still. */
export interface SamplerHost {
  platform: string;
  cpus(): Array<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }>;
  totalmem(): number;
  freemem(): number;
  loadavg(): number[];
  cpuUsage(): { user: number; system: number };
  memoryUsage(): { rss: number; heapUsed: number };
  uptime(): number;
  pid: number;
  version: string;
}

const realHost: SamplerHost = {
  platform: process.platform,
  cpus: () => os.cpus(),
  totalmem: () => os.totalmem(),
  freemem: () => os.freemem(),
  loadavg: () => os.loadavg(),
  cpuUsage: () => process.cpuUsage(),
  memoryUsage: () => process.memoryUsage(),
  uptime: () => process.uptime(),
  pid: process.pid,
  version: process.version,
};

interface Sample {
  at: number;
  hostCpu: CpuTimes | null;
  /** µs of user + system time this process has used. */
  hubCpuMicros: number;
  /** CPU ticks of each Hermes pid, for the next sample's delta. */
  pidTicks: Map<number, number>;
}

export interface SamplerOptions {
  proc?: ProcFs;
  host?: SamplerHost;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  /** Mean event-loop delay since the last call, in ms; null when nothing was measured. */
  loopLag?: () => number | null;
}

export interface MeasureInput {
  processes: HermesProcessInfo[];
  profiles: ProfileActivity[];
  sockets: Map<string, number>;
}

export class LiveSampler {
  private readonly proc: ProcFs;
  private readonly host: SamplerHost;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly loopLag: () => number | null;
  private histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
  private previous: Sample | null = null;
  private last: LivePerformance | null = null;
  private readonly history: HistoryPoint[] = [];

  constructor(options: SamplerOptions = {}) {
    this.proc = options.proc ?? new ProcFs();
    this.host = options.host ?? realHost;
    this.now = options.now ?? Date.now;
    this.wait =
      options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()));
    this.loopLag = options.loopLag ?? (() => this.defaultLoopLag());
  }

  /** Stops the event-loop monitor (the app closing). */
  close(): void {
    this.histogram?.disable();
    this.histogram = null;
  }

  async measure(input: MeasureInput): Promise<LivePerformance> {
    const now = this.now();
    if (this.last && now - Date.parse(this.last.at) < REUSE_WITHIN_MS) return this.last;
    const useProc = this.proc.available();
    const pids = input.processes
      .map((process) => process.pid)
      .filter((pid): pid is number => pid !== null);

    if (!this.previous || now - this.previous.at > BASELINE_MAX_AGE_MS) {
      this.previous = this.take(useProc, pids);
      this.loopLag(); // start the window the first figure covers
      await this.wait(BASELINE_WAIT_MS);
    }
    const before = this.previous;
    const current = this.take(useProc, pids);
    const seconds = Math.max((current.at - before.at) / 1000, 0.001);

    const hostCpu =
      current.hostCpu && before.hostCpu
        ? percentOf(
            current.hostCpu.total -
              before.hostCpu.total -
              (current.hostCpu.idle - before.hostCpu.idle),
            current.hostCpu.total - before.hostCpu.total,
          )
        : null;
    const hubCpu = round1(((current.hubCpuMicros - before.hubCpuMicros) / 1e6 / seconds) * 100);

    const reading = useProc ? this.proc.host() : null;
    const totalBytes = reading?.memory.totalBytes ?? this.host.totalmem();
    const usedBytes = reading
      ? reading.memory.totalBytes - reading.memory.availableBytes
      : this.host.totalmem() - this.host.freemem();
    const load = reading
      ? reading.load
      : this.host.platform === 'win32'
        ? null
        : (this.host.loadavg().slice(0, 3) as [number, number, number]);

    const processes = input.processes.map((process) => {
      const measured = useProc && process.pid !== null ? this.proc.process(process.pid) : null;
      const previousTicks = process.pid !== null ? before.pidTicks.get(process.pid) : undefined;
      return {
        ...process,
        cpu_percent:
          measured && previousTicks !== undefined
            ? round1(((measured.cpuTicks - previousTicks) / CLOCK_TICKS / seconds) * 100)
            : null,
        rss_bytes: measured?.rssBytes ?? null,
        uptime_seconds: measured?.uptimeSeconds ?? null,
      };
    });

    const memory = this.host.memoryUsage();
    const lag = this.loopLag();
    const at = new Date(current.at).toISOString();
    const measuredRss = processes
      .map((process) => process.rss_bytes)
      .filter((value): value is number => value !== null);
    this.history.push({
      at,
      host_cpu_percent: hostCpu,
      host_memory_used_bytes: usedBytes,
      hub_cpu_percent: hubCpu,
      hub_rss_bytes: memory.rss,
      event_loop_lag_ms: lag,
      hermes_rss_bytes: measuredRss.length > 0 ? measuredRss.reduce((a, b) => a + b, 0) : null,
    });
    if (this.history.length > LIVE_HISTORY_POINTS) this.history.shift();
    this.previous = current;

    const report: LivePerformance = {
      at,
      interval_seconds: LIVE_INTERVAL_SECONDS,
      host: {
        platform: this.host.platform,
        measured_from: useProc ? 'proc' : 'os',
        cpu_count: reading?.cpuCount || this.host.cpus().length,
        cpu_percent: hostCpu,
        memory_total_bytes: totalBytes,
        memory_used_bytes: usedBytes,
        load,
      },
      hub: {
        pid: this.host.pid,
        cpu_percent: hubCpu,
        rss_bytes: memory.rss,
        heap_used_bytes: memory.heapUsed,
        event_loop_lag_ms: lag,
        uptime_seconds: Math.floor(this.host.uptime()),
        node_version: this.host.version,
      },
      processes,
      profiles: input.profiles
        .map((profile) => ({ ...profile, sockets: input.sockets.get(profile.profile) ?? 0 }))
        .sort((a, b) => a.profile.localeCompare(b.profile)),
      history: [...this.history],
    };
    this.last = report;
    return report;
  }

  private take(useProc: boolean, pids: number[]): Sample {
    const pidTicks = new Map<number, number>();
    if (useProc) {
      for (const pid of pids) {
        const reading = this.proc.process(pid);
        if (reading) pidTicks.set(pid, reading.cpuTicks);
      }
    }
    const usage = this.host.cpuUsage();
    return {
      at: this.now(),
      hostCpu: useProc ? (this.proc.host()?.cpu ?? null) : cpuTimesOf(this.host.cpus()),
      hubCpuMicros: usage.user + usage.system,
      pidTicks,
    };
  }

  private defaultLoopLag(): number | null {
    if (!this.histogram) {
      this.histogram = monitorEventLoopDelay({ resolution: 10 });
      this.histogram.enable();
      return null;
    }
    const mean = this.histogram.mean;
    this.histogram.reset();
    return Number.isFinite(mean) && mean > 0 ? Math.round((mean / 1e6) * 100) / 100 : null;
  }
}

/** Every core's times added up — the `os` module's answer where there is no `/proc`. */
export function cpuTimesOf(cpus: ReturnType<SamplerHost['cpus']>): CpuTimes | null {
  if (cpus.length === 0) return null;
  let total = 0;
  let idle = 0;
  for (const { times } of cpus) {
    total += times.user + times.nice + times.sys + times.idle + times.irq;
    idle += times.idle;
  }
  return { total, idle };
}

function percentOf(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return round1(Math.min(100, Math.max(0, (part / whole) * 100)));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Connected clients per profile: every Socket.IO connection admitted to a profile, counted
 * once however many namespaces it opened. `auth`'s handshake leaves the profiles a socket
 * was admitted to in `socket.data.workspaces`.
 */
export function socketsPerProfile(
  namespaces: Iterable<{ sockets: Map<string, { data: unknown; client?: unknown }> }>,
): Map<string, number> {
  // One connection opens a socket per namespace; they share one `client`.
  const seen = new Map<string, Set<unknown>>();
  for (const namespace of namespaces) {
    for (const [id, socket] of namespace.sockets) {
      const workspaces = (socket.data as { workspaces?: Array<{ slug?: string }> } | undefined)
        ?.workspaces;
      for (const workspace of workspaces ?? []) {
        if (!workspace.slug) continue;
        const set = seen.get(workspace.slug) ?? new Set<unknown>();
        set.add(socket.client ?? id);
        seen.set(workspace.slug, set);
      }
    }
  }
  return new Map([...seen].map(([slug, set]) => [slug, set.size]));
}
