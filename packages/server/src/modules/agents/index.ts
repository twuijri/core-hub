/**
 * Module `agents`: the curated catalog, the registry, the adapters (ADR 0002) and the
 * install lifecycle as jobs (ADR 0006).
 *
 * Implemented: `agents.list`, `agents.get`, `agents.update`, `agents.getSettings`,
 * `agents.updateSettings`, `agents.install`, `agents.uninstall`, `agents.upgrade`,
 * `agents.checkUpdate`, `agents.discover`.
 *
 * `agents.restart` restarts the Hermes runtime when this hub supervises it (ADR 0008,
 * `hermes-runtime.ts`); an external or absent runtime answers `409 state_invalid`.
 *
 * The three tool operations that need Hermes to act — `agents.testMcpServer`,
 * `agents.loginChannel` (WhatsApp by QR) — go through Hermes's own API in the selected
 * profile (`hermes-tools.ts`, ADR 0015); `agents.importSkills` installs an uploaded pack into
 * the profile's `skills/` (`skill-import.ts`), because Hermes has no importer. The plugin
 * operations (`agents.listPlugins`, `updatePlugin`, `installPlugin`, `deletePlugin`) run
 * Hermes's own `hermes plugins` command against the selected profile's home
 * (`hermes-plugins.ts`).
 *
 * Still documented 501 stubs, with the reason:
 * - `agents.getAvatar` — every agent is a `generated` avatar drawn from its slug until
 *   the `knowledge` module stores attachments.
 * - presets, journey and config files —
 *   each is a read or a write against the agent's own home through its adapter, and that
 *   adapter surface (the Hermes gateway RPC) arrives with the `sessions` module.
 *
 * Composition note: the module object is a singleton shared by every `buildServer()` in a
 * test process, so the service is kept per Socket.IO server (one per app), the same way
 * `auth` keeps its context.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Server as SocketServer } from 'socket.io';
import { loadOpenApiDocument } from '@majlis/contracts';
import { requireSqlite } from '../../lib/db.js';
import { HubError, notFound } from '../../lib/errors.js';
import { createContractIndex } from '../../lib/contract.js';
import { defineModule } from '../../lib/module.js';
import { createRealtime } from '../../lib/realtime.js';
import { defineRoute } from '../../lib/route.js';
import { t } from '../../i18n/index.js';
import {
  findWorkspace,
  ownerUser,
  registerWorkspaceStatsProvider,
  requireRole,
  requireUser,
  requireWorkspace,
  type WorkspaceScope,
} from '../auth/index.js';
import { auditFor, jobRunnerFor } from '../audit/index.js';
import { createAdapterSet, type AdapterSet, type AdapterSetOptions } from './adapters/index.js';
import type { AdapterKind } from './adapters/types.js';
import { HERMES_ENTRY } from './catalog/index.js';
import { HermesRuntime, type HermesRuntimeStatus, type Spawner } from './hermes-runtime.js';
import { HermesDashboard, type DashboardSpawner } from './hermes-dashboard.js';
import { QR_PLATFORMS, pairWhatsApp, testMcpServer, type HermesApiCall } from './hermes-tools.js';
import { namedHermesProfiles } from './hermes-profiles.js';
import {
  hermesCliRunner,
  installPlugin,
  listPlugins,
  removePlugin,
  setPluginEnabled,
  type HermesCli,
} from './hermes-plugins.js';
import { hermesProfileName, profileHome } from './profile-home.js';
import { SkillImportError, installPack, planImport, type UploadedFile } from './skill-import.js';
import { createNpmInstaller, managedBinDirs, type AgentInstaller } from './installer.js';
import type { AgentDirectoryPort, AgentInfo, AgentModelsPort, AgentRunnerPort } from './ports.js';
import { AgentRunner } from './runner.js';
import { AgentsService, type AgentPatchInput } from './service.js';
import { ChannelError, clearChannel, listChannels, putChannel, type Channel } from './channels.js';
import {
  MemoryError,
  deleteMemory,
  listMemory,
  migrateLegacyMemory,
  putMemory,
  type MemoryDocument,
} from './memory.js';
import {
  McpError,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  putMcpServer,
  type McpServer,
} from './mcp.js';
import {
  SkillError,
  categoryDescription,
  deleteSkill,
  skillsDir,
  getSkill,
  listSkills,
  putSkill,
  setSkillEnabled,
  type Skill,
} from './skills.js';

export { AgentsService } from './service.js';
export type { AgentPatchInput, AgentsServiceOptions, ReconcileReport } from './service.js';
export { createAdapterSet } from './adapters/index.js';
export type { AdapterSet, AdapterSetOptions } from './adapters/index.js';
export {
  agentBinDir,
  agentPrefix,
  agentsRoot,
  createNpmInstaller,
  managedBinDirs,
} from './installer.js';
export type { AgentInstaller } from './installer.js';
export {
  CATALOG,
  HERMES_ENTRY,
  INSTALLABLE,
  assertCatalogIsWellFormed,
  catalogEntry,
  entriesFor,
  isManaged,
  pinnedVersion,
} from './catalog/index.js';
export type { CatalogEntry, HealthCheck, InstallRecipe } from './catalog/index.js';
export type {
  AgentDirectoryPort,
  AgentInfo,
  AgentModelsPort,
  AgentRunnerPort,
  RunnerEvent,
} from './ports.js';

/**
 * The shared provider store (ADR 0010), registered by the `models` module at boot.
 *
 * A slot rather than a constructor argument because `agents` mounts before `models` in
 * the composition order, and inverting that order would make the registry depend on the
 * provider store being up. Until it is registered, an agent starts with its own settings
 * only — never with a wrong key.
 *
 * Keyed to the app's own Socket.IO server, exactly like `contexts` below: two hubs in one
 * process (the test suite builds dozens) must never share a port, or one hub's agents
 * would resolve credentials out of another hub's database.
 */
