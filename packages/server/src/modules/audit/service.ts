/**
 * The write side of `audit`, used by other modules through `index.ts`.
 *
 * Three ledgers, all owned here (docs/domain/audit.md):
 *
 * - **audit_events** — who did what. `auth` records sign-ins, pairings and user changes;
 *   `agents` records installs. This replaces `auth/audit-stub.ts`, which wrote the same
 *   rows with hand-built SQL while this module was empty.
 * - **jobs** — every long piece of work is a job (invariant 4). A module that owns the
 *   work drives it through `createJob` / `startJob` / `progressJob` / `finishJob`, and
 *   `jobs.ts` wraps that in a runner for work that is a single async function.
 * - **usage_records** — the only place cost lives. One row per (run, model label).
 *
 * Every state change of a job is announced on `/rt/jobs` when a realtime emitter is
 * attached, so a client polling `jobs.list` and a client on the socket see one history.
 *
 * The API is synchronous because the SQLite driver is (`lib/db.ts`); nothing here awaits.
 */
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { newUlid } from '../../db/ids.js';
import type { ModuleDb } from '../../lib/db.js';
import { clampLimit, decodeCursor, pageOf } from '../../lib/pagination.js';
import { iso } from '../../lib/time.js';
import type { ErrorCode } from '../../lib/errors.js';
import {
  auditEvents,
  jobEvents,
  jobs,
  skillUses,
  usageRecords,
  type ACTOR_KINDS,
  type COST_SOURCES,
  type JOB_STATUSES,
  type USAGE_ORIGINS,
} from './schema.js';

export type JobStatus = (typeof JOB_STATUSES)[number];
export type CostSource = (typeof COST_SOURCES)[number];
export type UsageOrigin = (typeof USAGE_ORIGINS)[number];
export type ActorKind = (typeof ACTOR_KINDS)[number];

export type JobRow = typeof jobs.$inferSelect;

/** The contract's `JobKind`: the verb half of the stored `<module>.<verb>` kind. */
export type ContractJobKind =
  | 'run'
  | 'install'
  | 'update'
  | 'uninstall'
  | 'restart'
  | 'check_update'
  | 'discover'
  | 'refresh_catalogue'
  | 'worktree'
  | 'webhook_test'
  | 'device_request'
  | 'export'
  | 'schedule_run'
  | 'workflow_run';

export interface AuditEventInput {
  actorKind: ActorKind;
  actorId?: string | null;
  /** `<entity>.<verb>`: `auth.login`, `agents.installed`. */
  action: string;
  workspace?: string | null;
  entityKind?: string | null;
  entityId?: string | null;
  /** One English line; clients localise by `action`. Never a secret. */
  summary?: string;
  data?: Record<string, unknown>;
  deviceId?: string | null;
  requestId?: string | null;
  /** The user the row is attributed to; the owner account for system actions. */
  ownerId: string;
}

export interface JobCreate {
  /**
   * Null only for work that has no workspace yet — importing a profile creates one. Such
   * a job is invisible to `jobs.list`, which is workspace-scoped, and the contract's
   * `Job.profile` is not nullable; the operation that needs it owns that gap.
   */
  workspace: string | null;
  ownerId: string;
  /** `<module>.<verb>` (docs/domain/audit.md); the contract's `JobKind` is the wire form. */
  kind: string;
  entityKind?: string | null;
  entityId?: string | null;
  input?: Record<string, unknown>;
  /** First progress line, already localised. */
  message?: string;
}

export interface UsageWrite {
  workspace: string;
  ownerId: string;
  runId: string;
  sessionId: string;
  agentId: string;
  providerId?: string | null;
  modelLabel: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costMicroUsd?: number;
  costSource?: CostSource;
  originKind?: UsageOrigin;
  originId?: string | null;
}

export interface SkillUseWrite {
  workspace: string;
  ownerId: string;
  runId: string;
  sessionId: string;
  agentId: string;
  /** The skill's name as the agent asked for it. */
  skill: string;
  at?: number;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costMicroUsd: number;
  /** False when no record carries a provider-reported or computed cost. */
  hasCost: boolean;
}

const ZERO: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costMicroUsd: 0,
  hasCost: false,
};

