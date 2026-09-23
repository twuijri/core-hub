/**
 * Module `tasks`: projects, the nine-column board, and everything that happens to a task.
 *
 * All twenty-seven operations answer, and since 2026-09-24 assigning a task can **start**
 * it: `assignTask` with `start: true` opens a session of source `task` for the assignee,
 * queues one run whose prompt is the task (title, brief, checklist, the instructions given
 * with the assignment), moves the task to `running` and answers `202` with the real job,
 * run and session ids. When the run ends the task moves on its own — `review` with the
 * agent's last words as the progress summary, `blocked` with the reason it failed — and
 * stop, unassign and reassign cancel the run for real (`runs.ts`). A hub that restarts
 * settles, at boot, the tasks it finds left `running`.
 *
 * Without `start` the task is only assigned, and `TaskAssigned` says so with `null` ids.
 * A task on Hermes's own kanban is never started here: Hermes's dispatcher owns it.
 *
 * Still not done by the hub (stage 2): a git worktree per task — the row is recorded in
 * `creating` and the run works in the session's ordinary folder under the workspace — and
 * reporting into a project's room, which waits on `rooms`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Server as SocketServer } from 'socket.io';
import { loadOpenApiDocument } from '@majlis/contracts';
import { createContractIndex } from '../../lib/contract.js';
import { requireSqlite } from '../../lib/db.js';
import { HubError, notFound } from '../../lib/errors.js';
import { defineModule, REALTIME_NAMESPACES } from '../../lib/module.js';
import { clampLimit, decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { createRealtime, type Realtime } from '../../lib/realtime.js';
import { defineRoute } from '../../lib/route.js';
import { HermesRefusal } from './hermes-kanban.js';
import { ARCHIVE_AFTER_MS, HermesMirror, type HermesBoardPort } from './hermes-mirror.js';
import { jobRunnerFor, serializeJob } from '../audit/index.js';
import { listWorkspacesFor, requireRole, requireUser, requireWorkspace } from '../auth/index.js';
import { TasksService, type Actor, type Scope, type TaskStatus } from './service.js';
import { TaskRuns, type TaskRunPort, type TaskRunScope } from './runs.js';
import {
  toComment,
  toProject,
  toSubtask,
  toTask,
  toWorktree,
  type NameOf,
  type TaskRow,
} from './serialize.js';
import { TASK_STATUSES } from './schema.js';

export { TasksService } from './service.js';
export type { Actor, Scope, TaskStatus } from './service.js';
export { between, append } from './position.js';
export type { TaskRunPort, TaskRunScope, TaskRunOutcome } from './runs.js';

/** How a name is found for an assignee. Injected so this module never reads another's tables. */
export interface TasksOverrides {
  nameOf?: NameOf;
}
let overrides: TasksOverrides = {};
export function overrideTasks(next: TasksOverrides): void {
  overrides = next;
}

const nameOf: NameOf = (kind, id) => overrides.nameOf?.(kind, id) ?? null;

function scopeOf(request: FastifyRequest): Scope {
  const workspace = request.workspace;
  const principal = request.principal;
  if (!workspace || !principal) throw new HubError('internal', { message: 'route has no scope' });
  return { workspace: workspace.id, profile: workspace.slug, userId: principal.user.id };
}

function actorOf(request: FastifyRequest): Actor {
  const principal = request.principal;
  return { kind: 'user', id: principal?.user.id ?? null, name: principal?.user.username ?? null };
}

function serviceOf(request: FastifyRequest): TasksService {
  return new TasksService(requireSqlite(request.server.hub.database));
}

/**
 * Hermes's board, reflected (`hermes-mirror.ts`). The port comes from the composition
 * root, because only it may put `agents` (which knows where Hermes lives) and `tasks`
 * together. Without one — tests, or a hub that composes no Hermes — every card is the
 * hub's own and nothing below changes behaviour.
 */
let hermesBoardFactory: ((app: FastifyInstance) => HermesBoardPort) | null = null;
export function registerHermesBoard(
  factory: ((app: FastifyInstance) => HermesBoardPort) | null,
): ((app: FastifyInstance) => HermesBoardPort) | null {
  const previous = hermesBoardFactory;
  hermesBoardFactory = factory;
  return previous;
}
const mirrors = new WeakMap<SocketServer, HermesMirror | null>();
function mirrorOf(app: FastifyInstance): HermesMirror | null {
  if (mirrors.has(app.hub.io)) return mirrors.get(app.hub.io) ?? null;
  const mirror = hermesBoardFactory ? new HermesMirror(hermesBoardFactory(app)) : null;
  mirrors.set(app.hub.io, mirror);
  return mirror;
}