const modelsPorts = new WeakMap<SocketServer, AgentModelsPort>();

export function registerAgentModelsPort(io: SocketServer, port: AgentModelsPort): void {
  modelsPorts.set(io, port);
}

export function agentModelsPort(io: SocketServer): AgentModelsPort | null {
  return modelsPorts.get(io) ?? null;
}
export { AgentRunner, toRunnerEvent, toolKindOf, mintSessionRef } from './runner.js';
export type { HermesApiCall } from './hermes-tools.js';
export type { HermesCli } from './hermes-plugins.js';
export { HermesRuntime, loadOrCreateHermesApiKey } from './hermes-runtime.js';
export {
  HermesProfileError,
  PROFILE_ARCHIVE_TIMEOUT_MS,
  createHermesProfileArchives,
  createHermesProfiles,
  hermesProfileRunner,
  namedHermesProfiles,
  type HermesProfileArchives,
  type HermesProfiles,
} from './hermes-profiles.js';
export type {
  HermesRuntimeMode,
  HermesRuntimeStatus,
  SpawnedProcess,
  Spawner,
} from './hermes-runtime.js';
export {
  HermesDashboard,
  HermesDashboardRefusal,
  HermesDashboardUnavailable,
  type DashboardSpawner,
  type HermesDashboardStatus,
} from './hermes-dashboard.js';

/** Test seams: a fake PATH, a fake adapter set, a fake installer. Set before the app boots. */
export interface AgentsOverrides {
  adapters?: AdapterSet;
  installer?: AgentInstaller;
  pathValue?: string;
  /** Options for the real adapter set (a stubbed `fetch` for the Hermes gateway probe). */
  adapterOptions?: Omit<AdapterSetOptions, 'host'>;
  /** The Hermes runtime supervisor's seams (a fake spawner, a health interval). */
  runtime?: { spawnImpl?: Spawner; healthIntervalMs?: number };
  /** Hermes's dashboard API's seams (a fake spawner and `fetch`, a short idle). */
  dashboard?: { spawnImpl?: DashboardSpawner; fetchImpl?: typeof fetch; idleMs?: number };
  /**
   * Hermes's API as the agent tools call it (MCP test, WhatsApp pairing), in place of the
   * dashboard — for a hub that does not supervise a real Hermes (the tests, the e2e hub).
   */
  hermesApi?: HermesApiCall;
  /**
   * Hermes's own command as the plugin pages run it (`hermes plugins …` against a profile's
   * home), in place of the real `hermes` — for the tests and the e2e hub.
   */
  hermesCli?: HermesCli;
  /** Between two questions to Hermes while a pairing runs. Default 1 s. */
  pairingPollMs?: number;
}

let pendingOverrides: AgentsOverrides | null = null;
const overrides = new WeakMap<SocketServer, AgentsOverrides>();

/**
 * Used by the test helpers: the next app to build takes these. Keyed to the app's own
 * Socket.IO server as soon as it exists, so two hubs in one process never share fakes.
 */
export function overrideAgents(next: AgentsOverrides | null): void {
  pendingOverrides = next;
}

interface AgentsContext {
  service: AgentsService;
  adapters: AdapterSet;
  runner: AgentRunner;
  runtime: HermesRuntime;
  dashboard: HermesDashboard;
  /** Hermes's API for the agent tools, or `null` where the hub does not supervise Hermes. */
  hermesApi(): HermesApiCall | null;
  /** Hermes's own command, or `null` where the hub does not supervise Hermes. */
  hermesCli(): HermesCli | null;
  pairingPollMs: number;
}

/**
 * The uploaded files a skill import reads, lent by `knowledge` (which owns the bytes) through
 * the composition root. Without it there is nothing to import from.
 */
export interface AgentAttachmentsPort {
  materialise(
    workspace: string,
    ids: readonly string[],
    directory: string,
  ): Array<{ id: string; name: string; path: string; mime: string; sizeBytes: number }>;
}

let attachmentsFactory: ((app: FastifyInstance) => AgentAttachmentsPort) | null = null;

/** Called once from `src/modules/index.ts`; `knowledge` provides the implementation. */
export function registerAgentAttachments(
  factory: (app: FastifyInstance) => AgentAttachmentsPort,
): void {
  attachmentsFactory = factory;
}

/**
 * Earlier hubs wrote `MEMORY.md` / `USER.md` at a profile's root, where Hermes never reads.
 * At boot every profile's are moved once into `memories/` (`memory.ts` §migrateLegacyMemory),
 * so the words reach the agent's next conversation without anyone opening the Memory page.
 * Best effort: a profile that cannot be moved is logged and tried again on its next memory read.
 */
export function migrateMemoryOfEveryProfile(
  root: string | null | undefined,
  log: Pick<FastifyInstance['log'], 'info' | 'warn'>,
): void {
  if (!root) return;
  const homes = [
    { profile: 'default', home: root },
    ...namedHermesProfiles(root).map((name) => ({
      profile: name,
      home: path.join(root, 'profiles', name),
    })),
  ];
  for (const { profile, home } of homes) {
    try {
      const moved = migrateLegacyMemory(home);
      if (moved.length > 0) {
        log.info({ profile, moved }, 'agents: memory moved to where Hermes reads it');
      }
    } catch (error) {
      log.warn({ profile, err: error }, 'agents: could not move memory to where Hermes reads it');
    }
  }
}