/**
 * How a job reaches `/rt/jobs`. Injected rather than imported so `audit` does not depend
 * on the socket layer; `index.ts` wires the real emitter at registration.
 */
export interface JobAnnouncer {
  (event: string, profile: string, job: Record<string, unknown>): void;
}

export class AuditService {
  private announcer: JobAnnouncer | null = null;

  constructor(private readonly db: ModuleDb) {}

  /** Attaches the `/rt/jobs` emitter. Without it the ledger still works, silently. */
  announceWith(announcer: JobAnnouncer | null): void {
    this.announcer = announcer;
  }

  // ------------------------------------------------------------ audit trail

  record(event: AuditEventInput, now: number = Date.now()): string {
    const id = newUlid(now);
    const at = new Date(now);
    this.db
      .insert(auditEvents)
      .values({
        id,
        ownerId: event.ownerId,
        workspace: event.workspace ?? null,
        actorKind: event.actorKind,
        actorId: event.actorId ?? null,
        action: event.action,
        entityKind: event.entityKind ?? null,
        entityId: event.entityId ?? null,
        summary: event.summary ?? null,
        data: event.data ?? {},
        deviceId: event.deviceId ?? null,
        requestId: event.requestId ?? null,
        createdAt: at,
        updatedAt: at,
      })
      .run();
    return id;
  }

  // ------------------------------------------------------------------- jobs

  /** Create a `queued` job and return its id immediately (invariant 4). */
  createJob(input: JobCreate): string {
    const id = newUlid();
    this.db
      .insert(jobs)
      .values({
        id,
        ownerId: input.ownerId,
        workspace: input.workspace,
        kind: input.kind,
        status: 'queued',
        progress: -1,
        progressMessage: input.message ?? null,
        entityKind: input.entityKind ?? null,
        entityId: input.entityId ?? null,
        input: input.input ?? {},
      })
      .run();
    this.announce(id, 'job.queued');
    return id;
  }

  startJob(jobId: string): void {
    this.db
      .update(jobs)
      .set({ status: 'running', startedAt: new Date(), attempts: sql`${jobs.attempts} + 1` })
      .where(and(eq(jobs.id, jobId), inArray(jobs.status, ['queued', 'running'])))
      .run();
    this.announce(jobId, 'job.started');
  }

  /** `percent` null means "no measurable progress"; the message is already localised. */
  progressJob(
    jobId: string,
    percent: number | null,
    message: string | null,
    result?: Record<string, unknown>,
  ): void {
    const row = this.job(jobId);
    if (
      !row ||
      row.status === 'succeeded' ||
      row.status === 'failed' ||
      row.status === 'cancelled'
    ) {
      return;
    }
    const now = new Date();
    this.db
      .update(jobs)
      .set({
        progress: percent ?? -1,
        progressMessage: message,
        heartbeatAt: now,
        updatedAt: now,
        ...(result !== undefined ? { result } : {}),
      })
      .where(eq(jobs.id, jobId))
      .run();
    if (message) this.appendJobEvent(jobId, message, 'progress');
    this.announce(jobId, 'job.progress');
  }

  finishJob(
    jobId: string,
    status: Extract<JobStatus, 'succeeded' | 'failed' | 'cancelled'>,
    outcome: {
      result?: Record<string, unknown>;
      errorCode?: string;
      errorMessage?: string;
      message?: string;
    } = {},
  ): void {
    this.db
      .update(jobs)
      .set({
        status,
        finishedAt: new Date(),
        updatedAt: new Date(),
        ...(status === 'succeeded' ? { progress: 100 } : {}),
        ...(outcome.message !== undefined ? { progressMessage: outcome.message } : {}),
        result: outcome.result ?? null,
        errorCode: outcome.errorCode ?? null,
        errorMessage: outcome.errorMessage ?? null,
      })
      .where(eq(jobs.id, jobId))
      .run();
    this.appendJobEvent(
      jobId,
      outcome.message ?? outcome.errorMessage ?? status,
      status === 'failed' ? 'error' : 'info',
    );
    this.announce(
      jobId,
      status === 'succeeded'
        ? 'job.completed'
        : status === 'failed'
          ? 'job.failed'
          : 'job.cancelled',
    );
  }

