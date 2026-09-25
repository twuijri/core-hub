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
 *   approval    waits for a person: an ordinary approval (kind `workflow_step`) is raised,
 *               the run pauses (`waiting_approval`), and the answer continues it — approve
 *               follows the `success` edges, deny fails the step with the reason given.
 *               Any other step with `approval_required` waits the same way *before* it
 *               does its work.
 *
 * Walking the graph: the nodes nothing points to start; after a step, each outgoing edge
 * fires if its route matches (`always`, `success` after a step that succeeded or a
 * condition that said yes, `failure` otherwise); a node runs once, when the first edge
 * reaches it. A failed step with no edge to handle it fails the run with the step's own
 * error. Nothing here evaluates code — templates and conditions are `expr.ts`, which walks
 * paths and compares values.
 *
 * **Limits** (DECISIONS §53): a run works under a time budget, a cost budget and a per-step
 * timeout (`limits.ts`), each optional. A step is raced against them: the time budget and
 * the step timeout are timers, the cost budget is the hub's per-turn estimate of the agent
 * step's run, read every few seconds while it works and once when it ends. When the time or
 * the cost budget runs out the step working is cancelled (an agent's run stopped as the
 * chat's Stop does) and the run ends `failed`, saying which limit and how much; a step past
 * its timeout fails like any failed step, so a `failure` edge can take it, and only a
 * timeout nothing handles ends the run. Time spent waiting for a person at an approval is
 * not work and counts toward nothing: what was used is written down with the run's place.
 *
 * The engine keeps its place in memory while a step works. A restart fails the runs that
 * were going (`failInterruptedRuns`) instead of leaving them "running" forever — except a
 * run waiting at an approval: that one's place is written down (`resume_state`: the nodes
 * still to visit, the nodes visited, every output so far), so an answer given after a
 * restart continues it exactly where it stopped.
 */
import type { FastifyBaseLogger } from 'fastify';
import { ConditionError, evaluate, parseCondition, render, type Context } from './expr.js';
import { NO_LIMITS, dollars, duration, microUsdOf, moneyOfMicro } from './limits.js';
import type {
  WorkflowBudgetUse,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowLimits,
  WorkflowNode,
} from './schema.js';
import type {
  NodeRunRow,
  SchedulesService,
  Scope,
  WorkflowRow,
  WorkflowRunRow,
} from './service.js';

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

/**
 * How the engine follows an agent's turn while it works: it learns the turn's ids as soon
 * as it starts (to read its cost), and aborting `signal` stops the turn — a limit ran out.
 */
export interface TurnControl {
  signal: AbortSignal;
  started(ids: { sessionId: string; runId: string }): void;
}

/** The hub's estimate of what one agent turn cost so far (`Usage.cost`). */
export interface TurnCost {
  microUsd: number;
  /** False when no model call of the turn had a price. */
  priced: boolean;
}

/** What the engine needs from the rest of the hub. Composed in `modules/index.ts`. */
export interface WorkflowPorts {
  /** One whole agent turn; `null` when this hub composes no sessions. */
  agentTurn:
    | ((
        scope: RunScope,
        input: {
          agentId: string;
          prompt: string;
          title: string;
          /** The step's own model (`<provider>/<model>`), else the agent's. */
          model?: string | null;
          provider?: string | null;
        },
        control?: TurnControl,
      ) => Promise<AgentTurnResult>)
    | null;
  /**
   * What a turn has cost so far, by the hub's per-turn estimate. Absent, the cost budget
   * sees nothing to count and never stops a run.
   */
  cost?: ((scope: RunScope, runId: string) => TurnCost) | null;
  /** A notice in the run owner's inbox. */
  notice: ((scope: Scope, input: { title: string; body: string | null }) => void) | null;
  /**
   * A step's gate: an ordinary approval (`sessions`), raised when a step waits for a
   * person and closed when its run is cancelled. Absent, a gated step fails saying so.
   */
  approvals?: {
    raise(
      scope: Scope,
      input: {
        workflowRunId: string;
        workflowId: string;
        workflowName: string;
        nodeId: string;
        title: string;
        description: string | null;
      },
    ): string;
    cancel(scope: Scope, workflowRunId: string): number;
  } | null;
}

/** How a person answered a gate. */
export interface GateAnswer {
  nodeId: string;
  approved: boolean;
  answer: string | null;
  by: string;
}

