/**
 * Module `schedules`: when something should happen, and what.
 *
 * Every operation answers. A schedule for Hermes lives in Hermes's own scheduler, which
 * fires it (`hermes-cron.ts`); every other schedule — a `direct` agent, a coding agent, a
 * workflow — is fired by the hub itself (`scheduler.ts` claims the tick, `schedule-runs.ts`
 * starts it), and `runNow` starts that same run at once and answers with its real ids.
 * Workflows run step by step (`workflow-engine.ts`), and a step can wait for a person: an
 * ordinary approval, answered through `/approvals/{id}/respond`, that survives a restart.
 *
 * A cron expression the hub cannot evaluate is refused **when the schedule is saved**,
 * with the field and the reason. A schedule that looks fine and never fires is the failure
 * that makes people stop trusting schedulers.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Server as SocketServer } from 'socket.io';
import { loadOpenApiDocument } from '@corehub/contracts';
import { newUlid } from '../../db/ids.js';
import { createContractIndex } from '../../lib/contract.js';
import { requireSqlite } from '../../lib/db.js';
import { conflict, HubError, notFound } from '../../lib/errors.js';
import { defineModule, REALTIME_NAMESPACES } from '../../lib/module.js';
import { clampLimit, decodeCursor, pageOf } from '../../lib/pagination.js';
import { createRealtime, type Realtime } from '../../lib/realtime.js';
import { defineRoute } from '../../lib/route.js';
import {
  defaultWorkspace,
  findUser,
  listWorkspacesFor,
  requireRole,
  requireUser,
  requireWorkspace,
} from '../auth/index.js';
import {
  SchedulesService,
  validateDefinition,
  warningsFor,
  type ScheduleRow,
  type Scope,
  type WorkflowRunRow,
} from './service.js';
import type { WorkflowDefinition } from './schema.js';
import { HermesCron, refusedByHermesCron, type HermesCronPort } from './hermes-cron.js';
import {
  WorkflowEngine,
  costOf,
  stepOf,
  stoppedByOf,
  type RunScope,
  type WorkflowPorts,
} from './workflow-engine.js';
import { NO_LIMITS, runLimits } from './limits.js';
import { ScheduleRuns, type ScheduleRunPorts } from './schedule-runs.js';
import { HubScheduler } from './scheduler.js';

export { SchedulesService, validateDefinition, warningsFor } from './service.js';
export type { Scope } from './service.js';
export { nextRunAt, parseCron, nextCron, CronError } from './cron.js';
export type { ScheduleRunPorts, TurnOutcome } from './schedule-runs.js';
export { MISSED_GRACE_MS } from './scheduler.js';

function scopeOf(request: FastifyRequest): Scope {
  const workspace = request.workspace;
  const principal = request.principal;
  if (!workspace || !principal) throw new HubError('internal', { message: 'route has no scope' });
  return { workspace: workspace.id, profile: workspace.slug, userId: principal.user.id };
}

function serviceOf(request: FastifyRequest): SchedulesService {
  return new SchedulesService(requireSqlite(request.server.hub.database));
}

/**
 * Hermes's scheduler, reflected (`hermes-cron.ts`). The port comes from the composition
 * root, the only place allowed to put `agents` (which knows where Hermes is) and
 * `schedules` together. Without one every schedule is the hub's own, as before.
 */
let hermesCronFactory: ((app: FastifyInstance) => HermesCronPort) | null = null;
export function registerHermesCron(
  factory: ((app: FastifyInstance) => HermesCronPort) | null,
): ((app: FastifyInstance) => HermesCronPort) | null {
  const previous = hermesCronFactory;
  hermesCronFactory = factory;
  return previous;
}
const crons = new WeakMap<SocketServer, HermesCron | null>();
function cronOf(app: FastifyInstance): HermesCron | null {
  if (crons.has(app.hub.io)) return crons.get(app.hub.io) ?? null;
  const cron = hermesCronFactory ? new HermesCron(hermesCronFactory(app)) : null;
  crons.set(app.hub.io, cron);
  return cron;
}

/** Hermes keeps one scheduler per home, and the hub has one Hermes home: the default workspace. */
async function syncHermes(
  request: FastifyRequest,
  service: SchedulesService,
  home: Scope,
): Promise<void> {
  const cron = cronOf(request.server);
  if (!cron) return;
  const report = await cron
    .sync(service, home)
    .catch((error: unknown) => ({ error: String(error) }));
  if (report?.error) request.log.warn({ err: report.error }, 'schedules: Hermes cron sync');
}

/**
 * What a workflow step reaches outside this module — an agent turn (`sessions`) and the
 * inbox (`notify`) — composed in `modules/index.ts`. Without it, agent and notify steps
 * fail saying the hub cannot do them; conditions and delays still run.
 */
