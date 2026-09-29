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
import {
  ConditionError,
  evaluate,
  evaluateRules,
  hasRules,
  parseCondition,
  render,
  rulesText,
  type Context,
} from './expr.js';
import { NO_LIMITS, dollars, duration, microUsdOf, moneyOfMicro } from './limits.js';
import {
  chatIdOf,
  hasSend,
  resultOf,
  splitMessage,
  targetKey,
  telegramSend,
  withoutToken,
  type SendResult,
} from './send.js';
import type {
  WorkflowBudgetUse,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowLimits,
  WorkflowNode,
  WorkflowSend,
} from './schema.js';
import type { Sealer } from './trigger-desk.js';
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

/**
 * Where a "Send message" step's words go (DECISIONS §124), lent by the composition root:
 * Telegram through the profile's own bot, and a Core Hub conversation through `sessions`.
 */
export interface MessagePorts {
  /** The Hermes profile's `TELEGRAM_BOT_TOKEN`; `null` when it has no bot. */
  telegramToken(scope: Scope): string | null;
  /** Telegram's Bot API origin (a test hub points it at a fake). */
  telegramApi: string;
  fetch: typeof fetch;
  /**
   * Post the words into a conversation. When it no longer exists, a new one is made under
   * `title` with `agentId` and the words go there (`recreated`).
   */
  post(
    scope: RunScope,
    input: { sessionId: string | null; title: string | null; agentId: string | null; text: string },
  ): Promise<{ sessionId: string; messageId: string; recreated: boolean; title: string | null }>;
}

/** What a send remembers so a step tried again does not send twice; `null` sends every time. */
export interface SentMemory {
  seen(target: string, part: number): string | null;
  keep(target: string, part: number, messageId: string): void;
}

/**
 * What happened at one target of a send, for the hub's log (never the bot token or the
 * words): the platform, where, whether it went, the platform's ids, and why not.
 */
export interface SendReport {
  platform: string;
  target: string;
  chat_id: string | null;
  session_id: string | null;
  status: 'sent' | 'failed';
  message_ids: string[];
  error_code: string | null;
  error: string | null;
}

/** A log line's fields for one target of a send (`report` of `deliverSend`). */
export function sendLogFields(report: SendReport): Record<string, unknown> {
  return {
    platform: report.platform,
    target: report.target,
    ...(report.chat_id !== null ? { chat_id: report.chat_id } : {}),
    ...(report.session_id !== null ? { session_id: report.session_id } : {}),
    status: report.status,
    ...(report.message_ids.length > 0
      ? { message_id: report.message_ids[0], message_ids: report.message_ids }
      : {}),
    ...(report.error !== null ? { error_code: report.error_code, error: report.error } : {}),
  };
}

/**
 * Send the words to every target of a "Send message" step (or of its test): each target on
 * its own, a failure of one never stopping another, and the result says exactly what went.
 * `report` hears each target's outcome, for the hub's log.
 */
