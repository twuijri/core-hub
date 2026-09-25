/**
 * The Usage and Skills usage screens (`audit.getUsage`, `audit.getSkillUsage`; contract
 * decision §47).
 *
 * Both are aggregated here, in SQL grouped by calendar day, over the time indexes of the two
 * ledgers (`usage_records_workspace_time_idx`, `skill_uses_workspace_time_idx`) and of the runs
 * (`runs_workspace_time_idx`, read through the `runActivity` port because runs are `sessions`'s).
 * A period of 365 days returns at most one group per (agent, model, day), never the raw rows.
 *
 * The hub's rule for reports holds: **only what was measured is a number.**
 * - The ledger stores an unreported cache as `0`. A whole period with no cache read (or write)
 *   therefore reads as "not reported" — `null` — rather than as a measured 0 % hit rate.
 * - An agent that ran but reported no usage at all (coding agents over ACP) is listed with
 *   `reports_usage: false` and `null` tokens, and its runs are counted as `unreported_runs`.
 * - Cost is `null` wherever no record was priced.
 * - Skill use was never recorded before this version; `counting_since` says from when.
 */
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { ModuleDb } from '../../lib/db.js';
import { isoDate, moneyOf } from './reports.js';
import { auditCounters, skillUses, usageRecords } from './schema.js';

const DAY_MS = 86_400_000;

/** A profile a report covers: its id for the ledgers, its slug for the answer. */
export interface AnalyticsProfile {
  id: string;
  slug: string;
  isDefault: boolean;
}

export interface AnalyticsQuery {
  profiles: readonly AnalyticsProfile[];
  days: number;
  agentId?: string | undefined;
  /** Minutes east of UTC; days are counted in that calendar. */
  utcOffsetMinutes?: number | undefined;
  now?: number;
}

/** Runs of one agent in one conversation on one calendar day. */
export interface RunActivityRow {
  agentId: string;
  sessionId: string;
  day: string;
  runs: number;
}

export interface RunActivityQuery {
  workspaces: readonly string[];
  from: number;
  to: number;
  /** Added to a run's time before its calendar day is taken. */
  offsetMs: number;
}

/**
 * What the reports need from other modules, joined in the composition root
 * (`modules/index.ts`): the runs (`sessions`), an agent's name and the installed skills
 * (`agents`). Each is optional; without it the report says less, never something false.
 */
export interface AnalyticsSources {
  runActivity?: (query: RunActivityQuery) => RunActivityRow[];
  agentName?: (agentId: string) => string | null;
  /** Enabled skills of the hub's Hermes in one profile, by name; `null` when unknown. */
  installedSkills?: (profile: AnalyticsProfile) => string[] | null;
}

export interface CalendarPeriod {
  /** The first instant of the first day, UTC epoch ms. */
  from: number;
  /** The first instant after the last day (today). */
  to: number;
  /** Every day of the period, oldest first, `YYYY-MM-DD` in the caller's calendar. */
  dates: string[];
  offsetMs: number;
}

/** `days` calendar days ending today, in the calendar `utcOffsetMinutes` east of UTC. */
export function calendarPeriod(days: number, now: number, utcOffsetMinutes = 0): CalendarPeriod {
  const offsetMs = utcOffsetMinutes * 60_000;
  const todayLocal = Math.floor((now + offsetMs) / DAY_MS) * DAY_MS;
  const firstLocal = todayLocal - (days - 1) * DAY_MS;
  const dates = Array.from({ length: days }, (_, i) => isoDate(firstLocal + i * DAY_MS));
  return { from: firstLocal - offsetMs, to: todayLocal + DAY_MS - offsetMs, dates, offsetMs };
}

type Money = { amount: string; currency: string };

interface TokenSums {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number;
  priced: boolean;
}

const zero = (): TokenSums => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  cost: 0,
  priced: false,
});

const tokensOf = (sums: TokenSums) => sums.input + sums.output + sums.cacheRead + sums.cacheWrite;
const costOf = (sums: TokenSums): Money | null => (sums.priced ? moneyOf(sums.cost) : null);
const ratio = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : 0;

function addInto(into: TokenSums, row: TokenSums): void {
  into.input += row.input;
  into.output += row.output;
  into.cacheRead += row.cacheRead;
  into.cacheWrite += row.cacheWrite;
  into.reasoning += row.reasoning;
  into.cost += row.cost;
  into.priced ||= row.priced;
}

export class UsageAnalytics {
  constructor(
    private readonly db: ModuleDb,
    private readonly sources: AnalyticsSources = {},
  ) {}

  // ------------------------------------------------------------------ usage

