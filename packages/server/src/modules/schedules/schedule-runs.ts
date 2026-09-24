/**
 * Firing one of the hub's own schedules: what happens when its time comes, or when a
 * person presses "Run now".
 *
 * The run is the one a person would start by hand:
 *
 * - an `agent_prompt` target opens a session of source `schedule` (its origin the history
 *   line, a `schedule_run`) in the schedule's profile, as the schedule's owner, and queues one run whose
 *   prompt is the schedule's — an ordinary conversation, in the ordinary per-session folder
 *   under `/data/workspaces/<profile>/`, that the history line can open;
 * - a `workflow` target starts the workflow, as `runWorkflow` would, with the schedule and
 *   the tick in `{{trigger}}`.
 *
 * Every firing is a line in the history, written before anything starts (the scheduler's
 * claim, or "Run now"), then marked with what it started, then settled once with how it
 * ended. A target that cannot start — the agent is not installed or cannot run, the
 * workflow is gone or empty — settles the line as failed with the reason, never as a run
 * that silently did not happen.
 *
 * The follow-up of a prompt run lives in this process; the follow-up of a workflow run is
 * the engine's own ending (so a run that waits days at an approval still settles its line).
 * A hub that restarts settles, at boot, the lines it finds open (`settleStranded`).
 *
 * The schedule's `overlap` (DECISIONS §39) lives here too: a time held back while the
 * previous run goes (`wait`) starts when that run's line settles (`release`), and `replace`
 * stops the previous run for real before the next starts (`stop`).
 *
 * The session run belongs to `sessions`: this file reaches it only through
 * `ScheduleRunPorts`, filled in the composition root (`modules/index.ts`).
 */
import type { FastifyBaseLogger } from 'fastify';
import { HubError } from '../../lib/errors.js';
import type { ScheduleRow, ScheduleRunRow, SchedulesService, WorkflowRunRow } from './service.js';
import type { WorkflowDefinition } from './schema.js';
import { missedReason } from './scheduler.js';
import type { RunScope, WorkflowEngine } from './workflow-engine.js';

/** How a session run stands, as `sessions` reports it. */
export interface TurnOutcome {
  sessionId: string;
  runId: string;
  status: string;
  output: string;
  error: string | null;
  errorCode?: string | null;
}

/** What firing a prompt schedule needs from `sessions`. */
export interface ScheduleRunPorts {
  /** Open the schedule's session and queue its run; resolves once both exist. */
  start(
    scope: RunScope,
    input: {
      scheduleId: string;
      /** The history line: the session's origin (`schedule_run`), so each run is traceable. */
      scheduleRunId: string;
      agentId: string;
      prompt: string;
      title: string;
    },
  ): Promise<{ sessionId: string; runId: string; jobId: string; done: Promise<TurnOutcome> }>;
  /** A run by id, for settling after a restart; `null` when there is no such run. */
  outcome(workspace: string, runId: string): TurnOutcome | null;
  /** Stop a run the way the chat's Stop does; a run already over is nothing to stop. */
  cancel(scope: RunScope, sessionId: string, runId: string): Promise<void>;
}

/** What a firing started — the ids `runNow` answers with. */
export interface Fired {
  scheduleRunId: string;
  jobId: string;
  sessionId: string | null;
  runId: string | null;
  workflowRunId: string | null;
  /** Why the target could not start; the line is already settled as failed. */
  error: string | null;
}

export interface ScheduleRunsDeps {
  service: () => SchedulesService;
  ports: () => ScheduleRunPorts | null;
  engine: () => WorkflowEngine;
  /** The schedule's owner, in the schedule's profile; `null` when either is gone. */
  scopeOf: (workspace: string, userId: string) => RunScope | null;
  /** A workspace's profile slug, for the realtime room. */
  profileOf: (workspace: string) => string | null;
  emit: (profile: string, event: string, payload: Record<string, unknown>) => void;
  /** Cancel a workflow run the way its Cancel does (`schedules.cancelWorkflowRun`). */
  cancelWorkflow: (scope: RunScope, workflowRunId: string) => void;
  /** How long `stop` waits for a stopped run to end before the next one starts. */
  stopWaitMs?: number;
  /** The contract's `Schedule` and `ScheduleRun`, as the routes render them. */
  toSchedule: (row: ScheduleRow, profile: string) => Record<string, unknown>;
  toRun: (row: ScheduleRunRow) => Record<string, unknown>;
  log: FastifyBaseLogger;
}

