/**
 * Module `tasks`: projects, the nine-column board, and everything that happens to a task.
 *
 * All twenty-seven operations answer. What they do **not** do is start the work: the
 * contract's `assignTask` describes a future in which assigning opens a session and
 * queues a run, and that worker is not built. So this module assigns, moves, records and
 * reports, and says plainly that nothing started — `TaskAssigned` answers with `null` for
 * the job, the run and the session rather than an invented id. A board a person drives by
 * hand is a board that works; a board that claims to have started a run it never started
 * is worse than an empty screen.
 *
 * The same honesty applies to a worktree: the row is recorded in `creating`, because
 * making a git worktree belongs to whatever runs the task.
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
import { jobRunnerFor, serializeJob } from '../audit/index.js';
import { listWorkspacesFor, requireRole, requireUser, requireWorkspace } from '../auth/index.js';
import { TasksService, type Actor, type Scope, type TaskStatus } from './service.js';
import { toComment, toProject, toSubtask, toTask, toWorktree, type NameOf } from './serialize.js';
import { TASK_STATUSES } from './schema.js';

export { TasksService } from './service.js';
export type { Actor, Scope, TaskStatus } from './service.js';
export { between, append } from './position.js';

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

    const task = (request: FastifyRequest, service: TasksService, scope: Scope, id: string) => {
      const row = service.task(scope, id);
      return toTask(row, scope.profile, {
        nameOf,
        subtaskCounts: service.subtaskCounts(row.id),
        dependsOn: service.dependenciesOf(row.id),
        worktree: service.worktreeOf(row.id),
      });
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
      handler: (request, { query }) => {
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
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const input = body as { project_id: string; max?: number; dry_run?: boolean };
        const project = service.project(scope, input.project_id);
        const actor = actorOf(request);
        const job = jobRunnerFor(request.server).start(
          {
            workspace: scope.workspace,
            ownerId: scope.userId,
            kind: 'tasks.run',
            entityKind: 'project',
            entityId: project.id,
            input: { max: input.max ?? 1, dry_run: input.dry_run ?? false },
          },
          () => {
            const candidates = service.dispatchable(scope, project.id, input.max ?? 1);
            const assignments: Array<Record<string, unknown>> = [];
            for (const candidate of candidates) {
              const agentId = candidate.assigneeAgentId ?? project.defaultAgentId;
              if (!agentId) continue;
              if (!input.dry_run) {
                service.assign(scope, actor, candidate.id, { agent_id: agentId });
                announce(request, 'task.assigned', { task_id: candidate.id, agent_id: agentId });
              }
              // Assigned, not started: the worker that would start a run is not built.
              assignments.push({
                task_id: candidate.id,
                agent_id: agentId,
                job_id: null,
                run_id: null,
                session_id: null,
              });
            }
            return Promise.resolve({ assignments, started: 0 });
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
      handler: (request, { body }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const row = service.createTask(scope, actorOf(request), body as Record<string, unknown>);
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
            service.deleteTask(scope, id);
            return { id, ok: true, error: null };
          } catch {
            return { id, ok: false, error: { error: 'not_found', code: 'not_found' } };
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
      handler: (request, { params, body }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
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
      handler: (request, { params }) => {
        const scope = scopeOf(request);
        serviceOf(request).deleteTask(scope, params.task_id as string);
        announce(request, 'task.deleted', { task_id: params.task_id });
        return null;
      },
    });

    defineRoute(app, deps, {
      operationId: 'tasks.moveTask',
      handler: (request, { params, body }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        service.moveTask(
          scope,
          actorOf(request),
          params.task_id as string,
          body as { status: TaskStatus },
        );
        const moved = task(request, service, scope, params.task_id as string);
        announce(request, 'task.moved', { task: moved });
        return moved;
      },
    });

    defineRoute(app, deps, {
      operationId: 'tasks.assignTask',
      status: 202,
      handler: (request, { params, body }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const id = params.task_id as string;
        service.assign(scope, actorOf(request), id, body as { agent_id: string });
        announce(request, 'task.assigned', {
          task_id: id,
          agent_id: (body as { agent_id: string }).agent_id,
        });
        // Assigned, and nothing started: the worker that opens a session and queues a run
        // is not built, and a made-up run id would be worse than a null one.
        return { job_id: null, run_id: null, session_id: null, task_id: id };
      },
    });

    defineRoute(app, deps, {
      operationId: 'tasks.unassignTask',
      status: 204,
      handler: (request, { params }) => {
        const scope = scopeOf(request);
        serviceOf(request).unassign(scope, actorOf(request), params.task_id as string);
        announce(request, 'task.unassigned', { task_id: params.task_id });
        return null;
      },
    });

    defineRoute(app, deps, {
      operationId: 'tasks.stopTask',
      status: 204,
      handler: (request, { params }) => {
        const scope = scopeOf(request);
        serviceOf(request).stop(scope, actorOf(request), params.task_id as string);
        announce(request, 'task.moved', { task_id: params.task_id });
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