let workflowPortsFactory: ((app: FastifyInstance) => WorkflowPorts) | null = null;
export function registerWorkflowPorts(
  factory: ((app: FastifyInstance) => WorkflowPorts) | null,
): ((app: FastifyInstance) => WorkflowPorts) | null {
  const previous = workflowPortsFactory;
  workflowPortsFactory = factory;
  return previous;
}
const engines = new WeakMap<SocketServer, WorkflowEngine>();
/** The app's engine; the first use also fails the runs a restart cut short. */
export function workflowEngineFor(app: FastifyInstance): WorkflowEngine {
  const existing = engines.get(app.hub.io);
  if (existing) return existing;
  const engine = new WorkflowEngine(
    workflowPortsFactory?.(app) ?? { agentTurn: null, notice: null },
    (profile, event, payload) =>
      realtimeOf(app).emit(REALTIME_NAMESPACES.schedules, event, { profile }, payload),
    app.log,
    // A run a schedule started settles its history line when it ends — hours later, after
    // an approval, or after a restart: whenever that is.
    (run, outcome) => firerFor(app).settleWorkflow(run, outcome),
  );
  engines.set(app.hub.io, engine);
  const stale = new SchedulesService(requireSqlite(app.hub.database)).failInterruptedRuns();
  if (stale > 0) app.log.warn({ runs: stale }, 'workflows: runs left by a restart failed');
  return engine;
}

/**
 * What firing a prompt schedule reaches in `sessions` — a session of source `schedule`
 * and its run — composed in `modules/index.ts`. Without it, a prompt schedule's run fails
 * saying the hub cannot run an agent; workflow schedules still run.
 */
let scheduleRunnerFactory: ((app: FastifyInstance) => ScheduleRunPorts | null) | null = null;
export function registerScheduleRunner(
  factory: ((app: FastifyInstance) => ScheduleRunPorts | null) | null,
): ((app: FastifyInstance) => ScheduleRunPorts | null) | null {
  const previous = scheduleRunnerFactory;
  scheduleRunnerFactory = factory;
  return previous;
}

/**
 * Who a scheduled run acts as: the schedule's owner, in the schedule's profile and the
 * owner's own language — nobody's request is there to say otherwise.
 */
function runScopeFor(app: FastifyInstance, workspace: string, userId: string): RunScope | null {
  const db = requireSqlite(app.hub.database);
  const row = listWorkspacesFor(db, { id: '', role: 'owner' }).find((w) => w.id === workspace);
  const user = findUser(db, userId);
  if (!row || !user) return null;
  return {
    workspace: row.id,
    profile: row.slug,
    userId: user.id,
    userName: user.username,
    language: user.locale === 'en' ? 'en' : 'ar',
  };
}

function profileOf(app: FastifyInstance, workspace: string): string | null {
  const db = requireSqlite(app.hub.database);
  return (
    listWorkspacesFor(db, { id: '', role: 'owner' }).find((w) => w.id === workspace)?.slug ?? null
  );
}

const firers = new WeakMap<SocketServer, ScheduleRuns>();
/** The app's firing of its own schedules (`schedule-runs.ts`). */
export function firerFor(app: FastifyInstance): ScheduleRuns {
  const existing = firers.get(app.hub.io);
  if (existing) return existing;
  const created = new ScheduleRuns({
    service: () => new SchedulesService(requireSqlite(app.hub.database)),
    ports: () => scheduleRunnerFactory?.(app) ?? null,
    engine: () => workflowEngineFor(app),
    scopeOf: (workspace, userId) => runScopeFor(app, workspace, userId),
    profileOf: (workspace) => profileOf(app, workspace),
    emit: (profile, event, payload) =>
      realtimeOf(app).emit(REALTIME_NAMESPACES.schedules, event, { profile }, payload),
    cancelWorkflow: (scope, workflowRunId) => {
      cancelWorkflowRunNow(
        app,
        new SchedulesService(requireSqlite(app.hub.database)),
        scope,
        workflowRunId,
      );
    },
    toSchedule: (row, profile) =>
      toSchedule(
        row,
        profile,
        new SchedulesService(requireSqlite(app.hub.database)).shownNext(row),
      ),
    toRun: (row) => toScheduleRun(row, { full: false }),
    log: app.log,
  });
  firers.set(app.hub.io, created);
  return created;
}

const schedulers = new WeakMap<SocketServer, HubScheduler>();
/** The app's scheduler; started when the hub is ready, stopped when it closes. */
export function schedulerFor(app: FastifyInstance): HubScheduler {
  const existing = schedulers.get(app.hub.io);
  if (existing) return existing;
  const created = new HubScheduler({
    service: () => new SchedulesService(requireSqlite(app.hub.database)),
    fire: (schedule, line) => firerFor(app).fire(schedule, line),
    skipped: (schedule) => firerFor(app).skipped(schedule),
    waiting: (schedule) => firerFor(app).waiting(schedule),
    stop: (schedule, lines) => firerFor(app).stop(schedule, lines),
    log: app.log,
  });
  schedulers.set(app.hub.io, created);
  return created;
}

/**
 * The paused-workflow half of an approval (`sessions` records the answer, then hands it
 * here through the composition root): the run goes on as its owner, from where it stopped.
 */