  /** Marks a job as asked to stop. A queued job dies at once; a running one winds down. */
  requestCancel(jobId: string): JobRow | null {
    const row = this.job(jobId);
    if (!row) return null;
    const now = new Date();
    this.db
      .update(jobs)
      .set({ status: 'cancelling', cancelRequestedAt: now, updatedAt: now })
      .where(eq(jobs.id, jobId))
      .run();
    this.announce(jobId, 'job.progress');
    return this.job(jobId);
  }

  job(jobId: string): JobRow | null {
    return this.db.select().from(jobs).where(eq(jobs.id, jobId)).get() ?? null;
  }

  jobIn(workspace: string, jobId: string): JobRow | null {
    return (
      this.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, jobId), eq(jobs.workspace, workspace)))
        .get() ?? null
    );
  }

  listJobs(query: {
    workspace: string;
    status?: string | undefined;
    kind?: string | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
  }): { items: JobRow[]; next_cursor: string | null } {
    const limit = clampLimit(query.limit);
    const before = decodeCursor(query.cursor);
    const rows = this.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.workspace, query.workspace),
          before ? lt(jobs.id, before) : undefined,
          // `<module>.<verb>`: the contract sends the verb.
          query.kind ? sql`${jobs.kind} like ${`%.${query.kind}`}` : undefined,
          // `cancelling` is an internal state; the contract calls it `running`.
          query.status === 'running'
            ? inArray(jobs.status, ['running', 'cancelling'])
            : query.status
              ? eq(jobs.status, query.status as JobStatus)
              : undefined,
        ),
      )
      .orderBy(desc(jobs.id))
      .limit(limit + 1)
      .all();
    return pageOf(rows, limit, (row) => row);
  }

  appendJobEvent(jobId: string, message: string, level: 'info' | 'error' | 'progress'): void {
    const row = this.job(jobId);
    if (!row) return;
    const last = this.db
      .select({ seq: jobEvents.seq })
      .from(jobEvents)
      .where(eq(jobEvents.jobId, jobId))
      .orderBy(desc(jobEvents.seq))
      .limit(1)
      .get();
    this.db
      .insert(jobEvents)
      .values({
        id: newUlid(),
        ownerId: row.ownerId,
        workspace: row.workspace,
        jobId,
        seq: (last?.seq ?? 0) + 1,
        level,
        message,
      })
      .run();
  }

  private announce(jobId: string, event: string): void {
    if (!this.announcer) return;
    const row = this.job(jobId);
    if (!row) return;
    const profile = this.slugs.get(row.workspace ?? '');
    // A job whose workspace slug nobody registered is still recorded; it just has no
    // profile room to reach, and `Job.profile` in the contract is not nullable.
    if (!profile) return;
    this.announcer(event, profile, serializeJob(row, profile));
  }

  /**
   * `Job.profile` is a workspace **slug** while the column holds the id, so an emitted
   * job needs a translation. `auth` owns workspaces; rather than read its tables from
   * here, every caller that already resolved `X-Hub-Profile` registers the pair.
   */
  private readonly slugs = new Map<string, string>();

  rememberWorkspace(id: string, slug: string): void {
    this.slugs.set(id, slug);
  }

  /** The slug registered for a workspace id, for callers that serialize a job themselves. */
  slugFor(workspaceId: string): string | null {
    return this.slugs.get(workspaceId) ?? null;
  }

  // ------------------------------------------------------------------ usage

  /**
   * Record what a run cost. Idempotent per (run, model label): a second report for the
   * same pair replaces the first, because adapters re-send cumulative totals.
   */
  recordUsage(input: UsageWrite): void {
    const row = {
      ownerId: input.ownerId,
      workspace: input.workspace,
      runId: input.runId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      providerId: input.providerId ?? null,
      modelLabel: input.modelLabel,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      cacheReadTokens: input.cacheReadTokens ?? 0,
      cacheWriteTokens: input.cacheWriteTokens ?? 0,
      reasoningTokens: input.reasoningTokens ?? 0,
      costMicroUsd: input.costMicroUsd ?? 0,
      costSource: input.costSource ?? 'unknown',
      originKind: input.originKind ?? 'user',
      originId: input.originId ?? null,
      recordedAt: new Date(),
    };
    this.db
      .insert(usageRecords)
      .values({ id: newUlid(), ...row })
      .onConflictDoUpdate({
        target: [usageRecords.runId, usageRecords.modelLabel],
        set: { ...row, updatedAt: new Date() },
      })
      .run();
  }

  // ------------------------------------------------------------ skill use

  /**
   * One skill an agent loaded in one run (contract decision §47). The same skill loaded again
   * in the same run is the same use, so a second write is ignored rather than counted.
   */
  recordSkillUse(input: SkillUseWrite): void {
    const skill = input.skill.trim().slice(0, 200);
    if (!skill) return;
    const at = new Date(input.at ?? Date.now());
    this.db
      .insert(skillUses)
      .values({
        id: newUlid(at.getTime()),
        ownerId: input.ownerId,
        workspace: input.workspace,
        runId: input.runId,
        sessionId: input.sessionId,
        agentId: input.agentId,
        skill,
        usedAt: at,
        createdAt: at,
        updatedAt: at,
      })
      .onConflictDoNothing({ target: [skillUses.runId, skillUses.skill] })
      .run();
  }

  totalsForRun(workspace: string, runId: string): UsageTotals {
    return this.total(and(eq(usageRecords.workspace, workspace), eq(usageRecords.runId, runId)));
  }

  totalsForSession(workspace: string, sessionId: string): UsageTotals {
    return this.total(
      and(eq(usageRecords.workspace, workspace), eq(usageRecords.sessionId, sessionId)),
    );
  }

  /** Totals for many runs at once, so a page of runs costs one query. */
  totalsForRuns(workspace: string, runIds: readonly string[]): Map<string, UsageTotals> {
    const out = new Map<string, UsageTotals>();
    if (runIds.length === 0) return out;
    const rows = this.db
      .select()
      .from(usageRecords)
      .where(and(eq(usageRecords.workspace, workspace), inArray(usageRecords.runId, [...runIds])))
      .all();
    for (const row of rows) {
      out.set(row.runId, add(out.get(row.runId) ?? { ...ZERO }, row));
    }
    return out;
  }

  private total(where: ReturnType<typeof and>): UsageTotals {
    const rows = this.db.select().from(usageRecords).where(where).all();
    return rows.reduce<UsageTotals>((acc, row) => add(acc, row), { ...ZERO });
  }
}

