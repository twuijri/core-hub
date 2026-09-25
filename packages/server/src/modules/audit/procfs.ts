/**
 * What Linux says about the machine and its processes, read from `/proc` (proc(5)).
 *
 * Pure parsers over the files' text, and one reader that takes the root to read from, so
 * the tests read a fixture tree and the hub reads `/proc`. Every reader answers `null`
 * rather than throwing: a process that exited between two reads, or a host with no
 * `/proc` at all, is an absent number, never a crash and never a zero.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Clock ticks per second (`sysconf(_SC_CLK_TCK)`). Node cannot ask for it without running
 * `getconf`; it is 100 on every Linux the hub ships to (x86-64 and arm64 both fix
 * `USER_HZ` at 100), and the times in `/proc/<pid>/stat` are in it.
 */
export const CLOCK_TICKS = 100;

export interface CpuTimes {
  /** Every tick of every state. */
  total: number;
  /** Ticks spent idle or waiting for I/O. */
  idle: number;
}

/** The aggregate `cpu` line of `/proc/stat`. `guest` is already counted in `user`. */
export function parseProcStat(text: string): { cpu: CpuTimes; cpuCount: number } | null {
  let cpu: CpuTimes | null = null;
  let cpuCount = 0;
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    const name = fields[0] ?? '';
    if (name === 'cpu') {
      const values = fields.slice(1, 9).map(Number);
      if (values.length < 4 || values.some((v) => !Number.isFinite(v))) return null;
      const [
        user = 0,
        nice = 0,
        system = 0,
        idle = 0,
        iowait = 0,
        irq = 0,
        softirq = 0,
        steal = 0,
      ] = values;
      cpu = {
        total: user + nice + system + idle + iowait + irq + softirq + steal,
        idle: idle + iowait,
      };
    } else if (/^cpu\d+$/.test(name)) cpuCount += 1;
  }
  return cpu ? { cpu, cpuCount } : null;
}

/** `MemTotal` and `MemAvailable` of `/proc/meminfo`, in bytes. */
export function parseMeminfo(text: string): { totalBytes: number; availableBytes: number } | null {
  const kb = (key: string): number | null => {
    const match = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return match ? Number(match[1]) * 1024 : null;
  };
  const total = kb('MemTotal');
  // Kernels before 3.14 have no MemAvailable; free + buffers + cached is what it replaced.
  const available = kb('MemAvailable') ?? sumOrNull([kb('MemFree'), kb('Buffers'), kb('Cached')]);
  if (total === null || available === null) return null;
  return { totalBytes: total, availableBytes: Math.min(available, total) };
}

/** The three load averages of `/proc/loadavg`. */
export function parseLoadavg(text: string): [number, number, number] | null {
  const values = text.trim().split(/\s+/).slice(0, 3).map(Number);
  if (values.length !== 3 || values.some((v) => !Number.isFinite(v))) return null;
  return [values[0]!, values[1]!, values[2]!];
}

/** Seconds since boot, from `/proc/uptime`. */
export function parseUptime(text: string): number | null {
  const value = Number(text.trim().split(/\s+/)[0]);
  return Number.isFinite(value) ? value : null;
}

export interface PidStat {
  state: string;
  /** User + system time, in clock ticks. */
  cpuTicks: number;
  /** When the process started, in clock ticks after boot. */
  startTicks: number;
}

/**
 * `/proc/<pid>/stat`. The second field is the command in parentheses and may itself hold
 * spaces and parentheses, so the fields are counted from the **last** `)`.
 */
export function parsePidStat(text: string): PidStat | null {
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  // After ") ": field 3 (state) is index 0, so field n is index n - 3.
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const at = (field: number) => Number(fields[field - 3]);
  const utime = at(14);
  const stime = at(15);
  const start = at(22);
  if (![utime, stime, start].every(Number.isFinite)) return null;
  return { state: fields[0] ?? '?', cpuTicks: utime + stime, startTicks: start };
}

/** `VmRSS` of `/proc/<pid>/status`, in bytes; null for a kernel thread or a zombie. */
export function parsePidStatus(text: string): number | null {
  const match = /^VmRSS:\s+(\d+)\s*kB/m.exec(text);
  return match ? Number(match[1]) * 1024 : null;
}

function sumOrNull(values: Array<number | null>): number | null {
  return values.every((v) => v !== null) ? values.reduce<number>((a, b) => a + b!, 0) : null;
}

// ------------------------------------------------------------------ reading

export interface HostReading {
  cpu: CpuTimes;
  cpuCount: number;
  memory: { totalBytes: number; availableBytes: number };
  load: [number, number, number] | null;
  uptimeSeconds: number;
}

export interface ProcessReading {
  cpuTicks: number;
  rssBytes: number | null;
  /** Seconds the process has been running. */
  uptimeSeconds: number;
}

export type TextReader = (file: string) => string | null;

const readText: TextReader = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** A `/proc` (or a fixture shaped like one) to read the host and its processes from. */
export class ProcFs {
  constructor(
    readonly root: string = '/proc',
    private readonly read: TextReader = readText,
  ) {}

  /** Whether there is a `/proc` here at all: Linux, or a fixture. */
  available(): boolean {
    return this.read(path.join(this.root, 'stat')) !== null;
  }

  host(): HostReading | null {
    const stat = this.parse('stat', parseProcStat);
    const memory = this.parse('meminfo', parseMeminfo);
    const uptime = this.parse('uptime', parseUptime);
    if (!stat || !memory || uptime === null) return null;
    return {
      cpu: stat.cpu,
      cpuCount: stat.cpuCount,
      memory,
      load: this.parse('loadavg', parseLoadavg),
      uptimeSeconds: uptime,
    };
  }

  process(pid: number): ProcessReading | null {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const stat = this.parse(`${pid}/stat`, parsePidStat);
    const uptime = this.parse('uptime', parseUptime);
    if (!stat || uptime === null || stat.state === 'Z') return null;
    const status = this.read(path.join(this.root, String(pid), 'status'));
    return {
      cpuTicks: stat.cpuTicks,
      rssBytes: status === null ? null : parsePidStatus(status),
      uptimeSeconds: Math.max(0, Math.floor(uptime - stat.startTicks / CLOCK_TICKS)),
    };
  }

  private parse<T>(file: string, parser: (text: string) => T | null): T | null {
    const text = this.read(path.join(this.root, file));
    return text === null ? null : parser(text);
  }
}