export function workflowGateFor(app: FastifyInstance) {
  return {
    async resolve(input: {
      workspace: string;
      workflowRunId: string;
      nodeId: string;
      approved: boolean;
      answer: string | null;
      respondedBy: { id: string; name: string };
    }): Promise<void> {
      const service = new SchedulesService(requireSqlite(app.hub.database));
      const run = service.workflowRunById(input.workflowRunId);
      if (!run || run.workspace !== input.workspace) return;
      const scope = runScopeFor(app, run.workspace, run.ownerId);
      if (!scope) return;
      const resumed = workflowEngineFor(app).resume(service, scope, run.id, {
        nodeId: input.nodeId,
        approved: input.approved,
        answer: input.answer,
        by: input.respondedBy.name,
      });
      if (!resumed) {
        app.log.warn(
          { workflowRunId: run.id },
          'workflows: an answer came for a run no longer waiting',
        );
      }
    },
  };
}

function runScopeOf(request: FastifyRequest): RunScope {
  return {
    ...scopeOf(request),
    userName: request.principal?.user.username ?? '',
    language: request.language === 'en' ? 'en' : 'ar',
  };
}

/** The steps a rerun keeps: the last successful output of every node before the restart. */
function outputsOf(
  steps: ReturnType<SchedulesService['stepsOf']>,
): Record<string, { output: unknown }> {
  const out: Record<string, { output: unknown }> = {};
  // `stepsOf` is newest first; the first success seen per node is its latest.
  for (const step of steps) {
    if (step.status === 'succeeded' && !(step.nodeKey in out)) {
      out[step.nodeKey] = { output: (step.output as { value?: unknown } | null)?.value ?? null };
    }
  }
  return out;
}

const realtimes = new WeakMap<SocketServer, Realtime>();
function realtimeOf(app: FastifyInstance): Realtime {
  const existing = realtimes.get(app.hub.io);
  if (existing) return existing;
  const created = createRealtime(app.hub.io);
  realtimes.set(app.hub.io, created);
  return created;
}

/**
 * Cancel a workflow run as its Cancel does: the row, the live walk, a gate it waits at, the
 * ending (which settles a schedule's line) and the event. The row as cancelled.
 */
function cancelWorkflowRunNow(
  app: FastifyInstance,
  service: SchedulesService,
  scope: Scope,
  workflowRunId: string,
): WorkflowRunRow {
  const row = service.cancelWorkflowRun(scope, workflowRunId);
  const engine = workflowEngineFor(app);
  engine.cancel(row.id);
  // A run waiting at a gate has nothing live to stop: its step and approval close here.
  engine.closeGates(service, scope, row.id);
  engine.announceFinished(row, { status: 'cancelled', error: null });
  realtimeOf(app).emit(
    REALTIME_NAMESPACES.schedules,
    'workflow_run.cancelled',
    { profile: scope.profile },
    { workflow_run_id: row.id, workflow_id: row.workflowId },
  );
  return row;
}

/** The contract's `Schedule`, from the row. */
function toSchedule(
  row: ReturnType<SchedulesService['get']>,
  profile: string,
  next: Date | null,
): Record<string, unknown> {
  const exhausted = row.repeatLimit !== null && row.repeatCount >= row.repeatLimit;
  return {
    id: row.id,
    profile,
    owner_id: row.ownerId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    name: row.name,
    trigger: {
      kind: row.kind,
      expression: row.cronExpr,
      every_minutes: row.intervalSeconds === null ? null : Math.round(row.intervalSeconds / 60),
      run_at: row.runAt?.toISOString() ?? null,
      timezone: row.timezone,
    },
    target: {
      kind: row.targetKind === 'workflow' ? 'workflow' : 'agent_prompt',
      agent_id: row.agentId,
      prompt: row.prompt,
      model: null,
      provider: null,
      skills: row.skills,
      workflow_id: row.workflowId,
      input: null,
    },
    delivery: {
      kind: row.delivery.channel
        ? 'channel'
        : row.delivery.roomId
          ? 'room'
          : row.delivery.notify
            ? 'notice'
            : 'none',
      room_id: row.delivery.roomId ?? null,
      channel: row.delivery.channel ?? null,
      address: row.delivery.address ?? null,
    },
    repeat: { limit: row.repeatLimit, completed: row.repeatCount },
    enabled: row.enabled,
    // Four states, and each is a fact about the row rather than a guess — for a reflection,
    // the fact is what Hermes reported.
    state: row.externalState
      ? stateOfHermes(row.externalState)
      : exhausted
        ? 'exhausted'
        : !row.enabled
          ? 'paused'
          : next
            ? 'scheduled'
            : 'paused',
    next_run_at: next?.toISOString() ?? null,
    last_run_at: row.lastRunAt?.toISOString() ?? null,
    last_status:
      row.lastStatus === 'queued' || row.lastStatus === 'running'
        ? row.lastStatus
        : (row.lastStatus ?? null),
    last_error: row.lastError,
    last_delivery_error: row.lastDeliveryError,
    // Hermes's scheduler decides both for its own jobs, and per profile, not per job
    // (`cron.catch_up_missed`, and a job still running is always skipped): nothing to set.
    run_if_missed: row.externalSource ? null : row.misfirePolicy === 'run_once',
    overlap: row.externalSource ? null : row.overlap,
    external:
      row.externalSource && row.externalId
        ? { source: row.externalSource, id: row.externalId }
        : null,
  };
}

