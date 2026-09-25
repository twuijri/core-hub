/**
 * The Usage and Skills usage reports (contract decision §47): aggregated by calendar day, per
 * profile and per agent, and — the hub's rule — a number only where something was measured.
 */
import { describe, expect, it } from 'vitest';
import { memoryDb } from '../../../tests/unit/helpers.js';
import {
  UsageAnalytics,
  calendarPeriod,
  type AnalyticsProfile,
  type RunActivityRow,
} from './analytics.js';
import { auditCounters, skillUses, usageRecords } from './schema.js';

const OWNER = '01J8QK3ZR2W7M5N4P6T8V9X0HM';
const HOME: AnalyticsProfile = { id: '01J8QK3ZR2W7M5N4P6T8V9X0PF', slug: 'default', isDefault: true };
const WORK: AnalyticsProfile = { id: '01J8QK3ZR2W7M5N4P6T8V9X0PG', slug: 'work', isDefault: false };
const HERMES = '01J8QK3ZR2W7M5N4P6T8V9X0A1';
const CODER = '01J8QK3ZR2W7M5N4P6T8V9X0A2';
/** 2026-09-25 09:00 UTC — 12:00 in Riyadh. */
const NOW = Date.parse('2026-09-25T09:00:00Z');
const DAY = 86_400_000;

type Db = ReturnType<typeof memoryDb>;
let seq = 0;

function usage(db: Db, over: Partial<typeof usageRecords.$inferInsert> = {}): void {
  seq += 1;
  const id = `01J8QK3ZR2W7M5N4P6T8V9X${String(seq).padStart(3, '0')}`;
  db.insert(usageRecords)
    .values({
      id,
      ownerId: OWNER,
      workspace: HOME.id,
      runId: id,
      sessionId: 's1',
      agentId: HERMES,
      modelLabel: 'gpt-test',
      inputTokens: 100,
      outputTokens: 20,
      costMicroUsd: 1_000,
      costSource: 'estimated',
      recordedAt: new Date(NOW - 3_600_000),
      ...over,
    })
    .run();
}

function skill(db: Db, name: string, at: number, over: Partial<typeof skillUses.$inferInsert> = {}) {
  seq += 1;
  const id = `01J8QK3ZR2W7M5N4P6T8V9X${String(seq).padStart(3, '0')}`;
  db.insert(skillUses)
    .values({
      id,
      ownerId: OWNER,
      workspace: HOME.id,
      skill: name,
      agentId: HERMES,
      sessionId: 's1',
      runId: id,
      usedAt: new Date(at),
      ...over,
    })
    .run();
}

const names = (id: string) => (id === HERMES ? 'Hermes' : id === CODER ? 'Claude Code' : null);

describe('the calendar a report counts in', () => {
  it('is `days` whole days ending today, in the caller’s own calendar', () => {
    const utc = calendarPeriod(7, NOW);
    expect(utc.dates).toEqual([
      '2026-09-19',
      '2026-09-20',
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
      '2026-09-24',
      '2026-09-25',
    ]);
    expect(new Date(utc.from).toISOString()).toBe('2026-09-19T00:00:00.000Z');
    // 23:30 UTC is already tomorrow in Riyadh (UTC+3).
    const late = Date.parse('2026-09-25T23:30:00Z');
    expect(calendarPeriod(1, late, 180).dates).toEqual(['2026-09-26']);
    expect(new Date(calendarPeriod(1, late, 180).from).toISOString()).toBe(
      '2026-09-25T21:00:00.000Z',
    );
    expect(calendarPeriod(365, NOW).dates).toHaveLength(365);
  });
});

