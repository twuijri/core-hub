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
import {
  attachSessionsRealtime,
  sessionsRealtimeFor,
  type FollowCheck,
  type SessionEventListener,
} from './realtime.js';
import { registerSessionRoutes } from './routes.js';
import { ChannelConversations, channelSourceFor } from './channel-conversations.js';
import { derivedScopeResolver, type ScopeCaller, type ScopeResolver } from './scope.js';
import { SessionsService, type TurnHandle, type TurnInput, type TurnResult } from './service.js';
import type { EngineScope } from './engine.js';
import { SessionsStore } from './store.js';
import type {
  AgentAskRequest,
  AgentDirectory,
  AgentInfo,
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
  // One reader per app: what it read of Hermes is kept per app, never shared between hubs.
  const channelReaders = new WeakMap<SocketServer, ChannelConversations>();
  const channels = (request: FastifyRequest): ChannelConversations => {
    const app = request.server;
    let reader = channelReaders.get(app.hub.io);
    if (!reader) {
      reader = new ChannelConversations(() => channelSourceFor(app));
      channelReaders.set(app.hub.io, reader);
    }
    return reader;
  };

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
      hub.config.hostEnv.inherited,
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
      registerSessionRoutes(app, { service, scopes, channels });
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
      seats.set(app, {
        open: (scope, input) => serviceFor(app, app.log).openSeatSession(scope, input),
        start: (scope, input) => serviceFor(app, app.log).startSeatTurn(scope, input),
        async configure(scope, sessionId, patch) {
          await serviceFor(app, app.log).update(scope, sessionId, patch);
        },
        async cancel(scope, sessionId, runId) {
          try {
            await serviceFor(app, app.log).cancelRun(scope, sessionId, runId);
          } catch (error) {
            if (error instanceof HubError && ['state_invalid', 'not_found'].includes(error.code))
              return;
            throw error;
          }
        },
        runs: (scope, runIds) => serviceFor(app, app.log).runsById(scope, runIds),
        list: (scope, sessionIds, filter) =>
          serviceFor(app, app.log).runsOfSessions(
            scope,
            sessionIds,
            filter.status,
            filter.cursor,
            filter.limit,
          ),
        outcome: (workspace, runId) => serviceFor(app, app.log).turnResult(workspace, runId),
        agent: (workspace, agentId) => portsFor(app).agents.find(workspace, agentId),
        async ask(request) {
          const runner = portsFor(app).runner;
          if (!runner.ask) return null;
          try {
            return await runner.ask(request);
          } catch {
            return null;
          }
        },
        listen: (listener) => sessionsRealtimeFor(app.hub.io)?.listen(listener) ?? (() => false),
      });
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

/** This module's runs and subagents in the Background panel (§56); `null` when not composed. */
export function sessionBackgroundFor(app: FastifyInstance): BackgroundSource | null {
  return backgrounds.get(app) ?? null;
}

/**
 * A room's seats (`rooms`, DECISIONS §69): each seat has one session of its own, opened when
 * the seat is added, and every turn it takes is a run in it. `listen` hears the sessions'
 * streams so the room can re-emit them on `/rt/rooms` with the room's ids set.
 */
export interface SeatSessions {
  open(
    scope: EngineScope,
    input: {
      agentId: string;
      seatId: string;
      title: string;
      model?: string | null | undefined;
      provider?: string | null | undefined;
      reasoningEffort?: string | null | undefined;
      workingDir?: string | null | undefined;
    },
  ): Promise<string>;
  start(
    scope: EngineScope,
    input: { sessionId: string; seatId: string; prompt: string },
  ): Promise<TurnHandle>;
  /** A seat's model, provider or effort changed: its session follows. */
  configure(
    scope: EngineScope,
    sessionId: string,
    patch: {
      model?: string | null;
      provider?: string | null;
      reasoning_effort?: string | null;
      archived?: boolean;
    },
  ): Promise<void>;
  /** Stop a run; one that already ended (or was deleted) is not an error. */
  cancel(scope: EngineScope, sessionId: string, runId: string): Promise<void>;
  /** The contract's `Run` for each id that exists. */
  runs(scope: EngineScope, runIds: readonly string[]): Record<string, unknown>[];
  list(
    scope: EngineScope,
    sessionIds: readonly string[],
    filter: { status?: string | undefined; cursor?: string | undefined; limit: number },
  ): { items: Record<string, unknown>[]; next_cursor: string | null };
  outcome(workspace: string, runId: string): TurnResult | null;
  /** The agent a seat would sit, as the runs see it: `null` when the profile has none. */
  agent(workspace: string, agentId: string): Promise<AgentInfo | null>;
  /**
   * One question to an agent outside any run (the room's summary). `null` when the agent has
   * no one-shot surface, gave up, or failed — the caller then uses its own fallback.
   */
  ask(request: AgentAskRequest): Promise<string | null>;
  listen(listener: SessionEventListener): () => void;
}
const seats = new WeakMap<FastifyInstance, SeatSessions>();

/** `null` when this app composes no sessions module. */
export function seatSessionsFor(app: FastifyInstance): SeatSessions | null {
  return seats.get(app) ?? null;
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

/**
 * Per workspace id: its unfinished runs and its conversations not archived. For the
 * Performance screen, through the composition root.
 */
export function sessionActivityFor(
  app: FastifyInstance,
): Map<string, { activeRuns: number; sessions: number }> {
  return new SessionsStore(requireSqlite(app.hub.database)).activityByWorkspace();
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
export {
  ChannelSourceRefusal,
  ChannelSourceUnavailable,
  registerChannelSource,
  type ChannelSource,
} from './channel-conversations.js';
export { RUN_FILES_DIR, collectOutputs, ensureRunFolders, runFolders } from './run-files.js';
export type { ProducedFile, ProducedFiles, ProducedRefusal } from './run-files.js';
export type { ScopeResolver, RequestScope } from './scope.js';
export type { SessionEventListener, SessionEventName } from './realtime.js';
export type { TurnHandle, TurnInput, TurnResult } from './service.js';
export type { EngineScope } from './engine.js';
export { runActivity } from './activity.js';
export { skillUseOf } from './skill-use.js';