/** A run reached its end: succeeded, failed or cancelled. */
export type RunFinished = (
  run: WorkflowRunRow,
  outcome: { status: 'succeeded' | 'failed' | 'cancelled'; error: string | null },
) => void;

/** Longest `delay` step. Anything longer is a schedule, not a pause. */
export const MAX_DELAY_SECONDS = 3600;
/** A drawing with a loop cannot run forever: each node runs once, and this is the cap. */
const MAX_STEPS = 200;
/** How often an agent step's cost is read while it works, when the run has a cost budget. */
export const COST_POLL_MS = 2_000;

/** The limit that ended a run (`WorkflowRun.stopped_by`). */
export type StoppedBy = 'max_duration' | 'max_cost' | 'step_timeout';

type Emit = (profile: string, event: string, payload: Record<string, unknown>) => void;

interface StepResult {
  ok: boolean;
  /** For a condition: which way it went. Otherwise the same as `ok`. */
  route: 'success' | 'failure';
  output: unknown;
  error: string | null;
  runId?: string | null;
  /** The step waits for a person: the run pauses here. */
  waiting?: { stepId: string; approvalId: string };
  /** The run's time or cost budget ran out while this step worked: the run stops. */
  stop?: 'max_duration' | 'max_cost';
  /** The step ran past its own timeout (it failed; a `failure` edge may take it). */
  timedOut?: boolean;
}

interface Live {
  cancelled: boolean;
  wake: (() => void) | null;
  budget: Budget;
}

/**
 * A live run's limits and what it has used of them. `workedMs` is the work before this
 * stretch; the stretch started at `since` — a pause at an approval ends one stretch and
 * the answer starts the next, so the wait is never counted.
 */
class Budget {
  private since = Date.now();
  constructor(
    readonly limits: WorkflowLimits,
    private workedMs: number,
    public costMicroUsd: number,
    public priced: boolean,
  ) {}

  static of(limits: WorkflowLimits | undefined, used?: WorkflowBudgetUse): Budget {
    return new Budget(
      limits ?? NO_LIMITS,
      used?.workedMs ?? 0,
      used?.costMicroUsd ?? 0,
      used?.priced ?? false,
    );
  }

  worked(): number {
    return this.workedMs + (Date.now() - this.since);
  }

  /** Time left in the run's budget, in ms; `null` without one. */
  timeLeft(): number | null {
    const max = this.limits.max_duration_seconds;
    return max === null ? null : max * 1000 - this.worked();
  }

  maxCost(): number | null {
    return this.limits.max_cost ? microUsdOf(this.limits.max_cost.amount) : null;
  }

  add(cost: TurnCost | null): void {
    if (!cost) return;
    this.costMicroUsd += cost.microUsd;
    this.priced ||= cost.priced;
  }

  /** Nothing left of a budget: the run must not start another step. */
  spent(): 'max_duration' | 'max_cost' | null {
    const left = this.timeLeft();
    if (left !== null && left <= 0) return 'max_duration';
    const max = this.maxCost();
    if (max !== null && this.costMicroUsd >= max) return 'max_cost';
    return null;
  }

  /** What was used, to write down when the run pauses. */
  used(): WorkflowBudgetUse {
    return { workedMs: this.worked(), costMicroUsd: this.costMicroUsd, priced: this.priced };
  }

  /** The run's `output` fields for what it cost (`WorkflowRun.cost`). */
  output(): { cost_micro_usd: number; priced: boolean } {
    return { cost_micro_usd: this.costMicroUsd, priced: this.priced };
  }

  /** The words a person reads when a budget stopped the run. */
  reason(stop: 'max_duration' | 'max_cost'): string {
    if (stop === 'max_duration') {
      return `stopped: the run went over its time limit of ${duration(this.limits.max_duration_seconds ?? 0)}`;
    }
    return `stopped: the run went over its cost limit of ${dollars(this.maxCost() ?? 0)} (it cost about ${dollars(this.costMicroUsd)})`;
  }
}

/** The run's cost as the contract says it (`WorkflowRun.cost`): `null` until a turn had a price. */
export function costOf(output: unknown): { amount: string; currency: 'USD' } | null {
  const fields = (output ?? {}) as { cost_micro_usd?: number; priced?: boolean };
  return fields.priced ? moneyOfMicro(fields.cost_micro_usd ?? 0) : null;
}

