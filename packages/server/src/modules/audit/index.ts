/**
 * Module `audit`: the audit trail, the usage/cost ledger, performance snapshots, and the
 * jobs kernel every other module uses for long work (invariant 4).
 *
 * Implemented: `jobs.list`, `jobs.get`, `jobs.cancel`, the `/rt/jobs` namespace, and the
 * `AuditService` / `JobRunner` other modules import from here.
 *
 * Also implemented (Phase 4): `audit.getReport` for `usage`, `logs` and `performance`.
 * `skills` still answers `501` with its operation id, because nothing records skill use
 * yet and a page of zeros would read as "no skills were used" — see `reports.ts`.
 *
 * Composition note: the module object is a singleton shared by every `buildServer()` in a
 * test process, so the service is kept per Socket.IO server (one per app), the same way
 * `auth` keeps its context.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Server as SocketServer } from 'socket.io';
import { loadOpenApiDocument } from '@majlis/contracts';
import { newUlid } from '../../db/ids.js';
import { requireSqlite } from '../../lib/db.js';
import { HubError, notFound } from '../../lib/errors.js';
import { createContractIndex } from '../../lib/contract.js';
import { defineModule, REALTIME_NAMESPACES } from '../../lib/module.js';
import { createRealtime, type Realtime } from '../../lib/realtime.js';
import { defineRoute } from '../../lib/route.js';
import { requireRole, requireUser, requireWorkspace } from '../auth/index.js';
import { createJobRunner, type JobRunner } from './jobs.js';
import { ReportService, type LogLevel, type ReportKind } from './reports.js';
import { AuditService, serializeJob } from './service.js';

export { AuditService, serializeJob } from './service.js';
export type {
  ActorKind,
  AuditEventInput,
  ContractJobKind,
  CostSource,
  JobCreate,
  JobRow,
  JobStatus,
  UsageOrigin,
  UsageTotals,
  UsageWrite,
} from './service.js';
export { createJobRunner } from './jobs.js';
export { ReportService, isoDate, moneyOf, windowOf } from './reports.js';
export type { LogLevel, Report, ReportKind, ReportRequest } from './reports.js';
export type { JobHandle, JobRunner, JobWorker, NewJob } from './jobs.js';

interface AuditContext {
  audit: AuditService;
  runner: JobRunner;
  realtime: Realtime;
  reports: ReportService;
}

/** One context per Socket.IO server, so several hubs in one process (tests) do not mix. */
const contexts = new WeakMap<SocketServer, AuditContext>();

function contextOf(app: FastifyInstance): AuditContext {
  const { hub } = app;
  const existing = contexts.get(hub.io);
  if (existing) return existing;
  const db = requireSqlite(hub.database);
  const realtime = createRealtime(hub.io);
  const audit = new AuditService(db);
  audit.announceWith((event, profile, job) => {
    realtime.emit(REALTIME_NAMESPACES.jobs, event, { profile }, { job });
  });
  const reports = new ReportService(db);
  const created: AuditContext = {
    audit,
    realtime,
    runner: createJobRunner({ audit, log: app.log }),
    reports,
  };
  contexts.set(hub.io, created);
  startSampler(app, reports);
  return created;
}

/** How often the hub writes down what it is using. One row a minute is 1 440 a day. */
export const SAMPLE_INTERVAL_MS = 60_000;

/** A row nobody signed: the hub measuring itself has no user behind it. */
const SYSTEM_OWNER = '00000000000000000000000000';

/**
 * The Performance screen needs a history, and a history has to be written by somebody.
 * The hub writes one row a minute about itself, and stops when the app closes — a timer
 * that outlives its app would keep a test process alive for ever, so it is `unref`'d and
 * hooked to `onClose` as well.
 */
function startSampler(app: FastifyInstance, reports: ReportService): void {
  const timer = setInterval(() => {
    try {
      reports.sample({
        id: newUlid(),
        ownerId: SYSTEM_OWNER,
        queuedJobs: reports.queuedJobs(),
        connectedClients: app.hub.io.engine?.clientsCount ?? 0,
      });
    } catch (error) {
      // A sample nobody can write is not worth failing a hub over.
      app.log.debug({ err: error }, 'audit: performance sample failed');
    }
  }, SAMPLE_INTERVAL_MS);
  timer.unref?.();
  app.addHook('onClose', () => {
    clearInterval(timer);
  });
}