const contexts = new WeakMap<SocketServer, AgentsContext>();

function contextOf(app: FastifyInstance): AgentsContext {
  const { hub } = app;
  const existing = contexts.get(hub.io);
  if (existing) return existing;
  if (pendingOverrides) {
    overrides.set(hub.io, pendingOverrides);
    pendingOverrides = null;
  }
  const own = overrides.get(hub.io) ?? {};
  // Coding agents live in the data volume, one directory each (ADR 0006); the adapters
  // must see those binaries exactly like a CLI the person installed themselves.
  const host = {
    pathValue: [...managedBinDirs(hub.config.dataDir), own.pathValue ?? hub.config.hostEnv.path]
      .filter(Boolean)
      .join(':'),
    pathExt: hub.config.hostEnv.pathExt,
    inherited: hub.config.hostEnv.inherited,
  };
  // The supervised Hermes (ADR 0008). Its API key is what the adapter sends; an external
  // gateway is expected to carry the same key file (docs/DEPLOY.md).
  const hermesFetch = own.adapterOptions?.hermes?.fetchImpl;
  const runtime = new HermesRuntime({
    dataDir: hub.config.dataDir,
    host,
    log: app.log,
    endpoint: own.adapterOptions?.hermes?.defaultEndpoint ?? HERMES_ENTRY.defaultEndpoint!,
    ...(hermesFetch ? { fetchImpl: hermesFetch } : {}),
    ...(own.runtime?.spawnImpl ? { spawnImpl: own.runtime.spawnImpl } : {}),
    ...(own.runtime?.healthIntervalMs !== undefined
      ? { healthIntervalMs: own.runtime.healthIntervalMs }
      : {}),
    onState: (status: HermesRuntimeStatus) => {
      const ctx = contexts.get(hub.io);
      if (!ctx) return;
      ctx.service.setRuntime(HERMES_ENTRY.id, {
        state: status.state,
        url: status.state === 'running' ? status.endpoint : null,
        error: status.lastError,
      });
      if (status.state === 'running') {
        void ctx.service.reprobe(HERMES_ENTRY.id).catch((error: unknown) => {
          app.log.warn({ err: error }, 'agents: hermes reprobe failed');
        });
      }
    },
  });
  const adapters =
    own.adapters ??
    createAdapterSet({
      ...own.adapterOptions,
      hermes: {
        apiKey: () => runtime.apiKey(),
        tui: () => runtime.tuiChannel(),
        ensureProfile: (name: string) => runtime.ensureProfile(name),
        ...own.adapterOptions?.hermes,
      },
      // The hub's own agent reaches the providers through the same port every other
      // agent's credentials come from, looked up per turn because `models` registers it
      // after this module mounts (ADR 0010; ADOPTION-BACKLOG §2.15).
      direct: {
        models: () => modelsPorts.get(hub.io) ?? null,
        ...own.adapterOptions?.direct,
      },
      host,
    });
  const service = new AgentsService({
    db: requireSqlite(hub.database),
    log: app.log,
    realtime: createRealtime(hub.io),
    audit: auditFor(app),
    jobs: jobRunnerFor(app),
    adapters,
    installer: own.installer ?? createNpmInstaller({ dataDir: hub.config.dataDir, host }),
    models: () => modelsPorts.get(hub.io) ?? null,
    // A workspace is a Hermes profile (ADR 0014): its slug, or `default` for the hub's
    // default workspace whatever it is called. An archived or unknown one has none.
    profileOf: (workspaceId: string) => {
      const row = findWorkspace(requireSqlite(hub.database), workspaceId);
      if (!row || row.id !== workspaceId) return null;
      return hermesProfileName(row);
    },
  });
  const runner = new AgentRunner({ service, adapters, log: app.log });
  // Hermes's own web server as an internal API (ADR 0015): nothing runs until a caller
  // asks, and only where `runtime` is managed (`hermesDashboardFor`).
  const dashboard = new HermesDashboard({
    host: runtime,
    dataDir: hub.config.dataDir,
    log: app.log,
    ...(own.dashboard?.spawnImpl ? { spawnImpl: own.dashboard.spawnImpl } : {}),
    ...(own.dashboard?.fetchImpl ? { fetchImpl: own.dashboard.fetchImpl } : {}),
    ...(own.dashboard?.idleMs !== undefined ? { idleMs: own.dashboard.idleMs } : {}),
  });
  const created: AgentsContext = {
    service,
    adapters,
    runner,
    runtime,
    dashboard,
    hermesApi: () =>
      own.hermesApi ??
      (dashboard.available()
        ? (method, route, body, options) => dashboard.request(method, route, body, options)
        : null),
    hermesCli: () => {
      if (own.hermesCli) return own.hermesCli;
      // The same rule as Hermes's API: only a Hermes this hub runs, on this host.
      const { mode, home } = runtime.status();
      const command = runtime.executable();
      if (mode !== 'managed' || !home || !command) return null;
      return hermesCliRunner({ command, env: () => runtime.cliEnv() });
    },
    pairingPollMs: own.pairingPollMs ?? 1000,
  };
  contexts.set(hub.io, created);
  return created;
}

export function agentsServiceFor(app: FastifyInstance): AgentsService {
  return contextOf(app).service;
}

/** The Hermes runtime this hub supervises or found (ADR 0008). */
export function hermesRuntimeFor(app: FastifyInstance): HermesRuntime {
  return contextOf(app).runtime;
}

