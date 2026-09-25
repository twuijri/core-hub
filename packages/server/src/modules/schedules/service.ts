/**
 * Schedules and workflows: **when** something should happen, and **what** should happen.
 *
 * This module owns both definitions and the history of what was tried. Since 2026-09-24 it
 * also fires the hub's own schedules (`scheduler.ts` claims a due tick, `runs.ts` starts
 * it); a schedule for Hermes lives in Hermes's scheduler, which fires it (`hermes-cron.ts`).
 *
 * `next_run_at` is computed for real (`cron.ts`) and stored: the stored value is the tick
 * the scheduler claims, with a compare-and-set on that very value, so two ticks — two
 * processes, or one restarted — never fire the same moment twice.
 */
import { and, asc, desc, eq, inArray, isNull, lt, lte } from 'drizzle-orm';
import { newUlid } from '../../db/ids.js';
import type { ModuleDb } from '../../lib/db.js';
import { conflict, notFound } from '../../lib/errors.js';
import { CronError, nextRunAt, parseCron } from './cron.js';
import { ConditionError, parseCondition, pathsIn } from './expr.js';
import { deliveryOfHermes, type HermesJob } from './hermes-jobs.js';
import { MAX_DELAY_SECONDS } from './workflow-engine.js';
import {
  nodeRuns,
  scheduleRuns,
  schedules,
  workflowRuns,
  workflows,
  SCHEDULE_OVERLAPS,
  type ScheduleOverlap,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowResumeState,
} from './schema.js';

export interface Scope {
  workspace: string;
  profile: string;
  userId: string;
}

export type ScheduleRow = typeof schedules.$inferSelect;
export type ScheduleRunRow = typeof scheduleRuns.$inferSelect;
export type WorkflowRow = typeof workflows.$inferSelect;
export type WorkflowRunRow = typeof workflowRuns.$inferSelect;
export type NodeRunRow = typeof nodeRuns.$inferSelect;

export class SchedulesService {
  constructor(private readonly db: ModuleDb) {}

  // ------------------------------------------------------------ schedules

  list(
    scope: Scope,
    filter: { agentId?: string; workflowId?: string; enabled?: boolean },
  ): ScheduleRow[] {
    return this.listAcross([scope.workspace], filter);
  }

  /**
   * The schedules of several workspaces in one statement — the Schedules page gathers every
   * profile the person may enter (ADR 0016). Newest first (`id desc`), one keyset over all
   * of them: `cursor` is the last id of the previous page, so a page never repeats or skips
   * a schedule from another workspace. Which workspaces is the caller's business.
   */
  listAcross(
    workspaces: readonly string[],
    filter: { agentId?: string; workflowId?: string; enabled?: boolean },
    page: { cursor?: string | null; limit?: number } = {},
  ): ScheduleRow[] {
    if (workspaces.length === 0) return [];
    const query = this.db
      .select()
      .from(schedules)
      .where(
        and(
          inArray(schedules.workspace, [...workspaces]),
          isNull(schedules.archivedAt),
          filter.agentId ? eq(schedules.agentId, filter.agentId) : undefined,
          filter.workflowId ? eq(schedules.workflowId, filter.workflowId) : undefined,
          filter.enabled === undefined ? undefined : eq(schedules.enabled, filter.enabled),
          page.cursor ? lt(schedules.id, page.cursor) : undefined,
        ),
      )
      .orderBy(desc(schedules.id));
    return page.limit === undefined ? query.all() : query.limit(page.limit).all();
  }

  get(scope: Scope, id: string): ScheduleRow {
    const row = this.db
      .select()
      .from(schedules)
      .where(and(eq(schedules.workspace, scope.workspace), eq(schedules.id, id)))
      .get();
    if (!row) throw notFound({ resource: 'schedule', id });
    return row;
  }

