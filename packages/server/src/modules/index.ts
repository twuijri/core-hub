// The module list the app composes, in mount order. Every module in ARCHITECTURE §Modules is here.
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { HubModule } from '../lib/module.js';
import { requireSqlite } from '../lib/db.js';
import type { SessionsNotifier } from './sessions/ports.js';
import {
  MAX_EXPORT_BYTES,
  ProfileArchiveRefusal,
  ProfileArchiveUnavailable,
  ProfileMirrorError,
  RUNTIME_DEFAULT_PROFILE,
  authModule,
  findUser,
  listWorkspacesFor,
  principalScopeResolver,
  registerProfileMirror,
  onProfileCreated,
  profileCreatedFor,
  registerProfileTransfer,
  type ProfileArchiveRuntime,
  type ProfileTransferPorts,
} from './auth/index.js';
import {
  HermesProfileError,
  agentDirectory,
  agentRunner,
  agentsModule,
  agentsServiceFor,
  HermesDashboardRefusal,
  HermesDashboardUnavailable,
  type HermesDashboard,
  createHermesProfileArchives,
  createHermesProfiles,
  hermesDashboardFor,
  hermesProfileRunner,
  hermesRuntimeFor,
  registerAgentAttachments,
} from './agents/index.js';
import {
  attachmentReferences,
  createSessionsModule,
  registerWorkflowGate,
  sessionRunsFor,
  sessionTurnsFor,
  workflowApprovalsFor,
} from './sessions/index.js';
import { roomsModule } from './rooms/index.js';
import {
  HermesApiUnavailable,
  HermesRefusal,
  createHermesCardApi,
  registerHermesBoard,
  registerTaskNames,
  registerTaskRunner,
  tasksModule,
  type HermesCardApi,
} from './tasks/index.js';
import { createHermesKanban, processRunner } from './tasks/hermes-kanban.js';
import { createHermesJobs } from './schedules/hermes-jobs.js';
import {
  registerHermesCron,
  registerScheduleRunner,
  registerWorkflowPorts,
  schedulesModule,
  workflowGateFor,
} from './schedules/index.js';
import {
  attachmentsPort,
  knowledgeModule,
  profileArchiveFiles,
  registerAttachmentReferences,
} from './knowledge/index.js';
import { modelsModule, modelsServiceFor } from './models/index.js';
import { devicesModule } from './devices/index.js';
import { createNotifier, notifyModule } from './notify/index.js';
import { updatesModule } from './updates/index.js';
import { auditModule } from './audit/index.js';
import { pluginsModule } from './plugins/index.js';

// The one wiring line the sessions module asked for: its ports come from `agents` (the
// registry and the runner over the adapters), `auth` (who is asking, in which workspace)
// and `knowledge` (the file registry a turn reads from and writes back to).
/**
 * `sessions` announces what happened; `notify` decides whether the person hears it and in
 * which words. The translation between the two lives here, in the composition root, so
 * neither module has to know the other exists (ARCHITECTURE §Modules).
 */
export const notifierPort = (app: FastifyInstance): SessionsNotifier => {
  const notifier = createNotifier(requireSqlite(app.hub.database), () => app.hub.io);
  return {
    runFinished(input) {
      notifier.announce(
        { userId: input.userId, workspace: input.workspace, profile: input.profile },
        input.outcome === 'succeeded'
          ? { kind: 'run_completed', agent: input.agentName, session: input.sessionTitle }
          : {
              kind: 'run_failed',
              agent: input.agentName,
              session: input.sessionTitle,
              reason: input.reason,
            },
        { kind: 'session', id: input.sessionId },
      );
    },
    approvalRequested(input) {
      notifier.announce(
        { userId: input.userId, workspace: input.workspace, profile: input.profile },
        { kind: 'approval_requested', agent: input.agentName, session: '', what: input.what },
        // A workflow waiting at a step opens its run; an agent waiting opens its chat.
        input.resource ?? { kind: 'session', id: input.sessionId },
      );
    },
  };
};

export const sessionsModule = createSessionsModule({
  agents: agentDirectory,
  runner: agentRunner,
  attachments: attachmentsPort,
  scopes: principalScopeResolver,
  notifier: notifierPort,
});

