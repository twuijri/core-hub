/**
 * The reports behind `audit.getReport`: `usage` and `skills`, one profile each.
 *
 * The contract leaves `data` open (`additionalProperties: true`). The rule it follows is the
 * hub's rule everywhere else: **a report only ever contains what was actually recorded.** A
 * period with no runs is a report of zeros, not an absent report; a number nobody measured is
 * absent, not zero.
 *
 * - **usage** (workspace): the ledger `audit.usage_records`, which every finished run
 *   writes one row per model to. Totals, then the same totals broken down by model, by
 *   agent and by day, so a screen can draw any of the three without asking again.
 *   `cost_source` travels with the numbers because an estimate must never be shown as an
 *   invoice (see `modules/models/service.ts` §costOf).
 * - **skills**: built by `analytics.ts` from `skill_uses` (contract decision §50) and answered
 *   by the route itself, so `build` has nothing to say about it.
 *
 * `logs` and `performance` were here until contract decision §73: the Logs and Performance
 * screens of every client read the live `audit.listLogLines` and `audit.getLivePerformance`
 * (§51), and nothing asked for the old ones any more.
 */
import { and, eq, gte, lte } from 'drizzle-orm';
import type { ModuleDb } from '../../lib/db.js';
import { usageRecords } from './schema.js';

export type ReportKind = 'usage' | 'skills';

export interface ReportRequest {
  kind: ReportKind;
  workspace: string | null;
  days: number;
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
