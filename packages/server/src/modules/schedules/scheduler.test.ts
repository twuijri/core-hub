/**
 * The hub's own scheduler, on a real schema and a fake clock: when a schedule is due, what
 * its next time becomes, what pausing does, a timezone, a restart after missed ticks, and
 * that no tick fires twice — two schedulers at once, or one after a restart. And the two
 * options of each schedule (owner, 2026-09-24): "run if missed", with the short lateness
 * that is still on time, and each answer to "if the previous run is still going".
 *
 * The firing itself is a fake here (it only records); `tests/unit/schedule-runs.test.ts`
 * fires into real sessions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryDb } from '../../../tests/unit/helpers.js';
import type { ModuleDatabase } from '../../db/handle.js';
import { newUlid } from '../../db/ids.js';
import { HubScheduler, LATE_GRACE_MS, MISSED_GRACE_MS, TICK_MS } from './scheduler.js';
import { SchedulesService, type ScheduleRow, type ScheduleRunRow } from './service.js';

const scope = { workspace: newUlid(), profile: 'default', userId: newUlid() };
const T0 = new Date('2026-09-24T05:58:00.000Z');
const MINUTE = 60_000;

const target = {
  kind: 'agent_prompt',
  agent_id: '01KAGENTXYZ000000000000000',
  prompt: 'اكتب ملخص اليوم',
  skills: [],
  workflow_id: null,
};
const every = (minutes: number) => ({
  name: `every ${minutes}`,
  trigger: {
    kind: 'interval',
    expression: null,
    every_minutes: minutes,
    run_at: null,
    timezone: 'UTC',
  },
  target,
});

interface Harness {
  db: ModuleDatabase;
  service: SchedulesService;
  fired: Array<{ schedule: ScheduleRow; line: ScheduleRunRow; at: Date }>;
  skipped: ScheduleRunRow[];
  waiting: ScheduleRunRow[];
  /** What `overlap: replace` asked to stop, and when relative to the firing. */
  stopped: Array<{ lines: ScheduleRunRow[]; firedBefore: number }>;
  scheduler: () => HubScheduler;
}

function harness(db: ModuleDatabase = memoryDb()): Harness {
  const service = new SchedulesService(db);
  const fired: Harness['fired'] = [];
  const skipped: ScheduleRunRow[] = [];
  const waiting: ScheduleRunRow[] = [];
  const stopped: Harness['stopped'] = [];
  const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never;
  return {
    db,
    service,
    fired,
    skipped,
    waiting,
    stopped,
    scheduler: () =>
      new HubScheduler({
        service: () => service,
        fire: async (schedule, line) => {
          fired.push({ schedule, line, at: new Date() });
        },
        skipped: (_schedule, line) => {
          skipped.push(line);
        },
        waiting: async (_schedule, line) => {
          waiting.push(line);
        },
        stop: async (_schedule, lines) => {
          stopped.push({ lines, firedBefore: fired.length });
        },
        log,
      }),
  };
}

