// `/proc` read from a fixture tree shaped like a real one (tests/fixtures/proc), so what the
// Performance screen shows on Linux is pinned without depending on the machine running it.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ProcFs,
  parseLoadavg,
  parseMeminfo,
  parsePidStat,
  parsePidStatus,
  parseProcStat,
  parseUptime,
} from './procfs.js';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures/proc',
);

describe('/proc parsers', () => {
  it('adds up the aggregate cpu line and counts the cores', () => {
    const parsed = parseProcStat(
      'cpu  100 5 50 800 20 1 2 3 40 0\ncpu0 50 2 25 400 10 0 1 1 20 0\ncpu1 50 3 25 400 10 1 1 2 20 0\n',
    );
    // guest (40) is already inside user, so it is not added again.
    expect(parsed).toEqual({ cpu: { total: 981, idle: 820 }, cpuCount: 2 });
    expect(parseProcStat('intr 1 2 3')).toBeNull();
  });

  it('reads MemAvailable, and falls back to free + buffers + cached on an old kernel', () => {
    expect(parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 600 kB\n')).toEqual({
      totalBytes: 1000 * 1024,
      availableBytes: 600 * 1024,
    });
    expect(
      parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 250 kB\n'),
    ).toEqual({ totalBytes: 1000 * 1024, availableBytes: 400 * 1024 });
    expect(parseMeminfo('MemFree: 100 kB\n')).toBeNull();
  });

  it('reads the load averages and the uptime', () => {
    expect(parseLoadavg('0.42 0.51 0.60 2/1233 86031\n')).toEqual([0.42, 0.51, 0.6]);
    expect(parseLoadavg('garbage')).toBeNull();
    expect(parseUptime('350735.47 234388.90\n')).toBe(350735.47);
  });

  it('counts a process stat from the last parenthesis, whatever the command is called', () => {
    // A command may contain spaces and parentheses; counting from the first ")" would read
    // the wrong fields and report someone else's numbers.
    const stat = parsePidStat('7 (a (b) c) R 1 7 7 0 -1 0 0 0 0 0 11 22 0 0 20 0 1 0 500 0 0 0\n');
    expect(stat).toEqual({ state: 'R', cpuTicks: 33, startTicks: 500 });
    expect(parsePidStat('no parenthesis here')).toBeNull();
  });

  it('reads VmRSS, and says nothing for a process without one', () => {
    expect(parsePidStatus('Name:\tx\nVmRSS:\t  2048 kB\n')).toBe(2048 * 1024);
    expect(parsePidStatus('Name:\tkthreadd\nState:\tS\n')).toBeNull();
  });
});

describe('ProcFs over a fixture tree', () => {
  const proc = new ProcFs(FIXTURE);

  it('reads the host', () => {
    expect(proc.available()).toBe(true);
    expect(proc.host()).toEqual({
      cpu: { total: 60_377_929, idle: 46_845_166 },
      cpuCount: 4,
      memory: { totalBytes: 16_694_710_272, availableBytes: 10_090_557_440 },
      load: [0.42, 0.51, 0.6],
      uptimeSeconds: 350735.47,
    });
  });

  it('reads a process: its CPU ticks, its memory and how long it has run', () => {
    // utime 1523 + stime 347; started 34563400 ticks after boot = 345634 s, boot was
    // 350735.47 s ago.
    expect(proc.process(4242)).toEqual({
      cpuTicks: 1870,
      rssBytes: 227_540_992,
      uptimeSeconds: 5101,
    });
  });

  it('answers null for a process that is gone and for a pid that cannot be one', () => {
    expect(proc.process(9999)).toBeNull();
    expect(proc.process(0)).toBeNull();
    expect(proc.process(-1)).toBeNull();
  });

  it('is not available where there is no /proc', () => {
    const none = new ProcFs(path.join(FIXTURE, 'no-such-dir'));
    expect(none.available()).toBe(false);
    expect(none.host()).toBeNull();
    expect(none.process(4242)).toBeNull();
  });
});
