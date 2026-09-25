// The realtime envelope of packages/contracts/events (README §Envelope).
export interface Envelope<P = Record<string, unknown>> {
  event: string;
  namespace: string;
  profile: string | null;
  ts: string;
  seq: number;
  payload: P;
}

export function isEnvelope(value: unknown): value is Envelope {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.event === 'string' &&
    typeof e.namespace === 'string' &&
    typeof e.seq === 'number' &&
    typeof e.ts === 'string' &&
    !!e.payload &&
    typeof e.payload === 'object'
  );
}

export const SESSION_EVENTS = [
  'session.created',
  'session.updated',
  'session.deleted',
  'message.created',
  'message.delta',
  'reasoning.delta',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'run.queued',
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'approval.requested',
  'approval.resolved',
  'context.updated',
  'context.compression',
] as const;

/**
 * A conversation's subagents (contract decision §56). Profile-wide on `/rt/sessions`, so the
 * Background panel hears them wherever the person is; each carries the whole `Subagent`.
 */
export const SUBAGENT_EVENTS = [
  'subagent.started',
  'subagent.updated',
  'subagent.completed',
] as const;

/** `/rt/tasks`: the board only listens, and refreshes on any of these. */
export const TASK_EVENTS = [
  'task.created',
  'task.updated',
  'task.deleted',
  'task.moved',
  'task.assigned',
  'task.unassigned',
  'task.commented',
  'worktree.updated',
] as const;

/** `/rt/schedules`: the Schedules page only listens, and refreshes on any of these. */
export const SCHEDULE_EVENTS = [
  'schedule.created',
  'schedule.updated',
  'schedule.deleted',
  'schedule.fired',
  'schedule_run.started',
  'schedule_run.completed',
  'schedule_run.failed',
  // A workflow run as it goes, so a run on the screen follows it — a gate raised or answered.
  'workflow_run.started',
  'workflow_run.completed',
  'workflow_run.failed',
  'workflow_run.cancelled',
  'step.started',
  'step.completed',
  'step.failed',
  'step.waiting',
  // A workflow drawn, changed or deleted elsewhere: the Workflows section follows it.
  'workflow.created',
  'workflow.updated',
  'workflow.deleted',
] as const;

export const JOB_EVENTS = [
  'job.queued',
  'job.started',
  'job.progress',
  'job.completed',
  'job.failed',
  'job.cancelled',
  'agent.updated',
] as const;

export const DEVICE_EVENTS = [
  'pairing.claimed',
  'device.linked',
  'device.updated',
  'device.unlinked',
] as const;
