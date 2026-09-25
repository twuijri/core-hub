/**
 * The four reports behind the Logs, Usage, Performance and Skills screens
 * (`audit.getReport`).
 *
 * The contract leaves `data` open (`additionalProperties: true`) and says Phase 4 fixes
 * its shape. This file is that fixing, and the rule it follows is the hub's rule
 * everywhere else: **a report only ever contains what was actually recorded.** A period
 * with no runs is a report of zeros, not an absent report; a number nobody measured is
 * absent, not zero.
 *
 * - **usage** (workspace): the ledger `audit.usage_records`, which every finished run
 *   writes one row per model to. Totals, then the same totals broken down by model, by
 *   agent and by day, so a screen can draw any of the three without asking again.
 *   `cost_source` travels with the numbers because an estimate must never be shown as an
 *   invoice (see `modules/models/service.ts` §costOf).
 * - **logs** (global, admin): the audit trail and the job events, merged into one
 *   time-ordered list. Audit events carry no level of their own — they are things that
 *   happened, not complaints — so they read as `info`, while a job event keeps the level
 *   it was written with. That is why `level` filters the merged list rather than one table.
 * - **performance** (global, admin): the snapshots the sampler writes, plus this
 *   process's own numbers at the moment of asking.
 * - **skills**: built by `analytics.ts` from `skill_uses` (contract decision §50) and answered
 *   by the route itself, so `build` has nothing to say about it.
 */
import { and, desc, eq, gte, inArray, like, lte, sql } from 'drizzle-orm';
import type { ModuleDb } from '../../lib/db.js';
import { auditEvents, jobEvents, jobs, performanceSnapshots, usageRecords } from './schema.js';

export type ReportKind = 'logs' | 'usage' | 'performance' | 'skills';
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface ReportRequest {
  kind: ReportKind;
  workspace: string | null;
  days: number;
  q?: string | undefined;
  level?: LogLevel | undefined;
  now?: number;
}

export interface Report {
  kind: ReportKind;
  period: { from: string; to: string };
  generated_at: string;
  data: Record<string, unknown>;
}

/** `YYYY-MM-DD` in UTC — the contract's `format: date`. */
export function isoDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Micro-USD integers -> a decimal string, the same shape `Money` uses everywhere. */
export function moneyOf(microUsd: number): { amount: string; currency: string } {
  const sign = microUsd < 0 ? '-' : '';
  const abs = Math.abs(microUsd);
  return {
    amount: `${sign}${Math.floor(abs / 1_000_000)}.${String(abs % 1_000_000).padStart(6, '0')}`,
    currency: 'USD',
  };
}

const DAY_MS = 86_400_000;

export interface PeriodWindow {
  from: number;
  to: number;
}

/** The window a report covers: `days` whole days back from now, inclusive. */
export function windowOf(days: number, now: number): PeriodWindow {
  return { from: now - days * DAY_MS, to: now };
}

export class ReportService {
  constructor(private readonly db: ModuleDb) {}

  build(request: ReportRequest): Report | null {
    const now = request.now ?? Date.now();
    const period = windowOf(request.days, now);
    const shell = {
      kind: request.kind,
      period: { from: isoDate(period.from), to: isoDate(period.to) },
      generated_at: new Date(now).toISOString(),
    };
    if (request.kind === 'usage') return { ...shell, data: this.usage(request.workspace, period) };
    if (request.kind === 'logs') return { ...shell, data: this.logs(request, period) };
    if (request.kind === 'performance') return { ...shell, data: this.performance(period, now) };
    // `skills` is `analytics.ts`'s; the route answers it before asking here.
    return null;
  }

  // ------------------------------------------------------------------ usage

  private usage(workspace: string | null, period: PeriodWindow): Record<string, unknown> {
    const where = and(
      workspace === null ? undefined : eq(usageRecords.workspace, workspace),
      gte(usageRecords.recordedAt, new Date(period.from)),
      lte(usageRecords.recordedAt, new Date(period.to)),
    );
    const rows = this.db.select().from(usageRecords).where(where).all();

    const totals = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      runs: 0,
      cost_micro_usd: 0,
    };
    const sessions = new Set<string>();
    const byModel = new Map<string, Totals>();
    const byAgent = new Map<string, Totals>();
    const byDay = new Map<string, Totals>();
    // An estimate and an invoice must never be added into one number silently.
    const costSources = new Set<string>();

    for (const row of rows) {
      totals.input_tokens += row.inputTokens;
      totals.output_tokens += row.outputTokens;
      totals.cache_read_tokens += row.cacheReadTokens;
      totals.cache_write_tokens += row.cacheWriteTokens;
      totals.reasoning_tokens += row.reasoningTokens;
      totals.cost_micro_usd += row.costMicroUsd;
      totals.runs += 1;
      sessions.add(row.sessionId);
      if (row.costMicroUsd > 0) costSources.add(row.costSource);
      add(byModel, row.modelLabel, row);
      add(byAgent, row.agentId, row);
      add(byDay, isoDate(row.recordedAt.getTime()), row);
    }