  usage(query: AnalyticsQuery): Record<string, unknown> {
    const now = query.now ?? Date.now();
    const period = calendarPeriod(query.days, now, query.utcOffsetMinutes);
    const workspaces = query.profiles.map((p) => p.id);
    const day = sql<string>`strftime('%Y-%m-%d', (${usageRecords.recordedAt} + ${period.offsetMs}) / 1000, 'unixepoch')`;

    // One group per (agent, model, day): the whole period's ledger in a few hundred rows.
    const groups =
      workspaces.length === 0
        ? []
        : this.db
            .select({
              agentId: usageRecords.agentId,
              model: usageRecords.modelLabel,
              day,
              input: sql<number>`sum(${usageRecords.inputTokens})`,
              output: sql<number>`sum(${usageRecords.outputTokens})`,
              cacheRead: sql<number>`sum(${usageRecords.cacheReadTokens})`,
              cacheWrite: sql<number>`sum(${usageRecords.cacheWriteTokens})`,
              reasoning: sql<number>`sum(${usageRecords.reasoningTokens})`,
              cost: sql<number>`sum(${usageRecords.costMicroUsd})`,
              priced: sql<number>`max(${usageRecords.costSource} <> 'unknown')`,
              estimated: sql<number>`max(${usageRecords.costSource} = 'estimated')`,
              runs: sql<number>`count(distinct ${usageRecords.runId})`,
            })
            .from(usageRecords)
            .where(
              and(
                inArray(usageRecords.workspace, [...workspaces]),
                gte(usageRecords.recordedAt, new Date(period.from)),
                lt(usageRecords.recordedAt, new Date(period.to)),
              ),
            )
            .groupBy(usageRecords.agentId, usageRecords.modelLabel, day)
            .all();

    // Runs that reported usage, per agent: whoever has none "reports no usage".
    const reported = new Map<string, number>(
      (workspaces.length === 0
        ? []
        : this.db
            .select({
              agentId: usageRecords.agentId,
              runs: sql<number>`count(distinct ${usageRecords.runId})`,
            })
            .from(usageRecords)
            .where(
              and(
                inArray(usageRecords.workspace, [...workspaces]),
                gte(usageRecords.recordedAt, new Date(period.from)),
                lt(usageRecords.recordedAt, new Date(period.to)),
              ),
            )
            .groupBy(usageRecords.agentId)
            .all()
      ).map((row) => [row.agentId, Number(row.runs)]),
    );

    const activity = this.activity(workspaces, period);
    const agents = this.agentsOf(activity, reported, groups);

    const wanted = (agentId: string) => !query.agentId || agentId === query.agentId;
    const totals = zero();
    let estimated = false;
    const byDay = new Map<string, TokenSums>(period.dates.map((d) => [d, zero()]));
    const byModel = new Map<string, TokenSums & { runs: number }>();
    const byAgent = new Map<string, TokenSums>();
    for (const group of groups) {
      if (!wanted(group.agentId)) continue;
      const sums: TokenSums = {
        input: Number(group.input),
        output: Number(group.output),
        cacheRead: Number(group.cacheRead),
        cacheWrite: Number(group.cacheWrite),
        reasoning: Number(group.reasoning),
        cost: Number(group.cost),
        priced: Number(group.priced) === 1,
      };
      estimated ||= Number(group.estimated) === 1;
      addInto(totals, sums);
      const dayTotals = byDay.get(group.day);
      if (dayTotals) addInto(dayTotals, sums);
      const model = byModel.get(group.model) ?? { ...zero(), runs: 0 };
      addInto(model, sums);
      model.runs += Number(group.runs);
      byModel.set(group.model, model);
      const agent = byAgent.get(group.agentId) ?? zero();
      addInto(agent, sums);
      byAgent.set(group.agentId, agent);
    }

    // Runs and conversations: every run, whether or not its agent reported usage.
    const runsByDay = new Map<string, { runs: number; sessions: Set<string> }>();
    const runsByAgent = new Map<string, { runs: number; sessions: Set<string> }>();
    const sessions = new Set<string>();
    let runs = 0;
    for (const row of activity) {
      if (!wanted(row.agentId)) continue;
      runs += row.runs;
      sessions.add(row.sessionId);
      for (const [map, key] of [
        [runsByDay, row.day],
        [runsByAgent, row.agentId],
      ] as const) {
        const entry = map.get(key) ?? { runs: 0, sessions: new Set<string>() };
        entry.runs += row.runs;
        entry.sessions.add(row.sessionId);
        map.set(key, entry);
      }
    }

    const grand = tokensOf(totals);
    const cacheReadKnown = totals.cacheRead > 0;
    const cacheWriteKnown = totals.cacheWrite > 0;
    let unreportedRuns = 0;
    for (const [agentId, entry] of runsByAgent) {
      unreportedRuns += Math.max(0, entry.runs - (reported.get(agentId) ?? 0));
    }
    const activeDays = [...runsByDay.values()].reduce((sum, d) => sum + d.sessions.size, 0);

    const agentRows = agents
      .filter((agent) => wanted(agent.agent_id))
      .map((agent) => {
        const sums = byAgent.get(agent.agent_id);
        const activityOf = runsByAgent.get(agent.agent_id);
        const known = agent.reports_usage && !!sums;
        return {
          agent_id: agent.agent_id,
          name: agent.name,
          reports_usage: agent.reports_usage,
          runs: activityOf?.runs ?? 0,
          conversations: activityOf?.sessions.size ?? 0,
          input_tokens: known ? sums.input : null,
          output_tokens: known ? sums.output : null,
          total_tokens: known ? tokensOf(sums) : null,
          share: known ? ratio(tokensOf(sums), grand) : null,
          cost: known ? costOf(sums) : null,
        };
      })
      .sort(
        (a, b) =>
          Number(b.reports_usage) - Number(a.reports_usage) ||
          (b.total_tokens ?? 0) - (a.total_tokens ?? 0) ||
          b.runs - a.runs,
      );

    return {
      period: this.periodOf(period),
      generated_at: new Date(now).toISOString(),
      profiles: query.profiles.map((p) => p.slug),
      agents,
      totals: {
        input_tokens: totals.input,
        output_tokens: totals.output,
        cache_read_tokens: cacheReadKnown ? totals.cacheRead : null,
        cache_write_tokens: cacheWriteKnown ? totals.cacheWrite : null,
        reasoning_tokens: totals.reasoning,
        total_tokens: grand,
        cache_hit_rate: cacheReadKnown ? ratio(totals.cacheRead, totals.input + totals.cacheRead) : null,
        runs,
        unreported_runs: unreportedRuns,
        conversations: sessions.size,
        conversations_per_day: Math.round((activeDays / period.dates.length) * 100) / 100,
        cost: costOf(totals),
        // An estimate and an invoice are never added into one number silently.
        cost_source: !totals.priced ? 'unknown' : estimated ? 'estimated' : 'provider',
      },
      by_day: period.dates.map((date) => {
        const sums = byDay.get(date) ?? zero();
        const activityOf = runsByDay.get(date);
        return {
          date,
          input_tokens: sums.input,
          output_tokens: sums.output,
          cache_read_tokens: sums.cacheRead,
          cache_write_tokens: sums.cacheWrite,
          total_tokens: tokensOf(sums),
          runs: activityOf?.runs ?? 0,
          conversations: activityOf?.sessions.size ?? 0,
          cost: costOf(sums),
        };
      }),
      by_model: [...byModel.entries()]
        .map(([model, sums]) => ({
          model,
          input_tokens: sums.input,
          output_tokens: sums.output,
          cache_read_tokens: sums.cacheRead,
          cache_write_tokens: sums.cacheWrite,
          total_tokens: tokensOf(sums),
          share: ratio(tokensOf(sums), grand),
          runs: sums.runs,
          cost: costOf(sums),
        }))
        .sort((a, b) => b.total_tokens - a.total_tokens || a.model.localeCompare(b.model)),
      by_agent: agentRows,
    };
  }

