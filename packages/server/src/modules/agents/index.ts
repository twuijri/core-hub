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
 * Still documented 501 stubs, with the reason:
 * - `agents.getAvatar` — every agent is a `generated` avatar drawn from its slug until
 *   the `knowledge` module stores attachments.
 * - skills, MCP servers, memory, channels, plugins, presets, journey and config files —
 *   each is a read or a write against the agent's own home through its adapter, and that
 *   adapter surface (the Hermes gateway RPC) arrives with the `sessions` module.
 *
 * Composition note: the module object is a singleton shared by every `buildServer()` in a
 * test process, so the service is kept per Socket.IO server (one per app), the same way
 * `auth` keeps its context.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Server as SocketServer } from 'socket.io';
import { loadOpenApiDocument } from '@majlis/contracts';
import { requireSqlite } from '../../lib/db.js';
import { HubError, notFound } from '../../lib/errors.js';
import { createContractIndex } from '../../lib/contract.js';
import { defineModule } from '../../lib/module.js';
import { createRealtime } from '../../lib/realtime.js';
import { defineRoute } from '../../lib/route.js';
import {
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
import { createNpmInstaller, managedBinDirs, type AgentInstaller } from './installer.js';
import type { AgentDirectoryPort, AgentInfo, AgentModelsPort, AgentRunnerPort } from './ports.js';
import { AgentRunner } from './runner.js';
import { AgentsService, type AgentPatchInput } from './service.js';
import { ChannelError, clearChannel, listChannels, putChannel, type Channel } from './channels.js';
import { MemoryError, deleteMemory, listMemory, putMemory, type MemoryDocument } from './memory.js';
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
export { HermesRuntime, loadOrCreateHermesApiKey } from './hermes-runtime.js';
export {
  HermesProfileError,
  createHermesProfiles,
  hermesProfileRunner,
  type HermesProfiles,
} from './hermes-profiles.js';
export type { HermesRuntimeMode, HermesRuntimeStatus, Spawner } from './hermes-runtime.js';

/** Test seams: a fake PATH, a fake adapter set, a fake installer. Set before the app boots. */
export interface AgentsOverrides {
  adapters?: AdapterSet;
  installer?: AgentInstaller;
  pathValue?: string;
  /** Options for the real adapter set (a stubbed `fetch` for the Hermes gateway probe). */
  adapterOptions?: Omit<AdapterSetOptions, 'host'>;
  /** The Hermes runtime supervisor's seams (a fake spawner, a health interval). */
  runtime?: { spawnImpl?: Spawner; healthIntervalMs?: number };
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
  });
  const runner = new AgentRunner({ service, adapters, log: app.log });
  const created: AgentsContext = { service, adapters, runner, runtime };
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
 * `source` is read from the file: a skill that names the pack it came from is `external`,
 * and one that names none was written by a person, which is `user`.
 */
function toSkill(skill: Skill, pinned: readonly string[]): Record<string, unknown> {
  return {
    key: skill.key,
    name: skill.name,
    description: skill.broken ? `[${skill.broken}]` : skill.description,
    enabled: skill.enabled,
    pinned: pinned.includes(skill.key),
    source: skill.pack ? 'external' : 'user',
    use_count: 0,
    updated_at: skill.updatedAt.toISOString(),
    content: skill.content,
  };
}

/**
 * Group the folder into the contract's categories.
 *
 * Hermes has no categories on disk, so the honest grouping is the one the files already
 * carry: the pack a skill came from. Everything hand-written lands in one category of its
 * own, and pinned skills come first inside each — an order a person chose beats one the
 * filesystem chose.
 */
function categorise(
  skills: readonly Skill[],
  pinned: readonly string[],
): Array<Record<string, unknown>> {
  const groups = new Map<string, Skill[]>();
  for (const skill of skills) {
    const key = skill.pack ?? 'user';
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
        description: null,
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
    });
    app.addHook('onClose', async () => {
      await ctx.runner.closeAll();
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
     */
    const skillHome = (request: FastifyRequest, agentId: string): string => {
      const context = contextOf(request.server);
      const row = context.service.get(scopeOf(request), agentId, request.language);
      if (row.kind !== 'hermes') {
        throw new HubError('state_invalid', {
          details: { agent_id: agentId, reason: 'skills_are_hermes_only' },
        });
      }
      const home = context.runtime.status().home;
      if (!home) {
        // No Hermes at all: no folder to read, and no folder to invent.
        throw new HubError('state_invalid', {
          details: { agent_id: agentId, reason: 'runtime_absent' },
        });
      }
      return home;
    };

    const skillFault = (error: unknown): never => {
      if (error instanceof SkillError) {
        if (error.reason === 'skill_not_found') throw notFound({ resource: 'skill' });
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
     * MCP servers. One block of `config.yaml`, edited in place (`mcp.ts`).
     *
     * `agents.testMcpServer` is **not** here and stays a documented 501: testing means
     * spawning the command or opening the socket and running the handshake, and until
     * something does that, a green tick would be a guess. What this hub does is write the
     * file; Hermes connects when it starts, which is why the screen says to restart.
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
        throw new HubError('bad_request', { details: { reason: error.reason } });
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
     * `agents.loginChannel` is **not** here and stays a documented 501: pairing by QR is
     * a conversation with the running gateway, not an edit to a file.
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
      login: null,
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
