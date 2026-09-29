/**
 * Whether a workflow is running, as its card on the Workflows page and the sidebar's
 * Workflows entry show it (owner, 2026-09-29: «ابي اشوفه وهو يشتغل»).
 *
 * The list says a workflow has a run still going (`active_run_id`); the run itself says
 * whether it waits for a person and which step it is on. A run started by a trigger (a
 * ClickUp delivery), a schedule or the Run button reaches the page the same way: the hub's
 * `workflow_run.*` and `step.*` events on `/rt/schedules`, with a poll behind them while the
 * socket is away.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useRealtime } from '../../realtime/context.js';
import { latestSteps, type RunStep } from './model.js';
import {
  useWorkflowRun,
  useWorkflows,
  workflowKeys,
  type WorkflowRow,
  type WorkflowRunRow,
} from './queries.js';

export type CardActivity =
  | { state: 'idle' }
  | { state: 'error' }
  | { state: 'running'; step: string | null }
  | { state: 'waiting'; step: string | null };

type ListedWorkflow = Pick<WorkflowRow, 'status' | 'active_run_id' | 'nodes'>;
type SeenRun = Pick<WorkflowRunRow, 'id' | 'status' | 'steps'>;

const OVER: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled']);

/** The title a step's node has in the workflow, or null when it has none. */
function titleOf(workflow: ListedWorkflow, nodeId: string): string | null {
  for (const raw of workflow.nodes) {
    const node = raw as { id?: unknown; title?: unknown };
    if (node.id === nodeId) {
      return typeof node.title === 'string' && node.title.trim() ? node.title.trim() : null;
    }
  }
  return null;
}

function stepWith(run: SeenRun, statuses: readonly string[]): RunStep | undefined {
  return [...latestSteps(run).values()].find((step) => statuses.includes(step.status));
}

/**
 * The card's state from the listed workflow and, when it has one, its run still going.
 * A run already over while the list has not caught up yet is idle: the list follows.
 */
export function cardActivity(
  workflow: ListedWorkflow,
  run: SeenRun | null | undefined,
): CardActivity {
  const live =
    workflow.active_run_id !== null ||
    workflow.status === 'running' ||
    workflow.status === 'waiting';
  if (!live) return { state: workflow.status === 'error' ? 'error' : 'idle' };
  const current = run && run.id === workflow.active_run_id ? run : null;
  if (!current) {
    return { state: workflow.status === 'waiting' ? 'waiting' : 'running', step: null };
  }
  if (OVER.has(current.status)) return { state: 'idle' };
  if (current.status === 'waiting') {
    const gate = stepWith(current, ['waiting_approval']);
    return { state: 'waiting', step: gate ? titleOf(workflow, gate.node_id) : null };
  }
  const step = stepWith(current, ['running']) ?? stepWith(current, ['pending', 'queued']);
  return { state: 'running', step: step ? titleOf(workflow, step.node_id) : null };
}

/** A card's state, reading its live run (and following it) only while it has one. */
export function useCardActivity(workflow: WorkflowRow): CardActivity {
  const run = useWorkflowRun(workflow.profile, workflow.active_run_id);
  return cardActivity(workflow, run.data);
}

/** The events that start or end a run: all the sidebar needs to hear. */
const RUN_EVENTS = [
  'workflow_run.started',
  'workflow_run.completed',
  'workflow_run.failed',
  'workflow_run.cancelled',
] as const;

/**
 * Whether any workflow of `profile` has a run going, for the sidebar's Workflows entry. It
 * hears runs start and end on `/rt/schedules` wherever the person is; the list's own poll
 * (`useWorkflows`) is the fallback.
 */
export function useAnyWorkflowRunning(profile: string): boolean {
  const workflows = useWorkflows();
  const realtime = useRealtime();
  const queryClient = useQueryClient();
  useEffect(() => {
    const socket = realtime.socket('schedules');
    const refresh = () =>
      void queryClient.invalidateQueries({ queryKey: workflowKeys.all, exact: true });
    for (const name of RUN_EVENTS) socket.on(name, refresh);
    socket.on('connect', refresh);
    if (!socket.connected && !socket.active) socket.connect();
    return () => {
      for (const name of RUN_EVENTS) socket.off(name, refresh);
      socket.off('connect', refresh);
    };
  }, [queryClient, realtime, realtime.epoch]);
  return (workflows.data ?? []).some(
    (workflow) => workflow.profile === profile && workflow.active_run_id !== null,
  );
}