/**
 * Hermes's dashboard API (ADR 0015) — Hermes's own web server, started on the first call
 * and stopped when idle — or `null` where this hub does not supervise Hermes. For the
 * composition root: a module that needs it is handed a port built from this.
 */
export function hermesDashboardFor(app: FastifyInstance): HermesDashboard | null {
  const { dashboard } = contextOf(app);
  return dashboard.available() ? dashboard : null;
}

/** The live turns, for anything that must not interrupt one (`models` recycles Hermes). */
export function agentRunnerFor(app: FastifyInstance): AgentRunner {
  return contextOf(app).runner;
}

const scopeOf = (request: FastifyRequest): WorkspaceScope => {
  const workspace = request.workspace;
  if (!workspace) throw new HubError('internal', { message: 'route has no workspace' });
  // Jobs store the workspace id and report its slug; registering the pair here is what
  // lets a `/rt/jobs` event name the profile it belongs to.
  auditFor(request.server).rememberWorkspace(workspace.id, workspace.slug);
  return workspace;
};

const actorOf = (request: FastifyRequest): { userId: string } => {
  const principal = request.principal;
  if (!principal) throw new HubError('internal', { message: 'route has no principal' });
  return { userId: principal.user.id };
};

/**
 * The contract's `Skill`.
 *
 * `use_count` is **0 and says nothing**, because nothing records skill use yet — the same
 * reason `audit.getReport` refuses the Skills report rather than answering zeros that
 * would read as a measurement. Here the field is required by the contract, so it is 0 and
 * this comment is the footnote.
 *
 * `source` is read from the files: a skill Hermes seeded from its bundle is `builtin` (and
 * read-only here), one that names the pack it came from is `external`, and one that names
 * none was written by a person, which is `user`.
 */
function toSkill(skill: Skill, pinned: readonly string[]): Record<string, unknown> {
  return {
    key: skill.key,
    name: skill.name,
    description: skill.broken ? `[${skill.broken}]` : skill.description,
    enabled: skill.enabled,
    pinned: pinned.includes(skill.key),
    source: skill.bundled ? 'builtin' : skill.pack ? 'external' : 'user',
    use_count: 0,
    updated_at: skill.updatedAt.toISOString(),
    content: skill.content,
  };
}

/**
 * Group the folder into the contract's categories.
 *
 * A skill in a category folder (`skills/<category>/<name>/`, Hermes's layout for its own
 * skills) lists under that category, described by its `DESCRIPTION.md`. A skill directly under
 * `skills/` has no folder to say, so the grouping is the one its file carries: the pack it came
 * from. Everything hand-written lands in one category of its own, and pinned skills come first
 * inside each — an order a person chose beats one the filesystem chose.
 */
function categorise(
  home: string,
  skills: readonly Skill[],
  pinned: readonly string[],
): Array<Record<string, unknown>> {
  const groups = new Map<string, Skill[]>();
  const folders = new Set<string>();
  for (const skill of skills) {
    if (skill.category) folders.add(skill.category);
    const key = skill.category ?? skill.pack ?? 'user';
    const list = groups.get(key);
    if (list) list.push(skill);
    else groups.set(key, [skill]);
  }
  return (
    [...groups.entries()]
      // The person's own skills first; packs after, in name order.
      .sort(([a], [b]) => (a === 'user' ? -1 : b === 'user' ? 1 : a.localeCompare(b)))
      .map(([key, list]) => ({
        key,
        name: key,
        description: folders.has(key) ? categoryDescription(home, key) : null,
        skills: list
          .sort((a, b) => Number(pinned.includes(b.key)) - Number(pinned.includes(a.key)))
          .map((skill) => toSkill(skill, pinned)),
      }))
  );
}