/** Hermes's job state in the contract's four: a finished one-shot and a dead one are both done. */
function stateOfHermes(state: string): 'scheduled' | 'running' | 'paused' | 'exhausted' {
  if (state === 'running' || state === 'paused' || state === 'scheduled') return state;
  return 'exhausted';
}

function toScheduleRun(
  row: ReturnType<SchedulesService['run']>,
  options: { full: boolean },
): Record<string, unknown> {
  return {
    id: row.id,
    schedule_id: row.scheduleId,
    job_id: row.id,
    run_id: row.runId,
    session_id: row.sessionId,
    workflow_run_id: row.workflowRunId,
    // The contract has no `skipped`: a tick not run is a run that did not happen, and its
    // `error` says why.
    status: row.status === 'skipped' ? 'cancelled' : row.status,
    trigger: row.trigger,
    waiting: row.waiting,
    output_preview: row.outputPreview,
    // The full text belongs to the single-run read only, as the contract says.
    output: options.full ? row.outputPreview : null,
    output_size_bytes: row.outputPreview?.length ?? 0,
    error: row.error,
    delivery_status: 'none',
    delivery_error: null,
    started_at: row.startedAt?.toISOString() ?? null,
    finished_at: row.finishedAt?.toISOString() ?? null,
  };
}

function toWorkflow(
  row: ReturnType<SchedulesService['workflow']>,
  profile: string,
  counts: { runs: number; schedules: number; activeRunId: string | null },
): Record<string, unknown> {
  const definition = row.definition as WorkflowDefinition;
  return {
    id: row.id,
    profile,
    owner_id: row.ownerId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    name: row.name,
    description: row.description,
    working_dir: definition.workingDir ?? null,
    nodes: definition.nodes,
    edges: definition.edges,
    status: counts.activeRunId ? 'running' : 'idle',
    active_run_id: counts.activeRunId,
    run_count: counts.runs,
    schedule_count: counts.schedules,
    limits: definition.limits ?? { ...NO_LIMITS },
  };
}

function toWorkflowRun(
  row: ReturnType<SchedulesService['workflowRun']>,
  profile: string,
  steps: ReturnType<SchedulesService['stepsOf']>,
): Record<string, unknown> {
  return {
    id: row.id,
    profile,
    owner_id: row.ownerId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    workflow_id: row.workflowId,
    job_id: row.id,
    // The contract's six: a run paused at an approval (or paused at all) is `waiting`.
    status:
      row.status === 'waiting_approval' || row.status === 'paused'
        ? 'waiting'
        : row.status === 'timed_out'
          ? 'failed'
          : row.status,
    // Who or what started it (`RunTrigger`): a person, a schedule, or the API.
    trigger:
      row.triggerKind === 'schedule'
        ? { kind: 'schedule', id: row.scheduleId }
        : row.triggerKind === 'manual'
          ? { kind: 'user', id: row.ownerId }
          : { kind: 'api', id: null },
    input: (row.input as { input?: string | null } | null)?.input ?? null,
    steps: steps.map(stepOf),
    error: row.error,
    started_at: row.startedAt?.toISOString() ?? null,
    finished_at: row.finishedAt?.toISOString() ?? null,
    // The limits it ran under, what it cost so far, and which limit ended it (§53).
    limits: (row.definitionSnapshot as WorkflowDefinition).limits ?? { ...NO_LIMITS },
    cost: costOf(row.output),
    stopped_by: stoppedByOf(row.output),
  };
}

/**
 * A preview of an import, held in memory for ten minutes.
 *
 * It is not a table on purpose: a preview nobody confirmed is not a thing the hub should
 * remember across a restart, and a restart losing one costs a click.
 */
interface Preview {
  id: string;
  workspace: string;
  document: Record<string, unknown>;
  expiresAt: number;
}
const previews = new Map<string, Preview>();
const PREVIEW_TTL_MS = 10 * 60_000;

function sweepPreviews(now: number): void {
  for (const [id, preview] of previews) if (preview.expiresAt <= now) previews.delete(id);
}

/**
 * An edit to a schedule that is, or is becoming, or is ceasing to be Hermes's.
 *
 * Hermes is asked first in every case, so a refusal leaves both sides as they were:
 * - still Hermes's: the changed fields go to Hermes, then Hermes's answer is the row;
 * - moving to Hermes: saved here, then created on Hermes (and rolled back if refused);
 * - leaving Hermes: removed from Hermes, then the row is the hub's own again.
 */