describe('the Usage report', () => {
  it('is zeros and nulls when nothing ran — never invented cache or cost', () => {
    const report = new UsageAnalytics(memoryDb()).usage({ profiles: [HOME], days: 7, now: NOW });
    expect(report.totals).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: null,
      cache_write_tokens: null,
      cache_hit_rate: null,
      runs: 0,
      conversations: 0,
      cost: null,
      cost_source: 'unknown',
    });
    expect(report.by_day).toHaveLength(7);
    expect(report.by_model).toEqual([]);
    expect(report.by_agent).toEqual([]);
  });

  it('adds up days, models and agents, and shares add up to the whole', () => {
    const db = memoryDb();
    usage(db, { cacheReadTokens: 300 });
    usage(db, { modelLabel: 'claude-test', inputTokens: 50, outputTokens: 50, costMicroUsd: 0, costSource: 'unknown' });
    usage(db, { sessionId: 's2', recordedAt: new Date(NOW - 2 * DAY) });
    // Outside the 7 days: not counted.
    usage(db, { recordedAt: new Date(NOW - 8 * DAY) });
    const report = new UsageAnalytics(db, { agentName: names }).usage({
      profiles: [HOME],
      days: 7,
      now: NOW,
    });
    const totals = report.totals as Record<string, unknown>;
    expect(totals).toMatchObject({
      input_tokens: 250,
      output_tokens: 90,
      cache_read_tokens: 300,
      cache_write_tokens: null,
      total_tokens: 640,
      // 300 read from the cache out of 250 + 300 input read.
      cache_hit_rate: 0.5455,
      runs: 3,
      conversations: 2,
      cost: { amount: '0.002000', currency: 'USD' },
      cost_source: 'estimated',
    });
    const days = report.by_day as Array<{ date: string; total_tokens: number; conversations: number }>;
    expect(days.map((d) => d.date)[0]).toBe('2026-09-19');
    expect(days.find((d) => d.date === '2026-09-25')).toMatchObject({
      total_tokens: 520,
      conversations: 1,
    });
    expect(days.find((d) => d.date === '2026-09-23')).toMatchObject({
      total_tokens: 120,
      conversations: 1,
    });
    // Two days had one conversation each, over seven days.
    expect(totals.conversations_per_day).toBe(0.29);

    const models = report.by_model as Array<{ model: string; share: number; cost: unknown }>;
    expect(models.map((m) => m.model)).toEqual(['gpt-test', 'claude-test']);
    expect(models[1]!.cost).toBeNull();
    expect(models.reduce((sum, m) => sum + m.share, 0)).toBeCloseTo(1, 3);
    expect(report.by_agent).toEqual([
      expect.objectContaining({ agent_id: HERMES, name: 'Hermes', reports_usage: true, share: 1 }),
    ]);
  });

  it('covers one profile, or every one it is given, and never mixes them', () => {
    const db = memoryDb();
    usage(db);
    usage(db, { workspace: WORK.id, sessionId: 'w1', inputTokens: 1_000 });
    const analytics = new UsageAnalytics(db);
    const home = analytics.usage({ profiles: [HOME], days: 7, now: NOW });
    const both = analytics.usage({ profiles: [HOME, WORK], days: 7, now: NOW });
    expect(home.profiles).toEqual(['default']);
    expect(home.totals).toMatchObject({ input_tokens: 100, conversations: 1 });
    expect(both.profiles).toEqual(['default', 'work']);
    expect(both.totals).toMatchObject({ input_tokens: 1_100, conversations: 2 });
  });

  it('says which agents report no usage, and counts their runs without inventing tokens', () => {
    const db = memoryDb();
    usage(db, { sessionId: 's1' });
    const activity: RunActivityRow[] = [
      { agentId: HERMES, sessionId: 's1', day: '2026-09-25', runs: 1 },
      // A coding agent over ACP ran twice and reported nothing.
      { agentId: CODER, sessionId: 's9', day: '2026-09-24', runs: 2 },
    ];
    const analytics = new UsageAnalytics(db, { runActivity: () => activity, agentName: names });
    const report = analytics.usage({ profiles: [HOME], days: 7, now: NOW });
    expect(report.totals).toMatchObject({ runs: 3, unreported_runs: 2, conversations: 2 });
    expect(report.agents).toEqual([
      { agent_id: CODER, name: 'Claude Code', reports_usage: false },
      { agent_id: HERMES, name: 'Hermes', reports_usage: true },
    ]);
    const coder = (report.by_agent as Array<Record<string, unknown>>).find(
      (row) => row.agent_id === CODER,
    );
    expect(coder).toMatchObject({
      reports_usage: false,
      runs: 2,
      conversations: 1,
      input_tokens: null,
      total_tokens: null,
      share: null,
      cost: null,
    });

    // Narrowed to one agent, the report is that agent's; the list of agents stays whole.
    const narrowed = analytics.usage({ profiles: [HOME], days: 7, now: NOW, agentId: HERMES });
    expect(narrowed.totals).toMatchObject({ runs: 1, unreported_runs: 0, input_tokens: 100 });
    expect(narrowed.by_agent).toHaveLength(1);
    expect(narrowed.agents).toHaveLength(2);
  });

  it('puts a run on the caller’s own calendar day', () => {
    const db = memoryDb();
    // 22:30 UTC on the 24th is 01:30 on the 25th in Riyadh.
    usage(db, { recordedAt: new Date(Date.parse('2026-09-24T22:30:00Z')) });
    const analytics = new UsageAnalytics(db);
    const utc = analytics.usage({ profiles: [HOME], days: 2, now: NOW });
    const riyadh = analytics.usage({ profiles: [HOME], days: 2, now: NOW, utcOffsetMinutes: 180 });
    const dayOf = (report: Record<string, unknown>) =>
      (report.by_day as Array<{ date: string; total_tokens: number }>).find(
        (d) => d.total_tokens > 0,
      )?.date;
    expect(dayOf(utc)).toBe('2026-09-24');
    expect(dayOf(riyadh)).toBe('2026-09-25');
  });
});

