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
import {
  HermesApiUnavailable,
  toHermesPriority,
  type HermesCardApi,
  type HubPriority,
} from './hermes-api.js';
import { ARCHIVE_AFTER_MS, HermesMirror, type HermesBoardPort } from './hermes-mirror.js';
import { jobRunnerFor } from '../audit/index.js';
import {
  defaultWorkspace,
  findUser,
  listWorkspacesFor,
  requireRole,
  requireUser,
  requireWorkspace,
} from '../auth/index.js';
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
export type { HermesBoardPort } from './hermes-mirror.js';
export {
  HermesApiUnavailable,
  createHermesCardApi,
  type HermesApiRequest,
  type HermesCardApi,
} from './hermes-api.js';
export { HermesRefusal } from './hermes-kanban.js';

/**
 * How a name is found for an assignee or a comment's author: the agents registry for an
 * agent, `auth` for a person. Injected by the composition root so this module never reads
 * another's tables — and resolved here, on the hub, so a card from another profile carries
 * its agent's name instead of leaving each client to guess it from the agents of whatever
 * profile it happens to be in (DECISIONS §31). Without one (tests that compose no names),
 * an assignee's name is its id, never an invention.
 */
let taskNamesFactory: ((app: FastifyInstance) => NameOf) | null = null;
export function registerTaskNames(
  factory: ((app: FastifyInstance) => NameOf) | null,
): ((app: FastifyInstance) => NameOf) | null {
  const previous = taskNamesFactory;
  taskNamesFactory = factory;
  return previous;
}
function namesOf(app: FastifyInstance): NameOf {
  const resolve = taskNamesFactory?.(app);
  return (kind, id) => {
    try {
      return resolve?.(kind, id) ?? null;
    } catch {
      // A name that cannot be found must not fail the board: the id stands in for it.
      return null;
    }
  };
}

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

/**
 * Hermes said no: answer 409 with Hermes's own sentence and change nothing. Hermes's server
 * could not be reached at all: 503, saying so — the change was not made, and it is not the
 * card's fault.
 */
function refusedByHermes(error: unknown): never {
  if (error instanceof HermesRefusal) {
    throw new HubError('conflict', {
      details: { reason: 'hermes_refused', verb: error.verb, message: error.message },
    });
  }
  if (error instanceof HermesApiUnavailable) {
    throw new HubError('service_unavailable', {
      message: `Hermes's API is not available: ${error.message}`,
      details: { reason: 'hermes_api_unavailable', message: error.message },
    });
  }
  throw error;
}

/**
 * Hermes's server for this card, when the card is Hermes's and the hub runs that server
 * (ADR 0015). `null` for the hub's own cards — and for Hermes's where the hub does not run
 * Hermes, which keep today's refusals.
 */
function hermesApiOf(
  app: FastifyInstance,
  row: TaskRow,
): { mirror: HermesMirror; api: HermesCardApi; id: string } | null {
  if (!HermesMirror.isHermes(row) || !row.externalId) return null;
  const mirror = mirrorOf(app);
  const api = mirror?.api() ?? null;
  return mirror && api ? { mirror, api, id: row.externalId } : null;
}

/** The name a person's comment carries on Hermes's board: their display name, else username. */
function displayNameOf(request: FastifyRequest): string {
  const principal = request.principal;
  if (!principal) return 'Majlis';
  const row = findUser(requireSqlite(request.server.hub.database), principal.user.id);
  return row?.displayName?.trim() || principal.user.username;
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
    (scope, id) =>
      renderTask(new TasksService(requireSqlite(app.hub.database)), scope, id, namesOf(app)),
    app.log,
  );
  workers.set(app.hub.io, created);
  return created;
}