/** A run that ends well, as the firing side would settle it. */
const finish = (h: Harness, line: ScheduleRunRow) =>
  h.service.settleRun(line.id, { status: 'succeeded' });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('scheduler: when a schedule is due', () => {
  it('fires at its time, once, and computes the next time from that run', async () => {
    const h = harness();
    const row = h.service.create(scope, every(5));
    expect(row.nextRunAt?.toISOString()).toBe('2026-09-24T06:03:00.000Z');
    const scheduler = h.scheduler();
    scheduler.start();
    try {
      await vi.advanceTimersByTimeAsync(4 * MINUTE);
      expect(h.fired).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(MINUTE + TICK_MS);
      expect(h.fired).toHaveLength(1);
      const [first] = h.fired;
      expect(first!.line).toMatchObject({ status: 'queued', trigger: 'schedule' });
      expect(first!.line.scheduledFor.toISOString()).toBe('2026-09-24T06:03:00.000Z');
      // The next time is five minutes after this run, not after the tick it was due at.
      const after = h.service.scheduleById(row.id)!;
      expect(after.lastRunAt?.getTime()).toBe(first!.at.getTime());
      expect(after.nextRunAt?.getTime()).toBe(first!.at.getTime() + 5 * MINUTE);
      finish(h, first!.line);

      await vi.advanceTimersByTimeAsync(5 * MINUTE + TICK_MS);
      expect(h.fired).toHaveLength(2);
    } finally {
      scheduler.stop();
    }
  });

  it("reads a cron in the schedule's own timezone", async () => {
    const h = harness();
    // 09:00 in Riyadh is 06:00 UTC.
    const row = h.service.create(scope, {
      name: 'الصباح',
      trigger: {
        kind: 'cron',
        expression: '0 9 * * *',
        every_minutes: null,
        run_at: null,
        timezone: 'Asia/Riyadh',
      },
      target,
    });
    expect(row.nextRunAt?.toISOString()).toBe('2026-09-24T06:00:00.000Z');
    const scheduler = h.scheduler();
    scheduler.start();
    try {
      await vi.advanceTimersByTimeAsync(MINUTE);
      expect(h.fired).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(MINUTE + TICK_MS);
      expect(h.fired).toHaveLength(1);
      expect(h.service.scheduleById(row.id)!.nextRunAt?.toISOString()).toBe(
        '2026-09-25T06:00:00.000Z',
      );
    } finally {
      scheduler.stop();
    }
  });

  it('fires a one-off once, and then has no next time', async () => {
    const h = harness();
    const row = h.service.create(scope, {
      name: 'مرة',
      trigger: {
        kind: 'once',
        expression: null,
        every_minutes: null,
        run_at: '2026-09-24T06:00:00.000Z',
        timezone: 'UTC',
      },
      target,
    });
    const scheduler = h.scheduler();
    scheduler.start();
    try {
      await vi.advanceTimersByTimeAsync(3 * MINUTE);
      expect(h.fired).toHaveLength(1);
      expect(h.service.scheduleById(row.id)!.nextRunAt).toBeNull();
      finish(h, h.fired[0]!.line);
      await vi.advanceTimersByTimeAsync(60 * MINUTE);
      expect(h.fired).toHaveLength(1);
    } finally {
      scheduler.stop();
    }
  });

  it('stops after its repeat limit', async () => {
    const h = harness();
    const row = h.service.create(scope, { ...every(1), repeat: { limit: 1 } });
    const scheduler = h.scheduler();
    scheduler.start();
    try {
      await vi.advanceTimersByTimeAsync(MINUTE + TICK_MS);
      expect(h.fired).toHaveLength(1);
      finish(h, h.fired[0]!.line);
      expect(h.service.scheduleById(row.id)).toMatchObject({ repeatCount: 1, nextRunAt: null });
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      expect(h.fired).toHaveLength(1);
    } finally {
      scheduler.stop();
    }
  });
});

describe('scheduler: paused', () => {
  it('never fires while paused, and resumes from now without catching up', async () => {
    const h = harness();
    const row = h.service.create(scope, every(5));
    h.service.update(scope, row.id, { enabled: false });
    expect(h.service.scheduleById(row.id)!.nextRunAt).toBeNull();
    const scheduler = h.scheduler();
    scheduler.start();
    try {
      await vi.advanceTimersByTimeAsync(30 * MINUTE);
      expect(h.fired).toHaveLength(0);

      h.service.update(scope, row.id, { enabled: true });
      const resumed = h.service.scheduleById(row.id)!;
      expect(resumed.nextRunAt?.getTime()).toBe(Date.now() + 5 * MINUTE);
      await vi.advanceTimersByTimeAsync(MINUTE);
      expect(h.fired).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(4 * MINUTE + TICK_MS);
      expect(h.fired).toHaveLength(1);
    } finally {
      scheduler.stop();
    }
  });
});

