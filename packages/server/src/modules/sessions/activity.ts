/**
 * Runs per agent, conversation and calendar day, for the Usage report (`audit.getUsage`,
 * contract decision §50). Runs are this module's, so the question is answered here and lent
 * to `audit` by the composition root; `audit` never reads this module's tables.
 *
 * Every run counts, whether or not its agent reported usage — that difference is what lets
 * the report say "this agent reports no usage" instead of showing zeros.
 */
import { and, gte, inArray, lt, sql } from 'drizzle-orm';
import type { ModuleDb } from '../../lib/db.js';
import type { RunActivityQuery, RunActivityRow } from '../audit/index.js';
import { runs } from './schema.js';

export function runActivity(db: ModuleDb, query: RunActivityQuery): RunActivityRow[] {
  if (query.workspaces.length === 0) return [];
  const day = sql<string>`strftime('%Y-%m-%d', (${runs.createdAt} + ${query.offsetMs}) / 1000, 'unixepoch')`;
  return db
    .select({
      agentId: runs.agentId,
      sessionId: runs.sessionId,
      day,
      runs: sql<number>`count(*)`,
    })
    .from(runs)
    .where(
      and(
        inArray(runs.workspace, [...query.workspaces]),
        gte(runs.createdAt, new Date(query.from)),
        lt(runs.createdAt, new Date(query.to)),
      ),
    )
    .groupBy(runs.agentId, runs.sessionId, day)
    .all()
    .map((row) => ({ ...row, runs: Number(row.runs) }));
}
