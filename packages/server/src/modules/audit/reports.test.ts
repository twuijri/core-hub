/**
 * The four reports (`audit.getReport`). The rule under test is the hub's rule: a report
 * contains what was recorded and nothing else — zeros where nothing happened, silence
 * where nothing was measured.
 */
import { describe, expect, it } from 'vitest';
import { memoryDb } from '../../../tests/unit/helpers.js';
import { ReportService, isoDate, moneyOf, windowOf } from './reports.js';
import { usageRecords } from './schema.js';

const OWNER = '01J8QK3ZR2W7M5N4P6T8V9X0HM';
const WORKSPACE = '01J8QK3ZR2W7M5N4P6T8V9X0PF';
const OTHER = '01J8QK3ZR2W7M5N4P6T8V9X0PG';
const NOW = Date.parse('2026-09-22T12:00:00Z');

function usage(
  db: ReturnType<typeof memoryDb>,
  id: string,
  over: Partial<typeof usageRecords.$inferInsert> = {},
): void {
  db.insert(usageRecords)
    .values({
      id,
      ownerId: OWNER,
      workspace: WORKSPACE,
      runId: id,
      sessionId: 'session-1',
      agentId: 'agent-1',
      modelLabel: 'gpt-test',
      inputTokens: 100,
      outputTokens: 20,
      costMicroUsd: 1_500,
      costSource: 'estimated',
      recordedAt: new Date(NOW - 3_600_000),
      ...over,
    })
    .run();
}

describe('the period a report covers', () => {
  it('counts whole days back from now, and names them as dates', () => {
    const period = windowOf(7, NOW);
    expect(isoDate(period.to)).toBe('2026-09-22');
    expect(isoDate(period.from)).toBe('2026-09-15');
  });

  it('turns micro-USD integers into the same money shape as everywhere else', () => {
    expect(moneyOf(1_500_000)).toEqual({ amount: '1.500000', currency: 'USD' });
    expect(moneyOf(0)).toEqual({ amount: '0.000000', currency: 'USD' });
    expect(moneyOf(-250)).toEqual({ amount: '-0.000250', currency: 'USD' });
  });
});

describe('the usage report', () => {
  it('is a report of zeros when nothing ran, never an absent report', () => {
    const reports = new ReportService(memoryDb());
    const report = reports.build({ kind: 'usage', workspace: WORKSPACE, days: 30, now: NOW });
    expect(report?.data.totals).toMatchObject({ input_tokens: 0, runs: 0, sessions: 0 });
    expect(report?.data.by_model).toEqual([]);
  });

  it('adds up the ledger and breaks it down by model, agent and day', () => {
    const db = memoryDb();
    usage(db, 'r1');
    usage(db, 'r2', { modelLabel: 'claude-test', agentId: 'agent-2', costMicroUsd: 500 });
    usage(db, 'r3', { sessionId: 'session-2', recordedAt: new Date(NOW - 2 * 86_400_000) });
    const report = new ReportService(db).build({
      kind: 'usage',
      workspace: WORKSPACE,
      days: 30,
      now: NOW,
    });
    const totals = report?.data.totals as Record<string, unknown>;
    expect(totals).toMatchObject({ input_tokens: 300, output_tokens: 60, runs: 3, sessions: 2 });
    expect(totals.cost).toEqual({ amount: '0.003500', currency: 'USD' });
    expect(report?.data.by_model).toHaveLength(2);
    expect(report?.data.by_agent).toHaveLength(2);
    expect(report?.data.by_day).toHaveLength(2);
  });

  it('never adds another workspace’s tokens into this one’s total', () => {
    const db = memoryDb();
    usage(db, 'r1');
    usage(db, 'r2', { workspace: OTHER, inputTokens: 9_000 });
    const report = new ReportService(db).build({
      kind: 'usage',
      workspace: WORKSPACE,
      days: 30,
      now: NOW,
    });
    expect((report?.data.totals as { input_tokens: number }).input_tokens).toBe(100);
  });

  it('leaves what is outside the period outside the total', () => {
    const db = memoryDb();
    usage(db, 'r1', { recordedAt: new Date(NOW - 40 * 86_400_000) });
    const report = new ReportService(db).build({
      kind: 'usage',
      workspace: WORKSPACE,
      days: 7,
      now: NOW,
    });
    expect((report?.data.totals as { runs: number }).runs).toBe(0);
  });

  it('says an estimate is an estimate, and says nothing when nothing was priced', () => {
    const db = memoryDb();
    usage(db, 'r1', { costMicroUsd: 0, costSource: 'unknown' });
    const bare = new ReportService(db).build({
      kind: 'usage',
      workspace: WORKSPACE,
      days: 30,
      now: NOW,
    });
    expect((bare?.data.totals as { cost_source: string }).cost_source).toBe('unknown');

    usage(db, 'r2');
    const priced = new ReportService(db).build({
      kind: 'usage',
      workspace: WORKSPACE,
      days: 30,
      now: NOW,
    });
    expect((priced?.data.totals as { cost_source: string }).cost_source).toBe('estimated');
  });
});

describe('the report nothing feeds', () => {
  it('answers with nothing at all for skills, so the route can say 501', () => {
    // A page of zeros would read as "no skills were used", which is a measurement we
    // have not made. Silence is the honest answer until something records skill use.
    expect(
      new ReportService(memoryDb()).build({
        kind: 'skills',
        workspace: WORKSPACE,
        days: 30,
        now: NOW,
      }),
    ).toBeNull();
  });
});
