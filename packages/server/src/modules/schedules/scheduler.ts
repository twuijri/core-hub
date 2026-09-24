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
 * Two options per schedule decide what else happens (owner, 2026-09-24; DECISIONS §39):
 *
 * - **Run if missed** (`misfire_policy`, the contract's `run_if_missed`, off by default). A
 *   tick up to `LATE_GRACE_MS` late is on time: the scheduler looks every `TICK_MS`, and a
 *   short wait for a look is not a miss, so it runs either way. Later than that the hub was
 *   not running at the time: with the option on it runs **once** (not once per missed tick)
 *   if it is at most `MISSED_GRACE_MS` late; otherwise, and always when it is older, the
 *   history records it as skipped, saying why. Either way the schedule moves on from now.
 *   The owner's reason for off: «مرات الشي لزم ينرسل بوقت بالضبط علشان ما ينحاس المستخدم».
 * - **If the previous run is still going** (`overlap`, default `wait`): `skip` records the
 *   tick as skipped; `wait` holds it (a `waiting` line) and `ScheduleRuns.release` starts it
 *   when the previous run ends — at most one waits, a further tick is skipped and recorded;
 *   `parallel` starts it alongside; `replace` stops the previous run (`ScheduleRuns.stop`)
 *   and then starts. "Run now" never goes through here: it starts at once and stops nothing.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { ClaimDecision, ScheduleRow, ScheduleRunRow, SchedulesService } from './service.js';

/** How long after its time a missed tick still runs when the hub is back (option on). */
export const MISSED_GRACE_MS = 24 * 60 * 60_000;
/** How late a tick may be and still be on time — it runs whatever the option says. */
export const LATE_GRACE_MS = 2 * 60_000;
/** How often the scheduler looks. A minute is the finest a cron can ask for. */
export const TICK_MS = 15_000;

export interface SchedulerDeps {
  service: () => SchedulesService;
  /** Start what the schedule runs for the line just claimed (`ScheduleRuns.fire`). */
  fire: (schedule: ScheduleRow, line: ScheduleRunRow) => Promise<unknown>;
  /** A tick was claimed and not run. */
  skipped: (schedule: ScheduleRow, line: ScheduleRunRow) => void;
  /** A tick was claimed to wait for the previous run (`ScheduleRuns.waiting`). */
  waiting: (schedule: ScheduleRow, line: ScheduleRunRow) => Promise<unknown>;
  /** Stop these runs of the schedule before its next one starts (`ScheduleRuns.stop`). */
  stop: (schedule: ScheduleRow, lines: ScheduleRunRow[]) => Promise<unknown>;
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
      const missed = missedReason(row, row.nextRunAt!, now);
      const open = missed ? [] : service.openRunsOf(row.id);
      const decision = missed
        ? { fire: false as const, reason: missed }
        : overlapDecision(row, open, () => !!service.waitingRunOf(row.id));
      const line = service.claimTick(row, now, decision);
      if (!line) continue;
      if (decision.fire === false) {
        this.deps.skipped(row, line);
        continue;
      }
      try {
        if (decision.fire === 'wait') {
          await this.deps.waiting(row, line);
          continue;
        }
        if (row.overlap === 'replace' && open.length > 0) await this.deps.stop(row, open);
        await this.deps.fire(row, line);
        started += 1;
      } catch (error) {
        this.deps.log.warn({ err: error, scheduleId: row.id }, 'schedules: firing failed');
      }
    }
    return started;
  }
}

/**
 * Why a tick due at `due` does not run at `now` because it was missed — or `null` when it
 * runs: it is on time (within `LATE_GRACE_MS`), or the schedule runs a missed time and this
 * one is within `MISSED_GRACE_MS`.
 */
export function missedReason(
  row: Pick<ScheduleRow, 'misfirePolicy'>,
  due: Date,
  now: Date,
): string | null {
  const late = now.getTime() - due.getTime();
  if (late <= LATE_GRACE_MS) return null;
  const at = due.toISOString();
  if (late > MISSED_GRACE_MS) {
    return `missed: the hub was not running at ${at}, more than 24 hours ago`;
  }
  if (row.misfirePolicy !== 'run_once') {
    return `missed: the hub was not running at ${at}, and this schedule does not run a missed time`;
  }
  return null;
}

/** What a due tick does, given the schedule's runs still going and its `overlap`. */
function overlapDecision(
  row: ScheduleRow,
  open: ScheduleRunRow[],
  alreadyWaiting: () => boolean,
): ClaimDecision {
  if (open.length === 0) return { fire: true };
  switch (row.overlap) {
    case 'parallel':
    case 'replace':
      return { fire: true };
    case 'skip':
      return { fire: false, reason: 'skipped: the previous run was still going' };
    default:
      return alreadyWaiting()
        ? {
            fire: false,
            reason:
              'skipped: the previous run was still going and another time was already waiting for it',
          }
        : { fire: 'wait' };
  }
}