  // ----------------------------------------------------------------- skills

  skills(query: AnalyticsQuery): Record<string, unknown> {
    const now = query.now ?? Date.now();
    const period = calendarPeriod(query.days, now, query.utcOffsetMinutes);
    const workspaces = query.profiles.map((p) => p.id);
    const day = sql<string>`strftime('%Y-%m-%d', (${skillUses.usedAt} + ${period.offsetMs}) / 1000, 'unixepoch')`;
    const groups =
      workspaces.length === 0
        ? []
        : this.db
            .select({
              skill: skillUses.skill,
              agentId: skillUses.agentId,
              day,
              uses: sql<number>`count(*)`,
              last: sql<number>`max(${skillUses.usedAt})`,
            })
            .from(skillUses)
            .where(
              and(
                inArray(skillUses.workspace, [...workspaces]),
                gte(skillUses.usedAt, new Date(period.from)),
                lt(skillUses.usedAt, new Date(period.to)),
                query.agentId ? eq(skillUses.agentId, query.agentId) : undefined,
              ),
            )
            .groupBy(skillUses.skill, skillUses.agentId, day)
            .all();

    const perSkill = new Map<string, { uses: number; last: number }>();
    const perDay = new Map<string, Map<string, number>>();
    let uses = 0;
    for (const group of groups) {
      const count = Number(group.uses);
      uses += count;
      const entry = perSkill.get(group.skill) ?? { uses: 0, last: 0 };
      entry.uses += count;
      entry.last = Math.max(entry.last, Number(group.last));
      perSkill.set(group.skill, entry);
      const daily = perDay.get(group.day) ?? new Map<string, number>();
      daily.set(group.skill, (daily.get(group.skill) ?? 0) + count);
      perDay.set(group.day, daily);
    }

    const ranked = [...perSkill.entries()]
      .map(([skill, entry]) => ({
        skill,
        uses: entry.uses,
        share: ratio(entry.uses, uses),
        last_used_at: new Date(entry.last).toISOString(),
      }))
      .sort(
        (a, b) =>
          b.uses - a.uses ||
          b.last_used_at.localeCompare(a.last_used_at) ||
          a.skill.localeCompare(b.skill),
      );
    const series = ranked.slice(0, 6).map((row) => row.skill);

    const installed = this.installed(query.profiles);
    const neverUsed = installed === null ? null : installed.filter((name) => !perSkill.has(name));

    const activity = this.activity(workspaces, period);
    const counter = this.db
      .select()
      .from(auditCounters)
      .where(eq(auditCounters.name, 'skill_uses'))
      .get();

    return {
      period: this.periodOf(period),
      generated_at: new Date(now).toISOString(),
      profiles: query.profiles.map((p) => p.slug),
      counting_since: counter ? counter.startedAt.toISOString() : null,
      agents: this.agentsOf(activity, null, []),
      totals: {
        uses,
        distinct_skills: perSkill.size,
        top_skill: ranked[0] ? { skill: ranked[0].skill, uses: ranked[0].uses } : null,
        never_used_count: neverUsed === null ? null : neverUsed.length,
      },
      top_series: series,
      by_day: period.dates.map((date) => {
        const daily = perDay.get(date) ?? new Map<string, number>();
        const skills: Record<string, number> = {};
        let total = 0;
        let inSeries = 0;
        for (const [skill, count] of daily) {
          total += count;
          if (series.includes(skill)) {
            skills[skill] = count;
            inSeries += count;
          }
        }
        return { date, uses: total, skills, other: total - inSeries };
      }),
      top_skills: ranked,
      never_used: neverUsed,
    };
  }

