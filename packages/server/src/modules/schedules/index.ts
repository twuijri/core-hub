/**
 * Module `schedules`: when something should happen, and what.
 *
 * Twenty of the twenty-three operations answer. The three that would **start** something —
 * `runNow`, `runWorkflow`, `rerunWorkflowFromNode` — answer `501` with their operation ids,
 * because firing a schedule means opening a session and queueing a run and that worker is
 * not built (the same gap the Tasks board names). Everything that defines, validates,
 * lists and remembers answers properly, and `next_run_at` is computed for real.
 *
 * A cron expression the hub cannot evaluate is refused **when the schedule is saved**,
 * with the field and the reason. A schedule that looks fine and never fires is the failure
 * that makes people stop trusting schedulers.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Server as SocketServer } from 'socket.io';
import { loadOpenApiDocument } from '@majlis/contracts';
import { newUlid } from '../../db/ids.js';
import { createContractIndex } from '../../lib/contract.js';
import { requireSqlite } from '../../lib/db.js';
import { HubError, notFound } from '../../lib/errors.js';
import { defineModule, REALTIME_NAMESPACES } from '../../lib/module.js';
import { clampLimit } from '../../lib/pagination.js';
import { createRealtime, type Realtime } from '../../lib/realtime.js';
import { defineRoute } from '../../lib/route.js';
import { requireRole, requireUser, requireWorkspace } from '../auth/index.js';
import { SchedulesService, validateDefinition, warningsFor, type Scope } from './service.js';
import type { WorkflowDefinition } from './schema.js';

export { SchedulesService, validateDefinition, warningsFor } from './service.js';
export type { Scope } from './service.js';
export { nextRunAt, parseCron, nextCron, CronError } from './cron.js';

function scopeOf(request: FastifyRequest): Scope {
  const workspace = request.workspace;
  const principal = request.principal;
  if (!workspace || !principal) throw new HubError('internal', { message: 'route has no scope' });
  return { workspace: workspace.id, profile: workspace.slug, userId: principal.user.id };
}

function serviceOf(request: FastifyRequest): SchedulesService {
  return new SchedulesService(requireSqlite(request.server.hub.database));
}

const realtimes = new WeakMap<SocketServer, Realtime>();
function realtimeOf(app: FastifyInstance): Realtime {
  const existing = realtimes.get(app.hub.io);
  if (existing) return existing;
  const created = createRealtime(app.hub.io);
  realtimes.set(app.hub.io, created);
  return created;
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
      kind: row.delivery.roomId ? 'room' : row.delivery.notify ? 'notice' : 'none',
      room_id: row.delivery.roomId ?? null,
      channel: null,
      address: null,
    },
    repeat: { limit: row.repeatLimit, completed: row.repeatCount },
    enabled: row.enabled,
    // Four states, and each is a fact about the row rather than a guess.
    state: exhausted ? 'exhausted' : !row.enabled ? 'paused' : next ? 'scheduled' : 'paused',
    next_run_at: next?.toISOString() ?? null,
    last_run_at: row.lastRunAt?.toISOString() ?? null,
    last_status:
      row.lastStatus === 'queued' || row.lastStatus === 'running'
        ? row.lastStatus
        : (row.lastStatus ?? null),
    last_error: null,
    last_delivery_error: null,
  };
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
    session_id: null,
    workflow_run_id: row.workflowRunId,
    status: row.status === 'skipped' ? 'cancelled' : row.status,
    trigger: 'schedule',
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
    status: row.status,
    trigger: row.triggerKind === 'api' ? 'manual' : row.triggerKind,
    input: null,
    steps: steps.map((step) => ({
      node_id: step.nodeKey,
      attempt: step.attempt,
      status: step.status,
      session_id: null,
      run_id: step.runId,
      approval_id: step.approvalId,
      error: step.error,
      started_at: step.startedAt?.toISOString() ?? null,
      finished_at: step.finishedAt?.toISOString() ?? null,
    })),
    error: row.error,
    started_at: row.startedAt?.toISOString() ?? null,
    finished_at: row.finishedAt?.toISOString() ?? null,
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

/** The operation that would start something, and cannot yet. */
function notBuilt(operationId: string): never {
  throw new HubError('not_implemented', {
    details: {
      operationId,
      reason: 'worker_not_built',
      message: 'the hub can define and remember a run, but nothing starts one yet',
    },
  });
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

    // ----------------------------------------------------------- schedules

    defineRoute(app, deps, {
      operationId: 'schedules.list',
      handler: (request, { query }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const rows = service.list(scope, {
          ...(query.agent_id ? { agentId: String(query.agent_id) } : {}),
          ...(query.workflow_id ? { workflowId: String(query.workflow_id) } : {}),
          ...(query.enabled === undefined ? {} : { enabled: Boolean(query.enabled) }),
        });
        return {
          items: rows.map((row) => toSchedule(row, scope.profile, service.nextFor(row))),
          next_cursor: null,
        };
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.create',
      status: 201,
      handler: (request, { body }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const row = service.create(scope, body as Record<string, unknown>);
        const schedule = toSchedule(row, scope.profile, service.nextFor(row));
        announce(request, 'schedule.created', { schedule });
        return schedule;
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.get',
      handler: (request, { params }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const row = service.get(scope, params.schedule_id as string);
        return toSchedule(row, scope.profile, service.nextFor(row));
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.update',
      handler: (request, { params, body }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const row = service.update(
          scope,
          params.schedule_id as string,
          body as Record<string, unknown>,
        );
        const schedule = toSchedule(row, scope.profile, service.nextFor(row));
        announce(request, 'schedule.updated', { schedule });
        return schedule;
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.delete',
      status: 204,
      handler: (request, { params }) => {
        serviceOf(request).remove(scopeOf(request), params.schedule_id as string);
        announce(request, 'schedule.deleted', { schedule_id: params.schedule_id });
        return null;
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.runNow',
      handler: (request, { params }) => {
        // The schedule must exist before the hub says it cannot run it: a 404 is more
        // useful than a 501 when the id is simply wrong.
        serviceOf(request).get(scopeOf(request), params.schedule_id as string);
        return notBuilt('schedules.runNow');
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
              activeRunId: null,
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
          activeRunId: null,
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
          activeRunId: null,
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
          activeRunId: null,
        });
        announce(request, 'workflow.updated', { workflow });
        return workflow;
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.deleteWorkflow',
      status: 204,
      handler: (request, { params }) => {
        serviceOf(request).removeWorkflow(scopeOf(request), params.workflow_id as string);
        announce(request, 'workflow.deleted', { workflow_id: params.workflow_id });
        return null;
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.runWorkflow',
      handler: (request, { params }) => {
        serviceOf(request).workflow(scopeOf(request), params.workflow_id as string);
        return notBuilt('schedules.runWorkflow');
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
        serviceOf(request).removeWorkflowRun(scopeOf(request), params.workflow_run_id as string);
        return null;
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.cancelWorkflowRun',
      handler: (request, { params }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const row = service.cancelWorkflowRun(scope, params.workflow_run_id as string);
        return toWorkflowRun(row, scope.profile, service.stepsOf(row.id));
      },
    });

    defineRoute(app, deps, {
      operationId: 'schedules.rerunWorkflowFromNode',
      handler: (request, { params }) => {
        serviceOf(request).workflowRun(scopeOf(request), params.workflow_run_id as string);
        return notBuilt('schedules.rerunWorkflowFromNode');
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
          activeRunId: null,
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