  /**
   * An expression the hub cannot evaluate is refused **here**, when it is saved, with the
   * reason. The alternative is a schedule that looks fine and never fires.
   */
  private validateTrigger(trigger: Record<string, unknown> | undefined): void {
    if (!trigger) return;
    const kind = trigger.kind as string | undefined;
    if (kind === 'cron') {
      const expression = trigger.expression as string | null | undefined;
      if (!expression) throw conflict({ reason: 'cron_required', field: 'trigger.expression' });
      try {
        parseCron(expression);
      } catch (error) {
        throw conflict({
          reason: 'cron_invalid',
          field: 'trigger.expression',
          message: error instanceof CronError ? error.message : 'unreadable',
        });
      }
      const timezone = (trigger.timezone as string | undefined) ?? 'UTC';
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone });
      } catch {
        throw conflict({ reason: 'timezone_unknown', field: 'trigger.timezone', timezone });
      }
    }
    if (kind === 'interval' && !((trigger.every_minutes as number | undefined) ?? 0)) {
      throw conflict({ reason: 'interval_required', field: 'trigger.every_minutes' });
    }
    if (kind === 'once' && !trigger.run_at) {
      throw conflict({ reason: 'run_at_required', field: 'trigger.run_at' });
    }
  }

  private triggerOf(row: ScheduleRow) {
    return {
      kind: row.kind,
      cron: row.cronExpr,
      timezone: row.timezone,
      intervalSeconds: row.intervalSeconds,
      runAt: row.runAt,
    };
  }

  /** What the row would run next, from now — `null` when it never would. */
  nextFor(row: ScheduleRow, now: Date = new Date()): Date | null {
    // A reflection's next time is whatever its own scheduler said: it is the one firing it.
    if (row.externalSource) return row.nextRunAt;
    if (!row.enabled) return null;
    if (row.repeatLimit !== null && row.repeatCount >= row.repeatLimit) return null;
    return nextRunAt(this.triggerOf(row), now, row.lastRunAt);
  }

  /**
   * The next time a person is shown: the stored tick — the one the scheduler will claim —
   * so the page and the scheduler never disagree. `null` when paused or used up.
   */
  shownNext(row: ScheduleRow): Date | null {
    if (row.externalSource) return row.nextRunAt;
    if (!row.enabled) return null;
    if (row.repeatLimit !== null && row.repeatCount >= row.repeatLimit) return null;
    return row.nextRunAt;
  }

  create(scope: Scope, input: Record<string, unknown>): ScheduleRow {
    const trigger = input.trigger as Record<string, unknown> | undefined;
    const target = input.target as Record<string, unknown> | undefined;
    this.validateTrigger(trigger);
    const name = String(input.name ?? '').trim();
    if (name === '') throw conflict({ reason: 'name_required', field: 'name' });
    const id = newUlid();
    const kind = (trigger?.kind as ScheduleRow['kind']) ?? 'cron';
    this.db
      .insert(schedules)
      .values({
        id,
        ownerId: scope.userId,
        workspace: scope.workspace,
        name,
        description: (input.description as string | null) ?? null,
        kind,
        cronExpr: (trigger?.expression as string | null) ?? null,
        timezone: (trigger?.timezone as string | undefined) ?? 'UTC',
        intervalSeconds: trigger?.every_minutes ? Number(trigger.every_minutes) * 60 : null,
        runAt: trigger?.run_at ? new Date(String(trigger.run_at)) : null,
        enabled: (input.enabled as boolean | undefined) ?? true,
        targetKind: target?.kind === 'workflow' ? 'workflow' : 'prompt',
        agentId: (target?.agent_id as string | null) ?? null,
        workflowId: (target?.workflow_id as string | null) ?? null,
        prompt: (target?.prompt as string | null) ?? null,
        skills: (target?.skills as string[] | undefined) ?? [],
        delivery: deliveryOf(input.delivery as Record<string, unknown> | undefined),
        repeatLimit: (input.repeat as { limit?: number | null } | undefined)?.limit ?? null,
        // The owner's defaults (2026-09-24): a missed time does not run late, and a time that
        // comes while the previous run is going waits for it.
        misfirePolicy: input.run_if_missed === true ? 'run_once' : 'skip',
        overlap: overlapOf(input.overlap) ?? 'wait',
      })
      .run();
    const row = this.get(scope, id);
    return this.refreshNext(row);
  }

  update(scope: Scope, id: string, patch: Record<string, unknown>): ScheduleRow {
    const values = this.valuesOf(this.get(scope, id), patch);
    this.db.update(schedules).set(values).where(eq(schedules.id, id)).run();
    return this.refreshNext(this.get(scope, id));
  }

  /** The row `update` would make, validated, without writing it. */
  previewUpdate(scope: Scope, id: string, patch: Record<string, unknown>): ScheduleRow {
    const current = this.get(scope, id);
    return { ...current, ...(this.valuesOf(current, patch) as Partial<ScheduleRow>) };
  }

  private valuesOf(
    current: ScheduleRow,
    patch: Record<string, unknown>,
  ): Partial<typeof schedules.$inferInsert> {
    const trigger = patch.trigger as Record<string, unknown> | undefined;
    this.validateTrigger(trigger);
    const target = patch.target as Record<string, unknown> | undefined;
    const values: Partial<typeof schedules.$inferInsert> = { updatedAt: new Date() };
    if (patch.name !== undefined) values.name = String(patch.name);
    if (patch.description !== undefined) values.description = patch.description as string | null;
    if (patch.enabled !== undefined) values.enabled = patch.enabled as boolean;
    if (patch.repeat !== undefined)
      values.repeatLimit = (patch.repeat as { limit?: number | null }).limit ?? null;
    if (patch.delivery !== undefined)
      values.delivery = deliveryOf(patch.delivery as Record<string, unknown>);
    if (patch.run_if_missed !== undefined && patch.run_if_missed !== null)
      values.misfirePolicy = patch.run_if_missed === true ? 'run_once' : 'skip';
    const overlap = overlapOf(patch.overlap);
    if (overlap) values.overlap = overlap;
    if (trigger) {
      values.kind = (trigger.kind as ScheduleRow['kind']) ?? current.kind;
      values.cronExpr = (trigger.expression as string | null) ?? null;
      values.timezone = (trigger.timezone as string | undefined) ?? current.timezone;
      values.intervalSeconds = trigger.every_minutes ? Number(trigger.every_minutes) * 60 : null;
      values.runAt = trigger.run_at ? new Date(String(trigger.run_at)) : null;
    }
    if (target) {
      values.targetKind = target.kind === 'workflow' ? 'workflow' : 'prompt';
      values.agentId = (target.agent_id as string | null) ?? null;
      values.workflowId = (target.workflow_id as string | null) ?? null;
      values.prompt = (target.prompt as string | null) ?? null;
      values.skills = (target.skills as string[] | undefined) ?? [];
    }
    return values;
  }

  /** Recomputes `next_run_at` from the row as it now stands. */
  refreshNext(row: ScheduleRow, now: Date = new Date()): ScheduleRow {
    const next = this.nextFor(row, now);
    this.db
      .update(schedules)
      .set({ nextRunAt: next, updatedAt: new Date() })
      .where(eq(schedules.id, row.id))
      .run();
    return { ...row, nextRunAt: next };
  }

  remove(scope: Scope, id: string): void {
    this.get(scope, id);
    this.db.delete(schedules).where(eq(schedules.id, id)).run();
  }

  // ------------------------------------------------- Hermes's own schedules

  /**
   * Write what Hermes says about one of its jobs over the reflection — Hermes wins — and
   * put any run Hermes finished since the last look into the history.
   *
   * Hermes reports only its *latest* run, so a job that fired twice between two looks
   * shows once. The history says what was seen, never what was guessed.
   */
  reflectHermes(
    scope: Scope,
    job: HermesJob,
    context: { agentId: string | null; timezone: string },
    now: Date = new Date(),
  ): { row: ScheduleRow; created: boolean } | null {
    const raw = job.schedule?.kind;
    if (raw !== 'cron' && raw !== 'interval' && raw !== 'once') return null;
    const kind: ScheduleRow['kind'] = raw;
    const lastRunAt = job.last_run_at ? new Date(job.last_run_at) : null;
    const channel = deliveryOfHermes(job.deliver);
    const values = {
      name: (job.name || job.id).slice(0, 120),
      kind,
      cronExpr: kind === 'cron' ? (job.schedule.expr ?? null) : null,
      timezone: context.timezone,
      intervalSeconds: kind === 'interval' ? Number(job.schedule.minutes ?? 0) * 60 : null,
      runAt: kind === 'once' && job.schedule.run_at ? new Date(job.schedule.run_at) : null,
      enabled: job.enabled,
      targetKind: 'prompt' as const,
      agentId: context.agentId,
      prompt: job.prompt ?? null,
      skills: job.skills ?? [],
      delivery: channel ? { channel: channel.channel ?? '', address: channel.address } : {},
      repeatLimit: job.repeat?.times ?? null,
      repeatCount: job.repeat?.completed ?? 0,
      nextRunAt: job.next_run_at ? new Date(job.next_run_at) : null,
      lastRunAt,
      lastStatus: runStatusOfHermes(job.last_status),
      lastError: job.last_error ?? null,
      lastDeliveryError: job.last_delivery_error ?? null,
      externalState: job.state ?? (job.enabled ? 'scheduled' : 'paused'),
      externalSyncedAt: now,
    };
    // Hermes has one scheduler, so a job is one row wherever it was made: a schedule someone
    // created in the design workspace stays there, and only a job Hermes made itself lands
    // in `scope` (the default workspace).
    const existing = this.db
      .select()
      .from(schedules)
      .where(and(eq(schedules.externalSource, 'hermes'), eq(schedules.externalId, job.id)))
      .get();
    let id: string;
    if (existing) {
      id = existing.id;
      // A reflection that had been archived because Hermes stopped listing it comes back
      // when Hermes lists it again.
      this.db
        .update(schedules)
        .set({ ...values, archivedAt: null, updatedAt: now })
        .where(eq(schedules.id, id))
        .run();
    } else {
      id = newUlid();
      this.db
        .insert(schedules)
        .values({
          id,
          ownerId: scope.userId,
          workspace: scope.workspace,
          ...values,
          externalSource: 'hermes',
          externalId: job.id,
        })
        .run();
    }
    if (lastRunAt && (!existing?.lastRunAt || lastRunAt > existing.lastRunAt)) {
      this.settleHermesRun(scope, id, lastRunAt, values.lastStatus, values.lastError);
    }
    const row = this.db.select().from(schedules).where(eq(schedules.id, id)).get()!;
    return { row, created: !existing };
  }

  /** A run Hermes finished: the one the hub asked for, if one is open, or a new line. */
  private settleHermesRun(
    scope: Scope,
    scheduleId: string,
    at: Date,
    status: ScheduleRow['lastStatus'],
    error: string | null,
  ): void {
    const settled = status ?? 'succeeded';
    const open = this.db
      .select()
      .from(scheduleRuns)
      .where(
        and(
          eq(scheduleRuns.scheduleId, scheduleId),
          inArray(scheduleRuns.status, ['queued', 'running']),
        ),
      )
      .orderBy(asc(scheduleRuns.id))
      .get();
    if (open) {
      this.db
        .update(scheduleRuns)
        .set({ status: settled, error, finishedAt: at, updatedAt: new Date() })
        .where(eq(scheduleRuns.id, open.id))
        .run();
      return;
    }
    this.db
      .insert(scheduleRuns)
      .values({
        id: newUlid(),
        ownerId: scope.userId,
        workspace: scope.workspace,
        scheduleId,
        scheduledFor: at,
        status: settled,
        error,
        startedAt: at,
        finishedAt: at,
      })
      .onConflictDoNothing()
      .run();
  }

  /** Every reflection of Hermes's jobs here, archived ones included. */
  hermesRows(_scope: Scope): ScheduleRow[] {
    // Every workspace: Hermes's one scheduler may hold a job made from any of them.
    return this.db.select().from(schedules).where(eq(schedules.externalSource, 'hermes')).all();
  }

  /** Hermes no longer lists it: removed there, so gone from the list here. */
  archiveReflection(id: string, now: Date = new Date()): void {
    this.db
      .update(schedules)
      .set({ archivedAt: now, enabled: false, nextRunAt: null, updatedAt: now })
      .where(eq(schedules.id, id))
      .run();
  }

  /** Tie a row to the Hermes job it was just created as, taking Hermes's answer. */
  linkHermes(
    scope: Scope,
    id: string,
    job: HermesJob,
    context: { agentId: string | null; timezone: string },
  ): ScheduleRow {
    this.db
      .update(schedules)
      .set({ externalSource: 'hermes', externalId: job.id })
      .where(and(eq(schedules.workspace, scope.workspace), eq(schedules.id, id)))
      .run();
    return this.reflectHermes(scope, job, context)?.row ?? this.get(scope, id);
  }

  /** The row stops being a reflection (its agent changed away from Hermes). */
  unlinkExternal(scope: Scope, id: string): ScheduleRow {
    this.db
      .update(schedules)
      .set({
        externalSource: null,
        externalId: null,
        externalState: null,
        externalSyncedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(schedules.workspace, scope.workspace), eq(schedules.id, id)))
      .run();
    return this.refreshNext(this.get(scope, id));
  }

  /** A run the hub asked for; it stays `queued` until the scheduler that fires it reports. */
  queueRun(scope: Scope, scheduleId: string, now: Date = new Date()): ScheduleRunRow {
    const id = newUlid();
    this.db
      .insert(scheduleRuns)
      .values({
        id,
        ownerId: scope.userId,
        workspace: scope.workspace,
        scheduleId,
        scheduledFor: now,
        status: 'queued',
      })
      .run();
    return this.run(scope, scheduleId, id);
  }

  // ------------------------------------------------- firing the hub's own

  /**
   * The hub's own schedules whose stored tick has come: enabled, not archived, not living
   * in another scheduler. Oldest tick first, a bounded batch per look.
   */
  dueAt(now: Date, limit = 50): ScheduleRow[] {
    return this.db
      .select()
      .from(schedules)
      .where(
        and(
          eq(schedules.enabled, true),
          isNull(schedules.archivedAt),
          isNull(schedules.externalSource),
          lte(schedules.nextRunAt, now),
        ),
      )
      .orderBy(asc(schedules.nextRunAt))
      .limit(limit)
      .all();
  }

  /**
   * Claim one due tick, in one transaction: move `next_run_at` on **only if it still holds
   * the tick that was read** (compare-and-set), and write the tick's history line, which
   * is unique per (schedule, tick). Whoever loses either race gets `null` and does nothing
   * — another process, or this one before a restart, already has it.
   *
   * `fire: false` claims a tick that is not run (missed, or the previous run is still
   * going): the line is written `skipped`, with the reason. `fire: 'wait'` claims a tick
   * held back until the previous run ends (`overlap: wait`): the line is `queued` and
   * `waiting`, and `ScheduleRuns.release` starts it.
   */
  claimTick(row: ScheduleRow, now: Date, decision: ClaimDecision): ScheduleRunRow | null {
    const tick = row.nextRunAt;
    if (!tick) return null;
    // A time that will run — now or once the previous run ends — is this schedule's last
    // run: an interval counts from it, and a one-off is used up.
    const lastRunAt = decision.fire === false ? row.lastRunAt : now;
    const next = this.nextFor({ ...row, lastRunAt }, now);
    const id = newUlid(now.getTime());
    try {
      if (!this.claimIn(row.id, tick, id, now, next, decision, row)) return null;
    } catch (error) {
      if (!(error instanceof AlreadyFired)) throw error;
      return null;
    }
    return this.db.select().from(scheduleRuns).where(eq(scheduleRuns.id, id)).get() ?? null;
  }

  private claimIn(
    scheduleId: string,
    tick: Date,
    id: string,
    now: Date,
    next: Date | null,
    decision: ClaimDecision,
    row: ScheduleRow,
  ): boolean {
    return this.db.transaction((tx) => {
      const moved = tx
        .update(schedules)
        .set({
          nextRunAt: next,
          ...(decision.fire === true
            ? { lastRunAt: now, lastStatus: 'queued' as const, lastError: null }
            : decision.fire === 'wait'
              ? { lastRunAt: now }
              : {}),
          updatedAt: now,
        })
        .where(
          and(
            eq(schedules.id, scheduleId),
            eq(schedules.enabled, true),
            eq(schedules.nextRunAt, tick),
          ),
        )
        .run();
      if (moved.changes !== 1) return false;
      const written = tx
        .insert(scheduleRuns)
        .values({
          id,
          ownerId: row.ownerId,
          workspace: row.workspace,
          scheduleId: row.id,
          scheduledFor: tick,
          trigger: 'schedule',
          status: decision.fire === false ? 'skipped' : 'queued',
          waiting: decision.fire === 'wait',
          error: decision.fire === false ? decision.reason : null,
          finishedAt: decision.fire === false ? now : null,
        })
        .onConflictDoNothing()
        .run();
      // The tick is already in the history: someone fired it. Throwing undoes the move.
      if (written.changes !== 1) throw new AlreadyFired();
      return true;
    });
  }

  /** "Run now": a line of its own, now, that leaves the schedule's next time alone. */
  manualRun(row: ScheduleRow, now: Date = new Date()): ScheduleRunRow {
    // Two presses in the same millisecond are the only way to meet the unique tick; the
    // second one takes the next millisecond rather than failing.
    for (let offset = 0; ; offset += 1) {
      const id = newUlid(now.getTime());
      const written = this.db
        .insert(scheduleRuns)
        .values({
          id,
          ownerId: row.ownerId,
          workspace: row.workspace,
          scheduleId: row.id,
          scheduledFor: new Date(now.getTime() + offset),
          trigger: 'manual',
          status: 'queued',
        })
        .onConflictDoNothing()
        .run();
      if (written.changes === 1) {
        this.db
          .update(schedules)
          .set({ lastRunAt: now, lastStatus: 'queued', lastError: null, updatedAt: now })
          .where(eq(schedules.id, row.id))
          .run();
        return this.db.select().from(scheduleRuns).where(eq(scheduleRuns.id, id)).get()!;
      }
    }
  }

  /**
   * This schedule's runs that have started and not ended — "the previous run is still
   * going". A time waiting for them is not one of them (`waitingRunOf`).
   */
  openRunsOf(scheduleId: string): ScheduleRunRow[] {
    return this.db
      .select()
      .from(scheduleRuns)
      .where(
        and(
          eq(scheduleRuns.scheduleId, scheduleId),
          inArray(scheduleRuns.status, ['queued', 'running']),
          eq(scheduleRuns.waiting, false),
        ),
      )
      .orderBy(asc(scheduleRuns.createdAt))
      .all();
  }

  /** The one time of this schedule waiting for its previous run to end, if any. */
  waitingRunOf(scheduleId: string): ScheduleRunRow | undefined {
    return this.db
      .select()
      .from(scheduleRuns)
      .where(
        and(
          eq(scheduleRuns.scheduleId, scheduleId),
          eq(scheduleRuns.status, 'queued'),
          eq(scheduleRuns.waiting, true),
        ),
      )
      .get();
  }

  /**
   * The previous run ended: the waiting time is now an ordinary line about to start. A
   * compare-and-set on `waiting`, so it is taken once; `null` when someone already took it.
   */
  takeWaiting(id: string, now: Date = new Date()): ScheduleRunRow | null {
    const taken = this.db
      .update(scheduleRuns)
      .set({ waiting: false, updatedAt: now })
      .where(
        and(
          eq(scheduleRuns.id, id),
          eq(scheduleRuns.status, 'queued'),
          eq(scheduleRuns.waiting, true),
        ),
      )
      .run();
    if (taken.changes !== 1) return null;
    const line = this.scheduleRunById(id)!;
    this.db
      .update(schedules)
      .set({ lastRunAt: now, lastStatus: 'queued', lastError: null, updatedAt: now })
      .where(eq(schedules.id, line.scheduleId))
      .run();
    return line;
  }

  /**
   * A line that will not run after all — a waiting time whose wait could not end well — is
   * recorded as skipped with the reason. `null` when it had already moved on.
   */
  skipLine(id: string, reason: string, now: Date = new Date()): ScheduleRunRow | null {
    const done = this.db
      .update(scheduleRuns)
      .set({ status: 'skipped', waiting: false, error: reason, finishedAt: now, updatedAt: now })
      .where(and(eq(scheduleRuns.id, id), eq(scheduleRuns.status, 'queued')))
      .run();
    return done.changes === 1 ? this.scheduleRunById(id)! : null;
  }

  /** The run has started: what it started, so the history can open it. */
  markRunStarted(
    id: string,
    started: { runId?: string | null; sessionId?: string | null; workflowRunId?: string | null },
    now: Date = new Date(),
  ): ScheduleRunRow {
    this.db
      .update(scheduleRuns)
      .set({
        status: 'running',
        runId: started.runId ?? null,
        sessionId: started.sessionId ?? null,
        workflowRunId: started.workflowRunId ?? null,
        startedAt: now,
        updatedAt: now,
      })
      // Only a line still waiting to start: one already settled stays as it ended.
      .where(and(eq(scheduleRuns.id, id), eq(scheduleRuns.status, 'queued')))
      .run();
    return this.scheduleRunById(id)!;
  }

  scheduleRunById(id: string): ScheduleRunRow | undefined {
    return this.db.select().from(scheduleRuns).where(eq(scheduleRuns.id, id)).get();
  }

  scheduleById(id: string): ScheduleRow | undefined {
    return this.db.select().from(schedules).where(eq(schedules.id, id)).get();
  }

  /**
   * A run ended. Written once: a line already settled (by the follow-up, or by the restart
   * sweep) is left alone and `null` comes back. The schedule remembers how its last run
   * went; a success counts toward the repeat limit, and the limit reached ends the schedule.
   */
  settleRun(
    id: string,
    outcome: {
      status: 'succeeded' | 'failed' | 'cancelled';
      output?: string | null;
      error?: string | null;
    },
    now: Date = new Date(),
  ): { run: ScheduleRunRow; schedule: ScheduleRow } | null {
    const done = this.db
      .update(scheduleRuns)
      .set({
        status: outcome.status,
        outputPreview: outcome.output ? outcome.output.slice(0, 500) : null,
        error: outcome.error ?? null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(and(eq(scheduleRuns.id, id), inArray(scheduleRuns.status, ['queued', 'running'])))
      .run();
    if (done.changes !== 1) return null;
    const run = this.scheduleRunById(id)!;
    const current = this.scheduleById(run.scheduleId);
    if (!current) return null;
    const repeatCount = current.repeatCount + (outcome.status === 'succeeded' ? 1 : 0);
    const exhausted = current.repeatLimit !== null && repeatCount >= current.repeatLimit;
    this.db
      .update(schedules)
      .set({
        lastStatus: outcome.status,
        lastError: outcome.status === 'succeeded' ? null : (outcome.error ?? null),
        repeatCount,
        ...(exhausted ? { nextRunAt: null } : {}),
        updatedAt: now,
      })
      .where(eq(schedules.id, current.id))
      .run();
    return { run, schedule: this.scheduleById(current.id)! };
  }

  /** Lines of the hub's own schedules that had not ended — what a restart must settle. */
  openRuns(): ScheduleRunRow[] {
    return this.db
      .select({ run: scheduleRuns })
      .from(scheduleRuns)
      .innerJoin(schedules, eq(schedules.id, scheduleRuns.scheduleId))
      .where(
        and(
          inArray(scheduleRuns.status, ['queued', 'running']),
          eq(scheduleRuns.waiting, false),
          isNull(schedules.externalSource),
        ),
      )
      .all()
      .map((row) => row.run);
  }

  /** Times of the hub's own schedules still waiting for a previous run — for a restart. */
  waitingRuns(): ScheduleRunRow[] {
    return this.db
      .select({ run: scheduleRuns })
      .from(scheduleRuns)
      .innerJoin(schedules, eq(schedules.id, scheduleRuns.scheduleId))
      .where(
        and(
          eq(scheduleRuns.status, 'queued'),
          eq(scheduleRuns.waiting, true),
          isNull(schedules.externalSource),
        ),
      )
      .all()
      .map((row) => row.run);
  }

  // -------------------------------------------------------- schedule runs

  runsOf(scope: Scope, scheduleId: string, limit: number): ScheduleRunRow[] {
    this.get(scope, scheduleId);
    return this.db
      .select()
      .from(scheduleRuns)
      .where(eq(scheduleRuns.scheduleId, scheduleId))
      .orderBy(desc(scheduleRuns.id))
      .limit(limit)
      .all();
  }

  run(scope: Scope, scheduleId: string, runId: string): ScheduleRunRow {
    this.get(scope, scheduleId);
    const row = this.db
      .select()
      .from(scheduleRuns)
      .where(and(eq(scheduleRuns.scheduleId, scheduleId), eq(scheduleRuns.id, runId)))
      .get();
    if (!row) throw notFound({ resource: 'schedule_run', id: runId });
    return row;
  }

  removeRun(scope: Scope, scheduleId: string, runId: string): void {
    this.run(scope, scheduleId, runId);
    this.db.delete(scheduleRuns).where(eq(scheduleRuns.id, runId)).run();
  }

  // ------------------------------------------------------------ workflows

  listWorkflows(scope: Scope): WorkflowRow[] {
    return this.db
      .select()
      .from(workflows)
      .where(and(eq(workflows.workspace, scope.workspace), isNull(workflows.archivedAt)))
      .orderBy(desc(workflows.id))
      .all();
  }

  workflow(scope: Scope, id: string): WorkflowRow {
    const row = this.db
      .select()
      .from(workflows)
      .where(and(eq(workflows.workspace, scope.workspace), eq(workflows.id, id)))
      .get();
    if (!row) throw notFound({ resource: 'workflow', id });
    return row;
  }

  createWorkflow(scope: Scope, input: Record<string, unknown>): WorkflowRow {
    const name = String(input.name ?? '').trim();
    if (name === '') throw conflict({ reason: 'name_required', field: 'name' });
    const definition = definitionOf(input);
    const problems = validateDefinition(definition);
    if (problems.length > 0) throw conflict({ reason: 'workflow_invalid', problems });
    const id = newUlid();
    this.db
      .insert(workflows)
      .values({
        id,
        ownerId: scope.userId,
        workspace: scope.workspace,
        name,
        description: (input.description as string | null) ?? null,
        definition,
      })
      .run();
    return this.workflow(scope, id);
  }

  updateWorkflow(scope: Scope, id: string, patch: Record<string, unknown>): WorkflowRow {
    const current = this.workflow(scope, id);
    const values: Partial<typeof workflows.$inferInsert> = { updatedAt: new Date() };
    if (patch.name !== undefined) values.name = String(patch.name);
    if (patch.description !== undefined) values.description = patch.description as string | null;
    if (patch.nodes !== undefined || patch.edges !== undefined || patch.working_dir !== undefined) {
      const definition = definitionOf({
        nodes: patch.nodes ?? current.definition.nodes,
        edges: patch.edges ?? current.definition.edges,
        working_dir: patch.working_dir ?? current.definition.workingDir ?? null,
      });
      const problems = validateDefinition(definition);
      if (problems.length > 0) throw conflict({ reason: 'workflow_invalid', problems });
      values.definition = definition;
      // A run snapshots the definition it used, so a change is a new version.
      values.version = current.version + 1;
    }
    this.db.update(workflows).set(values).where(eq(workflows.id, id)).run();
    return this.workflow(scope, id);
  }

  removeWorkflow(scope: Scope, id: string): void {
    this.workflow(scope, id);
    this.db.delete(workflows).where(eq(workflows.id, id)).run();
  }

  /** Enabled schedules pointing at this workflow — the contract's `schedule_count`. */
  scheduleCount(scope: Scope, workflowId: string): number {
    return this.db
      .select({ id: schedules.id })
      .from(schedules)
      .where(
        and(
          eq(schedules.workspace, scope.workspace),
          eq(schedules.workflowId, workflowId),
          eq(schedules.enabled, true),
        ),
      )
      .all().length;
  }

  // -------------------------------------------------------- workflow runs

  workflowRunsOf(scope: Scope, workflowId: string, limit: number): WorkflowRunRow[] {
    this.workflow(scope, workflowId);
    return this.db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowId, workflowId))
      .orderBy(desc(workflowRuns.id))
      .limit(limit)
      .all();
  }

  workflowRun(scope: Scope, id: string): WorkflowRunRow {
    const row = this.db
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.workspace, scope.workspace), eq(workflowRuns.id, id)))
      .get();
    if (!row) throw notFound({ resource: 'workflow_run', id });
    return row;
  }

  stepsOf(workflowRunId: string): NodeRunRow[] {
    return this.db
      .select()
      .from(nodeRuns)
      .where(eq(nodeRuns.workflowRunId, workflowRunId))
      .orderBy(desc(nodeRuns.id))
      .all();
  }

  removeWorkflowRun(scope: Scope, id: string): void {
    this.workflowRun(scope, id);
    this.db.delete(workflowRuns).where(eq(workflowRuns.id, id)).run();
  }

  // ------------------------------------------------------ running a workflow

  /** A run, started now, with the definition it runs frozen into it. */
  createWorkflowRun(
    scope: Scope,
    workflow: WorkflowRow,
    input: {
      input: Record<string, unknown>;
      triggerKind: WorkflowRunRow['triggerKind'];
      triggerRef?: string | null;
      scheduleId?: string | null;
    },
  ): WorkflowRunRow {
    const id = newUlid();
    const now = new Date();
    this.db
      .insert(workflowRuns)
      .values({
        id,
        ownerId: scope.userId,
        workspace: scope.workspace,
        workflowId: workflow.id,
        scheduleId: input.scheduleId ?? null,
        triggerKind: input.triggerKind,
        triggerRef: input.triggerRef ?? null,
        status: 'running',
        workflowVersion: workflow.version,
        definitionSnapshot: workflow.definition,
        input: input.input,
        startedAt: now,
      })
      .run();
    return this.workflowRun(scope, id);
  }

  updateWorkflowRun(id: string, patch: Partial<typeof workflowRuns.$inferInsert>): void {
    this.db
      .update(workflowRuns)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(workflowRuns.id, id))
      .run();
  }

  /** One step begins: a row per node and attempt, so a rerun keeps the old attempt. */
  startStep(
    scope: Scope,
    workflowRunId: string,
    node: WorkflowNode,
    input: Record<string, unknown>,
  ): NodeRunRow {
    const attempt =
      this.stepsOf(workflowRunId).filter((step) => step.nodeKey === node.id).length + 1;
    const id = newUlid();
    this.db
      .insert(nodeRuns)
      .values({
        id,
        ownerId: scope.userId,
        workspace: scope.workspace,
        workflowRunId,
        nodeKey: node.id,
        nodeType: node.kind === 'agent' ? 'agent_run' : node.kind,
        attempt,
        status: 'running',
        input,
        startedAt: new Date(),
      })
      .run();
    return this.db.select().from(nodeRuns).where(eq(nodeRuns.id, id)).get()!;
  }

  finishStep(
    id: string,
    patch: {
      status: NodeRunRow['status'];
      output?: Record<string, unknown> | null;
      error?: string | null;
      runId?: string | null;
    },
  ): NodeRunRow {
    const now = new Date();
    this.db
      .update(nodeRuns)
      .set({
        status: patch.status,
        output: patch.output ?? null,
        error: patch.error ?? null,
        runId: patch.runId ?? null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(eq(nodeRuns.id, id))
      .run();
    return this.db.select().from(nodeRuns).where(eq(nodeRuns.id, id)).get()!;
  }

  /** The run of this workflow that is still going, if any. */
  activeRunOf(workflowId: string): string | null {
    return (
      this.db
        .select({ id: workflowRuns.id })
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.workflowId, workflowId),
            inArray(workflowRuns.status, ['queued', 'running', 'waiting_approval']),
          ),
        )
        .orderBy(desc(workflowRuns.id))
        .get()?.id ?? null
    );
  }

  /**
   * Runs a restart cut short. The engine keeps its place in memory while a step works, so
   * a run that was going when the process stopped cannot continue — it is failed, with
   * that reason, rather than left "running" forever. A run **waiting at an approval** is
   * not cut short: its place is written down (`resume_state`), and it goes on when the
   * approval is answered, restart or not.
   */
  failInterruptedRuns(): number {
    const now = new Date();
    const reason = 'the hub restarted while this run was going';
    const stale = this.db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(inArray(workflowRuns.status, ['queued', 'running', 'paused']))
      .all();
    for (const run of stale) {
      this.db
        .update(nodeRuns)
        .set({ status: 'failed', error: reason, finishedAt: now, updatedAt: now })
        .where(
          and(
            eq(nodeRuns.workflowRunId, run.id),
            inArray(nodeRuns.status, ['pending', 'running', 'waiting_approval']),
          ),
        )
        .run();
      this.updateWorkflowRun(run.id, {
        status: 'failed',
        error: reason,
        activeNodeKeys: [],
        finishedAt: now,
      });
    }
    return stale.length;
  }

  /** A step now waits for a person: the step, and the run with its place written down. */
  pauseAtGate(
    workflowRunId: string,
    stepId: string,
    approvalId: string,
    nodeId: string,
    resume: WorkflowResumeState,
  ): void {
    const now = new Date();
    this.db
      .update(nodeRuns)
      .set({ status: 'waiting_approval', approvalId, updatedAt: now })
      .where(eq(nodeRuns.id, stepId))
      .run();
    this.updateWorkflowRun(workflowRunId, {
      status: 'waiting_approval',
      activeNodeKeys: [nodeId],
      resumeState: resume,
    });
  }

  /**
   * Take a waiting run back, once: `waiting_approval` → `running` only if it is still
   * waiting. The answer that loses a race (or comes after a cancel) gets `undefined`.
   */
  takeWaitingRun(workflowRunId: string): WorkflowRunRow | undefined {
    const result = this.db
      .update(workflowRuns)
      .set({ status: 'running', updatedAt: new Date() })
      .where(and(eq(workflowRuns.id, workflowRunId), eq(workflowRuns.status, 'waiting_approval')))
      .run();
    if (result.changes !== 1) return undefined;
    return this.db.select().from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)).get();
  }

  /** The step of a run that waits at a node's gate. */
  waitingStep(workflowRunId: string, nodeId: string): NodeRunRow | undefined {
    return this.db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.workflowRunId, workflowRunId),
          eq(nodeRuns.nodeKey, nodeId),
          eq(nodeRuns.status, 'waiting_approval'),
        ),
      )
      .orderBy(desc(nodeRuns.id))
      .get();
  }

  /** A gated step that was approved goes on doing its own work. */
  resumeStep(id: string): void {
    this.db
      .update(nodeRuns)
      .set({ status: 'running', updatedAt: new Date() })
      .where(eq(nodeRuns.id, id))
      .run();
  }

  /** Runs of a workflow paused at a gate — closed before the workflow is deleted. */
  waitingRunsOf(workflowId: string): WorkflowRunRow[] {
    return this.db
      .select()
      .from(workflowRuns)
      .where(
        and(eq(workflowRuns.workflowId, workflowId), eq(workflowRuns.status, 'waiting_approval')),
      )
      .all();
  }

  workflowRunById(id: string): WorkflowRunRow | undefined {
    return this.db.select().from(workflowRuns).where(eq(workflowRuns.id, id)).get();
  }

  workflowById(id: string): WorkflowRow | undefined {
    return this.db.select().from(workflows).where(eq(workflows.id, id)).get();
  }

  /** Steps a cancel left waiting at a gate end as cancelled. */
  cancelWaitingSteps(workflowRunId: string): void {
    const now = new Date();
    this.db
      .update(nodeRuns)
      .set({ status: 'cancelled', finishedAt: now, updatedAt: now })
      .where(
        and(
          eq(nodeRuns.workflowRunId, workflowRunId),
          inArray(nodeRuns.status, ['pending', 'running', 'waiting_approval']),
        ),
      )
      .run();
  }

  cancelWorkflowRun(scope: Scope, id: string): WorkflowRunRow {
    const row = this.workflowRun(scope, id);
    if (['succeeded', 'failed', 'cancelled'].includes(row.status)) {
      throw conflict({ reason: 'run_already_finished', status: row.status });
    }
    const now = new Date();
    this.db
      .update(workflowRuns)
      .set({
        status: 'cancelled',
        activeNodeKeys: [],
        resumeState: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(eq(workflowRuns.id, id))
      .run();
    return this.workflowRun(scope, id);
  }
}

/** A tick another claim already wrote: the transaction is undone, nothing fires. */
class AlreadyFired extends Error {}

/**
 * How a claimed tick goes on: it runs now, it waits for the previous run (`overlap: wait`),
 * or it does not run and the history says why.
 */
export type ClaimDecision = { fire: true } | { fire: 'wait' } | { fire: false; reason: string };

/** The contract's `overlap`, when a write says one; a word it does not know is refused. */
function overlapOf(value: unknown): ScheduleOverlap | null {
  if (value === undefined || value === null) return null;
  if ((SCHEDULE_OVERLAPS as readonly unknown[]).includes(value)) return value as ScheduleOverlap;
  throw conflict({ reason: 'overlap_unknown', field: 'overlap' });
}

/** Hermes's `last_status` in the hub's words; `delivery_failed` still ran. */
function runStatusOfHermes(status: string | null | undefined): ScheduleRow['lastStatus'] {
  if (!status) return null;
  if (status === 'ok' || status === 'delivery_failed') return 'succeeded';
  if (status === 'error') return 'failed';
  if (status === 'skipped') return 'skipped';
  return 'failed';
}

/** The contract's delivery block, stored as the table's smaller one. */
function deliveryOf(delivery: Record<string, unknown> | undefined) {
  if (!delivery) return {};
  const kind = delivery.kind as string | undefined;
  return {
    ...(kind === 'room' && delivery.room_id ? { roomId: String(delivery.room_id) } : {}),
    ...(kind === 'notice' ? { notify: true } : {}),
    ...(kind === 'channel' && delivery.channel
      ? { channel: String(delivery.channel), address: (delivery.address as string | null) ?? null }
      : {}),
  };
}

export function definitionOf(input: Record<string, unknown>): WorkflowDefinition {
  return {
    nodes: ((input.nodes as WorkflowNode[] | undefined) ?? []).map((node) => ({ ...node })),
    edges: ((input.edges as WorkflowEdge[] | undefined) ?? []).map((edge) => ({ ...edge })),
    workingDir: (input.working_dir as string | null | undefined) ?? null,
  };
}

/**
 * One thing worth saying about a drawing: a stable `code` a client translates, the node or
 * edge it is about (so an editor can mark it), and the same thing in English words — which
 * is what `workflow_invalid` has always carried (contract `WorkflowIssue`, DECISIONS §52).
 */
export interface WorkflowIssue {
  code: string;
  node_id: string | null;
  edge_id: string | null;
  detail: string | null;
  message: string;
}

const issue = (
  code: string,
  message: string,
  at: { node?: string | null; edge?: string | null; detail?: string | null } = {},
): WorkflowIssue => ({
  code,
  node_id: at.node ?? null,
  edge_id: at.edge ?? null,
  detail: at.detail ?? null,
  message,
});

/**
 * What is wrong with a workflow, in words a person can act on. A definition is refused
 * when it is *unrunnable* — a duplicate id, an edge to nowhere — and only warned about
 * when it is merely odd, because a half-drawn workflow is a normal thing to save.
 */
export function problemsOf(definition: WorkflowDefinition): WorkflowIssue[] {
  const problems: WorkflowIssue[] = [];
  const ids = new Set<string>();
  for (const node of definition.nodes) {
    if (!node.id) problems.push(issue('node_id_missing', 'a node has no id'));
    else if (ids.has(node.id)) {
      problems.push(
        issue('node_id_duplicate', `two nodes share the id "${node.id}"`, { node: node.id }),
      );
    }
    ids.add(node.id);
  }
  for (const edge of definition.edges) {
    if (!ids.has(edge.from)) {
      problems.push(
        issue('edge_from_unknown', `an edge starts at "${edge.from}", which is not a node`, {
          edge: edge.id ?? null,
          detail: edge.from,
        }),
      );
    }
    if (!ids.has(edge.to)) {
      problems.push(
        issue('edge_to_unknown', `an edge ends at "${edge.to}", which is not a node`, {
          edge: edge.id ?? null,
          detail: edge.to,
        }),
      );
    }
  }
  // What a step says is checked now, not when the run reaches it at 3 a.m. (`expr.ts`).
  for (const node of definition.nodes) {
    const name = node.title || node.id;
    const input = node.input ?? '';
    if (node.kind === 'condition') {
      try {
        parseCondition(input);
      } catch (error) {
        const reason = error instanceof ConditionError ? error.reason : 'unreadable';
        problems.push(
          issue('condition_unreadable', `the condition of "${name}" cannot be read (${reason})`, {
            node: node.id,
            detail: reason,
          }),
        );
      }
      continue;
    }
    if (node.kind === 'delay' && pathsIn(input).length === 0) {
      const seconds = Number(input.trim());
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_DELAY_SECONDS) {
        problems.push(
          issue(
            'delay_out_of_range',
            `the delay of "${name}" must be 0 to ${MAX_DELAY_SECONDS} seconds`,
            { node: node.id, detail: String(MAX_DELAY_SECONDS) },
          ),
        );
      }
    }
    for (const path of pathsIn(input)) {
      const [root, second] = path.split('.');
      if (root !== 'input' && root !== 'trigger' && root !== 'steps') {
        problems.push(
          issue(
            'template_root_unknown',
            `"${name}" refers to {{${path}}}; a path starts with input, trigger or steps`,
            { node: node.id, detail: path },
          ),
        );
      } else if (root === 'steps' && (!second || !ids.has(second))) {
        problems.push(
          issue(
            'template_step_unknown',
            `"${name}" refers to {{${path}}}, but there is no step "${second ?? ''}"`,
            { node: node.id, detail: path },
          ),
        );
      }
    }
  }
  return problems;
}