describe('scheduler: while the hub was down (run if missed)', () => {
  it('is off by default: a missed time does not run late, and the history says so', async () => {
    const h = harness();
    const row = h.service.create(scope, every(5));
    expect(row.misfirePolicy).toBe('skip');
    // Three hours pass with no scheduler; a new process starts.
    vi.setSystemTime(new Date(T0.getTime() + 3 * 60 * MINUTE));
    const scheduler = h.scheduler();
    scheduler.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(h.fired).toHaveLength(0);
      const [line] = h.service.runsOf(scope, row.id, 10);
      expect(line).toMatchObject({ status: 'skipped', trigger: 'schedule' });
      expect(line!.error).toBe(
        'missed: the hub was not running at 2026-09-24T06:03:00.000Z, and this schedule does not run a missed time',
      );
      // It moves on from now, and its next time runs as usual.
      expect(h.service.scheduleById(row.id)!.nextRunAt?.getTime()).toBe(Date.now() + 5 * MINUTE);
      await vi.advanceTimersByTimeAsync(5 * MINUTE + TICK_MS);
      expect(h.fired).toHaveLength(1);
    } finally {
      scheduler.stop();
    }
  });

  it('a look up to two minutes late is on time, and runs even with the option off', async () => {
    const h = harness();
    const row = h.service.create(scope, every(5));
    const due = h.service.scheduleById(row.id)!.nextRunAt!.getTime();
    expect(await h.scheduler().tick(new Date(due + LATE_GRACE_MS))).toBe(1);
    expect(h.fired).toHaveLength(1);

    const other = h.service.create(scope, every(5));
    const dueOther = h.service.scheduleById(other.id)!.nextRunAt!.getTime();
    expect(await h.scheduler().tick(new Date(dueOther + LATE_GRACE_MS + 1_000))).toBe(0);
    expect(h.service.runsOf(scope, other.id, 10)[0]).toMatchObject({ status: 'skipped' });
  });

  it('with the option on, runs a missed schedule once when the hub is back, not once per missed tick', async () => {
    const h = harness();
    const row = h.service.create(scope, { ...every(5), run_if_missed: true });
    expect(row.misfirePolicy).toBe('run_once');
    // Three hours pass with no scheduler: thirty-six ticks missed.
    vi.setSystemTime(new Date(T0.getTime() + 3 * 60 * MINUTE));
    const scheduler = h.scheduler();
    scheduler.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(h.fired).toHaveLength(1);
      expect(h.fired[0]!.line.scheduledFor.toISOString()).toBe('2026-09-24T06:03:00.000Z');
      expect(h.service.scheduleById(row.id)!.nextRunAt?.getTime()).toBe(Date.now() + 5 * MINUTE);
      finish(h, h.fired[0]!.line);
      await vi.advanceTimersByTimeAsync(4 * MINUTE);
      expect(h.fired).toHaveLength(1);
    } finally {
      scheduler.stop();
    }
  });

  it('skips a tick missed longer ago than 24 hours even with the option on, and says so', async () => {
    const h = harness();
    const row = h.service.create(scope, { ...every(5), run_if_missed: true });
    vi.setSystemTime(new Date(T0.getTime() + MISSED_GRACE_MS + 60 * MINUTE));
    const scheduler = h.scheduler();
    scheduler.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(h.fired).toHaveLength(0);
      expect(h.skipped).toHaveLength(1);
      const [line] = h.service.runsOf(scope, row.id, 10);
      expect(line).toMatchObject({ status: 'skipped' });
      expect(line!.error).toBe(
        'missed: the hub was not running at 2026-09-24T06:03:00.000Z, more than 24 hours ago',
      );
      // The schedule moved on from now.
      expect(h.service.scheduleById(row.id)!.nextRunAt?.getTime()).toBe(Date.now() + 5 * MINUTE);
      await vi.advanceTimersByTimeAsync(5 * MINUTE + TICK_MS);
      expect(h.fired).toHaveLength(1);
    } finally {
      scheduler.stop();
    }
  });
});

