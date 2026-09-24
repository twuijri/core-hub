/**
 * The hub's own scheduler: what fires a schedule whose agent is not Hermes (Hermes's
 * schedules live in Hermes's scheduler, `hermes-cron.ts`).
 *
 * Every few seconds it asks for the schedules whose stored `next_run_at` has come
 * (`SchedulesService.dueAt`) and claims each tick (`claimTick`): a compare-and-set on the
 * tick it read, plus a history line unique per (schedule, tick), in one transaction. Two
 * ticks at once — two processes on one database, or a tick racing a restart — cannot both
 * win, so a moment fires once.
 *
 * The next time is computed when the tick is claimed, from the moment of claiming, in the
 * schedule's own timezone (`cron.ts`): a cron's next matching minute, an interval from this
 * run, nothing after a one-off. A paused schedule has no next time and is never due; a
 * schedule whose repeat limit is reached has none either.
 *
 * **A tick missed while the hub was down** (proposed — owner to confirm): when the hub
 * comes back, a schedule whose time passed **runs once**, not once per missed tick, and
 * then continues from now — provided it was missed by at most `MISSED_GRACE_MS`. A tick
 * older than that is not run: the history records it as skipped, saying why, and the
 * schedule moves on. The same rule covers a hub upgraded from a version that never fired
 * its schedules. A tick that comes while the schedule's previous run is still going is
 * skipped the same way (the stored `overlap_policy` is `skip` for every schedule).
 */
import type { FastifyBaseLogger } from 'fastify';
import type { ScheduleRow, ScheduleRunRow, SchedulesService } from './service.js';

/** How long after its time a missed tick still runs when the hub is back. */
export const MISSED_GRACE_MS = 24 * 60 * 60_000;
/** How often the scheduler looks. A minute is the finest a cron can ask for. */
export const TICK_MS = 15_000;

export interface SchedulerDeps {
  service: () => SchedulesService;
  /** Start what the schedule runs for the line just claimed (`ScheduleRuns.fire`). */
  fire: (schedule: ScheduleRow, line: ScheduleRunRow) => Promise<unknown>;
  /** A tick was claimed and not run. */
  skipped: (schedule: ScheduleRow, line: ScheduleRunRow) => void;
  log: FastifyBaseLogger;
  tickMs?: number;
}

export class HubScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<number> | null = null;
  private stopped = true;

  constructor(private readonly deps: SchedulerDeps) {}

  /** Look now (a restart catches up at once), then every `tickMs`. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Wait for a look in progress — tests and shutdown. */
  async settled(): Promise<void> {
    await this.running;
  }

  /**
   * One look: claim and start every schedule due at `now`. Looks never overlap in one
   * process; across processes the claim is what keeps a tick from firing twice.
   * Resolves with how many runs it started.
   */
  tick(now: Date = new Date()): Promise<number> {
    if (this.running) return this.running;
    const work = this.look(now).finally(() => {
      this.running = null;
    });
    this.running = work;
    return work;
  }

  private loop(): void {
    if (this.stopped) return;
    void this.tick()
      .catch((error: unknown) => this.deps.log.warn({ err: error }, 'schedules: a look failed'))
      .finally(() => {
        if (this.stopped) return;
        this.timer = setTimeout(() => this.loop(), this.deps.tickMs ?? TICK_MS);
        this.timer.unref?.();
      });
  }

  private async look(now: Date): Promise<number> {
    const service = this.deps.service();
    let started = 0;
    for (const row of service.dueAt(now)) {
      const due = row.nextRunAt!;
      const late = now.getTime() - due.getTime();
      const decision =
        late > MISSED_GRACE_MS
          ? {
              fire: false as const,
              reason: `missed: the hub was not running at ${due.toISOString()}`,
            }
          : service.openRunOf(row.id)
            ? { fire: false as const, reason: 'skipped: the previous run was still going' }
            : { fire: true as const };
      const line = service.claimTick(row, now, decision);
      if (!line) continue;
      if (!decision.fire) {
        this.deps.skipped(row, line);
        continue;
      }
      try {
        await this.deps.fire(row, line);
        started += 1;
      } catch (error) {
        this.deps.log.warn({ err: error, scheduleId: row.id }, 'schedules: firing failed');
      }
    }
    return started;
  }
}
