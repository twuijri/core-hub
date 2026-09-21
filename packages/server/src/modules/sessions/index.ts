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
import { HubError } from '../../lib/errors.js';
import { defineModule, REALTIME_NAMESPACES, type HubModule } from '../../lib/module.js';
import { AuditService } from '../audit/index.js';
import { attachSessionsRealtime, sessionsRealtimeFor } from './realtime.js';
import { registerSessionRoutes } from './routes.js';
import { derivedScopeResolver, type ScopeResolver } from './scope.js';
import { SessionsService } from './service.js';
import { SessionsStore } from './store.js';
import type { AgentDirectory, AgentRunner, SessionsPorts } from './ports.js';
import { unavailableAgents, unavailableRunner } from './unavailable.js';

export interface SessionsModuleOptions {
  /** The `agents` registry. Default: nothing is installed (404 on every id). */
  agents?: AgentDirectory;
  /** The `AgentAdapter` slice a run needs. Default: `422 agent_unavailable`. */
  runner?: AgentRunner;
  /** `auth`'s workspace/user resolution. Default: derived from the profile slug. */
  scopes?: ScopeResolver;
  /** Silence from the adapter for this long ends a run as `timed_out`. */
  agentTimeoutMs?: number;
}

export function createSessionsModule(options: SessionsModuleOptions = {}): HubModule {
  const ports: SessionsPorts = {
    agents: options.agents ?? unavailableAgents,
    runner: options.runner ?? unavailableRunner,
    agentTimeoutMs: options.agentTimeoutMs ?? 10 * 60_000,
  };
  const scopes = options.scopes ?? derivedScopeResolver;
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
      ports,
      request.log,
    );
    const stale = created.recoverStaleRuns();
    if (stale > 0) request.log.warn({ runs: stale }, 'sessions: failed runs left by a restart');
    services.set(hub.io, created);
    return created;
  };

  return defineModule({
    name: 'sessions',
    registerRoutes(app: FastifyInstance) {
      registerSessionRoutes(app, { service, scopes });
    },
    registerEvents(io: SocketServer) {
      io.of(REALTIME_NAMESPACES.sessions);
      attachSessionsRealtime(io);
    },
  });
}

/** The module the app composes (`src/modules/index.ts`). */
export const sessionsModule = createSessionsModule();

export const registerRoutes = sessionsModule.registerRoutes.bind(sessionsModule);
export const registerEvents = sessionsModule.registerEvents.bind(sessionsModule);

export type {
  AgentDirectory,
  AgentEvent,
  AgentInfo,
  AgentRunAccepted,
  AgentRunInput,
  AgentRunRequest,
  AgentRunner,
} from './ports.js';
export type { ScopeResolver, RequestScope } from './scope.js';
