// Module `sessions`: owns chat sessions, messages, streaming runs, tool calls, approvals.
// Public surface of the module: other modules and app/ import this file only.
//
// Composition note: `registerEvents(io)` runs before `registerRoutes(app)` and
// before `app.decorate('hub', …)`, so the realtime layer is created from the
// Socket.IO server (one per app, tracked in `realtime.ts`) and the service is
// built lazily on the first request, when `app.hub.database` exists. That
// keeps one service per app — important because the module object is a
// singleton shared by every `buildServer()` in a test process.
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import type { Server as SocketServer } from 'socket.io';
import { requireSqlite } from '../../lib/db.js';
import { HubError } from '../../lib/errors.js';
import { defineModule, REALTIME_NAMESPACES, type HubModule } from '../../lib/module.js';
import { AuditService, type BackgroundSource } from '../audit/index.js';
import { sessionsBackground } from './background.js';
import { attachSessionsRealtime, sessionsRealtimeFor, type FollowCheck } from './realtime.js';
import { registerSessionRoutes } from './routes.js';
import { derivedScopeResolver, type ScopeCaller, type ScopeResolver } from './scope.js';
import { SessionsService, type TurnHandle, type TurnInput, type TurnResult } from './service.js';
import type { EngineScope } from './engine.js';
import { SessionsStore } from './store.js';
import type {
  AgentDirectory,
  AgentRunner,
  AttachmentsPort,
  SessionsNotifier,
  SessionsPorts,
  WorkflowGate,
} from './ports.js';
import { noAttachments, noNotifier, unavailableAgents, unavailableRunner } from './unavailable.js';

/**
 * A port, or a factory that builds it for one app: the real ports (`agents`, `auth`) keep
 * their state per app, so the module resolves them once per app instead of once per process.
 */
export type PortOrFactory<T> = T | ((app: FastifyInstance) => T);

export interface SessionsModuleOptions {
  /** The `agents` registry. Default: nothing is installed (404 on every id). */
  agents?: PortOrFactory<AgentDirectory>;
  /** The `AgentAdapter` slice a run needs. Default: `422 agent_unavailable`. */
  runner?: PortOrFactory<AgentRunner>;
  /** `knowledge`'s file registry. Default: nothing is stored and nothing resolves. */
  attachments?: PortOrFactory<AttachmentsPort>;
  /** `auth`'s workspace/user resolution. Default: derived from the profile slug. */
  scopes?: PortOrFactory<ScopeResolver>;
  /** `notify`'s inbox. Default: nobody is told anything. */
  notifier?: PortOrFactory<SessionsNotifier>;
  /** Silence from the adapter for this long ends a run as `timed_out`. */
  agentTimeoutMs?: number;
}

function resolvePort<T>(port: PortOrFactory<T>, app: FastifyInstance): T {
  return typeof port === 'function' ? (port as (app: FastifyInstance) => T)(app) : port;
}

