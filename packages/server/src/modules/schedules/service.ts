/**
 * Schedules and workflows: **when** something should happen, and **what** should happen.
 *
 * This module owns both definitions and the history of what was tried. It does not own the
 * doing: firing a schedule means opening a session and queueing a run, and that worker is
 * not built (the same gap the Tasks board names). So the three operations that would
 * *start* something — `runNow`, `runWorkflow`, `rerunWorkflowFromNode` — answer `501` with
 * their operation ids, and everything that defines, lists, validates and remembers answers
 * properly. A schedule that silently never fires is the failure that makes people distrust
 * schedulers; one that says out loud "I cannot run this yet" does not.
 *
 * What it does compute for real is `next_run_at` (`cron.ts`), so a saved schedule can
 * always say when it *would* run.
 */
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
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
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
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
    return this.db
      .select()
      .from(schedules)
      .where(
        and(
          eq(schedules.workspace, scope.workspace),
          isNull(schedules.archivedAt),
          filter.agentId ? eq(schedules.agentId, filter.agentId) : undefined,
          filter.workflowId ? eq(schedules.workflowId, filter.workflowId) : undefined,
          filter.enabled === undefined ? undefined : eq(schedules.enabled, filter.enabled),
        ),
      )
      .orderBy(desc(schedules.id))
      .all();
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
   * Runs a restart cut short. The engine keeps its place in memory, so a run that was
   * going when the process stopped cannot continue — it is failed, with that reason,
   * rather than left "running" forever.
   */
  failInterruptedRuns(): number {
    const now = new Date();
    const reason = 'the hub restarted while this run was going';
    const stale = this.db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(inArray(workflowRuns.status, ['queued', 'running', 'waiting_approval', 'paused']))
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

  cancelWorkflowRun(scope: Scope, id: string): WorkflowRunRow {
    const row = this.workflowRun(scope, id);
    if (['succeeded', 'failed', 'cancelled'].includes(row.status)) {
      throw conflict({ reason: 'run_already_finished', status: row.status });
    }
    const now = new Date();
    this.db
      .update(workflowRuns)
      .set({ status: 'cancelled', finishedAt: now, updatedAt: now })
      .where(eq(workflowRuns.id, id))
      .run();
    return this.workflowRun(scope, id);
  }
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

function definitionOf(input: Record<string, unknown>): WorkflowDefinition {
  return {
    nodes: ((input.nodes as WorkflowNode[] | undefined) ?? []).map((node) => ({ ...node })),
    edges: ((input.edges as WorkflowEdge[] | undefined) ?? []).map((edge) => ({ ...edge })),
    workingDir: (input.working_dir as string | null | undefined) ?? null,
  };
}

/**
 * What is wrong with a workflow, in words a person can act on. A definition is refused
 * when it is *unrunnable* — a duplicate id, an edge to nowhere — and only warned about
 * when it is merely odd, because a half-drawn workflow is a normal thing to save.
 */
export function validateDefinition(definition: WorkflowDefinition): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const node of definition.nodes) {
    if (!node.id) problems.push('a node has no id');
    else if (ids.has(node.id)) problems.push(`two nodes share the id "${node.id}"`);
    ids.add(node.id);
  }
  for (const edge of definition.edges) {
    if (!ids.has(edge.from)) problems.push(`an edge starts at "${edge.from}", which is not a node`);
    if (!ids.has(edge.to)) problems.push(`an edge ends at "${edge.to}", which is not a node`);
  }
  // What a step says is checked now, not when the run reaches it at 3 a.m. (`expr.ts`).
  for (const node of definition.nodes) {
    const name = node.title || node.id;
    const input = node.input ?? '';
    if (node.kind === 'condition') {
      try {
        parseCondition(input);
      } catch (error) {
        problems.push(
          `the condition of "${name}" cannot be read (${error instanceof ConditionError ? error.reason : 'unreadable'})`,
        );
      }
      continue;
    }
    if (node.kind === 'delay' && pathsIn(input).length === 0) {
      const seconds = Number(input.trim());
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_DELAY_SECONDS) {
        problems.push(`the delay of "${name}" must be 0 to ${MAX_DELAY_SECONDS} seconds`);
      }
    }
    for (const path of pathsIn(input)) {
      const [root, second] = path.split('.');
      if (root !== 'input' && root !== 'trigger' && root !== 'steps') {
        problems.push(
          `"${name}" refers to {{${path}}}; a path starts with input, trigger or steps`,
        );
      } else if (root === 'steps' && (!second || !ids.has(second))) {
        problems.push(`"${name}" refers to {{${path}}}, but there is no step "${second ?? ''}"`);
      }
    }
  }
  return problems;
}

/** Things worth saying about a workflow that are not reasons to refuse it. */
export function warningsFor(definition: WorkflowDefinition): string[] {
  const warnings: string[] = [];
  if (definition.nodes.length === 0) warnings.push('the workflow has no nodes yet');
  const reached = new Set(definition.edges.map((edge) => edge.to));
  const starts = definition.nodes.filter((node) => !reached.has(node.id));
  if (definition.nodes.length > 0 && starts.length === 0) {
    warnings.push('every node is reached by an edge, so the workflow has no starting point');
  }
  if (starts.length > 1) {
    warnings.push(`${starts.length} nodes have nothing before them`);
  }
  for (const node of definition.nodes) {
    if (node.kind === 'agent' && !node.agent_id) {
      warnings.push(`the node "${node.title || node.id}" names no agent`);
    }
  }
  return warnings;
}