type UsageRow = typeof usageRecords.$inferSelect;

function add(acc: UsageTotals, row: UsageRow): UsageTotals {
  return {
    inputTokens: acc.inputTokens + row.inputTokens,
    outputTokens: acc.outputTokens + row.outputTokens,
    cacheReadTokens: acc.cacheReadTokens + row.cacheReadTokens,
    cacheWriteTokens: acc.cacheWriteTokens + row.cacheWriteTokens,
    reasoningTokens: acc.reasoningTokens + row.reasoningTokens,
    costMicroUsd: acc.costMicroUsd + row.costMicroUsd,
    hasCost: acc.hasCost || row.costSource !== 'unknown',
  };
}

/**
 * Job row -> the contract's `Job`. Two shapes differ from the table on purpose:
 * `kind` stores `<module>.<verb>` and the API sends the verb; the table's `cancelling`
 * ("cancel asked, worker winding down") has no contract value and is reported as
 * `running` until the worker stops.
 */
export function serializeJob(row: JobRow, profile: string): Record<string, unknown> {
  const verb = row.kind.includes('.') ? row.kind.slice(row.kind.indexOf('.') + 1) : row.kind;
  return {
    id: row.id,
    profile,
    owner_id: row.ownerId,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
    kind: verb as ContractJobKind,
    status: row.status === 'cancelling' ? 'running' : row.status,
    progress: { percent: row.progress < 0 ? null : row.progress, message: row.progressMessage },
    resource: row.entityKind && row.entityId ? { kind: row.entityKind, id: row.entityId } : null,
    result: row.result ?? null,
    error: row.errorCode
      ? { error: row.errorMessage ?? row.errorCode, code: row.errorCode as ErrorCode }
      : null,
    started_at: iso(row.startedAt),
    finished_at: iso(row.finishedAt),
  };
}