describe('the Skills usage report', () => {
  it('ranks skills, draws the top six by day, and counts the rest as other', () => {
    const db = memoryDb();
    const at = (daysAgo: number) => NOW - daysAgo * DAY;
    for (const [name, count] of [
      ['a', 5],
      ['b', 4],
      ['c', 3],
      ['d', 3],
      ['e', 2],
      ['f', 2],
      ['g', 1],
    ] as const) {
      for (let i = 0; i < count; i += 1) skill(db, name, at(i % 3));
    }
    skill(db, 'old', at(20));
    skill(db, 'a', at(0), { workspace: WORK.id });
    const report = new UsageAnalytics(db, {
      installedSkills: () => ['a', 'b', 'never-1', 'never-2'],
    }).skills({ profiles: [HOME], days: 7, now: NOW });

    expect(report.totals).toEqual({
      uses: 20,
      distinct_skills: 7,
      top_skill: { skill: 'a', uses: 5 },
      never_used_count: 2,
    });
    expect(report.never_used).toEqual(['never-1', 'never-2']);
    expect(report.top_series).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    const ranked = report.top_skills as Array<{ skill: string; share: number; last_used_at: string }>;
    expect(ranked[0]).toMatchObject({ skill: 'a', share: 0.25 });
    expect(ranked).toHaveLength(7);
    const today = (report.by_day as Array<Record<string, unknown>>).find(
      (d) => d.date === '2026-09-25',
    );
    // Every skill once today (i = 0), `a` and `b` twice (i = 3); `g` is "other".
    expect(today).toMatchObject({ uses: 9, other: 1 });
    expect((today!.skills as Record<string, number>).a).toBe(2);
    expect(Object.keys(today!.skills as object)).not.toContain('g');
  });

  it('narrows to one agent, and says from when it has counted', () => {
    const db = memoryDb();
    skill(db, 'arxiv', NOW - 1_000);
    skill(db, 'shell-helper', NOW - 1_000, { agentId: CODER });
    const report = new UsageAnalytics(db).skills({
      profiles: [HOME],
      days: 30,
      now: NOW,
      agentId: HERMES,
    });
    expect(report.totals).toMatchObject({ uses: 1, top_skill: { skill: 'arxiv', uses: 1 } });
    // The migration wrote when this install started counting.
    const counter = db.select().from(auditCounters).all();
    expect(counter.map((row) => row.name)).toEqual(['skill_uses']);
    expect(report.counting_since).toBe(counter[0]!.startedAt.toISOString());
    // No way to see the installed skills: unknown, not "none unused".
    expect(report.never_used).toBeNull();
    expect((report.totals as Record<string, unknown>).never_used_count).toBeNull();
  });

  it('is an honest empty report before anything was loaded', () => {
    const report = new UsageAnalytics(memoryDb(), { installedSkills: () => ['arxiv'] }).skills({
      profiles: [HOME],
      days: 7,
      now: NOW,
    });
    expect(report.totals).toEqual({
      uses: 0,
      distinct_skills: 0,
      top_skill: null,
      never_used_count: 1,
    });
    expect(report.top_series).toEqual([]);
    expect(report.by_day).toHaveLength(7);
  });
});