export async function deliverSend(
  messages: MessagePorts | null | undefined,
  scope: RunScope,
  send: WorkflowSend,
  text: string,
  memory: SentMemory | null,
  moved: (from: string | null, to: { sessionId: string; title: string | null }) => void,
  report: (entry: SendReport) => void = () => undefined,
): Promise<{ result: SendResult; notes: string[] }> {
  const delivered: Array<{ target: string; ids: string[] }> = [];
  const failures: Array<{ target: string; reason: string }> = [];
  const notes: string[] = [];
  const tell = (entry: SendReport) => {
    try {
      report(entry);
    } catch {
      // A log line never changes what was sent.
    }
  };
  const failed = (
    target: WorkflowSend['targets'][number],
    key: string,
    code: string,
    reason: string,
  ) => {
    failures.push({ target: key, reason });
    tell({
      platform: String(target.platform),
      target: key,
      chat_id: target.platform === 'telegram' ? chatIdOf(target.chat_id) : null,
      session_id: target.platform === 'core_hub' ? (target.session_id ?? null) : null,
      status: 'failed',
      message_ids: [],
      error_code: code,
      error: reason,
    });
  };
  for (const target of send.targets) {
    const key = targetKey(target);
    if (!messages) {
      failed(target, key, 'no_messages', 'this hub cannot send messages');
      continue;
    }
    if (target.platform === 'telegram') {
      const chat = chatIdOf(target.chat_id);
      if (!chat) {
        failed(target, key, 'no_chat_id', 'no chat id');
        continue;
      }
      let token: string | null;
      try {
        token = messages.telegramToken(scope);
      } catch (error) {
        const said = error instanceof Error ? error.message : String(error);
        failed(
          target,
          key,
          'token_unreadable',
          `the profile's Telegram bot could not be read (${said})`,
        );
        continue;
      }
      if (!token) {
        failed(
          target,
          key,
          'no_bot',
          'this profile has no Telegram bot (TELEGRAM_BOT_TOKEN in its .env)',
        );
        continue;
      }
      const ids: string[] = [];
      let refusal: { code: string; reason: string } | null = null;
      const parts = splitMessage(text);
      for (let part = 0; part < parts.length; part += 1) {
        const before = memory?.seen(key, part) ?? null;
        if (before) {
          ids.push(before);
          continue;
        }
        const answer = await telegramSend(
          messages.fetch,
          messages.telegramApi,
          token,
          chat,
          parts[part]!,
        );
        if (!answer.ok) {
          refusal = {
            code: answer.code,
            reason:
              parts.length > 1
                ? `part ${part + 1} of ${parts.length}: ${answer.reason}`
                : answer.reason,
          };
          break;
        }
        memory?.keep(key, part, answer.messageId);
        ids.push(answer.messageId);
      }
      if (refusal) {
        failed(target, key, refusal.code, withoutToken(refusal.reason, token));
      } else {
        delivered.push({ target: key, ids });
        tell({
          platform: 'telegram',
          target: key,
          chat_id: chat,
          session_id: null,
          status: 'sent',
          message_ids: ids,
          error_code: null,
          error: null,
        });
      }
      continue;
    }
    if (target.platform === 'core_hub') {
      const before = memory?.seen(key, 0) ?? null;
      if (before) {
        delivered.push({ target: key, ids: [before] });
        continue;
      }
      try {
        const posted = await messages.post(scope, {
          sessionId: target.session_id ?? null,
          title: target.title ?? null,
          agentId: target.agent_id ?? null,
          text,
        });
        memory?.keep(key, 0, posted.messageId);
        if (posted.recreated || posted.sessionId !== (target.session_id ?? null)) {
          moved(target.session_id ?? null, { sessionId: posted.sessionId, title: posted.title });
          if (target.session_id) {
            notes.push(
              `The conversation "${posted.title ?? ''}" no longer existed: a new one with the same title was made, the message was posted there, and the step now sends to it.`,
            );
          }
        }
        const where = `core_hub:${posted.sessionId}`;
        delivered.push({ target: where, ids: [posted.messageId] });
        tell({
          platform: 'core_hub',
          target: where,
          chat_id: null,
          session_id: posted.sessionId,
          status: 'sent',
          message_ids: [posted.messageId],
          error_code: null,
          error: null,
        });
      } catch (error) {
        failed(target, key, 'post_failed', error instanceof Error ? error.message : String(error));
      }
      continue;
    }
    failed(target, key, 'platform_unknown', `this hub cannot send to "${target.platform}"`);
  }
  return { result: resultOf(delivered, failures), notes };
}

/** What trying one step on its own did (`WorkflowStepTestResult`, §127). */
export interface StepTestResult {
  rendered: string | null;
  answer: boolean | null;
  output: string | null;
  error: string | null;
  executed: boolean;
}

/**
 * One step tried with a sample (§127): nothing is saved and no run is made. A condition
 * answers; a template is rendered; an agent step runs a real turn only when asked to; a
 * "Send message" step is only rendered — its own "Send test message" is what sends.
 */