/** Said when a restart cut a run short; the same words as a workflow run's. */
export const RESTARTED = 'the hub restarted while this run was going';
/** Said on a run `overlap: replace` stopped. */
export const REPLACED = 'stopped: the next run of this schedule replaced it';
/** Said on a waiting time a restart ended, when the schedule does not run a missed time. */
export const WAIT_CUT = 'missed: the hub restarted while this time was waiting';
/** Said on a waiting time whose schedule was paused, archived or replaced meanwhile. */
export const WAIT_PAUSED = 'skipped: the schedule was paused while this time was waiting';
const WAIT_REPLACED = 'skipped: a newer run of this schedule replaced the waiting time';
/** How long `stop` waits for a stopped run to end. */
const STOP_WAIT_MS = 30_000;

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

/** A target that cannot start, in words a person can act on. */
class Unrunnable extends Error {}

export class ScheduleRuns {
  /** The follow-up of each prompt run started in this process, by history line. */
  private readonly live = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: ScheduleRunsDeps) {}

  /**
   * Start what the schedule runs, for a history line already written. Resolves once the
   * run has started (the ids are real), not when it ends.
   */
  async fire(schedule: ScheduleRow, line: ScheduleRunRow): Promise<Fired> {
    const service = this.deps.service();
    const profile = this.deps.profileOf(schedule.workspace);
    const current = service.scheduleById(schedule.id) ?? schedule;
    if (profile) {
      this.deps.emit(profile, 'schedule.fired', {
        schedule: this.deps.toSchedule(current, profile),
        schedule_run_id: line.id,
      });
    }
    const fired: Fired = {
      scheduleRunId: line.id,
      jobId: line.id,
      sessionId: null,
      runId: null,
      workflowRunId: null,
      error: null,
    };
    try {
      const scope = this.deps.scopeOf(schedule.workspace, schedule.ownerId);
      if (!scope) throw new Unrunnable("the schedule's owner or profile no longer exists");
      if (schedule.targetKind === 'workflow') {
        const workflow = schedule.workflowId
          ? service.workflowById(schedule.workflowId)
          : undefined;
        if (!workflow || workflow.workspace !== schedule.workspace || workflow.archivedAt) {
          throw new Unrunnable('the workflow this schedule runs no longer exists');
        }
        if ((workflow.definition as WorkflowDefinition).nodes.length === 0) {
          throw new Unrunnable('the workflow this schedule runs has no steps');
        }
        const run = this.deps.engine().start(service, scope, workflow, {
          trigger: {
            schedule_id: schedule.id,
            schedule_run_id: line.id,
            scheduled_for: line.scheduledFor.toISOString(),
          },
          input: null,
          triggerKind: 'schedule',
          triggerRef: line.id,
          scheduleId: schedule.id,
        });
        this.started(line.id, { workflowRunId: run.id });
        return { ...fired, jobId: run.id, workflowRunId: run.id };
      }
      if (!schedule.agentId) throw new Unrunnable('the schedule names no agent');
      const prompt = schedule.prompt?.trim();
      if (!prompt) throw new Unrunnable('the schedule has no prompt');
      const ports = this.deps.ports();
      if (!ports) throw new Unrunnable('this hub cannot run an agent');
      const handle = await ports.start(scope, {
        scheduleId: schedule.id,
        scheduleRunId: line.id,
        agentId: schedule.agentId,
        prompt,
        title: schedule.name,
      });
      this.started(line.id, { runId: handle.runId, sessionId: handle.sessionId });
      const followed = handle.done
        .then(
          (outcome) => this.settleTurn(line.id, outcome),
          (error: unknown) => {
            this.settle(line.id, { status: 'failed', error: String(error) });
          },
        )
        .finally(() => this.live.delete(line.id));
      this.live.set(line.id, followed);
      return {
        ...fired,
        jobId: handle.jobId,
        sessionId: handle.sessionId,
        runId: handle.runId,
      };
    } catch (error) {
      const reason = reasonOf(error);
      this.deps.log.warn({ err: error, scheduleId: schedule.id }, 'schedules: could not start');
      this.settle(line.id, { status: 'failed', error: reason });
      return { ...fired, error: reason };
    }
  }

  /** A skipped tick is history too: the schedule moved on, and the page says why. */
  skipped(schedule: ScheduleRow): void {
    const profile = this.deps.profileOf(schedule.workspace);
    const current = this.deps.service().scheduleById(schedule.id);
    if (profile && current) {
      this.deps.emit(profile, 'schedule.updated', {
        schedule: this.deps.toSchedule(current, profile),
      });
    }
  }

  /**
   * A tick claimed to wait for the previous run (`overlap: wait`). The page hears of it;
   * and if that run ended between the look and the claim, the wait is over at once.
   */
  async waiting(schedule: ScheduleRow): Promise<void> {
    this.skipped(schedule);
    await this.release(schedule.id);
  }

  /**
   * The schedule's previous runs have ended: start the time waiting for them, if one is and
   * none is still going. Taken with a compare-and-set, so it starts once. A schedule paused
   * or archived meanwhile does not start it: the line says why.
   */
  async release(scheduleId: string, now: Date = new Date()): Promise<Fired | null> {
    const service = this.deps.service();
    const waiting = service.waitingRunOf(scheduleId);
    if (!waiting || service.openRunsOf(scheduleId).length > 0) return null;
    const schedule = service.scheduleById(scheduleId);
    if (!schedule || !schedule.enabled || schedule.archivedAt || schedule.externalSource) {
      if (service.skipLine(waiting.id, WAIT_PAUSED, now) && schedule) this.skipped(schedule);
      return null;
    }
    const line = service.takeWaiting(waiting.id, now);
    if (!line) return null;
    return this.fire(schedule, line);
  }

  /**
   * `overlap: replace`: stop the schedule's runs still going, for real, before its next one
   * starts. Each line is settled `cancelled` with the reason first (so nothing it ends with
   * later overwrites that), then its session run or workflow run is cancelled, and the stop
   * waits — up to `stopWaitMs` — for the prompt runs to end. A time waiting (left from an
   * earlier `wait`) is skipped: the new run is the one that goes.
   */
  async stop(schedule: ScheduleRow, lines: ScheduleRunRow[]): Promise<void> {
    const service = this.deps.service();
    const scope = this.deps.scopeOf(schedule.workspace, schedule.ownerId);
    const endings: Promise<unknown>[] = [];
    for (const line of lines) {
      this.settle(line.id, { status: 'cancelled', error: REPLACED }, { release: false });
      if (!scope) continue;
      try {
        if (line.workflowRunId) {
          this.deps.cancelWorkflow(scope, line.workflowRunId);
        } else if (line.runId && line.sessionId) {
          await this.deps.ports()?.cancel(scope, line.sessionId, line.runId);
          const ending = this.live.get(line.id);
          if (ending) endings.push(ending);
        }
      } catch (error) {
        this.deps.log.warn(
          { err: error, scheduleId: schedule.id, scheduleRunId: line.id },
          'schedules: could not stop the previous run',
        );
      }
    }
    const waiting = service.waitingRunOf(schedule.id);
    if (waiting && service.skipLine(waiting.id, WAIT_REPLACED)) this.skipped(schedule);
    if (endings.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.deps.stopWaitMs ?? STOP_WAIT_MS);
      timer.unref?.();
    });
    await Promise.race([Promise.allSettled(endings), limit]);
    if (timer) clearTimeout(timer);
  }

  /** A prompt run ended. */
  settleTurn(lineId: string, outcome: TurnOutcome, options: SettleOptions = {}): void {
    const status =
      outcome.status === 'succeeded'
        ? 'succeeded'
        : outcome.status === 'cancelled'
          ? 'cancelled'
          : 'failed';
    this.settle(
      lineId,
      {
        status,
        output: outcome.output || null,
        error:
          status === 'succeeded'
            ? null
            : outcome.errorCode === 'stale'
              ? RESTARTED
              : (outcome.error ?? `the run ended ${outcome.status}`),
      },
      options,
    );
  }

  /** A workflow run a schedule started reached its end (the engine's hook). */
  settleWorkflow(
    run: WorkflowRunRow,
    outcome: { status: 'succeeded' | 'failed' | 'cancelled'; error: string | null },
  ): void {
    if (run.triggerKind !== 'schedule' || !run.triggerRef) return;
    this.settle(run.triggerRef, { status: outcome.status, error: outcome.error });
  }

  /**
   * At boot: every line of the hub's own schedules still open. A prompt run is settled by
   * what its record says (sessions has already failed what the restart cut short); a
   * workflow run by its own state — one waiting at an approval stays open, because it
   * still goes on; anything that never started failed with the restart.
   */
  settleStranded(now: Date = new Date()): number {
    const service = this.deps.service();
    const ports = this.deps.ports();
    let settled = 0;
    for (const line of service.openRuns()) {
      if (line.workflowRunId) {
        const run = service.workflowRunById(line.workflowRunId);
        if (run?.status === 'waiting_approval') continue;
        if (run && TERMINAL.has(run.status)) {
          const status =
            run.status === 'succeeded'
              ? 'succeeded'
              : run.status === 'cancelled'
                ? 'cancelled'
                : 'failed';
          settled += this.settle(line.id, { status, error: run.error }, HOLD) ? 1 : 0;
          continue;
        }
        settled += this.settle(line.id, { status: 'failed', error: RESTARTED }, HOLD) ? 1 : 0;
        continue;
      }
      const outcome = line.runId && ports ? ports.outcome(line.workspace, line.runId) : null;
      if (outcome && TERMINAL.has(outcome.status)) {
        this.settleTurn(line.id, outcome, HOLD);
        settled += 1;
        continue;
      }
      settled += this.settle(line.id, { status: 'failed', error: RESTARTED }, HOLD) ? 1 : 0;
    }
    settled += this.settleWaiting(now);
    return settled;
  }

  /**
   * At boot, after the open lines: a time that was waiting for a run the restart ended. The
   * hub was not running when that wait ended, so the schedule's "run if missed" decides — the
   * same rule as a missed tick (`missedReason`): on time, or the option on and within 24
   * hours, it starts now; otherwise it is recorded as missed. One still waiting for a run
   * that goes on (a workflow at an approval) keeps waiting.
   */
  private settleWaiting(now: Date): number {
    const service = this.deps.service();
    let settled = 0;
    for (const line of service.waitingRuns()) {
      if (service.openRunsOf(line.scheduleId).length > 0) continue;
      const schedule = service.scheduleById(line.scheduleId);
      if (schedule && !missedReason(schedule, line.scheduledFor, now)) {
        void this.release(line.scheduleId, now).catch((error: unknown) =>
          this.deps.log.warn({ err: error, scheduleRunId: line.id }, 'schedules: could not start'),
        );
        continue;
      }
      if (service.skipLine(line.id, WAIT_CUT, now)) {
        settled += 1;
        if (schedule) this.skipped(schedule);
      }
    }
    return settled;
  }

  private started(
    lineId: string,
    what: { runId?: string; sessionId?: string; workflowRunId?: string },
  ): void {
    const service = this.deps.service();
    const line = service.markRunStarted(lineId, what);
    const profile = this.deps.profileOf(line.workspace);
    if (profile && line.status === 'running') {
      this.deps.emit(profile, 'schedule_run.started', { schedule_run: this.deps.toRun(line) });
    }
  }

  /**
   * Write the ending once and tell the page; `false` when the line had already ended. Then,
   * unless told to hold, a time waiting for this run starts (`release`).
   */
  private settle(
    lineId: string,
    outcome: {
      status: 'succeeded' | 'failed' | 'cancelled';
      output?: string | null;
      error?: string | null;
    },
    options: SettleOptions = {},
  ): boolean {
    const service = this.deps.service();
    const result = service.settleRun(lineId, outcome);
    if (!result) return false;
    const profile = this.deps.profileOf(result.run.workspace);
    if (profile) {
      this.deps.emit(
        profile,
        outcome.status === 'succeeded' ? 'schedule_run.completed' : 'schedule_run.failed',
        { schedule_run: this.deps.toRun(result.run) },
      );
      this.deps.emit(profile, 'schedule.updated', {
        schedule: this.deps.toSchedule(result.schedule, profile),
      });
    }
    if (options.release !== false) {
      void this.release(result.run.scheduleId).catch((error: unknown) =>
        this.deps.log.warn(
          { err: error, scheduleId: result.run.scheduleId },
          'schedules: could not start the waiting time',
        ),
      );
    }
    return true;
  }
}

interface SettleOptions {
  /** `false`: do not start a time waiting for this run (a stop, or the boot sweep). */
  release?: boolean;
}
const HOLD: SettleOptions = { release: false };

/** Why a start failed, in words — a registry refusal named by what it means. */
function reasonOf(error: unknown): string {
  if (error instanceof Unrunnable) return error.message;
  if (error instanceof HubError) {
    if (error.code === 'not_found') return 'the agent this schedule names is not installed';
    if (error.code === 'agent_unavailable') {
      const status = (error.details as { status?: unknown } | undefined)?.status;
      return `the agent cannot run right now${typeof status === 'string' ? ` (${status})` : ''}`;
    }
    return error.message || error.code;
  }
  return error instanceof Error ? error.message : String(error);
}
