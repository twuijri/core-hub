/**
 * Module `audit`: the audit trail, the usage/cost ledger, and the jobs kernel every other
 * module uses for long work (invariant 4).
 *
 * Implemented: `jobs.list`, `jobs.get`, `jobs.cancel`, the `/rt/jobs` namespace, and the
 * `AuditService` / `JobRunner` other modules import from here.
 *
 * Also implemented (Phase 4): `audit.getReport` for `usage` and `skills` (its `logs` and
 * `performance` kinds went with contract decision §74), and the typed Usage and Skills usage screens `audit.getUsage` /
 * `audit.getSkillUsage` (contract decision §50, `analytics.ts`). Skill use is recorded from
 * the version that added it (`skill_uses`); the reports say from when. And the live screens
 * (contract decision §51): `audit.getLivePerformance` (`live.ts`, measured when asked) and
 * `audit.listLogLines` (the hub's log rings, `lib/log-ring.ts`).
 *
 * Composition note: the module object is a singleton shared by every `buildServer()` in a
 * test process, so the service is kept per Socket.IO server (one per app), the same way
 * `auth` keeps its context.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Server as SocketServer } from 'socket.io';
import { loadOpenApiDocument } from '@corehub/contracts';
import { requireSqlite } from '../../lib/db.js';
import { HubError, notFound } from '../../lib/errors.js';
import { createContractIndex } from '../../lib/contract.js';
import { defineModule, REALTIME_NAMESPACES } from '../../lib/module.js';
import { createRealtime, type Realtime } from '../../lib/realtime.js';
import { defineRoute } from '../../lib/route.js';
import { listWorkspacesFor, requireRole, requireUser, requireWorkspace } from '../auth/index.js';
import { UsageAnalytics, type AnalyticsProfile, type AnalyticsSources } from './analytics.js';
import {
  FINISHED_WINDOW_MS,
  backgroundSourcesFor,
  jobItem,
  mergeBackground,
  type BackgroundItem,
} from './background.js';
import { createJobRunner, type JobRunner } from './jobs.js';
import { ReportService, type ReportKind } from './reports.js';
import type { LogLevel } from '../../lib/log-ring.js';
import { LiveSampler, liveSourcesFor, socketsPerProfile } from './live.js';
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
  SkillUseWrite,
  UsageOrigin,
  UsageTotals,
  UsageWrite,
} from './service.js';
export { createJobRunner } from './jobs.js';
export { registerBackgroundSource } from './background.js';
export type {
  BackgroundCaller,
  BackgroundItem,
  BackgroundKind,
  BackgroundSource,
  BackgroundStatus,
} from './background.js';
export { ReportService, isoDate, moneyOf, windowOf } from './reports.js';
export type { Report, ReportKind, ReportRequest } from './reports.js';
export { UsageAnalytics, calendarPeriod } from './analytics.js';
export type {
  AnalyticsProfile,
  AnalyticsQuery,
  AnalyticsSources,
  RunActivityQuery,
  RunActivityRow,
} from './analytics.js';
export type { JobHandle, JobRunner, JobWorker, NewJob } from './jobs.js';
export { LiveSampler, registerLiveSources, socketsPerProfile } from './live.js';
export type {
  HermesProcessInfo,
  HermesProcessKind,
  LivePerformance,
  LiveSources,
  ProfileActivity,
} from './live.js';
export { ProcFs } from './procfs.js';

interface AuditContext {
  audit: AuditService;
  runner: JobRunner;
  realtime: Realtime;
  reports: ReportService;
  analytics: UsageAnalytics;
  live: LiveSampler;
}

/**
 * What the Usage and Skills usage reports read from other modules (runs, agent names,
 * installed skills). Joined once for the process by the composition root, like the other
 * cross-module ports; without it the reports fall back to what the ledgers know.
 */