export async function testStep(
  ports: WorkflowPorts,
  scope: RunScope,
  node: WorkflowNode,
  ctx: Context,
  execute: boolean,
): Promise<StepTestResult> {
  const base: StepTestResult = {
    rendered: null,
    answer: null,
    output: null,
    error: null,
    executed: false,
  };
  let rendered: string | null = null;
  try {
    if (node.kind === 'condition') {
      rendered = hasRules(node.rules) ? rulesText(node.rules) : (node.input ?? '');
      const answer = hasRules(node.rules)
        ? evaluateRules(node.rules, ctx)
        : evaluate(parseCondition(rendered), ctx);
      return { ...base, rendered, answer, output: String(answer), executed: true };
    }
    rendered = render(node.input ?? '', ctx);
    if (node.kind === 'delay') {
      const seconds = Number(rendered.trim());
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_DELAY_SECONDS) {
        return {
          ...base,
          rendered,
          error: `"${rendered}" is not 0 to ${MAX_DELAY_SECONDS} seconds`,
        };
      }
      return { ...base, rendered, output: String(seconds) };
    }
    if (node.kind !== 'agent' || !execute) return { ...base, rendered };
    if (!node.agent_id) return { ...base, rendered, error: 'this step names no agent' };
    if (!rendered.trim())
      return { ...base, rendered, error: 'this step has no prompt for the agent' };
    if (!ports.agentTurn) return { ...base, rendered, error: 'this hub cannot run an agent' };
    const turn = await ports.agentTurn(scope, {
      agentId: node.agent_id,
      prompt: rendered,
      title: `${node.title || node.id} (test)`,
      model: node.model ?? null,
      provider: node.provider ?? null,
    });
    return {
      ...base,
      rendered,
      output: turn.output,
      error:
        turn.status === 'succeeded' ? null : (turn.error ?? `the agent's run ended ${turn.status}`),
      executed: true,
    };
  } catch (error) {
    return {
      ...base,
      rendered,
      error:
        error instanceof ConditionError
          ? error.reason
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
}

/** What the engine needs from the rest of the hub. Composed in `modules/index.ts`. */
export interface WorkflowPorts {
  /** Where a "Send message" step's words go (§124); absent, such a step fails saying so. */
  messages?: MessagePorts | null;
  /**
   * The hub's data key ring, lent to seal an inbound trigger's secret (§123). Absent, a
   * trigger cannot store a secret and every delivery is refused.
   */
  sealer?: Sealer | null;
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
      /** A run a trigger's delivery started: the trigger and the event's ids (§123). */
      event?: { triggerId: string; eventId: string | null; taskId: string | null };
    },
  ): WorkflowRunRow {
    const run = service.createWorkflowRun(scope, workflow, {
      input: { trigger: options.trigger ?? null, input: options.input },
      triggerKind: options.triggerKind,
      triggerRef: options.triggerRef ?? null,
      scheduleId: options.scheduleId ?? null,
      ...(options.limits ? { limits: options.limits } : {}),
      ...(options.event ? { event: options.event } : {}),
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
    // A condition that said no with nothing to follow: the event was not one to act on (§123).
    let filtered = false;

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
      let followed = 0;
      for (const edge of edges) {
        if (edge.route === 'always' || edge.route === result.route) {
          queue.push(edge.to);
          followed += 1;
        }
      }
      if (node.kind === 'condition' && result.ok && result.route === 'failure' && followed === 0) {
        filtered = true;
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
        ...(filtered && !failed ? { filtered: true } : {}),
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
    if (failed) await this.alertFailure(service, scope, run, failed);
  }

  /**
   * A run failed: whoever its workflow says is told (§127) — the run owner's inbox, and the
   * targets of its alert (Telegram, a conversation), sent once for the run.
   */
  private async alertFailure(
    service: SchedulesService,
    scope: RunScope,
    run: WorkflowRunRow,
    error: string,
  ): Promise<void> {
    const alert = (run.definitionSnapshot as WorkflowDefinition).onFailure;
    if (!alert) return;
    const name = service.workflowById(run.workflowId)?.name ?? 'Workflow';
    const text = `${name}: the run failed.\n${error}`;
    try {
      if (alert.inbox && this.ports.notice) {
        this.ports.notice(scope, { title: `${name}: run failed`, body: error });
      }
      if (alert.send && hasSend(alert.send)) {
        const runKey = service.rootRunOf(run);
        await deliverSend(
          this.ports.messages,
          scope,
          alert.send,
          text,
          {
            seen: (target, part) => service.sentPart(runKey, '__on_failure', target, part),
            keep: (target, part, id) =>
              service.recordSent(run, { runKey, nodeKey: '__on_failure', target, part }, id),
          },
          () => undefined,
          (report) => this.logSend(scope, run, '__on_failure', report),
        );
      }
    } catch (failure) {
      this.log.warn({ err: failure, workflowRunId: run.id }, 'workflow: failure alert failed');
    }
  }

  private async step(
    service: SchedulesService,
    scope: RunScope,
    run: WorkflowRunRow,
    node: WorkflowNode,
    ctx: Context,
    state: Live,
  ): Promise<StepResult> {
    const rendered =
      node.kind === 'condition'
        ? hasRules(node.rules)
          ? rulesText(node.rules)
          : (node.input ?? '')
        : render(node.input ?? '', ctx);
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

    const work = this.perform(service, run, scope, node, rendered, ctx, state, control).catch(
      (error: unknown) => fail(error instanceof Error ? error.message : String(error)),
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

  /**
   * A "Send message" step (§124): the words to each target, each part remembered by the run
   * (a rerun counts as its first run), the node and the target, so trying again sends only
   * what did not go. Every target failing fails the step; any failure, or a conversation made
   * again, is also said in the run owner's inbox.
   */
  private async send(
    service: SchedulesService,
    run: WorkflowRunRow,
    scope: RunScope,
    node: WorkflowNode,
    send: WorkflowSend,
    rendered: string,
  ): Promise<StepResult> {
    const text = rendered.trim();
    if (!text) return fail('the message has no words');
    const runKey = service.rootRunOf(run);
    const memory: SentMemory = {
      seen: (target, part) => service.sentPart(runKey, node.id, target, part),
      keep: (target, part, id) =>
        service.recordSent(run, { runKey, nodeKey: node.id, target, part }, id),
    };
    const { result, notes } = await deliverSend(
      this.ports.messages,
      scope,
      send,
      text,
      memory,
      (from, to) => service.repointConversation(run.workflowId, node.id, from, to),
      (report) => this.logSend(scope, run, node.id, report),
    );
    const title = node.title || 'Send message';
    const said = [
      ...notes,
      ...result.failures.map((failure) => `${failure.target}: ${failure.reason}`),
    ];
    if (said.length > 0 && this.ports.notice) {
      try {
        this.ports.notice(scope, {
          title: result.status === 'failed' ? `${title}: not sent` : title,
          body: said.join('\n'),
        });
      } catch (error) {
        this.log.warn({ err: error, workflowRunId: run.id }, 'workflow: send notice failed');
      }
    }
    if (result.status === 'failed') {
      return {
        ...fail(
          result.failures.map((failure) => `${failure.target}: ${failure.reason}`).join('; ') ||
            'not sent',
        ),
        output: result,
      };
    }
    return succeed(result);
  }

  /** One log line per target a run's send reached (§124): where, what came of it, never the token. */
  private logSend(scope: RunScope, run: WorkflowRunRow, nodeId: string, report: SendReport): void {
    const fields = {
      workflow_id: run.workflowId,
      workflow_run_id: run.id,
      node_id: nodeId,
      profile: scope.profile,
      test: false,
      ...sendLogFields(report),
    };
    if (report.status === 'sent') this.log.info(fields, 'workflow send');
    else this.log.warn(fields, 'workflow send failed');
  }

  private async perform(
    service: SchedulesService,
    run: WorkflowRunRow,
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
          // Several rules when the step has them (§123), else the one comparison.
          answer = hasRules(node.rules)
            ? evaluateRules(node.rules, ctx)
            : evaluate(parseCondition(rendered), ctx);
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
        if (hasSend(node.send)) return this.send(service, run, scope, node, node.send, rendered);
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