/** The refusal's words, as `workflow_invalid` carries them. */
export function validateDefinition(definition: WorkflowDefinition): string[] {
  return problemsOf(definition).map((problem) => problem.message);
}

/** Things worth saying about a workflow that are not reasons to refuse it. */
export function warningIssuesOf(definition: WorkflowDefinition): WorkflowIssue[] {
  const warnings: WorkflowIssue[] = [];
  if (definition.nodes.length === 0) {
    warnings.push(issue('workflow_empty', 'the workflow has no nodes yet'));
  }
  const reached = new Set(definition.edges.map((edge) => edge.to));
  const starts = definition.nodes.filter((node) => !reached.has(node.id));
  if (definition.nodes.length > 0 && starts.length === 0) {
    warnings.push(
      issue('no_start', 'every node is reached by an edge, so the workflow has no starting point'),
    );
  }
  if (starts.length > 1) {
    warnings.push(
      issue('many_starts', `${starts.length} nodes have nothing before them`, {
        detail: String(starts.length),
      }),
    );
  }
  for (const node of definition.nodes) {
    if (node.kind === 'agent' && !node.agent_id) {
      warnings.push(
        issue('agent_missing', `the node "${node.title || node.id}" names no agent`, {
          node: node.id,
        }),
      );
    }
  }
  return warnings;
}

export function warningsFor(definition: WorkflowDefinition): string[] {
  return warningIssuesOf(definition).map((warning) => warning.message);
}
