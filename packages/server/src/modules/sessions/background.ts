/**
 * This module's share of the Background panel (contract decision §56): a person's runs — chat,
 * task and schedule runs; a workflow's agent steps are shown as their workflow run, by
 * `schedules` — and the subagents of their conversations. Registered with `audit` by the
 * composition root; stopping is the chat's own Stop and `sessions.interruptSubagent`.
 */
import { HubError } from '../../lib/errors.js';
import type { BackgroundItem, BackgroundSource, BackgroundStatus } from '../audit/index.js';
import type { EngineScope } from './engine.js';
import type { RunRow } from './mappers.js';
import type { SessionsService } from './service.js';
import type { SubagentRecord } from './subagents.js';

const LIVE: ReadonlySet<RunRow['status']> = new Set([
  'queued',
  'starting',
  'streaming',
  'waiting_approval',
  'waiting_input',
]);

const iso = (value: Date | number | null | undefined): string | null =>
  value === null || value === undefined ? null : new Date(value).toISOString();

function runStatus(status: RunRow['status']): BackgroundStatus {
  if (status === 'queued') return 'queued';
  if (LIVE.has(status)) return 'running';
  if (status === 'succeeded') return 'succeeded';
  if (status === 'cancelled') return 'cancelled';
  return 'failed';
}

/** A run as a Background item; `null` for a workflow's step, which its workflow run stands for. */
export function runItem(run: RunRow, title: string | null, profile: string): BackgroundItem | null {
  if (run.originKind === 'workflow') return null;
  const kind =
    run.originKind === 'task'
      ? 'task_run'
      : run.originKind === 'schedule'
        ? 'schedule_run'
        : 'chat_run';
  const resource =
    run.originKind === 'task' && run.originId
      ? { kind: 'task', id: run.originId }
      : run.originKind === 'schedule' && run.originId
        ? { kind: 'schedule_run', id: run.originId }
        : { kind: 'run', id: run.id };
  return {
    id: `run:${run.id}`,
    kind,
    job_kind: null,
    // Empty while the conversation has no title yet; a client names it.
    title: title?.trim() ?? '',
    profile,
    status: runStatus(run.status),
    started_at: iso(run.startedAt),
    finished_at: iso(run.finishedAt),
    stoppable: LIVE.has(run.status) && run.interruptRequestedAt === null,
    session_id: run.sessionId,
    resource,
  };
}

const SUBAGENT_STATUS: Record<SubagentRecord['status'], BackgroundStatus> = {
  running: 'running',
  completed: 'succeeded',
  failed: 'failed',
  interrupted: 'cancelled',
};

export function subagentItem(
  record: SubagentRecord,
  profile: string,
  stoppable: boolean,
): BackgroundItem {
  return {
    id: `subagent:${record.sessionId}:${record.id}`,
    kind: 'subagent',
    job_kind: null,
    title: record.goal.trim() || record.id,
    profile,
    status: SUBAGENT_STATUS[record.status],
    started_at: iso(record.startedAt),
    finished_at: iso(record.finishedAt),
    stoppable: record.status === 'running' && stoppable,
    session_id: record.sessionId,
    resource: null,
  };
}

/** The source `audit` gathers from. */
export function sessionsBackground(service: () => SessionsService): BackgroundSource {
  const canInterrupt = (svc: SessionsService, sessionId: string) => svc.canStopSubagents(sessionId);
  return {
    prefixes: ['run', 'subagent'],
    list(caller, since) {
      const svc = service();
      const slugOf = new Map(caller.workspaces.map((w) => [w.id, w.slug]));
      const items: BackgroundItem[] = [];
      for (const row of svc.store.backgroundRuns(caller.userId, [...slugOf.keys()], since)) {
        const item = runItem(row.run, row.title, slugOf.get(row.run.workspace) ?? '');
        if (item) items.push(item);
      }
      const workspaces = new Set(slugOf.keys());
      for (const { record, scope } of svc.subagents.runningFor(caller.userId, workspaces)) {
        items.push(subagentItem(record, scope.profile, canInterrupt(svc, record.sessionId)));
      }
      for (const { record, scope } of svc.subagents.finishedFor(caller.userId, workspaces, since)) {
        items.push(subagentItem(record, scope.profile, false));
      }
      return items;
    },
    async stop(caller, id) {
      const svc = service();
      const scope: EngineScope = {
        workspace: caller.workspace.id,
        profile: caller.workspace.slug,
        userId: caller.userId,
        userName: '',
        language: 'en',
      };
      if (id.startsWith('run:')) {
        const runId = id.slice(4);
        const run = svc.store.getRun(caller.workspace.id, runId);
        if (!run || run.ownerId !== caller.userId) return null;
        const session = svc.store.getSession(caller.workspace.id, run.sessionId);
        const before = runItem(run, session?.title ?? null, caller.workspace.slug);
        if (!before) return null;
        if (!LIVE.has(run.status)) {
          throw new HubError('state_invalid', { details: { reason: 'finished' } });
        }
        await svc.cancelRun(scope, run.sessionId, run.id);
        const after = svc.store.getRun(caller.workspace.id, run.id) ?? run;
        return runItem(after, session?.title ?? null, caller.workspace.slug);
      }
      if (id.startsWith('subagent:')) {
        const rest = id.slice('subagent:'.length);
        const cut = rest.indexOf(':');
        if (cut < 0) return null;
        const sessionId = rest.slice(0, cut);
        const subagentId = rest.slice(cut + 1);
        const session = svc.store.getSession(caller.workspace.id, sessionId);
        if (!session || session.ownerId !== caller.userId) return null;
        if (!svc.subagents.isRunning(sessionId, subagentId)) {
          svc.subagents.get(caller.workspace.id, sessionId, subagentId);
          throw new HubError('state_invalid', { details: { reason: 'finished' } });
        }
        if (!canInterrupt(svc, sessionId)) {
          throw new HubError('state_invalid', { details: { reason: 'not_stoppable' } });
        }
        const record = await svc.subagents.interrupt(caller.workspace.id, sessionId, subagentId);
        return subagentItem(record, caller.workspace.slug, canInterrupt(svc, sessionId));
      }
      return null;
    },
  };
}