export const agentsModule = defineModule({
  name: 'agents',
  async registerRoutes(app: FastifyInstance) {
    const document = loadOpenApiDocument();
    if (!document) throw new Error('packages/contracts/openapi.yaml is required (ADR 0003)');
    const deps = {
      contract: createContractIndex(document),
      guards: { requireUser, requireWorkspace, requireRole },
    };
    const service = agentsServiceFor(app);

    // `Profile.agent_count` comes from the registry, not from a number auth invents.
    registerWorkspaceStatsProvider((workspaceId) => ({
      agentCount: service.countEnabled(workspaceId),
    }));

    // First boot seeds the catalog; every boot reconciles it against the data volume.
    // Rows the hub creates for itself are attributed to the owner account (domain README).
    const owner = ownerUser(requireSqlite(app.hub.database));
    const report = await service.bootstrap(owner?.id ?? 'system');
    app.log.info(
      {
        installed: report.installed.length,
        missing: report.missing.length,
        interrupted: report.interrupted.length,
      },
      'agents: registry reconciled with the data volume',
    );

    // The Hermes runtime: decided once the server is ready to serve, stopped with it.
    const ctx = contextOf(app);
    app.addHook('onReady', async () => {
      const mode = await ctx.runtime.start();
      app.log.info({ mode, endpoint: ctx.runtime.endpoint }, 'agents: hermes runtime');
      migrateMemoryOfEveryProfile(ctx.runtime.status().home, app.log);
    });
    app.addHook('onClose', async () => {
      await ctx.runner.closeAll();
      await ctx.dashboard.close();
      await ctx.runtime.stop();
    });

    defineRoute(app, deps, {
      operationId: 'agents.list',
      handler: (request, { query }) => ({
        items: service.list(scopeOf(request), {
          ...(query.kind ? { kind: query.kind as AdapterKind } : {}),
          // An agent whose name is a word, not a brand, reads in the caller's language
          // (`service.ts` §`displayName`).
          language: request.language,
        }),
      }),
    });

    defineRoute(app, deps, {
      operationId: 'agents.get',
      handler: (request, { params }) =>
        service.get(scopeOf(request), params.agent_id as string, request.language),
    });

    defineRoute(app, deps, {
      operationId: 'agents.update',
      handler: (request, { params, body }) =>
        service.update(scopeOf(request), params.agent_id as string, body as AgentPatchInput),
    });

    defineRoute(app, deps, {
      operationId: 'agents.getSettings',
      handler: (request, { params }) => ({
        sections: service.settings(scopeOf(request), params.agent_id as string),
      }),
    });

    defineRoute(app, deps, {
      operationId: 'agents.updateSettings',
      handler: (request, { params, body }) =>
        service.updateSettings(
          scopeOf(request),
          params.agent_id as string,
          body as { section: string; values: Record<string, unknown> },
        ),
    });

    /**
     * Skills. They are folders in the agent's own home (`skills.ts`), so the hub has to
     * know where that home is — which it only does for the runtime it supervises. An
     * external Hermes keeps its skills somewhere this process cannot see, and saying so
     * is better than listing an empty folder as if the agent had no skills.
     *
     * The home is **the selected profile's** (ADR 0014): Hermes's root home for the default
     * profile, `profiles/<slug>` for any other. A profile Hermes does not have is said to be
     * missing rather than shown the default profile's files as if they were its own.
     */
    const toolHome = (
      request: FastifyRequest,
      agentId: string,
      onlyHermes = 'skills_are_hermes_only',
    ): { home: string; profile: string } => {
      const context = contextOf(request.server);
      const scope = scopeOf(request);
      const row = context.service.get(scope, agentId, request.language);
      if (row.kind !== 'hermes') {
        throw new HubError('state_invalid', {
          details: { agent_id: agentId, reason: onlyHermes },
        });
      }
      const root = context.runtime.status().home;
      if (!root) {
        // No Hermes at all: no folder to read, and no folder to invent.
        throw new HubError('state_invalid', {
          details: { agent_id: agentId, reason: 'runtime_absent' },
        });
      }
      const profile = hermesProfileName(scope);
      const home = profileHome(root, scope);
      if (!home) {
        throw new HubError('state_invalid', {
          details: { agent_id: agentId, reason: 'hermes_profile_absent', profile },
        });
      }
      return { home, profile };
    };
    const skillHome = (request: FastifyRequest, agentId: string): string =>
      toolHome(request, agentId).home;

    /** Hermes's API for the tools that need Hermes to act, or the reason there is none. */
    const hermesApiOf = (request: FastifyRequest, agentId: string): HermesApiCall => {
      const api = contextOf(request.server).hermesApi();
      if (!api) {
        throw new HubError('state_invalid', {
          details: { agent_id: agentId, reason: 'hermes_not_supervised' },
        });
      }
      return api;
    };

    /** Hermes's own command for the plugin pages, or the reason there is none. */
    const hermesCliOf = (request: FastifyRequest, agentId: string): HermesCli => {
      const cli = contextOf(request.server).hermesCli();
      if (!cli) {
        throw new HubError('state_invalid', {
          details: { agent_id: agentId, reason: 'hermes_not_supervised' },
        });
      }
      return cli;
    };

    const skillFault = (error: unknown): never => {
      if (error instanceof SkillError) {
        if (error.reason === 'skill_not_found') throw notFound({ resource: 'skill' });
        // Hermes's own skill: it keeps it in step with its bundle, so the hub leaves it be.
        if (error.reason === 'skill_bundled') {
          throw new HubError('conflict', { details: { reason: 'skill_bundled' } });
        }
        throw new HubError('bad_request', { details: { reason: error.reason } });
      }
      throw error;
    };

    defineRoute(app, deps, {
      operationId: 'agents.listSkills',
      handler: (request, { params }) => {
        const agentId = params.agent_id as string;
        const home = skillHome(request, agentId);
        return {
          categories: categorise(
            home,
            listSkills(home),
            contextOf(request.server).service.pinnedSkills(scopeOf(request), agentId),
          ),
          // Which folder this is. A Hermes somebody else started with a different home
          // would otherwise read as "no skills", and a path on screen is the difference
          // between an empty agent and the wrong directory.
          home: skillsDir(home),
        };
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.getSkill',
      handler: (request, { params }) => {
        const agentId = params.agent_id as string;
        const key = params.skill_key as string;
        const skill = getSkill(skillHome(request, agentId), key);
        if (!skill) throw notFound({ resource: 'skill', id: key });
        return toSkill(
          skill,
          contextOf(request.server).service.pinnedSkills(scopeOf(request), agentId),
        );
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.putSkill',
      handler: (request, { params, body }) => {
        const agentId = params.agent_id as string;
        const key = params.skill_key as string;
        const home = skillHome(request, agentId);
        try {
          const written = putSkill(home, key, {
            content: String((body as { content: string }).content),
          });
          return toSkill(
            written,
            contextOf(request.server).service.pinnedSkills(scopeOf(request), agentId),
          );
        } catch (error) {
          return skillFault(error);
        }
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.updateSkill',
      handler: (request, { params, body }) => {
        const agentId = params.agent_id as string;
        const key = params.skill_key as string;
        const home = skillHome(request, agentId);
        const patch = body as { enabled?: boolean; pinned?: boolean };
        const service = contextOf(request.server).service;
        const scope = scopeOf(request);
        try {
          let skill = getSkill(home, key);
          if (!skill) throw notFound({ resource: 'skill', id: key });
          if (patch.enabled !== undefined) skill = setSkillEnabled(home, key, patch.enabled);
          let pinned = service.pinnedSkills(scope, agentId);
          if (patch.pinned !== undefined) {
            pinned = service.setPinnedSkills(
              scope,
              agentId,
              patch.pinned ? [...pinned, key] : pinned.filter((entry) => entry !== key),
            );
          }
          return toSkill(skill, pinned);
        } catch (error) {
          return skillFault(error);
        }
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.deleteSkill',
      handler: (request, { params }) => {
        const home = skillHome(request, params.agent_id as string);
        try {
          deleteSkill(home, params.skill_key as string);
        } catch (error) {
          return skillFault(error);
        }
        return null;
      },
    });

    /**
     * Importing a skill pack: the uploaded files, read from `knowledge`, checked as Hermes
     * reads a skill, and installed all together or not at all (`skill-import.ts`).
     */
    defineRoute(app, deps, {
      operationId: 'agents.importSkills',
      status: 201,
      handler: (request, { params, body }) => {
        const agentId = params.agent_id as string;
        const { home } = toolHome(request, agentId);
        const scope = scopeOf(request);
        const ids = [...new Set((body as { attachment_ids: string[] }).attachment_ids)];
        const port = attachmentsFactory?.(request.server);
        if (!port) {
          throw new HubError('service_unavailable', {
            details: { reason: 'attachments_unavailable' },
          });
        }
        const scratch = mkdtempSync(path.join(tmpdir(), 'majlis-skill-import-'));
        try {
          const landed = port.materialise(scope.id, ids, scratch);
          const missing = ids.filter((id) => !landed.some((file) => file.id === id));
          if (missing.length > 0) throw notFound({ resource: 'attachment', id: missing[0] });
          const uploads: UploadedFile[] = ids.map((id) => {
            const file = landed.find((entry) => entry.id === id)!;
            return { name: file.name, data: readFileSync(file.path) };
          });
          const keys = installPack(home, planImport(home, uploads));
          const pinned = contextOf(request.server).service.pinnedSkills(scope, agentId);
          return {
            items: keys
              .map((key) => getSkill(home, key))
              .filter((skill): skill is Skill => skill !== null)
              .map((skill) => toSkill({ ...skill, content: null }, pinned)),
          };
        } catch (error) {
          if (error instanceof SkillImportError) {
            throw new HubError(error.kind === 'conflict' ? 'conflict' : 'bad_request', {
              message: error.message,
              details: {
                reason: error.reason,
                skill: error.where.skill ?? null,
                file: error.where.file ?? null,
                message: error.message,
              },
            });
          }
          throw error;
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      },
    });

    /**
     * MCP servers. One block of `config.yaml`, edited in place (`mcp.ts`).
     *
     * `agents.testMcpServer` asks Hermes to connect (`hermes-tools.ts`): the hub writes the
     * file, and Hermes — the one that will run the server — is the one that tries it. The
     * rows themselves still claim nothing: `connected` stays false until Hermes starts.
     */
    const mcpFault = (error: unknown): never => {
      if (error instanceof McpError) {
        if (error.reason === 'mcp_not_found') throw notFound({ resource: 'mcp_server' });
        throw new HubError('bad_request', { details: { reason: error.reason } });
      }
      throw error;
    };

    /** The contract's `McpServer`. `connected` and `tools` are not measured — see above. */
    const toMcpServer = (server: McpServer): Record<string, unknown> => ({
      name: server.name,
      transport: server.transport,
      enabled: server.enabled,
      connected: false,
      tools: [],
      error: null,
      config: server.config,
      updated_at: new Date().toISOString(),
    });

    defineRoute(app, deps, {
      operationId: 'agents.listMcpServers',
      handler: (request, { params }) => {
        const home = skillHome(request, params.agent_id as string);
        try {
          return { items: listMcpServers(home).map(toMcpServer) };
        } catch (error) {
          return mcpFault(error);
        }
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.createMcpServer',
      handler: (request, { params, body }) => {
        const home = skillHome(request, params.agent_id as string);
        const input = body as {
          name: string;
          transport: string;
          enabled?: boolean;
          config: Record<string, unknown>;
        };
        try {
          if (getMcpServer(home, input.name)) {
            throw new HubError('conflict', {
              details: { reason: 'mcp_name_taken', name: input.name },
            });
          }
          return toMcpServer(
            putMcpServer(home, input.name, {
              config: input.config,
              enabled: input.enabled ?? true,
            }),
          );
        } catch (error) {
          return mcpFault(error);
        }
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.updateMcpServer',
      handler: (request, { params, body }) => {
        const home = skillHome(request, params.agent_id as string);
        const name = params.server_name as string;
        const patch = body as { enabled?: boolean; config?: Record<string, unknown> };
        try {
          if (!getMcpServer(home, name)) throw notFound({ resource: 'mcp_server', id: name });
          return toMcpServer(
            putMcpServer(home, name, {
              ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
              ...(patch.config === undefined ? {} : { config: patch.config }),
            }),
          );
        } catch (error) {
          return mcpFault(error);
        }
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.deleteMcpServer',
      handler: (request, { params }) => {
        const home = skillHome(request, params.agent_id as string);
        try {
          deleteMcpServer(home, params.server_name as string);
        } catch (error) {
          return mcpFault(error);
        }
        return null;
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.testMcpServer',
      handler: async (request, { params }) => {
        const agentId = params.agent_id as string;
        const name = params.server_name as string;
        const { home, profile } = toolHome(request, agentId);
        let server: McpServer | null;
        try {
          server = getMcpServer(home, name);
        } catch (error) {
          return mcpFault(error);
        }
        if (!server) throw notFound({ resource: 'mcp_server', id: name });
        return testMcpServer(hermesApiOf(request, agentId), {
          profile,
          name,
          config: server.config,
          language: request.language,
        });
      },
    });

    /**
     * Memory: the three documents Hermes reads (`memory.ts`) — `soul`, `memory`, `user`.
     * Three and not a folder, because that is what the contract's `item_id` says and what
     * Hermes actually reads; a hub that offered arbitrary filenames here would be offering
     * a place the agent never looks.
     */
    const memoryFault = (error: unknown): never => {
      if (error instanceof MemoryError) {
        if (error.reason === 'memory_document_unknown') throw notFound({ resource: 'memory' });
        if (error.reason === 'memory_document_protected') {
          throw new HubError('conflict', { details: { reason: error.reason } });
        }
        throw new HubError('bad_request', { details: { reason: error.reason, ...error.details } });
      }
      throw error;
    };

    /** The contract's `MemoryItem`. Hermes's memory is documents, so `kind` is fixed. */
    const toMemoryItem = (item: MemoryDocument): Record<string, unknown> => ({
      id: item.id,
      kind: 'document',
      title: item.title,
      content: item.content,
      tags: [],
      // Files have no revision of their own; the hub does not invent a version number
      // for something a person can also edit with an editor.
      revision: 0,
      updated_at: item.updatedAt?.toISOString() ?? null,
    });

    defineRoute(app, deps, {
      operationId: 'agents.listMemory',
      handler: (request, { params, query }) => {
        const home = skillHome(request, params.agent_id as string);
        try {
          return {
            items: listMemory(home, query.q as string | undefined).map(toMemoryItem),
            next_cursor: null,
          };
        } catch (error) {
          return memoryFault(error);
        }
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.putMemoryItem',
      handler: (request, { params, body }) => {
        const home = skillHome(request, params.agent_id as string);
        try {
          return toMemoryItem(
            putMemory(
              home,
              params.item_id as string,
              String((body as { content: string }).content),
            ),
          );
        } catch (error) {
          return memoryFault(error);
        }
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.deleteMemoryItem',
      handler: (request, { params }) => {
        const home = skillHome(request, params.agent_id as string);
        try {
          deleteMemory(home, params.item_id as string);
        } catch (error) {
          return memoryFault(error);
        }
        return null;
      },
    });

    /**
     * Channels: the other block of `config.yaml` (`channels.ts`).
     *
     * `agents.loginChannel` pairs WhatsApp by QR through Hermes's own onboarding, as a job
     * whose progress carries the code (`hermes-tools.ts` §pairWhatsApp).
     *
     * `status` is `unknown`, deliberately. The hub writes the file; whether Telegram is
     * actually answering is something only the gateway knows, and `online` would be a
     * word nobody checked.
     */
    const channelFault = (error: unknown): never => {
      if (error instanceof ChannelError) {
        if (error.reason === 'channel_not_found') throw notFound({ resource: 'channel' });
        throw new HubError('bad_request', { details: { reason: error.reason } });
      }
      throw error;
    };

    const toChannel = (channel: Channel): Record<string, unknown> => ({
      platform: channel.platform,
      // The platform's own name. A table of pretty labels would go stale the moment
      // Hermes adds one, and the slug is what the person put in the file.
      label: channel.platform,
      enabled: channel.enabled,
      configured: channel.configured,
      exclusive: channel.exclusive,
      status: 'unknown',
      error: null,
      login: (QR_PLATFORMS as readonly string[]).includes(channel.platform) ? 'qr' : null,
      fields: channel.fields.map((field) => ({
        key: field.key,
        label: { ar: field.key, en: field.key },
        kind: field.kind === 'boolean' ? 'toggle' : field.kind,
        target: field.kind === 'secret' ? 'credentials' : 'configuration',
        value: field.value,
        hint: null,
      })),
    });

    defineRoute(app, deps, {
      operationId: 'agents.listChannels',
      handler: (request, { params }) => {
        const home = skillHome(request, params.agent_id as string);
        try {
          return { items: listChannels(home).map(toChannel) };
        } catch (error) {
          return channelFault(error);
        }
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.updateChannel',
      handler: (request, { params, body }) => {
        const home = skillHome(request, params.agent_id as string);
        const input = body as {
          enabled?: boolean;
          credentials?: Record<string, string>;
          configuration?: Record<string, unknown>;
        };
        try {
          return toChannel(
            putChannel(home, params.platform as string, {
              ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
              // The contract splits them by where they go; the file does not, so they
              // are merged back into the one node they came from.
              values: { ...(input.configuration ?? {}), ...(input.credentials ?? {}) },
            }),
          );
        } catch (error) {
          return channelFault(error);
        }
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.clearChannel',
      handler: (request, { params }) => {
        const home = skillHome(request, params.agent_id as string);
        try {
          return toChannel(clearChannel(home, params.platform as string));
        } catch (error) {
          return channelFault(error);
        }
      },
    });

    /**
     * Plugins: what Hermes itself lists and changes in the selected profile, through its own
     * `hermes plugins` command (`hermes-plugins.ts` says why not its dashboard routes).
     */
    const pluginTarget = (request: FastifyRequest, agentId: string) => {
      const { home, profile } = toolHome(request, agentId, 'plugins_are_hermes_only');
      return { home, profile, cli: hermesCliOf(request, agentId) };
    };

    defineRoute(app, deps, {
      operationId: 'agents.listPlugins',
      handler: async (request, { params }) => {
        const { home, cli } = pluginTarget(request, params.agent_id as string);
        return listPlugins(cli, home);
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.updatePlugin',
      handler: async (request, { params, body }) => {
        const { home, cli } = pluginTarget(request, params.agent_id as string);
        return setPluginEnabled(
          cli,
          home,
          params.plugin_key as string,
          (body as { enabled: boolean }).enabled,
        );
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.deletePlugin',
      status: 204,
      handler: async (request, { params }) => {
        const { home, cli } = pluginTarget(request, params.agent_id as string);
        await removePlugin(cli, home, params.plugin_key as string);
        return null;
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.installPlugin',
      status: 202,
      handler: (request, { params, body }) => {
        const agentId = params.agent_id as string;
        const { home, profile, cli } = pluginTarget(request, agentId);
        const identifier = String((body as { identifier: string }).identifier).trim();
        const scope = scopeOf(request);
        const language = request.language;
        const job = jobRunnerFor(request.server).start(
          {
            kind: 'agents.plugin_install',
            workspace: scope.id,
            ownerId: actorOf(request).userId,
            entityKind: 'agent',
            entityId: agentId,
            input: { identifier, profile },
            message: t('jobs.plugin_install.started', language),
          },
          (handle) => installPlugin(cli, handle, { home, identifier, language }),
        );
        return { job_id: job.id };
      },
    });

    defineRoute(app, deps, {
      operationId: 'agents.loginChannel',
      status: 202,
      handler: (request, { params }) => {
        const agentId = params.agent_id as string;
        const platform = params.platform as string;
        const { profile } = toolHome(request, agentId);
        if (!(QR_PLATFORMS as readonly string[]).includes(platform)) {
          throw new HubError('state_invalid', {
            details: { agent_id: agentId, platform, reason: 'login_not_supported' },
          });
        }
        const api = hermesApiOf(request, agentId);
        const scope = scopeOf(request);
        const language = request.language;
        const pollMs = contextOf(request.server).pairingPollMs;
        const job = jobRunnerFor(request.server).start(
          {
            kind: 'agents.channel_login',
            workspace: scope.id,
            ownerId: actorOf(request).userId,
            entityKind: 'agent',
            entityId: agentId,
            input: { platform, profile },
            message: t('jobs.channel_login.started', language),
          },
          (handle) => pairWhatsApp(api, handle, { profile, language, pollMs }),
        );
        return { job_id: job.id };
      },
    });

    // Long work: `202 { job_id }` now, progress and outcome on `/rt/jobs` (invariant 4).
    const lifecycle = {
      'agents.install': service.install.bind(service),
      'agents.upgrade': service.upgrade.bind(service),
      'agents.uninstall': service.uninstall.bind(service),
      'agents.checkUpdate': service.checkUpdate.bind(service),
    } as const;
    for (const [operationId, run] of Object.entries(lifecycle)) {
      defineRoute(app, deps, {
        operationId,
        status: 202,
        handler: (request, { params }) => ({
          job_id: run(scopeOf(request), actorOf(request), params.agent_id as string).id,
        }),
      });
    }

    defineRoute(app, deps, {
      operationId: 'agents.discover',
      status: 202,
      handler: (request) => ({ job_id: service.discover(scopeOf(request), actorOf(request)).id }),
    });

    defineRoute(app, deps, {
      operationId: 'agents.restart',
      status: 202,
      handler: (request, { params }) => ({
        job_id: service.restart(scopeOf(request), actorOf(request), params.agent_id as string, {
          managed: () => ctx.runtime.status().mode === 'managed',
          restart: () => ctx.runtime.restart(),
        }).id,
      }),
    });
  },
  registerEvents(_io: SocketServer) {
    // The registry's own event, `agent.updated`, rides on `/rt/jobs` because it is always
    // the outcome of hub-level work (packages/contracts/events/README.md). No client
    // command is accepted on that namespace.
  },
});

export const registerRoutes = agentsModule.registerRoutes.bind(agentsModule);
export const registerEvents = agentsModule.registerEvents.bind(agentsModule);

/**
 * The `AgentRunner` port `sessions` needs: one runner per app, over the app's adapters.
 * Wired next to the directory in `src/modules/index.ts`.
 */
export function agentRunner(app: FastifyInstance): AgentRunnerPort {
  return contextOf(app).runner;
}

/**
 * The `AgentDirectory` port `sessions` needs (`modules/sessions/ports.ts`). Wiring it is
 * one line in `src/modules/index.ts`:
 *
 *     createSessionsModule({ agents: agentDirectory, runner: agentRunner, scopes })
 *
 * so nothing inside `sessions` has to change when the registry grows.
 */
export function agentDirectory(app: FastifyInstance): AgentDirectoryPort {
  return {
    find(workspace: string, agentId: string): Promise<AgentInfo | null> {
      const service = agentsServiceFor(app);
      let row;
      try {
        row = service.loadAgent(agentId);
      } catch {
        return Promise.resolve(null);
      }
      const enabled = service.isEnabled(workspace, row.id);
      const available = row.installState === 'installed' && enabled;
      // What the workspace's providers resolve to for this agent (ADR 0010): the model
      // pinned to it, else the workspace default for its kind. A session that names no
      // model starts on this one, and nobody configured it per agent.
      const model = service.defaultModelOf(row, workspace);
      return Promise.resolve({
        id: row.id,
        name: row.name,
        adapterKind: row.adapterKind,
        defaultModel: model?.model ?? null,
        defaultProvider: model?.provider_id ?? null,
        available,
        ...(available ? {} : { unavailableReason: enabled ? row.installState : 'disabled' }),
      });
    },
  };
}