  // ---------------------------------------------------------------- helpers

  private periodOf(period: CalendarPeriod) {
    return {
      from: period.dates[0]!,
      to: period.dates[period.dates.length - 1]!,
      days: period.dates.length,
    };
  }

  /**
   * Runs per (agent, conversation, day). From `sessions` when the port is joined; otherwise
   * from the ledger itself, which knows only the runs that reported usage.
   */
  private activity(workspaces: readonly string[], period: CalendarPeriod): RunActivityRow[] {
    if (workspaces.length === 0) return [];
    if (this.sources.runActivity) {
      return this.sources.runActivity({
        workspaces,
        from: period.from,
        to: period.to,
        offsetMs: period.offsetMs,
      });
    }
    const day = sql<string>`strftime('%Y-%m-%d', (${usageRecords.recordedAt} + ${period.offsetMs}) / 1000, 'unixepoch')`;
    return this.db
      .select({
        agentId: usageRecords.agentId,
        sessionId: usageRecords.sessionId,
        day,
        runs: sql<number>`count(distinct ${usageRecords.runId})`,
      })
      .from(usageRecords)
      .where(
        and(
          inArray(usageRecords.workspace, [...workspaces]),
          gte(usageRecords.recordedAt, new Date(period.from)),
          lt(usageRecords.recordedAt, new Date(period.to)),
        ),
      )
      .groupBy(usageRecords.agentId, usageRecords.sessionId, day)
      .all()
      .map((row) => ({ ...row, runs: Number(row.runs) }));
  }

  /** Every agent active in the period, named, whatever the report is narrowed to. */
  private agentsOf(
    activity: readonly RunActivityRow[],
    reported: Map<string, number> | null,
    groups: ReadonlyArray<{ agentId: string }>,
  ): Array<{ agent_id: string; name: string | null; reports_usage: boolean }> {
    const ids = new Set<string>([
      ...activity.map((row) => row.agentId),
      ...groups.map((g) => g.agentId),
    ]);
    return [...ids]
      .map((agentId) => ({
        agent_id: agentId,
        name: this.nameOf(agentId),
        reports_usage: reported ? (reported.get(agentId) ?? 0) > 0 : true,
      }))
      .sort((a, b) => (a.name ?? a.agent_id).localeCompare(b.name ?? b.agent_id));
  }

  private nameOf(agentId: string): string | null {
    try {
      return this.sources.agentName?.(agentId) ?? null;
    } catch {
      // A removed agent keeps its history; it just has no name any more.
      return null;
    }
  }

  private installed(profiles: readonly AnalyticsProfile[]): string[] | null {
    if (!this.sources.installedSkills || profiles.length === 0) return null;
    const names = new Set<string>();
    for (const profile of profiles) {
      let list: string[] | null;
      try {
        list = this.sources.installedSkills(profile);
      } catch {
        list = null;
      }
      // One profile the hub cannot see makes the whole list unknown, not shorter.
      if (list === null) return null;
      for (const name of list) names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }
}