// The other direction of the same pair: `knowledge` refuses to delete a file a message
// still points at, and only `sessions` knows that (contract `409` on deleteAttachment).
registerAttachmentReferences(attachmentReferences);

// A skill pack is an uploaded file (`purpose: skill`); `agents` installs it and `knowledge`
// owns the bytes. Only the copy-out is lent, the same one a chat turn uses.
registerAgentAttachments((app) => ({
  materialise: (workspace, ids, directory) =>
    attachmentsPort(app).materialise(workspace, ids, directory),
}));

/**
 * The Tasks board reflects Hermes's own kanban (owner decision, 2026-09-23). `agents`
 * knows where Hermes lives — its executable and the home the gateway runs in — and
 * `tasks` knows what a card is; this is the one place allowed to put them together.
 *
 * There is a kanban only while both exist: no executable on this host, or no home to
 * point it at, and every card is simply the hub's own.
 *
 * The writes Hermes's CLI cannot make — a card's words, priority, deletion, comments,
 * reassignment, stopping its run — go through Hermes's own server (ADR 0015), which exists
 * only where the hub supervises Hermes. Its errors are translated here into the tasks
 * module's own, so neither module imports the other: Hermes's refusal stays Hermes's
 * sentence, and a server that is not there says so.
 */
registerHermesBoard((app) => ({
  kanban() {
    const runtime = hermesRuntimeFor(app);
    const home = runtime.status().home;
    const command = runtime.executable();
    if (!home || !command) return null;
    return createHermesKanban(processRunner({ command, home, env: runtime.cliEnv() }));
  },
  agentId: (workspace) => hermesAgentId(app, workspace),
  api: () => hermesCardApi(app),
  profiles: () =>
    // Every workspace, not the ones one person may enter: this maps Hermes's profiles, and
    // the routes check who may do what.
    listWorkspacesFor(requireSqlite(app.hub.database), { id: '', role: 'owner' }).map((row) => ({
      workspace: row.id,
      slug: row.slug,
      profile: row.isDefault ? RUNTIME_DEFAULT_PROFILE : row.slug,
    })),
}));

function hermesCardApi(app: FastifyInstance): HermesCardApi | null {
  const dashboard = hermesDashboardFor(app);
  if (!dashboard) return null;
  return createHermesCardApi({
    warm: () => dashboard.warm(),
    request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      try {
        return await dashboard.request<T>(method, path, body);
      } catch (error) {
        if (error instanceof HermesDashboardRefusal) {
          throw new HermesRefusal(error.verb, error.message);
        }
        if (error instanceof HermesDashboardUnavailable) {
          throw new HermesApiUnavailable(error.message);
        }
        throw error;
      }
    },
  });
}

/** The registry id of the Hermes agent. Agents are hub-wide rows; the scope only shapes settings. */
function hermesAgentId(app: FastifyInstance, workspace: string): string | null {
  const found = agentsServiceFor(app)
    .list({ id: workspace, slug: '', name: '', isDefault: false }, { kind: 'hermes' })
    .find((agent) => agent.slug === 'hermes');
  return found?.id ?? null;
}

/**
 * A workspace is a Hermes profile (ADR 0014). `auth` owns workspaces, `agents` knows where
 * Hermes lives; creating a workspace creates Hermes's profile of the same name, and a
 * profile Hermes already has is listed as a workspace. Only where the hub can run `hermes`
 * against its home — otherwise a workspace stays the hub's own filter.
 */
registerProfileMirror((app) => {
  const runtime = hermesRuntimeFor(app);
  const home = runtime.status().home;
  const command = runtime.executable();
  if (!home || !command) return null;
  const profiles = createHermesProfiles({
    home,
    run: hermesProfileRunner({ command, home, env: runtime.cliEnv() }),
  });
  return {
    list: () => profiles.list(),
    async create(name, origin) {
      try {
        await profiles.create(name, origin);
      } catch (error) {
        throw error instanceof HermesProfileError ? new ProfileMirrorError(error.message) : error;
      }
    },
    async setDisplayName(name, displayName) {
      try {
        await profiles.setDisplayName(name, displayName);
      } catch (error) {
        throw error instanceof HermesProfileError ? new ProfileMirrorError(error.message) : error;
      }
    },
  };
});