export function createSessionsModule(options: SessionsModuleOptions = {}): HubModule {
  const portsFor = (app: FastifyInstance): SessionsPorts => ({
    agents: resolvePort(options.agents ?? unavailableAgents, app),
    runner: resolvePort(options.runner ?? unavailableRunner, app),
    attachments: resolvePort(options.attachments ?? noAttachments, app),
    notifier: resolvePort(options.notifier ?? noNotifier, app),
    agentTimeoutMs: options.agentTimeoutMs ?? 10 * 60_000,
    gate: () => workflowGateFactory?.(app) ?? null,
  });
  const scopesFor = (app: FastifyInstance): ScopeResolver =>
    resolvePort(options.scopes ?? derivedScopeResolver, app);
  const services = new WeakMap<SocketServer, SessionsService>();

  const service = (request: FastifyRequest): SessionsService =>
    serviceFor(request.server, request.log);
  const serviceFor = (app: FastifyInstance, log: FastifyBaseLogger): SessionsService => {
    const hub = app.hub;
    const realtime = sessionsRealtimeFor(hub.io);
    if (!realtime) {
      throw new HubError('service_unavailable', { details: { reason: 'realtime_not_attached' } });
    }
    const existing = services.get(hub.io);
    if (existing) return existing;
    if (hub.database.kind !== 'sqlite') {
      // The schema is authored in sqlite-core; the PostgreSQL variant is
      // produced mechanically in a later change (src/db/README.md).
      throw new HubError('service_unavailable', { details: { database: hub.database.kind } });
    }
    const store = new SessionsStore(hub.database.db);
    const created = new SessionsService(
      store,
      new AuditService(hub.database.db),
      realtime,
      portsFor(app),
      log,
      hub.config.dataDir,
    );
    const stale = created.recoverStaleRuns();
    if (stale > 0) log.warn({ runs: stale }, 'sessions: failed runs left by a restart');
    services.set(hub.io, created);
    return created;
  };

  return defineModule({
    name: 'sessions',
    registerRoutes(app: FastifyInstance) {
      const scopes = scopesFor(app);
      registerSessionRoutes(app, { service, scopes });
      sessionsRealtimeFor(app.hub.io)?.authorizeFollowWith(followCheck(app, scopes));
      turns.set(app, (scope, input) => serviceFor(app, app.log).oneTurn(scope, input));
      runs.set(app, {
        start: (scope, input) => serviceFor(app, app.log).startTurn(scope, input),
        async cancel(scope, sessionId, runId) {
          try {
            await serviceFor(app, app.log).cancelRun(scope, sessionId, runId);
          } catch (error) {
            // Already over, or already gone: there is nothing left to stop, which is what
            // the caller wanted.
            if (error instanceof HubError && ['state_invalid', 'not_found'].includes(error.code))
              return;
            throw error;
          }
        },
        outcome: (workspace, runId) => serviceFor(app, app.log).turnResult(workspace, runId),
      });
      backgrounds.set(
        app,
        sessionsBackground(() => serviceFor(app, app.log)),
      );
      gates.set(app, {
        raise: (scope, input) => serviceFor(app, app.log).raiseWorkflowApproval(scope, input),
        cancel: (scope, workflowRunId) =>
          serviceFor(app, app.log).cancelWorkflowApprovals(scope, workflowRunId),
      });
    },
    registerEvents(io: SocketServer) {
      io.of(REALTIME_NAMESPACES.sessions);
      attachSessionsRealtime(io);
    },
  });
}

/**
 * `subscribe` on `/rt/sessions` asks what `GET /sessions/{id}` asks: resolve the caller's
 * scope for each workspace the socket was admitted to (the resolver applies `auth`'s
 * rule, so a workspace the caller may no longer enter is skipped), then look the session
 * up in that scope. Found in none of them — another workspace, or no such id — is a no.
 */
function followCheck(app: FastifyInstance, scopes: ScopeResolver): FollowCheck {
  let store: SessionsStore | undefined;
  return async (socket, sessionId) => {
    // Set by `auth`'s handshake middleware (`modules/auth/sockets.ts`).
    const { principal, workspaces = [] } = socket.data as {
      principal?: ScopeCaller['principal'];
      workspaces?: ReadonlyArray<{ slug: string }>;
    };
    if (!principal) return false;
    store ??= new SessionsStore(requireSqlite(app.hub.database));
    for (const workspace of workspaces) {
      const scope = await scopes
        .resolve(workspace.slug, { principal, authError: null })
        .catch(() => null);
      if (scope && store.getSession(scope.workspaceId, sessionId)) return true;
    }
    return false;
  };
}

/** A turn run for something other than a person — a workflow step (`SessionsService.oneTurn`). */
export type OneTurn = SessionsService['oneTurn'] extends (...args: infer A) => infer R
  ? (...args: A) => R
  : never;
const turns = new WeakMap<FastifyInstance, OneTurn>();

/**
 * One whole agent turn, for another module (through the composition root). `null` when
 * this app composes no sessions module — then nothing can run an agent, and says so.
 */
export function sessionTurnsFor(app: FastifyInstance): OneTurn | null {
  return turns.get(app) ?? null;
}