    return {
      totals: {
        ...totals,
        sessions: sessions.size,
        cost: moneyOf(totals.cost_micro_usd),
        // "estimated" when any priced row was our own multiplication; "provider" only when
        // every one of them came from the provider itself.
        cost_source:
          costSources.size === 0
            ? 'unknown'
            : costSources.has('estimated')
              ? 'estimated'
              : [...costSources][0],
      },
      by_model: listOf(byModel, 'model'),
      by_agent: listOf(byAgent, 'agent_id'),
      by_day: listOf(byDay, 'date').sort((a, b) => String(a.date).localeCompare(String(b.date))),
    };
  }

  // ------------------------------------------------------------------- logs

  private logs(request: ReportRequest, period: PeriodWindow): Record<string, unknown> {
    const needle = request.q?.trim();
    const auditRows = this.db
      .select()
      .from(auditEvents)
      .where(
        and(
          gte(auditEvents.createdAt, new Date(period.from)),
          lte(auditEvents.createdAt, new Date(period.to)),
          needle ? like(auditEvents.action, `%${needle}%`) : undefined,
        ),
      )
      .orderBy(desc(auditEvents.createdAt))
      .limit(500)
      .all();

    const jobRows = this.db
      .select({
        at: jobEvents.createdAt,
        level: jobEvents.level,
        message: jobEvents.message,
        jobId: jobEvents.jobId,
        kind: jobs.kind,
      })
      .from(jobEvents)
      .leftJoin(jobs, eq(jobs.id, jobEvents.jobId))
      .where(
        and(
          gte(jobEvents.createdAt, new Date(period.from)),
          lte(jobEvents.createdAt, new Date(period.to)),
          needle ? like(jobEvents.message, `%${needle}%`) : undefined,
        ),
      )
      .orderBy(desc(jobEvents.createdAt))
      .limit(500)
      .all();

    const entries = [
      ...auditRows.map((row) => ({
        at: row.createdAt.toISOString(),
        level: 'info' as LogLevel,
        source: 'audit',
        action: row.action,
        message: row.summary ?? row.action,
        actor: { kind: row.actorKind, id: row.actorId },
        entity: { kind: row.entityKind, id: row.entityId },
        workspace: row.workspace,
      })),
      ...jobRows.map((row) => ({
        at: row.at.toISOString(),
        // `progress` is a job's own level and not a log level; it reads as debug.
        level: (row.level === 'progress' ? 'debug' : row.level) as LogLevel,
        source: 'job',
        action: row.kind ?? 'job',
        message: row.message ?? '',
        actor: { kind: 'system', id: null },
        entity: { kind: 'job', id: row.jobId },
        workspace: null,
      })),
    ]
      .filter((entry) => !request.level || entry.level === request.level)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 500);

    return { entries, truncated: entries.length === 500 };
  }

  // ------------------------------------------------------------ performance

  private performance(period: PeriodWindow, now: number): Record<string, unknown> {
    const snapshots = this.db
      .select()
      .from(performanceSnapshots)
      .where(
        and(
          gte(performanceSnapshots.capturedAt, new Date(period.from)),
          lte(performanceSnapshots.capturedAt, new Date(period.to)),
        ),
      )
      .orderBy(desc(performanceSnapshots.capturedAt))
      .limit(500)
      .all();

    const memory = process.memoryUsage();
    return {
      // What this process knows about itself right now, measured and not stored.
      current: {
        at: new Date(now).toISOString(),
        uptime_seconds: Math.floor(process.uptime()),
        rss_bytes: memory.rss,
        heap_used_bytes: memory.heapUsed,
        node_version: process.version,
      },
      samples: snapshots.map((row) => ({
        at: row.capturedAt.toISOString(),
        cpu_percent: row.cpuPercent,
        memory_bytes: row.memoryBytes,
        disk_free_bytes: row.diskFreeBytes,
        db_bytes: row.dbBytes,
        active_runs: row.activeRuns,
        queued_jobs: row.queuedJobs,
        connected_clients: row.connectedClients,
      })),
    };
  }

  /** One measurement of this hub, for the Performance screen's history. */
  sample(input: {
    id: string;
    ownerId: string;
    at?: number;
    activeRuns?: number;
    queuedJobs?: number;
    connectedClients?: number;
    dbBytes?: number | null;
  }): void {
    const memory = process.memoryUsage();
    this.db
      .insert(performanceSnapshots)
      .values({
        id: input.id,
        ownerId: input.ownerId,
        capturedAt: new Date(input.at ?? Date.now()),
        memoryBytes: memory.rss,
        dbBytes: input.dbBytes ?? null,
        activeRuns: input.activeRuns ?? 0,
        queuedJobs: input.queuedJobs ?? 0,
        connectedClients: input.connectedClients ?? 0,
      })
      .run();
  }

  /** How many jobs are waiting right now — the one number a sampler cannot guess. */
  queuedJobs(): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(jobs)
      .where(inArray(jobs.status, ['queued', 'running']))
      .get();
    return row?.n ?? 0;
  }
}

interface Totals {
  input_tokens: number;
  output_tokens: number;
  cost_micro_usd: number;
  runs: number;
}

function add(
  into: Map<string, Totals>,
  key: string,
  row: { inputTokens: number; outputTokens: number; costMicroUsd: number },
): void {
  const current = into.get(key) ?? {
    input_tokens: 0,
    output_tokens: 0,
    cost_micro_usd: 0,
    runs: 0,
  };
  current.input_tokens += row.inputTokens;
  current.output_tokens += row.outputTokens;
  current.cost_micro_usd += row.costMicroUsd;
  current.runs += 1;
  into.set(key, current);
}

function listOf(totals: Map<string, Totals>, keyName: string): Array<Record<string, unknown>> {
  return [...totals.entries()]
    .map(([key, value]) => ({ [keyName]: key, ...value, cost: moneyOf(value.cost_micro_usd) }))
    .sort((a, b) => (b.cost_micro_usd as number) - (a.cost_micro_usd as number));
}
