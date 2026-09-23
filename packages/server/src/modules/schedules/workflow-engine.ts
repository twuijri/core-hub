/**
 * Running a workflow: the steps, in the order the drawing says, each done by the engine
 * or by an agent.
 *
 * Owner's design (2026-09-22): a step is either **deterministic** — the engine answers it
 * itself, with no model and no cost — or **an agent's** — a model reads, decides and acts,
 * with its own tools (sending a Telegram message is the agent's tool, not a hub feature).
 * The person drawing the workflow says which, per step.
 *
 *   agent       an agent turn: the step's `input` is the prompt, rendered with the trigger
 *               and earlier steps; the step's output is what the agent said. It runs in a
 *               session of its own (source `workflow`), so it is in the history with its
 *               tool calls, and an approval it asks for waits for a person as in a chat.
 *   condition   one comparison (`expr.ts`) — "yes" follows `success` edges, "no" `failure`.
 *   delay       wait N seconds, up to an hour; longer waits are a schedule's job.
 *   notify      a notice in the inbox of whoever the run belongs to, in the step's words.
 *   approval    not built: it fails, saying so, rather than pretending to wait.
 *
 * Walking the graph: the nodes nothing points to start; after a step, each outgoing edge
 * fires if its route matches (`always`, `success` after a step that succeeded or a
 * condition that said yes, `failure` otherwise); a node runs once, when the first edge
 * reaches it. A failed step with no edge to handle it fails the run with the step's own
 * error. Nothing here evaluates code — templates and conditions are `expr.ts`, which walks
 * paths and compares values.
 *
 * The engine keeps its place in memory. A restart fails the runs that were going
 * (`failInterruptedRuns`) instead of leaving them "running" forever.
 */
import type { FastifyBaseLogger } from 'fastify';
import { ConditionError, evaluate, parseCondition, render, type Context } from './expr.js';
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from './schema.js';
import type { SchedulesService, Scope, WorkflowRow, WorkflowRunRow } from './service.js';

/** Who a run acts as. `userName` and `language` go to the agent's session. */
export interface RunScope extends Scope {
  userName: string;
  language: 'ar' | 'en';
}

export interface AgentTurnResult {
  sessionId: string;
  runId: string;
  status: string;
  output: string;
  error: string | null;
}

/** What the engine needs from the rest of the hub. Composed in `modules/index.ts`. */
export interface WorkflowPorts {
  /** One whole agent turn; `null` when this hub composes no sessions. */
  agentTurn:
    | ((
        scope: RunScope,
        input: { agentId: string; prompt: string; title: string },
      ) => Promise<AgentTurnResult>)
    | null;
  /** A notice in the run owner's inbox. */
  notice: ((scope: Scope, input: { title: string; body: string | null }) => void) | null;
}

/** Longest `delay` step. Anything longer is a schedule, not a pause. */
export const MAX_DELAY_SECONDS = 3600;
/** A drawing with a loop cannot run forever: each node runs once, and this is the cap. */
const MAX_STEPS = 200;

type Emit = (profile: string, event: string, payload: Record<string, unknown>) => void;

interface StepResult {
  ok: boolean;
  /** For a condition: which way it went. Otherwise the same as `ok`. */
  route: 'success' | 'failure';
  output: unknown;
  error: string | null;
  runId?: string | null;
}

interface Live {
  cancelled: boolean;
  wake: (() => void) | null;
}