/**
 * A turn another module starts and follows on its own — a task (`tasks.assignTask`). The
 * ids come back at once; the ending arrives on `done`.
 */
export interface SessionRuns {
  start(scope: EngineScope, input: TurnInput): Promise<TurnHandle>;
  /** Stop a run; a run that already ended (or was deleted) is not an error. */
  cancel(scope: EngineScope, sessionId: string, runId: string): Promise<void>;
  /** How a run stands, by id — after a restart, when nobody holds its `done` any more. */
  outcome(workspace: string, runId: string): TurnResult | null;
}
const runs = new WeakMap<FastifyInstance, SessionRuns>();

/** `null` when this app composes no sessions module. */
export function sessionRunsFor(app: FastifyInstance): SessionRuns | null {
  return runs.get(app) ?? null;
}

const backgrounds = new WeakMap<FastifyInstance, BackgroundSource>();

/** This module's runs and subagents in the Background panel (§47); `null` when not composed. */
export function sessionBackgroundFor(app: FastifyInstance): BackgroundSource | null {
  return backgrounds.get(app) ?? null;
}

/**
 * A workflow step that waits for a person raises an ordinary approval here (kind
 * `workflow_step`), and closes the ones a cancelled run leaves open. For `schedules`,
 * through the composition root.
 */
export interface WorkflowApprovals {
  raise(
    scope: { workspace: string; profile: string; userId: string },
    input: {
      workflowRunId: string;
      workflowId: string;
      workflowName: string;
      nodeId: string;
      title: string;
      description: string | null;
    },
  ): string;
  cancel(scope: { workspace: string; profile: string }, workflowRunId: string): number;
}
const gates = new WeakMap<FastifyInstance, WorkflowApprovals>();

/** `null` when this app composes no sessions module. */
export function workflowApprovalsFor(app: FastifyInstance): WorkflowApprovals | null {
  return gates.get(app) ?? null;
}

/**
 * Who continues a paused workflow once its gate is answered (the composition root joins
 * it to `schedules`). Registered once for the process, like the other cross-module ports,
 * so every sessions module a test composes answers gates the same way.
 */
let workflowGateFactory: ((app: FastifyInstance) => WorkflowGate | null) | null = null;
export function registerWorkflowGate(
  factory: ((app: FastifyInstance) => WorkflowGate | null) | null,
): ((app: FastifyInstance) => WorkflowGate | null) | null {
  const previous = workflowGateFactory;
  workflowGateFactory = factory;
  return previous;
}

/** The module the app composes (`src/modules/index.ts`). */
export const sessionsModule = createSessionsModule();

/**
 * "Does a message already point at this attachment?" — what `knowledge` must ask
 * before it honours `sessions.deleteAttachment` (the contract's `409`). Messages are
 * this module's, so the answer is this module's too.
 */
export function attachmentReferences(app: FastifyInstance): {
  isReferenced(workspace: string, attachmentId: string): boolean;
} {
  const store = new SessionsStore(requireSqlite(app.hub.database));
  return {
    isReferenced: (workspace, attachmentId) =>
      store.isAttachmentReferenced(workspace, attachmentId),
  };
}

export const registerRoutes = sessionsModule.registerRoutes.bind(sessionsModule);
export const registerEvents = sessionsModule.registerEvents.bind(sessionsModule);

export type {
  AgentDirectory,
  AgentEvent,
  AgentFileExchange,
  AgentInfo,
  AgentPromptBlock,
  AgentRunAccepted,
  AgentRunInput,
  AgentRunRequest,
  AgentRunner,
  AttachmentsPort,
  AttachmentSummary,
  MaterialisedAttachment,
  WorkflowGate,
} from './ports.js';
export { RUN_FILES_DIR, collectOutputs, ensureRunFolders, runFolders } from './run-files.js';
export type { ProducedFile, ProducedFiles, ProducedRefusal } from './run-files.js';
export type { ScopeResolver, RequestScope } from './scope.js';
export type { TurnHandle, TurnInput, TurnResult } from './service.js';
export type { EngineScope } from './engine.js';