describe('scheduler: a tick fires once', () => {
  it('two schedulers on one database, looking at the same moment, fire it once', async () => {
    const h = harness();
    h.service.create(scope, every(5));
    const now = new Date(T0.getTime() + 6 * MINUTE);
    const a = h.scheduler();
    const b = h.scheduler();
    const first = a.tick(now);
    // A second look from the same scheduler while one is going is that same look.
    expect(a.tick(now)).toBe(first);
    const started = await Promise.all([first, b.tick(now)]);
    expect(started[0] + started[1]).toBe(1);
    expect(h.fired).toHaveLength(1);
  });

  it('a scheduler that stale-reads a tick another already claimed does nothing', () => {
    const h = harness();
    const row = h.service.create(scope, every(5));
    const now = new Date(T0.getTime() + 6 * MINUTE);
    const stale = h.service.dueAt(now)[0]!;
    expect(h.service.claimTick(stale, now, { fire: true })).not.toBeNull();
    // The same row as read before the claim: its tick is gone, and so is the claim.
    expect(h.service.claimTick(stale, now, { fire: true })).toBeNull();
    expect(h.service.runsOf(scope, row.id, 10)).toHaveLength(1);
  });

  it('does not fire again after a restart', async () => {
    const h = harness();
    h.service.create(scope, every(5));
    const now = new Date(T0.getTime() + 6 * MINUTE);
    expect(await h.scheduler().tick(now)).toBe(1);
    // A new process on the same database, looking at the same moment.
    const again = harness(h.db);
    expect(await again.scheduler().tick(now)).toBe(0);
    expect(again.fired).toHaveLength(0);
  });

  it('skips a tick while the previous run is still going, when told to skip', async () => {
    const h = harness();
    const row = h.service.create(scope, { ...every(5), overlap: 'skip' });
    const scheduler = h.scheduler();
    expect(await scheduler.tick(new Date(T0.getTime() + 6 * MINUTE))).toBe(1);
    // The run has not ended when the next tick comes.
    expect(await scheduler.tick(new Date(T0.getTime() + 12 * MINUTE))).toBe(0);
    const [latest] = h.service.runsOf(scope, row.id, 10);
    expect(latest).toMatchObject({
      status: 'skipped',
      error: 'skipped: the previous run was still going',
    });
  });

  it('waits by default: holds one time for the previous run, and skips a further one', async () => {
    const h = harness();
    const row = h.service.create(scope, every(5));
    expect(row.overlap).toBe('wait');
    const scheduler = h.scheduler();
    expect(await scheduler.tick(new Date(T0.getTime() + 6 * MINUTE))).toBe(1);
    // The first run is still going: the next time waits for it, and nothing starts now.
    expect(await scheduler.tick(new Date(T0.getTime() + 12 * MINUTE))).toBe(0);
    expect(h.fired).toHaveLength(1);
    expect(h.waiting).toHaveLength(1);
    expect(h.waiting[0]).toMatchObject({ status: 'queued', waiting: true });
    expect(h.service.waitingRunOf(row.id)?.id).toBe(h.waiting[0]!.id);
    // A waiting time is not "the previous run": the one going is still the first.
    expect(h.service.openRunsOf(row.id).map((line) => line.id)).toEqual([h.fired[0]!.line.id]);
    // At most one waits: the time after that is skipped, saying why.
    expect(await scheduler.tick(new Date(T0.getTime() + 18 * MINUTE))).toBe(0);
    expect(h.waiting).toHaveLength(1);
    const [latest] = h.service.runsOf(scope, row.id, 10);
    expect(latest).toMatchObject({
      status: 'skipped',
      error:
        'skipped: the previous run was still going and another time was already waiting for it',
    });
    // When the first ends, the waiting time is taken — once.
    finish(h, h.fired[0]!.line);
    const taken = h.service.takeWaiting(h.waiting[0]!.id);
    expect(taken).toMatchObject({ status: 'queued', waiting: false });
    expect(h.service.takeWaiting(h.waiting[0]!.id)).toBeNull();
  });

  it('runs alongside when told to, in a run of its own', async () => {
    const h = harness();
    h.service.create(scope, { ...every(5), overlap: 'parallel' });
    const scheduler = h.scheduler();
    expect(await scheduler.tick(new Date(T0.getTime() + 6 * MINUTE))).toBe(1);
    expect(await scheduler.tick(new Date(T0.getTime() + 12 * MINUTE))).toBe(1);
    expect(h.fired).toHaveLength(2);
    expect(h.fired[0]!.line.id).not.toBe(h.fired[1]!.line.id);
    expect(h.stopped).toHaveLength(0);
  });

  it('stops the previous run first, then starts, when told to replace', async () => {
    const h = harness();
    h.service.create(scope, { ...every(5), overlap: 'replace' });
    const scheduler = h.scheduler();
    expect(await scheduler.tick(new Date(T0.getTime() + 6 * MINUTE))).toBe(1);
    // Nothing to stop the first time.
    expect(h.stopped).toHaveLength(0);
    expect(await scheduler.tick(new Date(T0.getTime() + 12 * MINUTE))).toBe(1);
    expect(h.stopped).toHaveLength(1);
    expect(h.stopped[0]!.lines.map((line) => line.id)).toEqual([h.fired[0]!.line.id]);
    // The stop came before the second run started.
    expect(h.stopped[0]!.firedBefore).toBe(1);
    expect(h.fired).toHaveLength(2);
  });

  it('keeps the options a schedule is saved with, and changes them on edit', () => {
    const h = harness();
    const row = h.service.create(scope, { ...every(5), run_if_missed: true, overlap: 'replace' });
    expect(row).toMatchObject({ misfirePolicy: 'run_once', overlap: 'replace' });
    const edited = h.service.update(scope, row.id, { run_if_missed: false, overlap: 'skip' });
    expect(edited).toMatchObject({ misfirePolicy: 'skip', overlap: 'skip' });
    // A patch that does not name them leaves them alone.
    expect(h.service.update(scope, row.id, { name: 'renamed' })).toMatchObject({
      misfirePolicy: 'skip',
      overlap: 'skip',
    });
    expect(() => h.service.update(scope, row.id, { overlap: 'queue' })).toThrow();
  });

  it("leaves Hermes's schedules to Hermes", async () => {
    const h = harness();
    const row = h.service.create(scope, every(5));
    h.service.linkHermes(
      scope,
      row.id,
      {
        id: 'job-1',
        name: 'hermes',
        prompt: 'x',
        enabled: true,
        schedule: { kind: 'interval', minutes: 5 },
        next_run_at: '2026-09-24T06:00:00Z',
      } as never,
      { agentId: null, timezone: 'UTC' },
    );
    expect(await h.scheduler().tick(new Date(T0.getTime() + 60 * MINUTE))).toBe(0);
  });
});
