/**
 * Module `models`: the hub's one provider and credential store (ADR 0010).
 *
 * Implemented: `models.listProviders`, `models.listProviderPresets`, `models.probeProvider`,
 * `models.createProvider`, `models.updateProvider`,
 * `models.deleteProvider`, `models.refreshProvider`, `models.testProvider`,
 * `models.putModel`, `models.deleteModel`, `models.listCatalogue`, `models.getDefaults`,
 * `models.setDefaults`, `models.listEnsembles`, `models.createEnsemble`,
 * `models.updateEnsemble`, `models.deleteEnsemble`, `models.getSpeech`,
 * `models.updateSpeech`, `models.listVoices`, `models.synthesize`.
 *
 * Still documented 501 stubs, with the reason:
 * - `models.startProviderSignIn`, `models.getProviderSignIn`,
 *   `models.completeProviderSignIn` — no provider in the bundled catalogue authenticates
 *   by OAuth device code. Every one of them takes an API key, and answering `201` with
 *   an invented `verification_url` would be a lie the client would render. The operations
 *   land with the first OAuth provider (Anthropic's subscription sign-in, GitHub Copilot).
 * - `models.transcribe` — the audio arrives as `multipart/form-data` and the hub has no
 *   multipart reader wired (`packages/server` deliberately has one body parser). Adding
 *   one is its own change; until then the operation says so rather than returning an
 *   empty transcript.
 *
 * What this module gives the rest of the hub is `modelsPort()`: the credentials a coding
 * agent starts with and the default model an agent inherits, so the `agents` module never
 * asks a person for a key (ADR 0010 §Propagation).
 */
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Server as SocketServer } from 'socket.io';
import { loadOpenApiDocument } from '@corehub/contracts';
import { requireSqlite } from '../../lib/db.js';
import { HubError } from '../../lib/errors.js';
import { createContractIndex } from '../../lib/contract.js';
import { defineModule } from '../../lib/module.js';
import { defineRoute } from '../../lib/route.js';
import { t } from '../../i18n/index.js';
import {
  defaultWorkspace,
  findWorkspace,
  ownerUser,
  requireRole,
  requireUser,
  requireWorkspace,
  type WorkspaceScope,
} from '../auth/index.js';
import { auditFor, jobRunnerFor } from '../audit/index.js';
import {
  agentRunnerFor,
  hermesRuntimeFor,
  namedHermesProfiles,
  registerAgentModelsPort,
  type AgentModelsPort,
} from '../agents/index.js';
import { DataKeyRing } from './crypto.js';
import { SecretStore } from './secrets.js';
import { roleForAdapter } from './defaults.js';
import {
  ModelsService,
  type HermesTarget,
  type EnsembleWriteInput,
  type DefaultsWriteInput,
  type ModelPatchInput,
  type ProviderCreateInput,
  type ProviderPatchInput,
  type ProviderProbeInput,
  type SpeechPatchInput,
} from './service.js';

