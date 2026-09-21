/**
 * The write side of `audit`, used by other modules through `index.ts`.
 *
 * Two ledgers matter in Phase 0:
 *
 * - **jobs** — every long piece of work is a job (invariant 4). `sessions`
 *   creates one per run so `Run.job_id` is a real row, not an invented id.
 *   There is no job *worker* yet: the module that owns the work drives the
 *   job's status through `startJob` / `finishJob`, and the `jobs.*` HTTP
 *   operations and the `/rt/jobs` namespace stay `501` until the jobs kernel
 *   lands (docs/domain/audit.md, DECISIONS §6).
 * - **usage_records** — the only place cost lives (docs/domain/audit.md
 *   §usage_record). One row per (run, model label); the run's origin is
 *   copied so roll-ups by task, schedule or room need no join.
 *
 * Reads (`audit.getReport`) are Phase 4 and stay `501`.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { newUlid } from '../../db/ids.js';
import type { ModuleDatabase } from '../../db/handle.js';
import {
  jobs,
  usageRecords,
  type COST_SOURCES,
  type JOB_STATUSES,
  type USAGE_ORIGINS,
} from './schema.js';

export type JobStatus = (typeof JOB_STATUSES)[number];
export type CostSource = (typeof COST_SOURCES)[number];
export type UsageOrigin = (typeof USAGE_ORIGINS)[number];

export interface JobCreate {
  workspace: string;
  ownerId: string;
  /** `<module>.<verb>` (docs/domain/audit.md); the contract's `JobKind` is the wire form. */
  kind: string;
  entityKind: string;
  entityId: string;
  input?: Record<string, unknown>;
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

export class AuditService {
  constructor(private readonly db: ModuleDatabase) {}

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
        entityKind: input.entityKind,
        entityId: input.entityId,
        input: input.input ?? {},
      })
      .run();
    return id;
  }

  startJob(jobId: string): void {
    this.db
      .update(jobs)
      .set({ status: 'running', startedAt: new Date(), attempts: sql`${jobs.attempts} + 1` })
      .where(and(eq(jobs.id, jobId), inArray(jobs.status, ['queued', 'running'])))
      .run();
  }

  finishJob(
    jobId: string,
    status: Extract<JobStatus, 'succeeded' | 'failed' | 'cancelled'>,
    outcome: { result?: Record<string, unknown>; errorCode?: string; errorMessage?: string } = {},
  ): void {
    this.db
      .update(jobs)
      .set({
        status,
        finishedAt: new Date(),
        result: outcome.result ?? null,
        errorCode: outcome.errorCode ?? null,
        errorMessage: outcome.errorMessage ?? null,
      })
      .where(eq(jobs.id, jobId))
      .run();
  }

  /**
   * Record what a run cost. Idempotent per (run, model label): a second report
   * for the same pair replaces the first, because adapters re-send cumulative
   * totals rather than deltas.
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
      const current = out.get(row.runId) ?? { ...ZERO };
      out.set(row.runId, add(current, row));
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