/**
 * A profile moves as Hermes's own archive (ADR 0014 stage 2). `auth` owns the operations,
 * `agents` reaches Hermes's server — only where the hub supervises Hermes (ADR 0015), so
 * anywhere else `runtime` is null and `auth` refuses by name — `knowledge` keeps the bytes,
 * and `models` knows every provider key the export must not carry out (ADR 0010).
 */
export function profileTransferPorts(
  app: FastifyInstance,
  runtime: ProfileArchiveRuntime | null = hermesProfileArchives(app),
): ProfileTransferPorts {
  const hermes = hermesRuntimeFor(app);
  return {
    runtime,
    files: profileArchiveFiles(app, MAX_EXPORT_BYTES),
    secrets: () => {
      const values = modelsServiceFor(app).storedSecretValues();
      const apiKey = hermes.apiKey();
      return apiKey ? [...values, apiKey] : values;
    },
    // An export "with providers" carries them; an import makes them the profile's own (§37).
    providers: {
      exportOf: (workspaceId) => modelsServiceFor(app).exportProviders(workspaceId),
      importInto: (workspaceId, actorId, bundle) =>
        modelsServiceFor(app).importProviders(workspaceId, { userId: actorId }, bundle),
    },
    added: (profile, actorId) => profileCreatedFor(app, { profile, source: null, actorId }),
  };
}

/**
 * A profile just made — here, as a copy, or by an import (contract decision §37): a copy
 * takes its source's own providers with their keys, and the Hermes profile gets the
 * providers it uses (endpoints in its config, its own keys in its `.env`) before its first
 * turn rather than on it.
 */
onProfileCreated((app, { profile, source, actorId }) => {
  const models = modelsServiceFor(app);
  if (source) models.copyOwnProviders(source.id, profile.id, { userId: actorId });
  const home = hermesRuntimeFor(app).status().home;
  if (home && !profile.isDefault) models.prepareProfile(path.join(home, 'profiles', profile.slug));
});

/** Hermes's archives through its server, with its errors in `auth`'s words; null unmanaged. */
function hermesProfileArchives(app: FastifyInstance): ProfileArchiveRuntime | null {
  const dashboard = hermesDashboardFor(app);
  return dashboard ? hermesArchivesOver(dashboard) : null;
}

/** The archive calls over one dashboard server (the real-Hermes test hands in its own). */
export function hermesArchivesOver(dashboard: HermesDashboard): ProfileArchiveRuntime {
  return createHermesProfileArchives(async (method, path, body, options) => {
    try {
      return await dashboard.request(method, path, body, options);
    } catch (error) {
      if (error instanceof HermesDashboardRefusal) throw new ProfileArchiveRefusal(error.message);
      if (error instanceof HermesDashboardUnavailable) {
        throw new ProfileArchiveUnavailable(error.message);
      }
      throw error;
    }
  });
}

registerProfileTransfer((app) => profileTransferPorts(app));

/**
 * Hermes's own scheduler on the Schedules page (`schedules/hermes-cron.ts`). Reached over
 * the gateway's API with the key every chat turn uses; there is a scheduler only while the
 * hub supervises or found a gateway — otherwise every schedule is the hub's own.
 */
registerHermesCron((app) => ({
  jobs() {
    const runtime = hermesRuntimeFor(app);
    const { mode, endpoint } = runtime.status();
    if (mode !== 'managed' && mode !== 'external') return null;
    const jobs = createHermesJobs({
      baseUrl: endpoint,
      apiKey: () => runtime.apiKey(),
      fetch: runtime.apiFetch(),
    });
    // A job only fires where a gateway serves its profile (`agents/hermes-gateways.ts`): after
    // every write the set of profiles needing one is checked again.
    const then = <T>(written: Promise<T>): Promise<T> =>
      written.finally(() => {
        void runtime.scheduledJobsChanged().catch(() => {
          // The periodic check catches up; a write that worked is not made to fail here.
        });
      });
    return {
      list: () => jobs.list(),
      create: (input) => then(jobs.create(input)),
      update: (id, patch) => then(jobs.update(id, patch)),
      remove: (id) => then(jobs.remove(id)),
      pause: (id) => then(jobs.pause(id)),
      resume: (id) => then(jobs.resume(id)),
      run: (id) => then(jobs.run(id)),
    };
  },
  agentId: (workspace) => hermesAgentId(app, workspace),
  timezone: () => hermesRuntimeFor(app).timezone(),
}));