export { ModelsService } from './service.js';
export type {
  Actor,
  ContractProviderPreset,
  DefaultsWriteInput,
  DirectChatEvent,
  DirectChatRequest,
  DirectModelFacts,
  EnsembleWriteInput,
  HermesTarget,
  ModelPatchInput,
  ModelRefInput,
  ModelsServiceOptions,
  ProbeOutcome,
  ProviderCreateInput,
  ProviderHostInfo,
  ProviderPatchInput,
  ProviderProbeInput,
  SpeechPatchInput,
  TestOutcome,
} from './service.js';
export { LOOPBACK_ALIAS, hostInfo } from './service.js';
export { DataKeyRing, MASKED, hintOf, isMask, maskSecret } from './crypto.js';
export type { SealedSecret } from './crypto.js';
export { SecretStore } from './secrets.js';
export type { SecretSummary } from './secrets.js';
export {
  HERMES_PROVIDER_PREFIX,
  LEGACY_HERMES_PROVIDER_PREFIX,
  legacyHermesKeyEnvOf,
  PROVIDER_CATALOGUE,
  assertCatalogueIsWellFormed,
  authKindOf,
  catalogueEntry,
  envVarOf,
  familyEntries,
  hermesApiModeOf,
  hermesBaseUrlOf,
  hermesKeyEnvOf,
  hermesProviderNameOf,
  hermesRouteOf,
  secretNameOf,
} from './catalogue.js';
export type {
  CredentialFamily,
  HermesRouteKind,
  KeyRequirement,
  ProviderCatalogueEntry,
} from './catalogue.js';
export { AUXILIARY_TASKS, roleForAdapter } from './defaults.js';
export {
  agentEnvironment,
  writeHermesConfiguration,
  writeHermesEnv,
  writeHermesModel,
  writeHermesProviders,
} from './propagation.js';
export type { HermesProviderRoute, PropagationState, ResolvedCredential } from './propagation.js';
export { mergeEnv, parseEnv, quoteValue } from './dotenv.js';
export { providerAdapter } from './adapters/index.js';

/** Test seams: a scripted `fetch` for the provider adapters, an in-memory key ring. */
export interface ModelsOverrides {
  fetchImpl?: typeof fetch;
  /** Skip the key file entirely (the crypto tests own their own ring). */
  keys?: DataKeyRing;
  /**
   * A scripted Hermes home. The real one comes from the supervised runtime, which a test
   * process does not have; this is how the propagation path is exercised end to end.
   */
  hermes?: HermesTarget;
  /**
   * How long the service waits after the last write before recycling Hermes. Tests set
   * 0 so a restart is one macrotask away instead of a second and a half.
   */
  restartDelayMs?: number;
}

let pendingOverrides: ModelsOverrides | null = null;
const overrides = new WeakMap<SocketServer, ModelsOverrides>();

/** Used by the test helpers: the next app to build takes these. */
export function overrideModels(next: ModelsOverrides | null): void {
  pendingOverrides = next;
}

const contexts = new WeakMap<SocketServer, ModelsService>();
const rings = new WeakMap<SocketServer, DataKeyRing>();

/**
 * The hub's one data key ring (`${DATA_DIR}/keys/data.key`). Lent to the composition root
 * so another module that stores a secret (`devices`: push tokens and push credentials)
 * seals it with the same keys rather than opening a second copy of the file.
 */
export function dataKeyRingFor(app: FastifyInstance): DataKeyRing {
  const { hub } = app;
  const existing = rings.get(hub.io);
  if (existing) return existing;
  if (pendingOverrides) {
    overrides.set(hub.io, pendingOverrides);
    pendingOverrides = null;
  }
  const ring = overrides.get(hub.io)?.keys ?? DataKeyRing.open(hub.config.dataDir);
  rings.set(hub.io, ring);
  return ring;
}