async function updateThroughHermes(
  cron: HermesCron,
  service: SchedulesService,
  scope: Scope,
  current: ScheduleRow,
  patch: Record<string, unknown>,
  how: { wasHermes: boolean; willBeHermes: boolean },
): Promise<ScheduleRow> {
  const jobs = cron.jobs();
  if (!jobs) return service.update(scope, current.id, patch);
  const context = cron.contextFor(scope.workspace);
  const merged = { ...toWrite(current), ...patch };

  if (how.wasHermes && !how.willBeHermes) {
    await jobs.remove(current.externalId!).catch(refusedByHermesCron);
    service.unlinkExternal(scope, current.id);
    return service.update(scope, current.id, patch);
  }
  cron.checkWritable(merged);
  if (!how.wasHermes) {
    const saved = service.update(scope, current.id, patch);
    try {
      const job = await jobs.create(cron.jobOf(saved));
      return service.linkHermes(scope, saved.id, job, context);
    } catch (error) {
      service.update(scope, current.id, toWrite(current));
      return refusedByHermesCron(error);
    }
  }

  // Still Hermes's. Work out the row the patch would make without keeping it, so the
  // fields sent to Hermes are the hub's normalized ones.
  const preview = service.previewUpdate(scope, current.id, patch);
  const fields = cron.patchOf(patch, preview);
  let job = null;
  try {
    if (Object.keys(fields).length > 0) job = await jobs.update(current.externalId!, fields);
    if (patch.enabled !== undefined && patch.enabled !== current.enabled) {
      job = patch.enabled
        ? await jobs.resume(current.externalId!)
        : await jobs.pause(current.externalId!);
    }
  } catch (error) {
    return refusedByHermesCron(error);
  }
  const updated = service.update(scope, current.id, patch);
  return job ? (service.reflectHermes(scope, job, context)?.row ?? updated) : updated;
}

/** A row as the write body that would recreate it — for rollback and for merging a patch. */
function toWrite(row: ScheduleRow): Record<string, unknown> {
  return {
    name: row.name,
    enabled: row.enabled,
    trigger: {
      kind: row.kind,
      expression: row.cronExpr,
      every_minutes: row.intervalSeconds === null ? null : Math.round(row.intervalSeconds / 60),
      run_at: row.runAt?.toISOString() ?? null,
      timezone: row.timezone,
    },
    target: {
      kind: row.targetKind === 'workflow' ? 'workflow' : 'agent_prompt',
      agent_id: row.agentId,
      prompt: row.prompt,
      skills: row.skills,
      workflow_id: row.workflowId,
    },
    delivery: row.delivery.channel
      ? { kind: 'channel', channel: row.delivery.channel, address: row.delivery.address ?? null }
      : row.delivery.roomId
        ? { kind: 'room', room_id: row.delivery.roomId }
        : { kind: row.delivery.notify ? 'notice' : 'none' },
    repeat: { limit: row.repeatLimit },
  };
}