/** The audit ledger for this app; callers use it during a request, when `app.hub` exists. */
export function auditFor(app: FastifyInstance): AuditService {
  return contextOf(app).audit;
}

/** The job runner for this app. */
export function jobRunnerFor(app: FastifyInstance): JobRunner {
  return contextOf(app).runner;
}

export const auditModule = defineModule({
  name: 'audit',
  registerRoutes(app: FastifyInstance) {
    const document = loadOpenApiDocument();
    if (!document) throw new Error('packages/contracts/openapi.yaml is required (ADR 0003)');
    const deps = {
      contract: createContractIndex(document),
      guards: { requireUser, requireWorkspace, requireRole },
    };

    const scopeOf = (request: FastifyRequest) => {
      const workspace = request.workspace;
      if (!workspace) throw new HubError('internal', { message: 'route has no workspace' });
      // Jobs store the workspace id and report its slug; registering the pair here is what
      // lets a `/rt/jobs` event name the profile it belongs to.
      contextOf(request.server).audit.rememberWorkspace(workspace.id, workspace.slug);
      return workspace;
    };

    defineRoute(app, deps, {
      operationId: 'jobs.list',
      handler: (request, { query }) => {
        const scope = scopeOf(request);
        const page = contextOf(request.server).audit.listJobs({
          workspace: scope.id,
          status: query.status as string | undefined,
          kind: query.kind as string | undefined,
          cursor: query.cursor as string | undefined,
          limit: query.limit as number | undefined,
        });
        return {
          items: page.items.map((row) => serializeJob(row, scope.slug)),
          next_cursor: page.next_cursor,
        };
      },
    });

    defineRoute(app, deps, {
      operationId: 'jobs.get',
      handler: (request, { params }) => {
        const scope = scopeOf(request);
        const id = params.job_id as string;
        const row = contextOf(request.server).audit.jobIn(scope.id, id);
        if (!row) throw notFound({ resource: 'job', id });
        return serializeJob(row, scope.slug);
      },
    });

    defineRoute(app, deps, {
      operationId: 'jobs.cancel',
      handler: (request, { params }) => {
        const scope = scopeOf(request);
        const id = params.job_id as string;
        const context = contextOf(request.server);
        const current = context.audit.jobIn(scope.id, id);
        if (!current) throw notFound({ resource: 'job', id });
        if (['succeeded', 'failed', 'cancelled'].includes(current.status)) {
          throw new HubError('conflict', {
            details: { reason: 'job_already_finished', status: current.status },
          });
        }
        const row = context.runner.cancel(scope.id, id);
        if (!row) throw notFound({ resource: 'job', id });
        return serializeJob(row, scope.slug);
      },
    });

    defineRoute(app, deps, {
      operationId: 'audit.getReport',
      handler: (request, { params, query }) => {
        const kind = params.kind as ReportKind;
        // `usage` and `skills` are a workspace's own; `logs` and `performance` are the
        // hub's. The contract says so with an optional `X-Hub-Profile`, so the header
        // decides rather than this handler inventing a scope.
        const workspace =
          kind === 'usage' || kind === 'skills' ? (request.workspace?.id ?? null) : null;
        if ((kind === 'usage' || kind === 'skills') && workspace === null) {
          throw new HubError('bad_request', {
            details: { reason: 'profile_required', header: 'X-Hub-Profile' },
          });
        }
        const report = contextOf(request.server).reports.build({
          kind,
          workspace,
          days: (query.days as number | undefined) ?? 30,
          q: query.q as string | undefined,
          level: query.level as LogLevel | undefined,
        });
        // The one kind with nothing behind it says so with the hub's own 501, rather than
        // answering zeros that would read as a measurement.
        if (!report) {
          throw new HubError('not_implemented', {
            details: { operationId: 'audit.getReport', kind },
          });
        }
        return report;
      },
    });
  },
  registerEvents(io: SocketServer) {
    // `/rt/jobs` carries no client commands: every job of the profile arrives on connect
    // (packages/contracts/events/README.md). The namespace itself is created by
    // app/sockets.ts and authenticated by auth's handshake middleware.
    io.of(REALTIME_NAMESPACES.jobs);
  },
});

export const registerRoutes = auditModule.registerRoutes.bind(auditModule);
export const registerEvents = auditModule.registerEvents.bind(auditModule);