function contextOf(app: FastifyInstance): ModelsService {
  const { hub } = app;
  const existing = contexts.get(hub.io);
  if (existing) return existing;
  if (pendingOverrides) {
    overrides.set(hub.io, pendingOverrides);
    pendingOverrides = null;
  }
  const own = overrides.get(hub.io) ?? {};
  const db = requireSqlite(hub.database);
  const keys = dataKeyRingFor(app);
  const runtime = hermesRuntimeFor(app);
  const hermes: HermesTarget = own.hermes ?? {
    // Only a runtime this hub supervises has a home the hub may write into; an
    // external gateway is somebody else's process with somebody else's files.
    home: () => runtime.status().home,
    // Every named Hermes profile's home: a conversation runs in its workspace's profile
    // (ADR 0014 stage 3), and the endpoints a turn may name must be declared there too.
    profileHomes: () => {
      const home = runtime.status().home;
      return home ? namedHermesProfiles(home).map((name) => path.join(home, 'profiles', name)) : [];
    },
    restart: async () => {
      if (runtime.status().mode !== 'managed') return false;
      await runtime.restart();
      return true;
    },
    // `undecided` only exists before `onReady`; to a person looking at the screen that
    // is the same as "nothing found yet".
    mode: () => {
      const decided = runtime.status().mode;
      return decided === 'undecided' ? 'absent' : decided;
    },
    reloadedAt: () => runtime.status().startedAt,
    // A restart kills whatever turn is in flight; the runner is the only one who knows.
    busy: () => agentRunnerFor(app).busy,
    applyEnvironment: (env) => runtime.setProviderEnv(env),
  };
  const service = new ModelsService({
    db,
    log: app.log,
    secrets: new SecretStore({ db, keys }),
    audit: auditFor(app),
    jobs: jobRunnerFor(app),
    hermes,
    // Shared providers, their models and keys are stored under the default profile
    // (contract decision §37).
    hubScope: () => {
      const row = defaultWorkspace(db);
      return row ? { id: row.id, slug: row.slug, name: row.name, isDefault: row.isDefault } : null;
    },
    // A named Hermes profile is the workspace of that slug (ADR 0014).
    profileWorkspace: (profile) => {
      const row = findWorkspace(db, profile);
      return row && !row.isDefault ? row.id : null;
    },
    ...(own.fetchImpl ? { fetchImpl: own.fetchImpl } : {}),
    ...(own.restartDelayMs === undefined ? {} : { restartDelayMs: own.restartDelayMs }),
  });
  contexts.set(hub.io, service);
  return service;
}

export function modelsServiceFor(app: FastifyInstance): ModelsService {
  return contextOf(app);
}

const scopeOf = (request: FastifyRequest): WorkspaceScope => {
  const workspace = request.workspace;
  if (!workspace) throw new HubError('internal', { message: 'route has no workspace' });
  return workspace;
};

const actorOf = (request: FastifyRequest): { userId: string } => {
  const principal = request.principal;
  if (!principal) throw new HubError('internal', { message: 'route has no principal' });
  return { userId: principal.user.id };
};

/** The service, the workspace and the acting user in one step. */
function enter(request: FastifyRequest): {
  service: ModelsService;
  scope: WorkspaceScope;
  actor: { userId: string };
} {
  return { service: contextOf(request.server), scope: scopeOf(request), actor: actorOf(request) };
}