function renderTask(
  service: TasksService,
  scope: Scope,
  id: string,
  nameOf: NameOf,
): Record<string, unknown> {
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

    const task = (request: FastifyRequest, service: TasksService, scope: Scope, id: string) =>
      renderTask(service, scope, id, namesOf(request.server));

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
     * Read a Hermes card back from Hermes after a write, so the reflection is what Hermes
     * kept. Answers the refreshed row — in the workspace Hermes's answer put it in — or the
     * row as it was when Hermes could not be read (the write itself already succeeded).
     */
    const refreshFromHermes = async (
      request: FastifyRequest,
      service: TasksService,
      scope: Scope,
      row: TaskRow,
    ): Promise<TaskRow> => {
      const hermes = hermesApiOf(request.server, row);
      if (!hermes) return row;
      try {
        const detail = await hermes.api.show(hermes.id);
        const fresh = hermes.mirror.reflectCard(service, scope, detail.task);
        hermes.mirror.reflectComments(service, fresh, detail.comments);
        return fresh;
      } catch (error) {
        request.log.warn(
          { err: error instanceof Error ? error.message : String(error), taskId: row.id },
          'tasks: could not read the card back from Hermes',
        );
        return row;
      }
    };

    /**
     * Hand a Hermes card to another Hermes profile — which is another workspace (ADR 0014).
     * Hermes first: a card that is running has its run stopped by Hermes before it moves
     * (`reclaim_first`; the client asks the person before it sends this). The card then
     * follows Hermes's answer into the workspace of its new profile.
     */
    const handToProfile = async (
      request: FastifyRequest,
      service: TasksService,
      scope: Scope,
      current: TaskRow,
      slug: string,
    ): Promise<void> => {
      const hermes = hermesApiOf(request.server, current);
      if (!hermes) {
        refuseOnHermesCard(current, 'reassign');
        return;
      }
      const target = hermes.mirror.target(slug);
      const principal = request.principal;
      const enterable =
        !!target &&
        !!principal &&
        listWorkspacesFor(requireSqlite(request.server.hub.database), principal.user).some(
          (row) => row.id === target.workspace,
        );
      if (!target || !enterable) throw notFound({ resource: 'profile', id: slug });
      await hermes.api
        .reassign(hermes.id, target.profile, { reclaimFirst: current.status === 'running' })
        .catch(refusedByHermes);
      const fresh = await refreshFromHermes(request, service, scope, current);
      const own = {
        ...scope,
        workspace: fresh.workspace,
        profile: hermes.mirror.target(fresh.workspace)?.slug ?? scope.profile,
      };
      const rendered = renderTask(service, own, fresh.id, namesOf(request.server));
      for (const profile of new Set([scope.profile, own.profile])) {
        realtimeOf(request.server).emit(
          REALTIME_NAMESPACES.tasks,
          'task.assigned',
          { profile },
          { task: rendered },
        );
        if (fresh.status !== current.status) {
          realtimeOf(request.server).emit(
            REALTIME_NAMESPACES.tasks,
            'task.moved',
            { profile },
            {
              task: rendered,
              from: current.status,
              to: fresh.status,
              actor: authorOf(actorOf(request)),
            },
          );
        }
      }
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
            workspace: scope.workspace,
            priority: current.priority,
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
        // `profiles=all` is what the board is anyway (DECISIONS §31); with `profile` it says
        // two things at once, and the hub does not pick one.
        if (asked && query.profiles === 'all') {
          throw new HubError('validation_failed', {
            details: { field: 'profiles', reason: 'conflicts_with_profile' },
          });
        }
        const enterable = listWorkspacesFor(db, principal.user);
        const chosen = asked
          ? enterable.filter((row) => row.slug === asked || row.id === asked)
          : enterable;
        // A `profile` nobody may enter is not an empty board, it is a wrong request.
        if (asked && chosen.length === 0) throw notFound({ resource: 'profile', id: asked });
        const slugOf = new Map(chosen.map((row) => [row.id, row.slug]));
        const ids = chosen.map((row) => row.id);

        // Hermes keeps one board per home, and the hub has one Hermes home: each card is
        // reflected into the workspace of the Hermes profile it is given to (ADR 0014), and
        // a card given to none into the default workspace. Read before answering, so what
        // the person sees is what Hermes has — throttled, and never able to fail the board.
        const mirror = mirrorOf(request.server);
        // A person who opened the board is about to edit, comment or reassign: start
        // Hermes's server now, in the background, so that call does not wait for it (owner,
        // 2026-09-24). Each opening counts as a use, so it stays up ten minutes after the last.
        mirror?.warm();
        // The default workspace whether or not this person may enter it: a member of the
        // designer profile alone still sees the designer's cards as Hermes has them now.
        // Syncing writes reflections only; what is *shown* is still `chosen`.
        const home = defaultWorkspace(db);
        if (mirror && home && chosen.length > 0) {
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

        const nameOf = namesOf(request.server);
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
        // The contract's `JobAccepted`: the job's id; its result (the assignments) is read
        // from `jobs.get` or `/rt/jobs` once it ends.
        return { job_id: job.id };
      },
    });

    // ------------------------------------------------------------- tasks

    defineRoute(app, deps, {
      operationId: 'tasks.listTasks',
      handler: (request, { query }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const limit = clampLimit(query.limit as number | undefined);
        // `profiles=all` (ADR 0016, DECISIONS §31): every workspace this person may enter —
        // `auth`'s rule, asked here, never a list the client sends. The header was already
        // checked by `requireWorkspace`, so "all" opens no door the header could not.
        const slugOf = new Map<string, string>([[scope.workspace, scope.profile]]);
        if (query.profiles === 'all' && request.principal) {
          for (const row of listWorkspacesFor(
            requireSqlite(request.server.hub.database),
            request.principal.user,
          )) {
            slugOf.set(row.id, row.slug);
          }
        }
        const nameOf = namesOf(request.server);
        const rows = service.listTasksAcross([...slugOf.keys()], {
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
            toTask(row, slugOf.get(row.workspace) ?? scope.profile, {
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
              workspace: scope.workspace,
              priority: row.priority,
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
      handler: async (request, { body }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const input = body as { task_ids: string[]; patch: Record<string, unknown> };
        const results = [];
        for (const id of input.task_ids) {
          try {
            let patch = input.patch;
            const row = service.task(scope, id);
            const hermes = hermesApiOf(request.server, row);
            if (hermes) {
              // As one edit does: Hermes's words and priority on Hermes first, a new
              // status through Hermes's own move, and the rest is the hub's.
              const words: { title?: string; body?: string | null; priority?: number } = {};
              if (patch.title !== undefined) words.title = String(patch.title);
              if (patch.description !== undefined) words.body = patch.description as string | null;
              if (patch.priority !== undefined)
                words.priority = toHermesPriority(patch.priority as HubPriority);
              if (Object.keys(words).length > 0) {
                const card = await hermes.api.update(hermes.id, words).catch(refusedByHermes);
                hermes.mirror.reflectCard(service, scope, card);
              }
              if (typeof patch.status === 'string' && patch.status !== row.status) {
                await hermes.mirror
                  .moveThrough(row, patch.status as TaskStatus, null)
                  .catch(refusedByHermes);
              }
              const { title: _t, description: _d, priority: _p, ...rest } = patch;
              patch = rest;
            } else if (
              patch.title !== undefined ||
              patch.description !== undefined ||
              patch.status !== undefined
            ) {
              refuseOnHermesCard(row, 'bulk_update');
            }
            service.bulkUpdate(scope, actorOf(request), [id], patch);
            results.push({ id, ok: true, error: null });
          } catch (error) {
            // One bad id must not lose the other ninety-nine: the caller is told which.
            results.push({
              id,
              ok: false,
              error:
                error instanceof HubError
                  ? { error: error.code, code: error.code }
                  : { error: 'internal', code: 'internal' },
            });
          }
        }
        announce(request, 'task.updated', { task_ids: input.task_ids });
        return { results };
      },
    });

    defineRoute(app, deps, {
      operationId: 'tasks.bulkDeleteTasks',
      handler: async (request, { query }) => {
        const scope = scopeOf(request);
        const ids = String(query.ids ?? '')
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean);
        const service = serviceOf(request);
        const results = [];
        for (const id of ids) {
          try {
            const row = service.task(scope, id);
            const hermes = hermesApiOf(request.server, row);
            if (hermes) await hermes.api.remove(hermes.id).catch(refusedByHermes);
            else refuseOnHermesCard(row, 'delete');
            service.deleteTask(scope, id);
            results.push({ id, ok: true, error: null });
          } catch (error) {
            const code = error instanceof HubError ? error.code : 'not_found';
            results.push({ id, ok: false, error: { error: code, code } });
          }
        }
        announce(request, 'task.deleted', { task_ids: ids });
        return { results };
      },
    });

    defineRoute(app, deps, {
      operationId: 'tasks.getTask',
      handler: async (request, { params }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const id = params.task_id as string;
        let row = service.task(scope, id);
        // A Hermes card is read from Hermes when it is opened: the card as Hermes has it
        // now, and what was said on it there. A Hermes that cannot answer leaves the last
        // reflection showing — opening a card must not fail because a helper did.
        const hermes = hermesApiOf(request.server, row);
        if (hermes) {
          try {
            const detail = await hermes.api.show(hermes.id);
            row = hermes.mirror.reflectCard(service, scope, detail.task);
            hermes.mirror.reflectComments(service, row, detail.comments);
            row = service.task(scope, id);
          } catch (error) {
            if (error instanceof HubError) throw error;
            request.log.warn(
              { err: error instanceof Error ? error.message : String(error), taskId: id },
              'tasks: could not read the card from Hermes',
            );
          }
        }
        return {
          ...toTask(row, scope.profile, {
            nameOf: namesOf(request.server),
            subtaskCounts: service.subtaskCounts(id),
            dependsOn: service.dependenciesOf(id),
            worktree: service.worktreeOf(id),
          }),
          subtasks: service.subtasksOf(id).map(toSubtask),
          comments: service.commentsOf(id).map((row) => toComment(row, namesOf(request.server))),
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
        let patch = body as Record<string, unknown>;
        const current = service.task(scope, params.task_id as string);
        const hermes = hermesApiOf(request.server, current);
        if (hermes) {
          // Hermes's words and priority are written on Hermes first, through its server;
          // the reflection then takes what Hermes answered. A refusal changes nothing.
          const words: { title?: string; body?: string | null; priority?: number } = {};
          if (patch.title !== undefined) words.title = String(patch.title);
          if (patch.description !== undefined) words.body = patch.description as string | null;
          if (patch.priority !== undefined)
            words.priority = toHermesPriority(patch.priority as HubPriority);
          if (Object.keys(words).length > 0) {
            const card = await hermes.api.update(hermes.id, words).catch(refusedByHermes);
            hermes.mirror.reflectCard(service, scope, card);
          }
          const { title: _title, description: _description, priority: _priority, ...rest } = patch;
          patch = rest;
          if (typeof patch.status === 'string' && patch.status !== current.status) {
            await hermes.mirror
              .moveThrough(
                current,
                patch.status as TaskStatus,
                (patch.status_reason as string | null) ?? null,
              )
              .catch(refusedByHermes);
          }
        } else if (HermesMirror.isHermes(current)) {
          // Without Hermes's server the CLI edits a card's result, never its title or body —
          // so the hub cannot either. Accepting the edit here would last until the next
          // read, when Hermes wins and it silently vanishes.
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
        service.updateTask(scope, actorOf(request), params.task_id as string, patch);
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
        // A Hermes card is deleted on Hermes first; only then does its reflection go.
        const hermes = hermesApiOf(request.server, current);
        if (hermes) await hermes.api.remove(hermes.id).catch(refusedByHermes);
        else refuseOnHermesCard(current, 'delete');
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
        // A Hermes card handed to a workspace goes to that workspace's Hermes profile.
        const profile = (body as { profile?: string | null }).profile;
        if (profile) {
          const current = service.task(scope, id);
          if (HermesMirror.isHermes(current)) {
            await handToProfile(request, service, scope, current, profile);
            return { job_id: null, run_id: null, session_id: null, task_id: id };
          }
        }
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
        const hermes = hermesApiOf(request.server, current);
        if (hermes) {
          // Hermes's run is Hermes's to end: Hermes terminates it, then the card is read
          // back from Hermes, which decides where a stopped card goes.
          await hermes.api.stop(hermes.id).catch(refusedByHermes);
          await refreshFromHermes(request, service, scope, current);
          announceMove(request, service, scope, id, current.status);
          return null;
        }
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
      handler: async (request, { params, body }) => {
        const scope = scopeOf(request);
        const service = serviceOf(request);
        const content = String((body as { content?: string }).content ?? '');
        const current = service.task(scope, params.task_id as string);
        const hermes = hermesApiOf(request.server, current);
        if (hermes) {
          // Said on Hermes's card, in the person's name, and read back from Hermes: the
          // comment the hub shows is the one Hermes kept.
          const author = displayNameOf(request);
          await hermes.api.comment(hermes.id, content, author).catch(refusedByHermes);
          const detail = await hermes.api.show(hermes.id).catch(refusedByHermes);
          const comments = hermes.mirror.reflectComments(service, current, detail.comments, {
            id: request.principal?.user.id ?? null,
            name: author,
            body: content,
          });
          const mine = comments.filter(
            (comment) => comment.authorName === author && comment.body === content,
          );
          const row = mine.at(-1);
          if (!row) {
            throw new HubError('internal', {
              message: 'Hermes accepted the comment but does not show it',
            });
          }
          announce(request, 'task.commented', { task_id: params.task_id });
          return toComment(row, namesOf(request.server));
        }
        const row = service.comment(scope, actorOf(request), current.id, content);
        announce(request, 'task.commented', { task_id: params.task_id });
        return toComment(row, namesOf(request.server));
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
        return { job_id: job.id };
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
        return { job_id: job.id };
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