/**
 * A workflow step reaches two other modules: an agent turn is a `sessions` run in a session
 * of its own, and a `notify` step is a notice in the run owner's inbox. Neither module
 * knows `schedules` exists; this is where they meet.
 */
registerWorkflowPorts((app) => {
  const notifier = createNotifier(requireSqlite(app.hub.database), () => app.hub.io);
  return {
    agentTurn: async (scope, input) => {
      const turn = sessionTurnsFor(app);
      if (!turn) throw new Error('this hub composes no sessions module');
      return turn(scope, { ...input, source: 'workflow' });
    },
    notice: (scope, input) =>
      notifier.announce(
        { userId: scope.userId, workspace: scope.workspace, profile: scope.profile },
        { kind: 'system', title: input.title, body: input.body },
        null,
      ),
    // A step that waits for a person raises an ordinary approval: listed with the others,
    // announced profile-wide, in the inbox, answered by the same `respondApproval`.
    approvals: {
      raise(scope, input) {
        const approvals = workflowApprovalsFor(app);
        if (!approvals) throw new Error('this hub composes no sessions module to ask anyone');
        return approvals.raise(scope, input);
      },
      cancel: (scope, workflowRunId) =>
        workflowApprovalsFor(app)?.cancel(scope, workflowRunId) ?? 0,
    },
  };
});

/** The answer to a workflow step's gate (`sessions`) continues the paused run (`schedules`). */
registerWorkflowGate((app) => workflowGateFor(app));

/**
 * The hub fires its own schedules: a prompt schedule's run is a `sessions` turn in a
 * session of its own (source `schedule`, origin its history line), which the history opens.
 */
registerScheduleRunner((app) => {
  const runs = sessionRunsFor(app);
  if (!runs) return null;
  return {
    start: (scope, input) =>
      runs.start(scope, {
        agentId: input.agentId,
        prompt: input.prompt,
        title: input.title,
        source: 'schedule',
        // The session serves one firing: its origin is the history line (`schedule_run`).
        origin: { kind: 'schedule', id: input.scheduleRunId },
      }),
    outcome: (workspace, runId) => runs.outcome(workspace, runId),
    // `overlap: replace` stops the previous run the way the chat's Stop does.
    cancel: (scope, sessionId, runId) => runs.cancel(scope, sessionId, runId),
  };
});

/**
 * Assigning a task starts it: the task's run is a `sessions` turn in a session of its own
 * (source `task`, origin the task), and the task follows it to its end. `tasks` defines
 * what it needs (`TaskRunPort`) and never sees a session table; this is where they meet.
 */
registerTaskRunner((app) => {
  const runs = sessionRunsFor(app);
  if (!runs) return null;
  return {
    start: (scope, input) =>
      runs.start(scope, {
        agentId: input.agentId,
        prompt: input.prompt,
        title: input.title,
        source: 'task',
        model: input.model,
        provider: input.provider,
        origin: { kind: 'task', id: input.taskId },
        workingDir: input.workingDir,
      }),
    cancel: (scope, sessionId, runId) => runs.cancel(scope, sessionId, runId),
    outcome: (workspace, runId) => runs.outcome(workspace, runId),
  };
});

/**
 * The names a card shows: an agent's from the registry (`agents`), a person's from `auth`.
 * Resolved on the hub, so a card from any profile carries its agent's name — the board
 * gathers every profile, and a client guessing from the agents of the profile it is in
 * would show an id for the rest (DECISIONS §32).
 */
registerTaskNames((app) => (kind, id) => {
  if (kind === 'agent') return agentsServiceFor(app).loadAgent(id).name;
  const user = findUser(requireSqlite(app.hub.database), id);
  return user ? user.displayName?.trim() || user.username : null;
});

export const modules: readonly HubModule[] = [
  authModule,
  agentsModule,
  sessionsModule,
  roomsModule,
  tasksModule,
  schedulesModule,
  knowledgeModule,
  modelsModule,
  devicesModule,
  notifyModule,
  updatesModule,
  auditModule,
  pluginsModule,
];