/** Hermes said no: answer 409 with Hermes's own sentence and change nothing. */
function refusedByHermes(error: unknown): never {
  if (error instanceof HermesRefusal) {
    throw new HubError('conflict', {
      details: { reason: 'hermes_refused', verb: error.verb, message: error.message },
    });
  }
  throw error;
}

/**
 * Some things only Hermes may do to its own card: delete it, stop its run, rewrite it.
 * Doing them here would last until the next read, when Hermes wins and the change quietly
 * comes undone — so the hub refuses and says whose card it is.
 */
function refuseOnHermesCard(row: TaskRow, action: string): void {
  if (HermesMirror.isHermes(row)) {
    throw new HubError('conflict', { details: { reason: 'hermes_owns_card', action } });
  }
}

/**
 * The worker's reach into `sessions` (`runs.ts`). Filled by the composition root, like the
 * Hermes board; without it a task can be assigned but not started, and says so.
 */
let taskRunnerFactory: ((app: FastifyInstance) => TaskRunPort | null) | null = null;
export function registerTaskRunner(
  factory: ((app: FastifyInstance) => TaskRunPort | null) | null,
): ((app: FastifyInstance) => TaskRunPort | null) | null {
  const previous = taskRunnerFactory;
  taskRunnerFactory = factory;
  return previous;
}
const workers = new WeakMap<SocketServer, TaskRuns>();
/** This app's worker. Exported for tests, which wait on `settled()`. */
export function taskRunsFor(app: FastifyInstance): TaskRuns {
  const existing = workers.get(app.hub.io);
  if (existing) return existing;
  const created = new TaskRuns(
    taskRunnerFactory?.(app) ?? null,
    () => requireSqlite(app.hub.database),
    (profile, event, payload) =>
      realtimeOf(app).emit(REALTIME_NAMESPACES.tasks, event, { profile }, payload),
    (scope, id) => renderTask(new TasksService(requireSqlite(app.hub.database)), scope, id),
    app.log,
  );
  workers.set(app.hub.io, created);
  return created;
}

function renderTask(service: TasksService, scope: Scope, id: string): Record<string, unknown> {
  const row = service.task(scope, id);
  return toTask(row, scope.profile, {
    nameOf,
    subtaskCounts: service.subtaskCounts(row.id),
    dependsOn: service.dependenciesOf(row.id),
    worktree: service.worktreeOf(row.id),
  });
}

function runScopeOf(request: FastifyRequest): TaskRunScope {
  return {
    ...scopeOf(request),
    userName: request.principal?.user.username ?? '',
    language: request.language === 'en' ? 'en' : 'ar',
  };
}

/** The contract's `Author` for whoever moved a task. */
function authorOf(actor: Actor): Record<string, unknown> {
  return {
    kind: actor.kind === 'user' ? 'user' : actor.kind === 'agent' ? 'agent' : 'system',
    id: actor.id,
    name: actor.name ?? actor.kind,
    avatar: null,
  };
}

const realtimes = new WeakMap<SocketServer, Realtime>();
function realtimeOf(app: FastifyInstance): Realtime {
  const existing = realtimes.get(app.hub.io);
  if (existing) return existing;
  const created = createRealtime(app.hub.io);
  realtimes.set(app.hub.io, created);
  return created;
}