export const schedulesModule = defineModule({
  name: 'schedules',
  registerRoutes(app: FastifyInstance) {
    const document = loadOpenApiDocument();
    if (!document) throw new Error('packages/contracts/openapi.yaml is required (ADR 0003)');
    const deps = {
      contract: createContractIndex(document),
      guards: { requireUser, requireWorkspace, requireRole },
    };

    const announce = (request: FastifyRequest, event: string, payload: Record<string, unknown>) => {
      realtimeOf(request.server).emit(
        REALTIME_NAMESPACES.schedules,
        event,
        { profile: scopeOf(request).profile },
        payload,
      );
    };

    /**
     * The hub's own scheduler runs while the hub serves. Before it looks: workflow runs a
     * restart cut short are failed (the engine's first use), and history lines a restart
     * left open are settled — so a missed tick is judged against an honest history.
     */
    app.addHook('onReady', async () => {
      try {
        workflowEngineFor(app);
        const settled = firerFor(app).settleStranded();
        if (settled > 0)
          app.log.warn({ runs: settled }, 'schedules: settled runs a restart cut short');
      } catch (error) {
        app.log.warn({ err: error }, 'schedules: could not settle runs left open');
      }
      schedulerFor(app).start();
    });
    app.addHook('onClose', async () => {
      const scheduler = schedulerFor(app);
      scheduler.stop();
      await scheduler.settled().catch(() => undefined);
    });

    // ----------------------------------------------------------- schedules

    defineRoute(app, deps, {
      operationId: 'schedules.list',
      handler: async (request, { query }) => {
        // Global (like the Tasks board): every workspace this person may enter, each
        // schedule with its own. `profile` narrows it to one; `profiles=all` says "every
        // one" explicitly (DECISIONS §32), and the two together say two things at once.
        const principal = request.principal;
        if (!principal) throw new HubError('internal', { message: 'route has no principal' });
        const service = serviceOf(request);
        const db = requireSqlite(request.server.hub.database);
        const asked = query.profile ? String(query.profile) : undefined;
        if (asked && query.profiles === 'all') {
          throw new HubError('validation_failed', {
            details: { field: 'profiles', reason: 'conflicts_with_profile' },
          });
        }
        const enterable = listWorkspacesFor(db, principal.user);
        const chosen = asked
          ? enterable.filter((row) => row.slug === asked || row.id === asked)
          : enterable;
        // A `profile` nobody may enter is not an empty page, it is a wrong request.
        if (asked && chosen.length === 0) throw notFound({ resource: 'profile', id: asked });

        // Hermes keeps one scheduler, reflected into the default workspace (a job made in
        // Hermes itself lands there; one made from a profile stays in it); read before
        // answering, never able to fail the page. The default workspace whether or not this
        // person may enter it: a member of one profile still sees that profile's Hermes jobs
        // as Hermes has them now. Syncing writes reflections only; what is shown is `chosen`.
        const home = defaultWorkspace(db);
        if (home && chosen.length > 0) {
          await syncHermes(request, service, {
            workspace: home.id,
            profile: home.slug,
            userId: principal.user.id,
          });
        }
        const filter = {
          ...(query.agent_id ? { agentId: String(query.agent_id) } : {}),
          ...(query.workflow_id ? { workflowId: String(query.workflow_id) } : {}),
          ...(query.enabled === undefined ? {} : { enabled: Boolean(query.enabled) }),
        };
        const slugOf = new Map(chosen.map((row) => [row.id, row.slug]));
        const limit = clampLimit(query.limit as number | undefined);
        // Newest first across workspaces, one keyset: one statement, `limit + 1` to learn
        // whether there is another page.
        const rows = service.listAcross([...slugOf.keys()], filter, {
          cursor: decodeCursor(query.cursor as string | undefined),
          limit: limit + 1,
        });
        return pageOf(rows, limit, (row) =>
          toSchedule(row, slugOf.get(row.workspace) ?? '', service.shownNext(row)),
        );
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.create',
      status: 201,
      handler: async (request, { body }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const input = body as Record<string, unknown>;
        const cron = cronOf(request.server);
        const forHermes = cron?.targetsHermes(scope.workspace, input.target as never) ?? false;
        if (forHermes) cron!.checkWritable(input);
        let row = service.create(scope, input);
        // A schedule for Hermes lives in Hermes's scheduler, which is what fires it. If
        // Hermes refuses, the hub's row goes too: a schedule here that Hermes never heard
        // of would look saved and never run.
        if (forHermes) {
          try {
            const job = await cron!.jobs()!.create(cron!.jobOf(row));
            row = service.linkHermes(scope, row.id, job, cron!.contextFor(scope.workspace));
          } catch (error) {
            service.remove(scope, row.id);
            refusedByHermesCron(error);
          }
        }
        const schedule = toSchedule(row, scope.profile, service.shownNext(row));
        announce(request, 'schedule.created', { schedule });
        return schedule;
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.previewTrigger',
      handler: (request, { body }) => {
        const ask = body as { trigger: Record<string, unknown>; count?: number };
        const preview = serviceOf(request).previewTrigger(ask.trigger, ask.count ?? 3);
        return {
          timezone: preview.timezone,
          next_runs: preview.nextRuns.map((at) => at.toISOString()),
        };
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.get',
      handler: (request, { params }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const row = service.get(scope, params.schedule_id as string);
        return toSchedule(row, scope.profile, service.shownNext(row));
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.update',
      handler: async (request, { params, body }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const id = params.schedule_id as string;
        const patch = body as Record<string, unknown>;
        const current = service.get(scope, id);
        const cron = cronOf(request.server);
        const target = (patch.target as Record<string, unknown> | undefined) ?? {
          kind: current.targetKind === 'workflow' ? 'workflow' : 'agent_prompt',
          agent_id: current.agentId,
          prompt: current.prompt,
        };
        const wasHermes = current.externalSource === 'hermes' && !!current.externalId;
        const willBeHermes = cron?.targetsHermes(scope.workspace, target) ?? false;
        let row: ScheduleRow;
        if (cron && (wasHermes || willBeHermes)) {
          row = await updateThroughHermes(cron, service, scope, current, patch, {
            wasHermes,
            willBeHermes,
          });
        } else {
          row = service.update(scope, id, patch);
        }
        const schedule = toSchedule(row, scope.profile, service.shownNext(row));
        announce(request, 'schedule.updated', { schedule });
        return schedule;
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.delete',
      status: 204,
      handler: async (request, { params }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const row = service.get(scope, params.schedule_id as string);
        // Hermes first: a schedule deleted here and still in Hermes would keep firing.
        const jobs = cronOf(request.server)?.jobs();
        if (row.externalSource === 'hermes' && row.externalId && jobs) {
          await jobs.remove(row.externalId).catch(refusedByHermesCron);
        }
        service.remove(scope, row.id);
        announce(request, 'schedule.deleted', { schedule_id: params.schedule_id });
        return null;
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.runNow',
      status: 202,
      handler: async (request, { params }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        // The schedule must exist before the hub says it cannot run it: a 404 is more
        // useful than a 501 when the id is simply wrong.
        const row = service.get(scope, params.schedule_id as string);
        const jobs = cronOf(request.server)?.jobs();
        // Hermes has a scheduler, so a Hermes schedule can fire now: Hermes runs it on its
        // next tick, and the run stays `queued` here until Hermes reports how it went.
        if (row.externalSource === 'hermes' && row.externalId && jobs) {
          await jobs.run(row.externalId).catch(refusedByHermesCron);
          const run = service.queueRun(scope, row.id);
          announce(request, 'schedule.fired', {
            schedule: toSchedule(row, scope.profile, service.shownNext(row)),
            schedule_run_id: run.id,
          });
          return {
            job_id: run.id,
            schedule_run_id: run.id,
            session_id: null,
            run_id: null,
            workflow_run_id: null,
          };
        }
        // The hub's own: the same run its time would start, now, leaving the next time alone.
        const line = service.manualRun(row);
        const fired = await firerFor(request.server).fire(row, line);
        if (fired.error) {
          throw conflict({
            reason: 'target_unavailable',
            message: fired.error,
            schedule_run_id: line.id,
          });
        }
        return {
          job_id: fired.jobId,
          schedule_run_id: fired.scheduleRunId,
          session_id: fired.sessionId,
          run_id: fired.runId,
          workflow_run_id: fired.workflowRunId,
        };
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.listRuns',
      handler: (request, { params, query }) => {
        const scope = scopeOf(request);
        const limit = clampLimit(query.limit as number | undefined);
        const rows = serviceOf(request).runsOf(scope, params.schedule_id as string, limit);
        return { items: rows.map((row) => toScheduleRun(row, { full: false })), next_cursor: null };
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.getRun',
      handler: (request, { params }) =>
        toScheduleRun(
          serviceOf(request).run(
            scopeOf(request),
            params.schedule_id as string,
            params.schedule_run_id as string,
          ),
          { full: true },
        ),
    });

    defineRoute(app, deps, {
      operationId: 'schedules.deleteRun',
      status: 204,
      handler: (request, { params }) => {
        serviceOf(request).removeRun(
          scopeOf(request),
          params.schedule_id as string,
          params.schedule_run_id as string,
        );
        return null;
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.listDeliveryTargets',
      handler: () => ({
        // Only what exists. Rooms and messaging channels are their own modules and are
        // not built, so they are not offered as places output could go.
        items: [
          { kind: 'none', label: 'History only', room_id: null, channel: null, address: null },
          {
            kind: 'notice',
            label: 'A notice in the hub',
            room_id: null,
            channel: null,
            address: null,
          },
        ],
      }),
    });

    // ----------------------------------------------------------- workflows

    defineRoute(app, deps, {
      operationId: 'schedules.listWorkflows',
      handler: (request) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        return {
          items: service.listWorkflows(scope).map((row) =>
            toWorkflow(row, scope.profile, {
              runs: service.workflowRunsOf(scope, row.id, 1000).length,
              schedules: service.scheduleCount(scope, row.id),
              activeRunId: service.activeRunOf(row.id),
            }),
          ),
          next_cursor: null,
        };
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.createWorkflow',
      status: 201,
      handler: (request, { body }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const row = service.createWorkflow(scope, body as Record<string, unknown>);
        const workflow = toWorkflow(row, scope.profile, {
          runs: 0,
          schedules: 0,
          activeRunId: service.activeRunOf(row.id),
        });
        announce(request, 'workflow.created', { workflow });
        return workflow;
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.getWorkflow',
      handler: (request, { params }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const row = service.workflow(scope, params.workflow_id as string);
        return toWorkflow(row, scope.profile, {
          runs: service.workflowRunsOf(scope, row.id, 1000).length,
          schedules: service.scheduleCount(scope, row.id),
          activeRunId: service.activeRunOf(row.id),
        });
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.updateWorkflow',
      handler: (request, { params, body }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const row = service.updateWorkflow(
          scope,
          params.workflow_id as string,
          body as Record<string, unknown>,
        );
        const workflow = toWorkflow(row, scope.profile, {
          runs: service.workflowRunsOf(scope, row.id, 1000).length,
          schedules: service.scheduleCount(scope, row.id),
          activeRunId: service.activeRunOf(row.id),
        });
        announce(request, 'workflow.updated', { workflow });
        return workflow;
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.deleteWorkflow',
      status: 204,
      handler: (request, { params }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const workflow = service.workflow(scope, params.workflow_id as string);
        // Its runs go with it: nobody should still be asked to approve a step of one.
        for (const run of service.waitingRunsOf(workflow.id)) {
          workflowEngineFor(request.server).closeGates(service, scope, run.id);
          workflowEngineFor(request.server).announceFinished(run, {
            status: 'cancelled',
            error: 'the workflow was deleted',
          });
        }
        service.removeWorkflow(scope, workflow.id);
        announce(request, 'workflow.deleted', { workflow_id: params.workflow_id });
        return null;
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.runWorkflow',
      status: 202,
      handler: (request, { params, body }) => {
        const scope = runScopeOf(request);
        const service = serviceOf(request);
        const workflow = service.workflow(scope, params.workflow_id as string);
        const ask = (body ?? {}) as {
          input?: string | null;
          start_node_ids?: string[] | null;
          limits?: Record<string, unknown> | null;
          timeout_ms?: number | null;
        };
        const definition = workflow.definition as WorkflowDefinition;
        // This run's own limits over the workflow's (§53); refused before anything starts.
        const limits = runLimits(definition.limits, ask.limits, ask.timeout_ms);
        if (definition.nodes.length === 0) {
          throw new HubError('conflict', { details: { reason: 'workflow_empty' } });
        }
        const known = new Set(definition.nodes.map((node) => node.id));
        const unknown = (ask.start_node_ids ?? []).filter((id) => !known.has(id));
        if (unknown.length > 0) {
          throw new HubError('conflict', {
            details: { reason: 'start_node_unknown', node_ids: unknown },
          });
        }
        const run = workflowEngineFor(request.server).start(service, scope, workflow, {
          trigger: { input: ask.input ?? null },
          input: ask.input ?? null,
          triggerKind: 'manual',
          startNodeIds: ask.start_node_ids ?? null,
          limits,
        });
        return { job_id: run.id, workflow_run_id: run.id };
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.listWorkflowRuns',
      handler: (request, { params, query }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const limit = clampLimit(query.limit as number | undefined);
        const rows = service.workflowRunsOf(scope, params.workflow_id as string, limit);
        return {
          items: rows.map((row) => toWorkflowRun(row, scope.profile, service.stepsOf(row.id))),
          next_cursor: null,
        };
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.getWorkflowRun',
      handler: (request, { params }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const row = service.workflowRun(scope, params.workflow_run_id as string);
        return toWorkflowRun(row, scope.profile, service.stepsOf(row.id));
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.deleteWorkflowRun',
      status: 204,
      handler: (request, { params }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const run = service.workflowRun(scope, params.workflow_run_id as string);
        if (!['succeeded', 'failed', 'cancelled', 'timed_out'].includes(run.status)) {
          const engine = workflowEngineFor(request.server);
          engine.cancel(run.id);
          engine.closeGates(service, scope, run.id);
          engine.announceFinished(run, { status: 'cancelled', error: 'the run was deleted' });
        }
        service.removeWorkflowRun(scope, run.id);
        return null;
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.cancelWorkflowRun',
      handler: (request, { params }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const row = cancelWorkflowRunNow(
          request.server,
          service,
          scope,
          params.workflow_run_id as string,
        );
        return toWorkflowRun(row, scope.profile, service.stepsOf(row.id));
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.rerunWorkflowFromNode',
      status: 202,
      handler: (request, { params, body }) => {
        const scope = runScopeOf(request);
        const service = serviceOf(request);
        const previous = service.workflowRun(scope, params.workflow_run_id as string);
        const from = (body as { from_node_id: string }).from_node_id;
        const definition = previous.definitionSnapshot as WorkflowDefinition;
        if (!definition.nodes.some((node) => node.id === from)) {
          throw new HubError('conflict', {
            details: { reason: 'start_node_unknown', node_ids: [from] },
          });
        }
        // The same drawing the first run used, not today's: resuming means resuming that.
        const workflow = {
          ...service.workflow(scope, previous.workflowId),
          definition,
          version: previous.workflowVersion,
        };
        const earlier = previous.input as { trigger?: unknown; input?: string | null };
        const run = workflowEngineFor(request.server).start(service, scope, workflow, {
          trigger: earlier.trigger ?? null,
          input: earlier.input ?? null,
          triggerKind: 'manual',
          triggerRef: previous.id,
          startNodeIds: [from],
          steps: outputsOf(service.stepsOf(previous.id)),
        });
        return { job_id: run.id, workflow_run_id: run.id };
      },
    });

    // ------------------------------------------------------------- imports

    defineRoute(app, deps, {
      operationId: 'schedules.previewWorkflowImport',
      status: 201,
      handler: (request, { body }) => {
        const scope = scopeOf(request);
        const now = Date.now();
        sweepPreviews(now);
        const input = (body as { document?: Record<string, unknown> }).document ?? {};
        const definition: WorkflowDefinition = {
          nodes: (input.nodes as WorkflowDefinition['nodes'] | undefined) ?? [],
          edges: (input.edges as WorkflowDefinition['edges'] | undefined) ?? [],
          workingDir: (input.working_dir as string | null | undefined) ?? null,
        };
        // Refused now, not at confirm: a preview of something that cannot be created is
        // a promise the hub would have to break.
        const problems = validateDefinition(definition);
        if (problems.length > 0) {
          throw new HubError('bad_request', { details: { reason: 'workflow_invalid', problems } });
        }
        const id = newUlid(now);
        previews.set(id, {
          id,
          workspace: scope.workspace,
          document: input,
          expiresAt: now + PREVIEW_TTL_MS,
        });
        return {
          id,
          name: String(input.name ?? ''),
          node_count: definition.nodes.length,
          edge_count: definition.edges.length,
          warnings: warningsFor(definition),
          expires_at: new Date(now + PREVIEW_TTL_MS).toISOString(),
        };
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.confirmWorkflowImport',
      status: 201,
      handler: (request, { params }) => {
        const scope = scopeOf(request);
        const now = Date.now();
        sweepPreviews(now);
        const id = params.import_id as string;
        const preview = previews.get(id);
        // A preview belongs to the workspace that made it; another may not confirm it.
        if (!preview || preview.workspace !== scope.workspace) {
          throw notFound({ resource: 'workflow_import', id });
        }
        previews.delete(id);
        const service = serviceOf(request);
        const row = service.createWorkflow(scope, preview.document);
        const workflow = toWorkflow(row, scope.profile, {
          runs: 0,
          schedules: 0,
          activeRunId: service.activeRunOf(row.id),
        });
        announce(request, 'workflow.created', { workflow });
        return workflow;
      },
    });
  },
  registerEvents(io: SocketServer) {
    // `/rt/schedules` announces; it carries no client commands.
    io.of(REALTIME_NAMESPACES.schedules);
  },
});

export const registerRoutes = schedulesModule.registerRoutes.bind(schedulesModule);
export const registerEvents = schedulesModule.registerEvents.bind(schedulesModule);