/** Which limit ended a run, from its `output` (`WorkflowRun.stopped_by`). */
export function stoppedByOf(output: unknown): StoppedBy | null {
  const value = (output ?? {}) as { stopped_by?: unknown };
  return value.stopped_by === 'max_duration' ||
    value.stopped_by === 'max_cost' ||
    value.stopped_by === 'step_timeout'
    ? value.stopped_by
    : null;
}

export class WorkflowEngine {
  private readonly live = new Map<string, Live>();
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly ports: WorkflowPorts,
    private readonly emit: Emit,
    private readonly log: FastifyBaseLogger,
    private readonly finished: RunFinished = () => undefined,
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
      /** This run's limits (`limits.ts` → `runLimits`); the workflow's when not given. */
      limits?: WorkflowLimits;
    },
  ): WorkflowRunRow {
    const run = service.createWorkflowRun(scope, workflow, {
      input: { trigger: options.trigger ?? null, input: options.input },
      triggerKind: options.triggerKind,
      triggerRef: options.triggerRef ?? null,
      scheduleId: options.scheduleId ?? null,
      ...(options.limits ? { limits: options.limits } : {}),
    });
    const state: Live = {
      cancelled: false,
      wake: null,
      budget: Budget.of((run.definitionSnapshot as WorkflowDefinition).limits),
    };
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
    const definition = run.definitionSnapshot as WorkflowDefinition;
    const reached = new Set(definition.edges.map((edge) => edge.to));
    const queue = options.startNodeIds?.length
      ? [...options.startNodeIds]
      : definition.nodes.filter((node) => !reached.has(node.id)).map((node) => node.id);
    this.follow(service, run, state, () =>
      this.execute(service, scope, run, ctx, state, { queue, ran: new Set() }),
    );
    return run;
  }

  /**
   * A person answered the gate a run waits at: take the run back (once — a second answer
   * finds it no longer waiting and gets `false`), settle the gated step, and walk on from
   * the place written down when it paused. Works the same after a restart, because nothing
   * about a waiting run lives in memory.
   */
  resume(
    service: SchedulesService,
    scope: RunScope,
    workflowRunId: string,
    answer: GateAnswer,
  ): boolean {
    const run = service.takeWaitingRun(workflowRunId);
    if (!run) return false;
    const definition = run.definitionSnapshot as WorkflowDefinition;
    const node = definition.nodes.find((candidate) => candidate.id === answer.nodeId);
    const place = run.resumeState ?? { queue: [], ran: [], steps: {} };
    const input = (run.input ?? {}) as { trigger?: unknown; input?: string | null };
    const ctx: Context = {
      trigger: input.trigger ?? null,
      steps: { ...place.steps },
      input: input.input ?? '',
    };
    // The wait for the person is over: the budget goes on from what was used before it.
    const state: Live = {
      cancelled: false,
      wake: null,
      budget: Budget.of(definition.limits, place.used),
    };
    this.live.set(run.id, state);
    this.follow(service, run, state, async () => {
      service.updateWorkflowRun(run.id, {
        resumeState: null,
        activeNodeKeys: node ? [node.id] : [],
      });
      const row = service.waitingStep(run.id, answer.nodeId);
      const first =
        node && row
          ? {
              node,
              result: await this.passGate(service, scope, run, node, row, ctx, state, answer),
            }
          : null;
      await this.execute(
        service,
        scope,
        run,
        ctx,
        state,
        { queue: [...place.queue], ran: new Set(place.ran) },
        first,
      );
    });
    return true;
  }

  /** Stop at the next step boundary; a `delay` in progress ends at once. */
  cancel(workflowRunId: string): void {
    const state = this.live.get(workflowRunId);
    if (!state) return;
    state.cancelled = true;
    state.wake?.();
  }

  /**
   * A cancelled run that was waiting at a gate: nothing is live to stop, but its step ends
   * as cancelled and its approval is closed, so nobody is asked about a run that is over.
   */
  closeGates(service: SchedulesService, scope: Scope, workflowRunId: string): void {
    service.cancelWaitingSteps(workflowRunId);
    try {
      this.ports.approvals?.cancel(scope, workflowRunId);
    } catch (error) {
      this.log.warn({ err: error, workflowRunId }, 'workflow: closing its approval failed');
    }
  }

  /** Tell whoever cares that a run is over (a schedule's history line). */
  announceFinished(
    run: WorkflowRunRow,
    outcome: { status: 'succeeded' | 'failed' | 'cancelled'; error: string | null },
  ): void {
    try {
      this.finished(run, outcome);
    } catch (error) {
      this.log.warn({ err: error, workflowRunId: run.id }, 'workflow: after-run hook failed');
    }
  }

  private follow(
    service: SchedulesService,
    run: WorkflowRunRow,
    state: Live,
    work: () => Promise<void>,
  ): void {
    const done = work()
      .catch((error: unknown) => {
        // The engine's own bug, not a step's failure: still a run that ended, with a reason.
        this.log.error({ err: error, workflowRunId: run.id }, 'workflow: run crashed');
        const message = error instanceof Error ? error.message : String(error);
        service.updateWorkflowRun(run.id, {
          status: 'failed',
          error: message,
          activeNodeKeys: [],
          finishedAt: new Date(),
        });
        this.announceFinished(run, { status: 'failed', error: message });
      })
      .finally(() => {
        if (this.live.get(run.id) === state) this.live.delete(run.id);
        this.running.delete(done);
      });
    this.running.add(done);
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
    place: { queue: string[]; ran: Set<string> },
    first: { node: WorkflowNode; result: StepResult } | null = null,
  ): Promise<void> {
    const definition = run.definitionSnapshot as WorkflowDefinition;
    const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
    const outgoing = new Map<string, WorkflowEdge[]>();
    for (const edge of definition.edges) {
      outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
    }
    const { queue, ran } = place;
    let unhandled: string | null = null;
    let stoppedBy: StoppedBy | null = null;
    let steps = ran.size;

    /** After a step: its output is readable, its edges fire; `false` ends the run. */
    const advance = (node: WorkflowNode, result: StepResult): boolean => {
      if (result.stop) {
        // A budget ran out while this step worked: nothing after it runs.
        stoppedBy = result.stop;
        unhandled = state.budget.reason(result.stop);
        return false;
      }
      ctx.steps[node.id] = { output: result.output };
      const edges = outgoing.get(node.id) ?? [];
      for (const edge of edges) {
        if (edge.route === 'always' || edge.route === result.route) queue.push(edge.to);
      }
      // A condition's "no" is an answer, not a failure. A failed step that nothing
      // handles ends the run with its own words.
      if (!result.ok && !edges.some((edge) => edge.route !== 'success')) {
        unhandled = `${node.title || node.id}: ${result.error ?? 'failed'}`;
        if (result.timedOut) stoppedBy = 'step_timeout';
        return false;
      }
      // A budget used up by the step that just ended: the run stops before the next one.
      const spent = queue.length > 0 ? state.budget.spent() : null;
      if (spent) {
        stoppedBy = spent;
        unhandled = state.budget.reason(spent);
        return false;
      }
      return true;
    };

    let going = first ? advance(first.node, first.result) : true;
    while (going && queue.length > 0 && !state.cancelled) {
      const id = queue.shift()!;
      const node = nodes.get(id);
      if (!node || ran.has(id)) continue;
      if (++steps > MAX_STEPS) {
        unhandled = `the run stopped after ${MAX_STEPS} steps`;
        break;
      }
      const spent = state.budget.spent();
      if (spent) {
        stoppedBy = spent;
        unhandled = state.budget.reason(spent);
        break;
      }
      ran.add(id);
      service.updateWorkflowRun(run.id, { activeNodeKeys: [id] });
      const result = await this.step(service, scope, run, node, ctx, state);
      if (state.cancelled) break;
      if (result.waiting) {
        // A person decides. Everything needed to go on is written down, so nothing about
        // the wait lives in memory — a restart, or a day, changes nothing.
        service.pauseAtGate(run.id, result.waiting.stepId, result.waiting.approvalId, id, {
          queue: [...queue],
          ran: [...ran],
          steps: { ...ctx.steps },
          used: state.budget.used(),
        });
        const step = service.stepsOf(run.id).find((row) => row.id === result.waiting!.stepId);
        this.emit(scope.profile, 'step.waiting', {
          workflow_run_id: run.id,
          workflow_id: run.workflowId,
          step: step ? stepOf(step) : { node_id: id },
        });
        return;
      }
      going = advance(node, result);
    }

    const now = new Date();
    if (state.cancelled) {
      // `cancelWorkflowRun` already wrote the row; only the live diagram is left.
      service.updateWorkflowRun(run.id, { activeNodeKeys: [] });
      return;
    }
    const failed = unhandled as string | null;
    service.updateWorkflowRun(run.id, {
      status: failed ? 'failed' : 'succeeded',
      error: failed,
      activeNodeKeys: [],
      output: {
        steps: summarize(ctx.steps),
        ...state.budget.output(),
        stopped_by: stoppedBy as StoppedBy | null,
      },
      finishedAt: now,
    });
    this.emit(scope.profile, failed ? 'workflow_run.failed' : 'workflow_run.completed', {
      workflow_run_id: run.id,
      workflow_id: run.workflowId,
      error: failed,
      stopped_by: stoppedBy as StoppedBy | null,
    });
    this.announceFinished(run, { status: failed ? 'failed' : 'succeeded', error: failed });
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
    if (gated(node)) {
      if (this.ports.approvals) {
        try {
          const approvalId = this.ports.approvals.raise(scope, {
            workflowRunId: run.id,
            workflowId: run.workflowId,
            workflowName: service.workflowById(run.workflowId)?.name ?? '',
            nodeId: node.id,
            title: node.title || node.id,
            description: node.kind === 'approval' ? rendered.trim() || null : null,
          });
          return { ...succeed(null), waiting: { stepId: row.id, approvalId } };
        } catch (error) {
          result = fail(error instanceof Error ? error.message : String(error));
        }
      } else {
        result = fail('this hub cannot ask anyone for approval');
      }
    } else {
      result = await this.attempt(service, scope, run, node, rendered, ctx, state);
    }
    return this.finish(service, scope, run, node, row, result, state);
  }

  /**
   * The answer to a gate, as the gated step's result: an `approval` step is the gate, so
   * a yes is its success; any other step waited to be allowed, so a yes lets it do its
   * work now. A no fails the step with the reason given.
   */
  private async passGate(
    service: SchedulesService,
    scope: RunScope,
    run: WorkflowRunRow,
    node: WorkflowNode,
    row: NodeRunRow,
    ctx: Context,
    state: Live,
    answer: GateAnswer,
  ): Promise<StepResult> {
    let result: StepResult;
    if (!answer.approved) {
      const why = answer.answer?.trim();
      result = fail(why ? `denied by ${answer.by}: ${why}` : `denied by ${answer.by}`);
    } else if (node.kind === 'approval') {
      result = succeed(answer.answer?.trim() || 'approved');
    } else {
      service.resumeStep(row.id);
      const rendered = (row.input as { input?: string }).input ?? '';
      result = await this.attempt(service, scope, run, node, rendered, ctx, state);
    }
    return this.finish(service, scope, run, node, row, result, state);
  }

  /**
   * One step's work, raced against the run's limits. Whichever comes first ends the step:
   * its own result, its timeout, the run's time budget, or the run's cost budget read from
   * the agent turn it is waiting on. A limit that wins aborts the work — an agent's turn is
   * stopped, a delay woken — and what the turn cost until then is still counted.
   */
  private async attempt(
    service: SchedulesService,
    scope: RunScope,
    run: WorkflowRunRow,
    node: WorkflowNode,
    rendered: string,
    ctx: Context,
    state: Live,
  ): Promise<StepResult> {
    const budget = state.budget;
    const abort = new AbortController();
    const timers: ReturnType<typeof setTimeout>[] = [];
    let poll: ReturnType<typeof setInterval> | null = null;
    let turn: { runId: string } | null = null;
    const turnCost = (): TurnCost | null =>
      turn && this.ports.cost ? this.ports.cost(scope, turn.runId) : null;

    let trip: (result: StepResult) => void = () => undefined;
    const tripped = new Promise<StepResult>((resolve) => {
      trip = (result) => {
        if (abort.signal.aborted) return;
        abort.abort();
        resolve(result);
      };
    });
    const stepLimit = budget.limits.step_timeout_seconds;
    if (stepLimit !== null) {
      timers.push(
        setTimeout(
          () => trip({ ...fail(`timed out after ${duration(stepLimit)}`), timedOut: true }),
          stepLimit * 1000,
        ),
      );
    }
    const left = budget.timeLeft();
    if (left !== null) {
      timers.push(
        setTimeout(
          () => trip({ ...fail(budget.reason('max_duration')), stop: 'max_duration' }),
          Math.max(0, left),
        ),
      );
    }
    const maxCost = budget.maxCost();
    const control: TurnControl = {
      signal: abort.signal,
      started: (ids) => {
        turn = { runId: ids.runId };
        if (maxCost === null || !this.ports.cost || poll) return;
        poll = setInterval(() => {
          const now = turnCost();
          if (now && budget.costMicroUsd + now.microUsd > maxCost) {
            trip({ ...fail(budget.reason('max_cost')), stop: 'max_cost' });
          }
        }, COST_POLL_MS);
      },
    };

    const work = this.perform(scope, node, rendered, ctx, state, control).catch((error: unknown) =>
      fail(error instanceof Error ? error.message : String(error)),
    );
    let result = await Promise.race([work, tripped]);
    for (const timer of timers) clearTimeout(timer);
    if (poll) clearInterval(poll);
    if (!abort.signal.aborted) abort.abort();

    // What the turn cost, however it ended, and whether that was over the budget.
    const cost = turnCost();
    if (cost) {
      budget.add(cost);
      service.updateWorkflowRun(run.id, { output: budget.output() });
      if (result.stop === 'max_cost' && result.error) {
        result = { ...result, error: budget.reason('max_cost') };
      }
    }
    if (turn && !result.runId) result = { ...result, runId: (turn as { runId: string }).runId };
    return result;
  }

  private finish(
    service: SchedulesService,
    scope: RunScope,
    run: WorkflowRunRow,
    node: WorkflowNode,
    row: NodeRunRow,
    result: StepResult,
    state: Live,
  ): StepResult {
    service.finishStep(row.id, {
      // A budget that stopped the run cancelled the step working then; its error says why.
      status: state.cancelled || result.stop ? 'cancelled' : result.ok ? 'succeeded' : 'failed',
      // The route is written with the output, so a run's view can say which edges were taken.
      output: {
        ...(result.ok || result.route === 'failure' ? { value: result.output } : {}),
        route: state.cancelled || result.stop ? null : result.route,
      },
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
    control: TurnControl,
  ): Promise<StepResult> {
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
          const wake = () => {
            clearTimeout(timer);
            resolve();
          };
          state.wake = wake;
          // A limit that ran out ends the wait too.
          control.signal.addEventListener('abort', wake, { once: true });
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
        const turn = await this.ports.agentTurn(
          scope,
          {
            agentId: node.agent_id,
            prompt: rendered,
            title: node.title || node.id,
            model: node.model ?? null,
            provider: node.provider ?? null,
          },
          control,
        );
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

/** A step that waits for a person before it counts: an `approval`, or one that asks for it. */
function gated(node: WorkflowNode): boolean {
  return node.kind === 'approval' || node.approval_required === true;
}

/** A step as the contract's `WorkflowStep`. */
export function stepOf(step: NodeRunRow): Record<string, unknown> {
  return {
    node_id: step.nodeKey,
    attempt: step.attempt,
    status: step.status,
    session_id: null,
    run_id: step.runId,
    approval_id: step.approvalId,
    output: outputText(step),
    route: routeOf(step),
    error: step.error,
    started_at: step.startedAt?.toISOString() ?? null,
    finished_at: step.finishedAt?.toISOString() ?? null,
  };
}

/** The contract's cap on a step's `output`: enough to read, not a megabyte per step. */
const MAX_STEP_OUTPUT = 20_000;

/** What a finished step produced, as text (`WorkflowStep.output`); `null` before it ends. */
function outputText(step: NodeRunRow): string | null {
  const stored = step.output as { value?: unknown } | null;
  if (!stored || !('value' in stored) || stored.value === null || stored.value === undefined) {
    return null;
  }
  const value = stored.value;
  let text: string;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
  else {
    try {
      text = JSON.stringify(value) ?? '';
    } catch {
      text = '';
    }
  }
  return text.length > MAX_STEP_OUTPUT ? `${text.slice(0, MAX_STEP_OUTPUT)}…` : text;
}

/**
 * Which edges a finished step follows (`WorkflowStep.route`). Steps finished before the
 * route was written down read it from their status: a success, or a failure.
 */
function routeOf(step: NodeRunRow): 'success' | 'failure' | null {
  const stored = (step.output as { route?: unknown } | null)?.route;
  if (stored === 'success' || stored === 'failure') return stored;
  if (step.status === 'succeeded') {
    // A condition's "no" is a success whose value is `false`.
    const value = (step.output as { value?: unknown } | null)?.value;
    return step.nodeType === 'condition' && value === false ? 'failure' : 'success';
  }
  if (step.status === 'failed') return 'failure';
  return null;
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