export const modelsModule = defineModule({
  name: 'models',
  registerRoutes(app: FastifyInstance) {
    const document = loadOpenApiDocument();
    if (!document) throw new Error('packages/contracts/openapi.yaml is required (ADR 0003)');
    const deps = {
      contract: createContractIndex(document),
      guards: { requireUser, requireWorkspace, requireRole },
    };

    // The port `agents` asked for: every coding agent's credentials and default model
    // come from here, so installing one needs no key entry (ADR 0010). It reads rows and
    // creates none, so it needs no owner to attribute anything to.
    const port: AgentModelsPort = {
      environmentFor(workspace, declared, extra) {
        return contextOf(app).environmentFor(workspace, declared, extra);
      },
      defaultModelFor(workspace, adapterKind, pinnedModelId) {
        const service = contextOf(app);
        if (pinnedModelId) {
          const pinned = service.refForModelId(workspace, pinnedModelId);
          if (pinned) return pinned;
        }
        return service.defaultRefFor(workspace, adapterKind);
      },
      resolveModelKey(workspace, key) {
        return contextOf(app).resolveModelKey(workspace, key);
      },
      runtimeProviderName(workspace, providerId) {
        return contextOf(app).hermesProviderName(workspace, providerId);
      },
      roleForAdapter,
      // The `direct` agent's whole connection to this module (ADOPTION-BACKLOG §2.15).
      // It hands over a provider row id and a model and reads events; the row, the key
      // and the adapter that answered stay on this side of the line (ADR 0010).
      modelFacts(workspace, providerId, model) {
        return contextOf(app).modelFacts(workspace, providerId, model);
      },
      directChat(workspace, request) {
        return contextOf(app).chat(workspace, request);
      },
      // A named Hermes profile, just before one of its turns: the endpoints it uses in its
      // config, and in its own `.env` exactly the keys that differ from the root's (§37).
      prepareRuntimeProfile(profileHome) {
        contextOf(app).prepareProfile(profileHome);
      },
      // A messaging gateway about to start (`agents/hermes-gateways.ts`): the same preparation,
      // plus the model, which a gateway reads from its file where a turn names its own.
      prepareGatewayProfile(profile, home) {
        contextOf(app).prepareGateway(profile, home);
      },
    };
    registerAgentModelsPort(app.hub.io, port);

    /**
     * Boot reconciliation (ADR 0010 §Propagation).
     *
     * Hermes's home is a volume, and a volume outlives the rows that describe it: a
     * restored backup, an image upgrade, a `config.yaml` somebody edited by hand, or a
     * hub that crashed between storing a key and writing it, all leave Hermes describing
     * a world that is no longer this one. Writing only on change meant that state could
     * never heal — the owner had to touch a provider to fix a file nobody had touched.
     *
     * Runs after the `agents` module's own `onReady`, which is what decides whether there
     * is a supervised home to write into at all (modules are registered in order, and
     * Fastify runs `onReady` hooks in registration order). Nothing here throws: a hub
     * whose Hermes home is unwritable still serves every other screen.
     */
    app.addHook('onReady', async () => {
      const db = requireSqlite(app.hub.database);
      const owner = ownerUser(db);
      if (!owner) return;
      const service = contextOf(app);
      // Once: the root is the default profile's, whoever saved (decision §37). Reconciling per
      // profile used to leave Hermes with whichever profile came last.
      const row = defaultWorkspace(db);
      if (!row) return;
      try {
        service.reconcile(
          { id: row.id, slug: row.slug, name: row.name, isDefault: row.isDefault },
          { userId: owner.id },
        );
      } catch (error) {
        app.log.warn(
          { err: error, workspace: row.slug },
          'models: could not reconcile the Hermes configuration at boot',
        );
      }
    });

    // --------------------------------------------------------------- providers

    defineRoute(app, deps, {
      operationId: 'models.listProviders',
      handler: (request, { query }) => {
        const { service, scope } = enter(request);
        return {
          items: service.listProviders(scope, {
            ...(query.kind ? { kind: query.kind as string } : {}),
          }),
        };
      },
    });

    defineRoute(app, deps, {
      operationId: 'models.listProviderPresets',
      handler: (request, { query }) => {
        const { service } = enter(request);
        return service.listPresets({ ...(query.kind ? { kind: query.kind as string } : {}) });
      },
    });

    defineRoute(app, deps, {
      operationId: 'models.probeProvider',
      handler: async (request, { body }) => {
        const { service } = enter(request);
        const outcome = await service.probeProvider(body as ProviderProbeInput);
        return {
          ok: outcome.ok,
          // The endpoint's own words after the localised sentence, exactly as
          // `models.testProvider` does it; null when there was nothing to explain.
          message: outcome.reasonKey
            ? [t(outcome.reasonKey, request.language), outcome.detail].filter(Boolean).join(' — ')
            : null,
          duration_ms: outcome.durationMs,
          models: outcome.models,
        };
      },
    });

    defineRoute(app, deps, {
      operationId: 'models.createProvider',
      status: 201,
      handler: async (request, { body }) => {
        const { service, scope, actor } = enter(request);
        return (await service.createProvider(scope, actor, body as ProviderCreateInput)).provider;
      },
    });

    defineRoute(app, deps, {
      operationId: 'models.updateProvider',
      handler: async (request, { params, body }) => {
        const { service, scope, actor } = enter(request);
        return await service.updateProvider(
          scope,
          actor,
          params.provider_id as string,
          body as ProviderPatchInput,
        );
      },
    });

    defineRoute(app, deps, {
      operationId: 'models.deleteProvider',
      status: 204,
      handler: (request, { params }) => {
        const { service, scope, actor } = enter(request);
        service.deleteProvider(scope, actor, params.provider_id as string);
        return null;
      },
    });

    defineRoute(app, deps, {
      operationId: 'models.refreshProvider',
      status: 202,
      handler: (request, { params }) => {
        const { service, scope, actor } = enter(request);
        const job = service.refreshProvider(scope, actor, params.provider_id as string);
        if (!job) {
          throw new HubError('state_invalid', {
            messageKey: 'models.catalogue.not_refreshable',
            details: { reason: 'catalogue_not_refreshable' },
          });
        }
        return { job_id: job.id };
      },
    });

    defineRoute(app, deps, {
      operationId: 'models.testProvider',
      handler: async (request, { params }) => {
        const { service, scope } = enter(request);
        const outcome = await service.testProvider(scope, params.provider_id as string);
        const message = t(outcome.reasonKey, request.language);
        return {
          ok: outcome.ok,
          // The provider's own words help; the localised sentence says what happened.
          message: outcome.detail ? `${message} — ${outcome.detail}` : message,
          duration_ms: outcome.durationMs,
        };
      },
    });

    // ------------------------------------------------------------------ models

    defineRoute(app, deps, {
      operationId: 'models.putModel',
      handler: (request, { params, body }) => {
        const { service, scope, actor } = enter(request);
        return service.putModel(
          scope,
          actor,
          params.provider_id as string,
          decodeURIComponent(params.model as string),
          body as ModelPatchInput,
        );
      },
    });

    defineRoute(app, deps, {
      operationId: 'models.deleteModel',
      status: 204,
      handler: (request, { params }) => {
        const { service, scope, actor } = enter(request);
        service.deleteModel(
          scope,
          actor,
          params.provider_id as string,
          decodeURIComponent(params.model as string),
        );
        return null;
      },
    });

    defineRoute(app, deps, {
      operationId: 'models.listCatalogue',
      handler: (request, { query }) => {
        const { service, scope } = enter(request);
        return service.listCatalogue(scope, {
          ...(query.kind ? { kind: query.kind as string } : {}),
          ...(query.provider_id ? { provider_id: query.provider_id as string } : {}),
          ...(query.visible !== undefined ? { visible: query.visible as boolean } : {}),
          ...(query.q ? { q: query.q as string } : {}),
          ...(query.cursor ? { cursor: query.cursor as string } : {}),
          ...(query.limit !== undefined ? { limit: query.limit as number } : {}),
        });
      },
    });

    // ---------------------------------------------------------------- defaults

    defineRoute(app, deps, {
      operationId: 'models.getRuntime',
      handler: (request) => {
        const { service, scope } = enter(request);
        return service.runtimeReport(scope.id);
      },
    });

    defineRoute(app, deps, {
      operationId: 'models.getDefaults',
      handler: (request) => {
        const { service, scope } = enter(request);
        return service.getDefaults(scope);
      },
    });

    defineRoute(app, deps, {
      operationId: 'models.setDefaults',
      handler: (request, { body }) => {
        const { service, scope, actor } = enter(request);
        return service.setDefaults(scope, actor, body as DefaultsWriteInput);
      },
    });

    // --------------------------------------------------------------- ensembles

    defineRoute(app, deps, {
      operationId: 'models.listEnsembles',
      handler: (request) => {
        const { service, scope } = enter(request);
        return { items: service.listEnsembles(scope) };
      },
    });

    defineRoute(app, deps, {
      operationId: 'models.createEnsemble',
      status: 201,
      handler: (request, { body }) => {
        const { service, scope, actor } = enter(request);
        return service.createEnsemble(scope, actor, body as EnsembleWriteInput);
      },
    });

    defineRoute(app, deps, {
      operationId: 'models.updateEnsemble',
      handler: (request, { params, body }) => {
        const { service, scope, actor } = enter(request);
        return service.updateEnsemble(
          scope,
          actor,
          params.ensemble_id as string,
          body as EnsembleWriteInput,
        );
      },
    });

    defineRoute(app, deps, {
      operationId: 'models.deleteEnsemble',
      status: 204,
      handler: (request, { params }) => {
        const { service, scope, actor } = enter(request);
        service.deleteEnsemble(scope, actor, params.ensemble_id as string);
        return null;
      },
    });

    // ------------------------------------------------------------------ speech

    /**
     * `SpeechSide.reason` leaves as a sentence, not a key: the contract's example is a
     * sentence, and a client that is not ours would otherwise render `models.speech.…`.
     * The service keeps the key so the choice of language stays with the request.
     */
    const localiseSpeech = (
      speech: ReturnType<ModelsService['getSpeech']>,
      request: FastifyRequest,
    ) => ({
      stt: { ...speech.stt, reason: speech.stt.reason && t(speech.stt.reason, request.language) },
      tts: { ...speech.tts, reason: speech.tts.reason && t(speech.tts.reason, request.language) },
    });

    defineRoute(app, deps, {
      operationId: 'models.getSpeech',
      handler: (request) => {
        const { service, scope, actor } = enter(request);
        return localiseSpeech(service.getSpeech(scope, actor.userId), request);
      },
    });

    defineRoute(app, deps, {
      operationId: 'models.updateSpeech',
      handler: (request, { body }) => {
        const { service, scope, actor } = enter(request);
        return localiseSpeech(
          service.updateSpeech(scope, actor, body as SpeechPatchInput),
          request,
        );
      },
    });

    defineRoute(app, deps, {
      operationId: 'models.listVoices',
      handler: async (request, { query }) => {
        const { service, scope } = enter(request);
        return { items: await service.listVoices(scope, query.provider_id as string) };
      },
    });

    defineRoute(app, deps, {
      operationId: 'models.synthesize',
      handler: async (request, { body }, reply: FastifyReply) => {
        const { service, scope, actor } = enter(request);
        const input = body as {
          text: string;
          language?: string | null;
          voice?: string | null;
          provider_id?: string | null;
        };
        const spoken = await service.synthesize(scope, actor.userId, {
          text: input.text,
          language: input.language ?? null,
          voice: input.voice ?? null,
          providerId: input.provider_id ?? null,
        });
        return reply
          .header('X-Speech-Provider', spoken.provider)
          .type(spoken.contentType)
          .send(Buffer.from(spoken.audio));
      },
    });

    // ------------------------------------------------- the documented gaps

    /**
     * Declared in the contract, deliberately not implemented, and each says which gap it
     * is waiting on. An explicit route is better than the app's generic 501 stub: the
     * client gets the reason, not just "not implemented yet".
     */
    const gaps: Record<string, string> = {
      'models.startProviderSignIn': 'models.signin.not_implemented',
      'models.getProviderSignIn': 'models.signin.not_implemented',
      'models.completeProviderSignIn': 'models.signin.not_implemented',
      'models.transcribe': 'models.transcribe.not_implemented',
    };
    for (const [operationId, messageKey] of Object.entries(gaps)) {
      defineRoute(app, deps, {
        operationId,
        handler: () => {
          throw new HubError('not_implemented', {
            messageKey,
            details: { operation_id: operationId },
          });
        },
      });
    }
  },
  registerEvents(_io: SocketServer) {
    // This module does not stream (ARCHITECTURE §Realtime). A catalogue refresh is a job
    // and reports itself on `/rt/jobs` like every other 202.
  },
});

export const registerRoutes = modelsModule.registerRoutes.bind(modelsModule);
export const registerEvents = modelsModule.registerEvents.bind(modelsModule);