export class WorkflowEngine {
  private readonly live = new Map<string, Live>();
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly ports: WorkflowPorts,
    private readonly emit: Emit,
    private readonly log: FastifyBaseLogger,
  ) {}

  /**
   * Start a run and return it at once; the steps go on after the answer. `steps` carries
   * finished outputs forward when a run restarts from a node, so `{{steps.x.output}}` of a
   * step before the restart point still reads what it said the first time.
   */
  start(
    service: SchedulesService,
    scope: RunScope,
    workflow: WorkflowRow,
    options: {
      trigger: unknown;
      input: string | null;
      triggerKind: WorkflowRunRow['triggerKind'];
      triggerRef?: string | null;
      scheduleId?: string | null;
      startNodeIds?: readonly string[] | null;
      steps?: Record<string, { output: unknown }>;
    },
  ): WorkflowRunRow {
    const run = service.createWorkflowRun(scope, workflow, {
      input: { trigger: options.trigger ?? null, input: options.input },
      triggerKind: options.triggerKind,
      triggerRef: options.triggerRef ?? null,
      scheduleId: options.scheduleId ?? null,
    });
    const state: Live = { cancelled: false, wake: null };
    this.live.set(run.id, state);
    this.emit(scope.profile, 'workflow_run.started', {
      workflow_run_id: run.id,
      workflow_id: workflow.id,
    });
    const ctx: Context = {
      trigger: options.trigger ?? null,
      steps: { ...(options.steps ?? {}) },
      input: options.input ?? '',
    };
    const done = this.execute(service, scope, run, ctx, state, options.startNodeIds ?? null)
      .catch((error: unknown) => {
        // The engine's own bug, not a step's failure: still a run that ended, with a reason.
        this.log.error({ err: error, workflowRunId: run.id }, 'workflow: run crashed');
        service.updateWorkflowRun(run.id, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          activeNodeKeys: [],
          finishedAt: new Date(),
        });
      })
      .finally(() => {
        this.live.delete(run.id);
        this.running.delete(done);
      });
    this.running.add(done);
    return run;
  }

  /** Stop at the next step boundary; a `delay` in progress ends at once. */
  cancel(workflowRunId: string): void {
    const state = this.live.get(workflowRunId);
    if (!state) return;
    state.cancelled = true;
    state.wake?.();
  }

  /** Tests and shutdown: wait until nothing is running. */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }

  private async execute(
    service: SchedulesService,
    scope: RunScope,
    run: WorkflowRunRow,
    ctx: Context,
    state: Live,
    startNodeIds: readonly string[] | null,
  ): Promise<void> {
    const definition = run.definitionSnapshot as WorkflowDefinition;
    const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
    const outgoing = new Map<string, WorkflowEdge[]>();
    for (const edge of definition.edges) {
      outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
    }
    const reached = new Set(definition.edges.map((edge) => edge.to));
    const queue: string[] = startNodeIds?.length
      ? [...startNodeIds]
      : definition.nodes.filter((node) => !reached.has(node.id)).map((node) => node.id);

    const ran = new Set<string>();
    let unhandled: string | null = null;
    let steps = 0;
    while (queue.length > 0 && !state.cancelled) {
      const id = queue.shift()!;
      const node = nodes.get(id);
      if (!node || ran.has(id)) continue;
      if (++steps > MAX_STEPS) {
        unhandled = `the run stopped after ${MAX_STEPS} steps`;
        break;
      }
      ran.add(id);
      service.updateWorkflowRun(run.id, { activeNodeKeys: [id] });
      const result = await this.step(service, scope, run, node, ctx, state);
      if (state.cancelled) break;
      ctx.steps[id] = { output: result.output };
      const edges = outgoing.get(id) ?? [];
      for (const edge of edges) {
        if (edge.route === 'always' || edge.route === result.route) queue.push(edge.to);
      }
      // A condition's "no" is an answer, not a failure. A failed step that nothing
      // handles ends the run with its own words.
      if (!result.ok && !edges.some((edge) => edge.route !== 'success')) {
        unhandled = `${node.title || node.id}: ${result.error ?? 'failed'}`;
        break;
      }
    }

    const now = new Date();
    if (state.cancelled) {
      // `cancelWorkflowRun` already wrote the row; only the live diagram is left.
      service.updateWorkflowRun(run.id, { activeNodeKeys: [] });
      return;
    }
    service.updateWorkflowRun(run.id, {
      status: unhandled ? 'failed' : 'succeeded',
      error: unhandled,
      activeNodeKeys: [],
      output: { steps: summarize(ctx.steps) },
      finishedAt: now,
    });
    this.emit(scope.profile, unhandled ? 'workflow_run.failed' : 'workflow_run.completed', {
      workflow_run_id: run.id,
      workflow_id: run.workflowId,
      error: unhandled,
    });
  }

  private async step(
    service: SchedulesService,
    scope: RunScope,
    run: WorkflowRunRow,
    node: WorkflowNode,
    ctx: Context,
    state: Live,
  ): Promise<StepResult> {
    const rendered = node.kind === 'condition' ? (node.input ?? '') : render(node.input ?? '', ctx);
    const row = service.startStep(scope, run.id, node, { input: rendered });
    this.emit(scope.profile, 'step.started', {
      workflow_run_id: run.id,
      node_id: node.id,
      attempt: row.attempt,
    });
    let result: StepResult;
    try {
      result = await this.perform(scope, node, rendered, ctx, state);
    } catch (error) {
      result = fail(error instanceof Error ? error.message : String(error));
    }
    service.finishStep(row.id, {
      status: state.cancelled ? 'cancelled' : result.ok ? 'succeeded' : 'failed',
      output: result.ok || result.route === 'failure' ? { value: result.output } : null,
      error: result.error,
      runId: result.runId ?? null,
    });
    this.emit(scope.profile, result.ok ? 'step.completed' : 'step.failed', {
      workflow_run_id: run.id,
      node_id: node.id,
      attempt: row.attempt,
      error: result.error,
    });
    return result;
  }

  private async perform(
    scope: RunScope,
    node: WorkflowNode,
    rendered: string,
    ctx: Context,
    state: Live,
  ): Promise<StepResult> {
    if (node.approval_required || node.kind === 'approval') {
      return fail('approval steps are not built yet, so this step cannot wait for one');
    }
    switch (node.kind) {
      case 'condition': {
        let answer: boolean;
        try {
          answer = evaluate(parseCondition(rendered), ctx);
        } catch (error) {
          return fail(error instanceof ConditionError ? error.reason : String(error));
        }
        return { ok: true, route: answer ? 'success' : 'failure', output: answer, error: null };
      }
      case 'delay': {
        const seconds = Number(rendered.trim());
        if (!Number.isFinite(seconds) || seconds < 0) {
          return fail(`"${rendered}" is not a number of seconds`);
        }
        if (seconds > MAX_DELAY_SECONDS) {
          return fail(`a delay is at most ${MAX_DELAY_SECONDS} seconds; longer is a schedule`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, seconds * 1000);
          state.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        state.wake = null;
        return succeed(seconds);
      }
      case 'notify': {
        if (!this.ports.notice) return fail('this hub has no inbox to write to');
        const text = rendered.trim();
        if (!text) return fail('the notice has no words');
        this.ports.notice(scope, { title: node.title || 'Workflow', body: text });
        return succeed(text);
      }
      case 'agent': {
        if (!node.agent_id) return fail('this step names no agent');
        if (!rendered.trim()) return fail('this step has no prompt for the agent');
        if (!this.ports.agentTurn) return fail('this hub cannot run an agent');
        const turn = await this.ports.agentTurn(scope, {
          agentId: node.agent_id,
          prompt: rendered,
          title: node.title || node.id,
        });
        return turn.status === 'succeeded'
          ? { ...succeed(turn.output), runId: turn.runId }
          : {
              ...fail(turn.error ?? `the agent's run ended ${turn.status}`),
              output: turn.output,
              runId: turn.runId,
            };
      }
      default:
        return fail(`a "${(node as { kind: string }).kind}" step is not something this hub runs`);
    }
  }
}

function succeed(output: unknown): StepResult {
  return { ok: true, route: 'success', output, error: null };
}

function fail(error: string): StepResult {
  return { ok: false, route: 'failure', output: null, error };
}

/** What each step said, bounded so one chatty agent does not fill the run's row. */
function summarize(steps: Record<string, { output: unknown }>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, step] of Object.entries(steps)) {
    out[id] =
      typeof step.output === 'string' && step.output.length > 2000
        ? `${step.output.slice(0, 2000)}…`
        : step.output;
  }
  return out;
}