export const tasksModule = defineModule({
  name: 'tasks',
  registerRoutes(app: FastifyInstance) {
    const document = loadOpenApiDocument();
    if (!document) throw new Error('packages/contracts/openapi.yaml is required (ADR 0003)');
    const deps = {
      contract: createContractIndex(document),
      guards: { requireUser, requireWorkspace, requireRole },
    };

    /** Everything the board changes is announced, so a second tab is never stale. */
    const announce = (request: FastifyRequest, event: string, payload: Record<string, unknown>) => {
      realtimeOf(request.server).emit(
        REALTIME_NAMESPACES.tasks,
        event,
        { profile: scopeOf(request).profile },
        payload,
      );
    };

    const task = (_request: FastifyRequest, service: TasksService, scope: Scope, id: string) =>
      renderTask(service, scope, id);

    /**
     * A task the hub started and nobody moved is still `running` after a restart, and no
     * follow-up is left to move it: settle those before the hub serves anything.
     */
    app.addHook('onReady', async () => {
      try {
        const settled = taskRunsFor(app).settleStranded();
        if (settled > 0)
          app.log.warn({ tasks: settled }, 'tasks: settled runs a restart cut short');
      } catch (error) {
        app.log.warn({ err: error }, 'tasks: could not settle tasks left running');
      }
    });

    /**
     * Take a task off the run it is on, then stop that run. In that order: the run's own
     * ending arrives later and must find the task already moved, so it leaves it alone.
     */
    const leaveRun = async (
      request: FastifyRequest,
      move: () => TaskRow,
      current: TaskRow,
    ): Promise<TaskRow> => {
      const moved = move();
      if (current.status === 'running' && current.currentRunId) {
        await taskRunsFor(request.server)
          .cancel(runScopeOf(request), current.sessionId, current.currentRunId)
          .catch((error: unknown) =>
            request.log.warn({ err: error, taskId: current.id }, 'tasks: stopping the run failed'),
          );
      }
      return moved;
    };

    const announceMove = (
      request: FastifyRequest,
      service: TasksService,
      scope: Scope,
      id: string,
      from: TaskStatus,
    ) => {
      const moved = task(request, service, scope, id);
      if (moved.status === from) return moved;
      announce(request, 'task.moved', {
        task: moved,
        from,
        to: moved.status,
        actor: authorOf(actorOf(request)),
      });
      return moved;
    };

    /**
     * Assign a task and, when asked, start it: open its session, queue its run, move it to
     * `running`. The session and the run are opened **first**, so an agent that cannot take
     * the turn (`404`, `422`) leaves the task exactly as it was.
     */
    const assignAndStart = async (
      request: FastifyRequest,
      service: TasksService,
      scope: TaskRunScope,
      id: string,
      input: {
        agent_id: string;
        model?: string | null;
        provider?: string | null;
        instructions?: string | null;
        start?: boolean;
      },
    ): Promise<{ job_id: string | null; run_id: string | null; session_id: string | null }> => {
      const actor = actorOf(request);
      let current = service.task(scope, id);
      const mirror = mirrorOf(request.server);
      // Hermes's cards are Hermes's to run: its own dispatcher picks them up from its board.
      const hermes =
        HermesMirror.isHermes(current) || !!mirror?.isHermesAgent(scope.workspace, input.agent_id);
      const start = input.start === true && !hermes;
      const runs = taskRunsFor(request.server);
      if (start) {
        if (current.status === 'done' || current.status === 'archived') {
          throw new HubError('conflict', {
            details: { reason: 'task_closed', status: current.status },
          });
        }
        if (!runs.available) {
          throw new HubError('agent_unavailable', {
            details: { agent_id: input.agent_id, status: 'no_runner' },
          });
        }
      }
      // Given to Hermes and asked to start: the card goes on Hermes's board, where Hermes's
      // own dispatcher picks it up — the same rule as a card created for Hermes. Before
      // anything else changes, so a refusal from Hermes leaves the task as it was.
      if (hermes && input.start === true && mirror && !HermesMirror.isHermes(current)) {
        try {
          const brief = [current.description, input.instructions]
            .filter((part): part is string => !!part?.trim())
            .join('\n\n');
          const externalId = await mirror.createThrough({
            id: current.id,
            title: current.title,
            body: brief === '' ? null : brief,
            triage: false,
          });
          if (externalId) current = service.linkExternal(scope, id, 'hermes', externalId);
        } catch (error) {
          refusedByHermes(error);
        }
      }
      // Reassigning a running task interrupts its run.
      if (current.status === 'running' && current.currentRunId) {
        const before = current;
        current = await leaveRun(
          request,
          () => service.stop(scope, actor, id, 'reassigned'),
          before,
        );
        announceMove(request, service, scope, id, before.status);
      }
      if (!start) {
        service.assign(scope, actor, id, {
          agent_id: input.agent_id,
          instructions: input.instructions ?? null,
        });
        const assigned = task(request, service, scope, id);
        announce(request, 'task.assigned', { task: assigned });
        if (assigned.status !== current.status) {
          announce(request, 'task.moved', {
            task: assigned,
            from: current.status,
            to: assigned.status,
            actor: authorOf(actor),
          });
        }
        return { job_id: null, run_id: null, session_id: null };
      }
      const handle = await runs.open(scope, service, current, {
        agentId: input.agent_id,
        model: input.model ?? null,
        provider: input.provider ?? null,
        instructions: input.instructions ?? null,
      });
      service.assign(scope, actor, id, {
        agent_id: input.agent_id,
        instructions: input.instructions ?? null,
      });
      const { from } = service.startRun(scope, actor, id, {
        sessionId: handle.sessionId,
        runId: handle.runId,
      });
      const started = task(request, service, scope, id);
      announce(request, 'task.assigned', { task: started });
      announce(request, 'task.moved', {
        task: started,
        from,
        to: 'running',
        actor: authorOf(actor),
      });
      runs.follow(scope, id, handle.runId, handle.done);
      return { job_id: handle.jobId, run_id: handle.runId, session_id: handle.sessionId };
    };

    // ------------------------------------------------------------ projects

    defineRoute(app, deps, {
      operationId: 'tasks.listProjects',
      handler: (request, { query }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const status = query.status as string | undefined;
        const rows = service
          .listProjects(scope, status === 'archived')
          .filter((row) => !status || row.status === status);
        return {
          items: rows.map((row) => toProject(row, scope.profile, service.countsFor(scope, row.id))),
          next_cursor: null,
        };
      },
    });

    defineRoute(app, deps, {
      operationId: 'tasks.createProject',
      status: 201,
      handler: (request, { body }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const row = service.createProject(scope, body as Record<string, unknown>);
        const project = toProject(row, scope.profile, service.countsFor(scope, row.id));
        announce(request, 'project.created', { project });
        return project;
      },
    });

    defineRoute(app, deps, {
      operationId: 'tasks.getProject',
      handler: (request, { params }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const row = service.project(scope, params.project_id as string);
        return toProject(row, scope.profile, service.countsFor(scope, row.id));
      },
    });

    defineRoute(app, deps, {
      operationId: 'tasks.updateProject',
      handler: (request, { params, body }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const row = service.updateProject(
          scope,
          params.project_id as string,
          body as Record<string, unknown>,
        );
        const project = toProject(row, scope.profile, service.countsFor(scope, row.id));
        announce(request, 'project.updated', { project });
        return project;
      },
    });

    defineRoute(app, deps, {
      operationId: 'tasks.deleteProject',
      status: 204,
      handler: (request, { params }) => {
        const scope = scopeOf(request);
        serviceOf(request).deleteProject(scope, params.project_id as string);
        announce(request, 'project.deleted', { project_id: params.project_id });
        return null;
      },
    });

    // ----------------------------------------------------------- the board

    defineRoute(app, deps, {
      /**
       * One board for everything (owner decision, 2026-09-23).
       *
       * Global: the columns hold every workspace the person may enter, not the one in the
       * header — because a list of things to do that hides half of them by default is a
       * list you stop trusting. `profile`, `project_id` and `agent_id` narrow it.
       *
       * Each card still says which workspace it is from (`profile`), so the page is one
       * board and not a pile.
       */
      operationId: 'tasks.getColumns',
      handler: async (request, { query }) => {
        const service = serviceOf(request);
        const db = requireSqlite(request.server.hub.database);
        const principal = request.principal;
        if (!principal) throw new HubError('internal', { message: 'route has no principal' });

        const asked = query.profile as string | undefined;
        const enterable = listWorkspacesFor(db, principal.user);
        const chosen = asked
          ? enterable.filter((row) => row.slug === asked || row.id === asked)
          : enterable;
        // A `profile` nobody may enter is not an empty board, it is a wrong request.
        if (asked && chosen.length === 0) throw notFound({ resource: 'profile', id: asked });
        const slugOf = new Map(chosen.map((row) => [row.id, row.slug]));
        const ids = chosen.map((row) => row.id);

        // Hermes's board lands in the default workspace: Hermes keeps one board per home,
        // and the hub has one Hermes home. Read before answering, so what the person sees
        // is what Hermes has — throttled, and never able to fail the board.
        const mirror = mirrorOf(request.server);
        const home = chosen.find((row) => row.isDefault);
        if (mirror && home) {
          const report = await mirror
            .sync(service, { workspace: home.id, profile: home.slug, userId: principal.user.id })
            .catch((error: unknown) => ({ error: String(error) }));
          // The board answers with what it has; why Hermes could not be read goes to the log,
          // where the owner can find it, instead of a 500 that hides every other card.
          if (report?.error) request.log.warn({ err: report.error }, 'tasks: Hermes board sync');
        }
        // Done for a week goes to the archive, so Done is the recent week (owner, 2026-09-23).
        service.archiveDoneBefore(ids, new Date(Date.now() - ARCHIVE_AFTER_MS));

        const projectId = (query.project_id as string | undefined) ?? undefined;
        const agentId = (query.agent_id as string | undefined) ?? undefined;
        const includeArchived = (query.include_archived as boolean | undefined) ?? false;

        const columns = TASK_STATUSES.map((status) => {
          const rows = service.columnAcross(ids, { projectId, agentId }, status, includeArchived);
          return {
            status,
            count: rows.length,
            tasks: rows.map((row) =>
              toTask(row, slugOf.get(row.workspace) ?? '', {
                nameOf,
                subtaskCounts: service.subtaskCounts(row.id),
                dependsOn: service.dependenciesOf(row.id),
                worktree: service.worktreeOf(row.id),
              }),
            ),
          };
        });
        const total = columns.reduce((sum, column) => sum + column.count, 0);
        return {
          project_id: projectId ?? null,
          columns,
          counts: {
            total,
            by_status: Object.fromEntries(columns.map((column) => [column.status, column.count])),
          },
        };
      },
    });

    defineRoute(app, deps, {
      operationId: 'tasks.dispatch',
      status: 202,
      handler: (request, { body }) => {
        const scope = runScopeOf(request);
        const service = serviceOf(request);
        const input = body as { project_id: string; max?: number; dry_run?: boolean };
        const project = service.project(scope, input.project_id);
        const job = jobRunnerFor(request.server).start(
          {
            workspace: scope.workspace,
            ownerId: scope.userId,
            kind: 'tasks.run',
            entityKind: 'project',
            entityId: project.id,
            input: { max: input.max ?? 1, dry_run: input.dry_run ?? false },
          },
          async () => {
            const candidates = service.dispatchable(scope, project.id, input.max ?? 1);
            const assignments: Array<Record<string, unknown>> = [];
            let started = 0;
            for (const candidate of candidates) {
              const agentId = candidate.assigneeAgentId ?? project.defaultAgentId;
              if (!agentId) continue;
              if (input.dry_run) {
                assignments.push({
                  task_id: candidate.id,
                  agent_id: agentId,
                  job_id: null,
                  run_id: null,
                  session_id: null,
                });
                continue;
              }
              // Dispatch starts what it assigns, the same way a person's "assign and
              // start" does. One task whose agent cannot run is reported, and the rest
              // still go.
              try {
                const ids = await assignAndStart(request, service, scope, candidate.id, {
                  agent_id: agentId,
                  start: true,
                });
                if (ids.run_id) started += 1;
                assignments.push({ task_id: candidate.id, agent_id: agentId, ...ids });
              } catch (error) {
                service.assign(scope, actorOf(request), candidate.id, { agent_id: agentId });
                announce(request, 'task.assigned', {
                  task: task(request, service, scope, candidate.id),
                });
                assignments.push({
                  task_id: candidate.id,
                  agent_id: agentId,
                  job_id: null,
                  run_id: null,
                  session_id: null,
                  error: error instanceof HubError ? error.code : 'internal',
                });
              }
            }
            return { assignments, started };
          },
        );
        return serializeJob(job, scope.profile);
      },
    });

    // ------------------------------------------------------------- tasks

    defineRoute(app, deps, {
      operationId: 'tasks.listTasks',
      handler: (request, { query }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const limit = clampLimit(query.limit as number | undefined);
        const rows = service.listTasks(scope, {
          projectId: query.project_id as string | undefined,
          status: query.status as TaskStatus | undefined,
          assigneeId: query.assignee_agent_id as string | undefined,
          tag: query.tag as string | undefined,
          q: query.q as string | undefined,
          cursor: decodeCursor(query.cursor as string | undefined),
          limit: limit + 1,
        });
        const page = rows.slice(0, limit);
        return {
          items: page.map((row) =>
            toTask(row, scope.profile, {
              nameOf,
              subtaskCounts: service.subtaskCounts(row.id),
              dependsOn: service.dependenciesOf(row.id),
              worktree: service.worktreeOf(row.id),
            }),
          ),
          next_cursor: rows.length > limit ? encodeCursor(page.at(-1)!.id) : null,
        };
      },
    });

    defineRoute(app, deps, {
      operationId: 'tasks.createTask',
      status: 201,
      handler: async (request, { body }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const input = body as Record<string, unknown>;
        let row = service.createTask(scope, actorOf(request), input);
        // A card given to Hermes goes on Hermes's board too, with the hub's id as the
        // idempotency key — so a retry after a half-finished create finds the same card
        // rather than making a second one. If Hermes refuses, the hub's row goes as well:
        // a card that exists here and not there is the one thing the mirror must not make.
        const mirror = mirrorOf(request.server);
        if (mirror?.isHermesAgent(scope.workspace, input.assignee_agent_id as string | null)) {
          try {
            const externalId = await mirror.createThrough({
              id: row.id,
              title: row.title,
              body: row.description,
              triage: row.status === 'triage',
            });
            if (externalId) row = service.linkExternal(scope, row.id, 'hermes', externalId);
          } catch (error) {
            service.deleteTask(scope, row.id);
            refusedByHermes(error);
          }
        }
        const created = task(request, service, scope, row.id);
        announce(request, 'task.created', { task: created });
        return created;
      },
    });

    defineRoute(app, deps, {
      operationId: 'tasks.bulkUpdateTasks',
      handler: (request, { body }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const input = body as { task_ids: string[]; patch: Record<string, unknown> };
        const results = input.task_ids.map((id) => {
          try {
            if (
              input.patch.title !== undefined ||
              input.patch.description !== undefined ||
              input.patch.status !== undefined
            ) {
              refuseOnHermesCard(service.task(scope, id), 'bulk_update');
            }
            service.bulkUpdate(scope, actorOf(request), [id], input.patch);
            return { id, ok: true, error: null };
          } catch (error) {
            // One bad id must not lose the other ninety-nine: the caller is told which.
            return {
              id,
              ok: false,
              error:
                error instanceof HubError
                  ? { error: error.code, code: error.code }
                  : { error: 'internal', code: 'internal' },
            };
          }
        });
        announce(request, 'task.updated', { task_ids: input.task_ids });
        return { results };
      },
    });

    defineRoute(app, deps, {
      operationId: 'tasks.bulkDeleteTasks',
      handler: (request, { query }) => {
        const scope = scopeOf(request);
        const ids = String(query.ids ?? '')
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean);
        const service = serviceOf(request);
        const results = ids.map((id) => {
          try {
            refuseOnHermesCard(service.task(scope, id), 'delete');
            service.deleteTask(scope, id);
            return { id, ok: true, error: null };
          } catch (error) {
            const code = error instanceof HubError ? error.code : 'not_found';
            return { id, ok: false, error: { error: code, code } };
          }
        });
        announce(request, 'task.deleted', { task_ids: ids });
        return { results };
      },
    });

    defineRoute(app, deps, {
      operationId: 'tasks.getTask',
      handler: (request, { params }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const id = params.task_id as string;
        const row = service.task(scope, id);
        return {
          ...toTask(row, scope.profile, {
            nameOf,
            subtaskCounts: service.subtaskCounts(id),
            dependsOn: service.dependenciesOf(id),
            worktree: service.worktreeOf(id),
          }),
          subtasks: service.subtasksOf(id).map(toSubtask),
          comments: service.commentsOf(id).map((row) => toComment(row, nameOf)),
          // The runs of a task live in the session it works in; `sessions` owns that table.
          runs: [],
        };
      },
    });

    defineRoute(app, deps, {
      operationId: 'tasks.updateTask',
      handler: async (request, { params, body }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const patch = body as Record<string, unknown>;
        const current = service.task(scope, params.task_id as string);
        if (HermesMirror.isHermes(current)) {
          // Hermes's CLI edits a card's result, never its title or body — so the hub
          // cannot either. Accepting the edit here would last until the next read, when
          // Hermes wins and it silently vanishes.
          if (patch.title !== undefined || patch.description !== undefined) {
            throw new HubError('conflict', {
              details: {
                reason: 'hermes_owns_text',
                field: patch.title !== undefined ? 'title' : 'description',
              },
            });
          }
          if (typeof patch.status === 'string' && patch.status !== current.status) {
            await mirrorOf(request.server)
              ?.moveThrough(
                current,
                patch.status as TaskStatus,
                (patch.status_reason as string | null) ?? null,
              )
              .catch(refusedByHermes);
          }
        }
        service.updateTask(
          scope,
          actorOf(request),
          params.task_id as string,
          body as Record<string, unknown>,
        );
        const updated = task(request, service, scope, params.task_id as string);
        announce(request, 'task.updated', { task: updated });
        return updated;
      },
    });

    defineRoute(app, deps, {
      operationId: 'tasks.deleteTask',
      status: 204,
      handler: async (request, { params }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const current = service.task(scope, params.task_id as string);
        refuseOnHermesCard(current, 'delete');
        // A task deleted mid-run takes its run with it.
        await leaveRun(
          request,
          () => {
            service.deleteTask(scope, current.id);
            return current;
          },
          current,
        );
        announce(request, 'task.deleted', { task_id: params.task_id });
        return null;
      },
    });

    defineRoute(app, deps, {
      operationId: 'tasks.moveTask',
      handler: async (request, { params, body }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const move = body as { status: TaskStatus; reason?: string | null };
        const current = service.task(scope, params.task_id as string);
        // A Hermes card moves on Hermes first. If Hermes refuses, so does the hub —
        // with Hermes's words — and the row is not touched.
        await mirrorOf(request.server)
          ?.moveThrough(current, move.status, move.reason)
          .catch(refusedByHermes);
        const moveIt = () =>
          service.moveTask(
            scope,
            actorOf(request),
            params.task_id as string,
            body as { status: TaskStatus },
          );
        // A person who moves a running task out of `running` has taken it off its run:
        // the run stops, rather than go on working on a task the board says is elsewhere.
        if (move.status !== 'running') {
          await leaveRun(
            request,
            () => {
              moveIt();
              return service.detachRun(scope, current.id);
            },
            current,
          );
        } else {
          moveIt();
        }
        const moved = task(request, service, scope, params.task_id as string);
        announce(request, 'task.moved', { task: moved });
        return moved;
      },
    });

    defineRoute(app, deps, {
      operationId: 'tasks.assignTask',
      status: 202,
      handler: async (request, { params, body }) => {
        const scope = runScopeOf(request);
        const service = serviceOf(request);
        const id = params.task_id as string;
        const ids = await assignAndStart(
          request,
          service,
          scope,
          id,
          body as Parameters<typeof assignAndStart>[4],
        );
        return { ...ids, task_id: id };
      },
    });

    defineRoute(app, deps, {
      operationId: 'tasks.unassignTask',
      status: 204,
      handler: async (request, { params }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const id = params.task_id as string;
        const current = service.task(scope, id);
        // The run stops with the assignment, and a running task goes back to `ready`.
        await leaveRun(request, () => service.unassign(scope, actorOf(request), id), current);
        announce(request, 'task.unassigned', { task: task(request, service, scope, id) });
        announceMove(request, service, scope, id, current.status);
        return null;
      },
    });

    defineRoute(app, deps, {
      operationId: 'tasks.stopTask',
      status: 204,
      handler: async (request, { params }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const id = params.task_id as string;
        const current = service.task(scope, id);
        refuseOnHermesCard(current, 'stop');
        // The run is cancelled; the task stays with its agent and waits in `ready`.
        await leaveRun(request, () => service.stop(scope, actorOf(request), id), current);
        announceMove(request, service, scope, id, current.status);
        return null;
      },
    });

    // ---------------------------------------------------------- subtasks

    defineRoute(app, deps, {
      operationId: 'tasks.createSubtask',
      status: 201,
      handler: (request, { params, body }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const taskId = params.task_id as string;
        service.task(scope, taskId);
        const input = body as { title: string; index?: number };
        const row = service.createSubtask(scope, taskId, {
          title: input.title,
          ...(input.index === undefined ? {} : { index: input.index }),
        });
        announce(request, 'task.updated', { task_id: taskId });
        return toSubtask(row);
      },
    });

    defineRoute(app, deps, {
      operationId: 'tasks.updateSubtask',
      handler: (request, { params, body }) => {
        const scope = scopeOf(request);
        const row = serviceOf(request).updateSubtask(
          scope,
          params.subtask_id as string,
          body as Record<string, unknown>,
        );
        announce(request, 'task.updated', { task_id: params.task_id });
        return toSubtask(row);
      },
    });

    defineRoute(app, deps, {
      operationId: 'tasks.deleteSubtask',
      status: 204,
      handler: (request, { params }) => {
        const scope = scopeOf(request);
        serviceOf(request).deleteSubtask(scope, params.subtask_id as string);
        announce(request, 'task.updated', { task_id: params.task_id });
        return null;
      },
    });

    // ------------------------------------------------------ dependencies

    defineRoute(app, deps, {
      operationId: 'tasks.setDependencies',
      handler: (request, { params, body }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const id = params.task_id as string;
        service.setDependencies(scope, id, (body as { depends_on: string[] }).depends_on ?? []);
        const updated = task(request, service, scope, id);
        announce(request, 'task.updated', { task: updated });
        return updated;
      },
    });

    // -------------------------------------------------- comments, activity

    defineRoute(app, deps, {
      operationId: 'tasks.createComment',
      status: 201,
      handler: (request, { params, body }) => {
        const scope = scopeOf(request);
        const row = serviceOf(request).comment(
          scope,
          actorOf(request),
          params.task_id as string,
          String((body as { content?: string }).content ?? ''),
        );
        announce(request, 'task.commented', { task_id: params.task_id });
        return toComment(row, nameOf);
      },
    });

    defineRoute(app, deps, {
      operationId: 'tasks.listActivity',
      handler: (request, { params, query }) => {
        const scope = scopeOf(request);
        const limit = clampLimit(query.limit as number | undefined);
        return {
          items: serviceOf(request).activity(scope, params.task_id as string, limit),
          next_cursor: null,
        };
      },
    });

    // --------------------------------------------------------- worktrees

    defineRoute(app, deps, {
      operationId: 'tasks.getWorktree',
      handler: (request, { params }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const id = params.task_id as string;
        service.task(scope, id);
        const row = service.worktreeOf(id);
        if (!row) throw notFound({ resource: 'worktree', id });
        return toWorktree(row);
      },
    });

    defineRoute(app, deps, {
      operationId: 'tasks.createWorktree',
      status: 202,
      handler: (request, { params, body }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const id = params.task_id as string;
        const input = (body ?? {}) as { branch?: string | null; base_branch?: string | null };
        const job = jobRunnerFor(request.server).start(
          {
            workspace: scope.workspace,
            ownerId: scope.userId,
            kind: 'tasks.worktree',
            entityKind: 'task',
            entityId: id,
          },
          () => {
            const row = service.createWorktree(scope, id, input);
            announce(request, 'task.updated', { task_id: id });
            // `creating`, and it stays there: making a git worktree belongs to whatever
            // runs the task, and this hub does not pretend to have made one.
            return Promise.resolve({ worktree_id: row.id, status: row.status });
          },
        );
        return serializeJob(job, scope.profile);
      },
    });

    defineRoute(app, deps, {
      operationId: 'tasks.deleteWorktree',
      status: 202,
      handler: (request, { params }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const id = params.task_id as string;
        const job = jobRunnerFor(request.server).start(
          {
            workspace: scope.workspace,
            ownerId: scope.userId,
            kind: 'tasks.worktree',
            entityKind: 'task',
            entityId: id,
          },
          () => {
            service.removeWorktree(scope, id);
            announce(request, 'task.updated', { task_id: id });
            return Promise.resolve({ removed: true });
          },
        );
        return serializeJob(job, scope.profile);
      },
    });
  },
  registerEvents(io: SocketServer) {
    // `/rt/tasks` carries no client commands: the board is changed over HTTP and the
    // namespace only announces what changed (packages/contracts/events/README.md).
    io.of(REALTIME_NAMESPACES.tasks);
  },
});

export const registerRoutes = tasksModule.registerRoutes.bind(tasksModule);
export const registerEvents = tasksModule.registerEvents.bind(tasksModule);
