// Module `sessions`: owns chat sessions, messages, streaming runs, tool calls, approvals.
// Public surface of the module: other modules and app/ import this file only.
//
// Composition note: `registerEvents(io)` runs before `registerRoutes(app)` and
// before `app.decorate('hub', …)`, so the realtime layer is created from the
// Socket.IO server (one per app, tracked in `realtime.ts`) and the service is
// built lazily on the first request, when `app.hub.database` exists. That
// keeps one service per app — important because the module object is a
// singleton shared by every `buildServer()` in a test process.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Server as SocketServer } from 'socket.io';
import { requireSqlite } from '../../lib/db.js';
import { HubError } from '../../lib/errors.js';
import { defineModule, REALTIME_NAMESPACES, type HubModule } from '../../lib/module.js';
import { AuditService } from '../audit/index.js';
import { attachSessionsRealtime, sessionsRealtimeFor } from './realtime.js';
import { registerSessionRoutes } from './routes.js';
import { derivedScopeResolver, type ScopeResolver } from './scope.js';
import { SessionsService } from './service.js';
import { SessionsStore } from './store.js';
import type {
  AgentDirectory,
  AgentRunner,
  AttachmentsPort,
  SessionsNotifier,
  SessionsPorts,
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
  });
  const scopesFor = (app: FastifyInstance): ScopeResolver =>
    resolvePort(options.scopes ?? derivedScopeResolver, app);
  const services = new WeakMap<SocketServer, SessionsService>();

  const service = (request: FastifyRequest): SessionsService => {
    const hub = request.server.hub;
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
      portsFor(request.server),
      request.log,
      hub.config.dataDir,
    );
    const stale = created.recoverStaleRuns();
    if (stale > 0) request.log.warn({ runs: stale }, 'sessions: failed runs left by a restart');
    services.set(hub.io, created);
    return created;
  };

  return defineModule({
    name: 'sessions',
    registerRoutes(app: FastifyInstance) {
      registerSessionRoutes(app, { service, scopes: scopesFor(app) });
    },
    registerEvents(io: SocketServer) {
      io.of(REALTIME_NAMESPACES.sessions);
      attachSessionsRealtime(io);
    },
  });
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
} from './ports.js';
export { RUN_FILES_DIR, collectOutputs, ensureRunFolders, runFolders } from './run-files.js';
export type { ProducedFile, ProducedFiles, ProducedRefusal } from './run-files.js';
export type { ScopeResolver, RequestScope } from './scope.js';
