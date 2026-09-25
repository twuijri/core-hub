// The live sampler's arithmetic: CPU as a share of the time between two samples, the Hermes
// processes measured from /proc by pid, a host without /proc answered from `os` with the
// processes left unmeasured, and a history that stays a few minutes long.
import { describe, expect, it } from 'vitest';
import { LIVE_HISTORY_POINTS, LiveSampler, socketsPerProfile, type SamplerHost } from './live.js';
import { ProcFs } from './procfs.js';

/** A /proc whose files the test rewrites between two samples. */
function fakeProc(files: Record<string, string>) {
  return new ProcFs('/proc', (file) => files[file] ?? null);
}

function hostOf(over: Partial<SamplerHost> = {}): SamplerHost & { micros: number } {
  const host = {
    micros: 0,
    platform: 'linux',
    cpus: () => [
      { times: { user: 100, nice: 0, sys: 0, idle: 900, irq: 0 } },
      { times: { user: 100, nice: 0, sys: 0, idle: 900, irq: 0 } },
    ],
    totalmem: () => 8_000,
    freemem: () => 3_000,
    loadavg: () => [1, 2, 3],
    cpuUsage() {
      return { user: host.micros, system: 0 };
    },
    memoryUsage: () => ({ rss: 500, heapUsed: 200 }),
    uptime: () => 42.7,
    pid: 7,
    version: 'v24.0.0',
    ...over,
  };
  return host;
}

const procStat = (busy: number, idle: number) =>
  `cpu  ${busy} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 0 0 0 0\ncpu1 0 0 0 0\n`;
const pidStat = (ticks: number) =>
  `99 (python) S 1 1 1 0 -1 0 0 0 0 0 ${ticks} 0 0 0 20 0 1 0 1000 0 0 0\n`;

describe('LiveSampler', () => {
  it('measures CPU between two samples, the host from /proc and each Hermes pid', async () => {
    let now = 1_000_000;
    const files: Record<string, string> = {
      '/proc/stat': procStat(1000, 9000),
      '/proc/meminfo': 'MemTotal: 1000 kB\nMemAvailable: 250 kB\n',
      '/proc/loadavg': '0.5 0.4 0.3 1/2 3\n',
      '/proc/uptime': '100.00 50.00\n',
      '/proc/99/stat': pidStat(500),
      '/proc/99/status': 'VmRSS:\t 4 kB\n',
    };
    const host = hostOf();
    const sampler = new LiveSampler({
      proc: fakeProc(files),
      host,
      now: () => now,
      loopLag: () => 1.5,
      // The first look waits between its two samples; five seconds pass in the meantime.
      wait: async () => {
        now += 5_000;
        files['/proc/stat'] = procStat(1500, 9500); // 500 busy of 1000 ticks: 50 %
        files['/proc/99/stat'] = pidStat(750); // 250 ticks in 5 s: 50 % of one core
        host.micros = 1_000_000; // 1 s of CPU in 5 s: 20 %
      },
    });
    const report = await sampler.measure({
      processes: [
        { kind: 'gateway', profile: 'work', pid: 99, state: 'running' },
        { kind: 'dashboard', profile: null, pid: null, state: 'stopped' },
      ],
      profiles: [{ profile: 'work', active_runs: 1, sessions: 3 }],
      sockets: new Map([['work', 2]]),
    });

    expect(report.host).toEqual({
      platform: 'linux',
      measured_from: 'proc',
      cpu_count: 2,
      cpu_percent: 50,
      memory_total_bytes: 1000 * 1024,
      memory_used_bytes: 750 * 1024,
      load: [0.5, 0.4, 0.3],
    });
    expect(report.hub).toMatchObject({
      pid: 7,
      cpu_percent: 20,
      rss_bytes: 500,
      event_loop_lag_ms: 1.5,
      uptime_seconds: 42,
    });
    expect(report.processes).toEqual([
      {
        kind: 'gateway',
        profile: 'work',
        pid: 99,
        state: 'running',
        cpu_percent: 50,
        rss_bytes: 4096,
        uptime_seconds: 90,
      },
      // A process with no pid is listed, with nothing measured.
      {
        kind: 'dashboard',
        profile: null,
        pid: null,
        state: 'stopped',
        cpu_percent: null,
        rss_bytes: null,
        uptime_seconds: null,
      },
    ]);
    expect(report.profiles).toEqual([{ profile: 'work', active_runs: 1, sessions: 3, sockets: 2 }]);
    expect(report.history).toHaveLength(1);
    expect(report.history[0]).toMatchObject({ host_cpu_percent: 50, hermes_rss_bytes: 4096 });
  });

  it('answers from `os` where there is no /proc, and leaves the Hermes processes unmeasured', async () => {
    let now = 0;
    const host = hostOf({ platform: 'darwin' });
    const sampler = new LiveSampler({
      proc: fakeProc({}),
      host,
      now: () => now,
      loopLag: () => null,
      wait: async () => {
        now += 1_000;
      },
    });
    const report = await sampler.measure({
      processes: [{ kind: 'tui_gateway', profile: null, pid: 99, state: 'running' }],
      profiles: [],
      sockets: new Map(),
    });
    expect(report.host.measured_from).toBe('os');
    expect(report.host.memory_total_bytes).toBe(8_000);
    expect(report.host.memory_used_bytes).toBe(5_000);
    expect(report.host.load).toEqual([1, 2, 3]);
    expect(report.host.cpu_count).toBe(2);
    // Nothing moved between the two `os.cpus()` readings: no time passed, no share to give.
    expect(report.host.cpu_percent).toBeNull();
    expect(report.processes[0]).toMatchObject({
      pid: 99,
      cpu_percent: null,
      rss_bytes: null,
      uptime_seconds: null,
    });
    expect(report.history[0]!.hermes_rss_bytes).toBeNull();
  });

  it('shares one sample between viewers a moment apart, and keeps only a few minutes', async () => {
    let now = 0;
    const sampler = new LiveSampler({
      proc: fakeProc({}),
      host: hostOf(),
      now: () => now,
      loopLag: () => null,
      wait: async () => undefined,
    });
    const input = { processes: [], profiles: [], sockets: new Map<string, number>() };
    const first = await sampler.measure(input);
    now += 500;
    expect(await sampler.measure(input)).toBe(first);
    for (let i = 0; i < LIVE_HISTORY_POINTS + 10; i += 1) {
      now += 5_000;
      await sampler.measure(input);
    }
    const last = await sampler.measure(input);
    expect(last.history).toHaveLength(LIVE_HISTORY_POINTS);
    // Oldest first, and the newest is this sample.
    expect(last.history.at(-1)!.at).toBe(last.at);
    expect(Date.parse(last.history[0]!.at)).toBeLessThan(Date.parse(last.at));
  });
});

describe('socketsPerProfile', () => {
  it('counts a connection once however many namespaces it opened', () => {
    const client = {};
    const other = {};
    const namespaces = [
      {
        sockets: new Map([
          ['a', { data: { workspaces: [{ slug: 'default' }, { slug: 'work' }] }, client }],
          ['b', { data: { workspaces: [{ slug: 'default' }] }, client: other }],
        ]),
      },
      { sockets: new Map([['c', { data: { workspaces: [{ slug: 'default' }] }, client }]]) },
      { sockets: new Map([['d', { data: {} }]]) },
    ];
    expect(socketsPerProfile(namespaces)).toEqual(
      new Map([
        ['default', 2],
        ['work', 1],
      ]),
    );
  });
});