let analyticsSources: ((app: FastifyInstance) => AnalyticsSources) | null = null;
export function registerAnalyticsSources(
  factory: ((app: FastifyInstance) => AnalyticsSources) | null,
): ((app: FastifyInstance) => AnalyticsSources) | null {
  const previous = analyticsSources;
  analyticsSources = factory;
  return previous;
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
    analytics: new UsageAnalytics(db, analyticsSources?.(app) ?? {}),
    live: new LiveSampler(),
  };
  contexts.set(hub.io, created);
  app.addHook('onClose', () => {
    created.live.close();
  });
  return created;
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

    // ------------------------------------------------ the Background panel (§56)

    defineRoute(app, deps, {
      operationId: 'background.list',
      handler: (request, { query }) => {
        const scope = scopeOf(request);
        const user = request.principal?.user;
        if (!user) throw new HubError('unauthorized');
        const context = contextOf(request.server);
        // `profiles=all`: every workspace this person may enter — `auth`'s rule, never a list
        // the client sends; the header was already checked by `requireWorkspace`.
        const workspaces = new Map<string, string>([[scope.id, scope.slug]]);
        if (query.profiles === 'all') {
          for (const row of listWorkspacesFor(requireSqlite(request.server.hub.database), user)) {
            workspaces.set(row.id, row.slug);
          }
        }
        for (const [id, slug] of workspaces) context.audit.rememberWorkspace(id, slug);
        const since = Date.now() - FINISHED_WINDOW_MS;
        const caller = {
          userId: user.id,
          workspaces: [...workspaces].map(([id, slug]) => ({ id, slug })),
        };
        const items: BackgroundItem[] = [];
        for (const row of context.audit.backgroundJobs(user.id, [...workspaces.keys()], since)) {
          const item = jobItem(row, workspaces.get(row.workspace ?? '') ?? scope.slug);
          if (item) items.push(item);
        }
        for (const source of backgroundSourcesFor(request.server)) {
          items.push(...source.list(caller, since));
        }
        return mergeBackground(items);
      },
    });

    defineRoute(app, deps, {
      operationId: 'background.stop',
      handler: async (request, { params }) => {
        const scope = scopeOf(request);
        const user = request.principal?.user;
        if (!user) throw new HubError('unauthorized');
        const id = String(params.item_id);
        const prefix = id.slice(0, id.indexOf(':'));
        if (prefix === 'job') {
          const context = contextOf(request.server);
          const jobId = id.slice(4);
          const row = context.audit.jobIn(scope.id, jobId);
          const item = row && row.ownerId === user.id ? jobItem(row, scope.slug) : null;
          if (!row || !item) throw notFound({ resource: 'background_item', id });
          if (item.status !== 'queued' && item.status !== 'running') {
            throw new HubError('state_invalid', { details: { reason: 'finished' } });
          }
          if (!item.stoppable) {
            throw new HubError('state_invalid', { details: { reason: 'not_stoppable' } });
          }
          const after = context.runner.cancel(scope.id, jobId);
          return (after && jobItem(after, scope.slug)) ?? item;
        }
        const source = backgroundSourcesFor(request.server).find((candidate) =>
          candidate.prefixes.includes(prefix),
        );
        const stopped = source
          ? await source.stop(
              { userId: user.id, workspace: { id: scope.id, slug: scope.slug } },
              id,
            )
          : null;
        if (!stopped) throw notFound({ resource: 'background_item', id });
        return stopped;
      },
    });

    defineRoute(app, deps, {
      operationId: 'audit.getReport',
      handler: (request, { params, query }) => {
        const kind = params.kind as ReportKind;
        // Both reports are a profile's own: the contract's required `X-Hub-Profile` names it.
        const here = request.workspace;
        if (!here) {
          throw new HubError('bad_request', {
            details: { reason: 'profile_required', header: 'X-Hub-Profile' },
          });
        }
        const context = contextOf(request.server);
        const days = (query.days as number | undefined) ?? 30;
        if (kind === 'skills') {
          // The same body the Skills usage screen reads, for the header's profile alone.
          const data = context.analytics.skills({
            profiles: [{ id: here.id, slug: here.slug, isDefault: here.isDefault }],
            days,
          });
          const period = data.period as { from: string; to: string };
          return {
            kind,
            period: { from: period.from, to: period.to },
            generated_at: data.generated_at,
            data,
          };
        }
        const report = context.reports.build({ kind, workspace: here.id, days });
        // A kind without a builder would say so with the hub's 501 rather than answer zeros
        // that read as a measurement.
        if (!report) {
          throw new HubError('not_implemented', {
            details: { operationId: 'audit.getReport', kind },
          });
        }
        return report;
      },
    });

    /** The profiles a Usage / Skills usage report covers: the header's, or every one enterable. */
    const profilesOf = (request: FastifyRequest, all: boolean): AnalyticsProfile[] => {
      const here = request.workspace;
      const principal = request.principal;
      if (!here || !principal) throw new HubError('internal', { message: 'route has no scope' });
      contextOf(request.server).audit.rememberWorkspace(here.id, here.slug);
      if (!all) return [{ id: here.id, slug: here.slug, isDefault: here.isDefault }];
      // Which profiles "all" means is `auth`'s rule (ADR 0016), never a list the client sends.
      return listWorkspacesFor(requireSqlite(request.server.hub.database), principal.user).map(
        (row) => ({ id: row.id, slug: row.slug, isDefault: row.isDefault }),
      );
    };
    const analyticsQuery = (request: FastifyRequest, query: Record<string, unknown>) => ({
      profiles: profilesOf(request, query.profiles === 'all'),
      days: (query.days as number | undefined) ?? 30,
      agentId: query.agent_id as string | undefined,
      utcOffsetMinutes: (query.utc_offset_minutes as number | undefined) ?? 0,
    });

    defineRoute(app, deps, {
      operationId: 'audit.getUsage',
      handler: (request, { query }) =>
        contextOf(request.server).analytics.usage(analyticsQuery(request, query)),
    });

    defineRoute(app, deps, {
      operationId: 'audit.getSkillUsage',
      handler: (request, { query }) =>
        contextOf(request.server).analytics.skills(analyticsQuery(request, query)),
    });

    defineRoute(app, deps, {
      operationId: 'audit.getLivePerformance',
      handler: async (request) => {
        const server = request.server;
        const sources = liveSourcesFor(server);
        // A source that fails is an empty list on the screen, not a failed screen: the
        // host and the hub can still be measured.
        const listed = <T>(what: string, read: (() => T[]) | undefined): T[] => {
          try {
            return read?.() ?? [];
          } catch (error) {
            request.log.warn({ err: error }, `audit: could not list ${what}`);
            return [];
          }
        };
        const io = server.hub.io;
        return contextOf(server).live.measure({
          processes: listed('the Hermes processes', sources.hermesProcesses?.bind(sources)),
          profiles: listed('the profiles', sources.profileActivity?.bind(sources)),
          sockets: socketsPerProfile(
            Object.values(REALTIME_NAMESPACES).map((namespace) => io.of(namespace)),
          ),
        });
      },
    });

    defineRoute(app, deps, {
      operationId: 'audit.listLogLines',
      handler: (request, { query }) =>
        request.server.hub.logs.query({
          source: (query.source as 'all' | 'hub' | 'hermes' | 'errors' | undefined) ?? 'all',
          profile: query.profile as string | undefined,
          level: query.level as LogLevel | undefined,
          q: query.q as string | undefined,
          limit: (query.limit as number | undefined) ?? 200,
          after: query.after as number | undefined,
        }),
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
