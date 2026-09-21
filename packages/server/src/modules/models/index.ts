/**
 * Module `models`: the hub's one provider and credential store (ADR 0010).
 *
 * Implemented: `models.listProviders`, `models.createProvider`, `models.updateProvider`,
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
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Server as SocketServer } from 'socket.io';
import { loadOpenApiDocument } from '@majlis/contracts';
import { requireSqlite } from '../../lib/db.js';
import { HubError } from '../../lib/errors.js';
import { createContractIndex } from '../../lib/contract.js';
import { defineModule } from '../../lib/module.js';
import { defineRoute } from '../../lib/route.js';
import { t } from '../../i18n/index.js';
import {
  ownerUser,
  requireRole,
  requireUser,
  requireWorkspace,
  type WorkspaceScope,
} from '../auth/index.js';
import { auditFor, jobRunnerFor } from '../audit/index.js';
import {
  hermesRuntimeFor,
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
  type SpeechPatchInput,
} from './service.js';

export { ModelsService } from './service.js';
export type {
  Actor,
  DefaultsWriteInput,
  EnsembleWriteInput,
  HermesTarget,
  ModelPatchInput,
  ModelRefInput,
  ModelsServiceOptions,
  ProviderCreateInput,
  ProviderPatchInput,
  SpeechPatchInput,
  TestOutcome,
} from './service.js';
export { DataKeyRing, MASKED, hintOf, isMask, maskSecret } from './crypto.js';
export type { SealedSecret } from './crypto.js';
export { SecretStore } from './secrets.js';
export type { SecretSummary } from './secrets.js';
export {
  PROVIDER_CATALOGUE,
  assertCatalogueIsWellFormed,
  catalogueEntry,
  envVarOf,
  familyEntries,
  secretNameOf,
} from './catalogue.js';
export type { CredentialFamily, ProviderCatalogueEntry } from './catalogue.js';
export { AUXILIARY_TASKS, roleForAdapter } from './defaults.js';
export {
  agentEnvironment,
  writeHermesConfiguration,
  writeHermesEnv,
  writeHermesModel,
} from './propagation.js';
export type { PropagationState, ResolvedCredential } from './propagation.js';
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
}

let pendingOverrides: ModelsOverrides | null = null;
const overrides = new WeakMap<SocketServer, ModelsOverrides>();

/** Used by the test helpers: the next app to build takes these. */
export function overrideModels(next: ModelsOverrides | null): void {
  pendingOverrides = next;
}

const contexts = new WeakMap<SocketServer, ModelsService>();

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
  const keys = own.keys ?? DataKeyRing.open(hub.config.dataDir);
  const runtime = hermesRuntimeFor(app);
  const hermes: HermesTarget = own.hermes ?? {
    // Only a runtime this hub supervises has a home the hub may write into; an
    // external gateway is somebody else's process with somebody else's files.
    home: () => runtime.status().home,
    restart: async () => {
      if (runtime.status().mode !== 'managed') return false;
      await runtime.restart();
      return true;
    },
  };
  const service = new ModelsService({
    db,
    log: app.log,
    secrets: new SecretStore({ db, keys }),
    audit: auditFor(app),
    jobs: jobRunnerFor(app),
    hermes,
    ...(own.fetchImpl ? { fetchImpl: own.fetchImpl } : {}),
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

/** Seeds the workspace's providers and hands back scope + actor in one step. */
function enter(request: FastifyRequest): {
  service: ModelsService;
  scope: WorkspaceScope;
  actor: { userId: string };
} {
  const service = contextOf(request.server);
  const scope = scopeOf(request);
  const actor = actorOf(request);
  service.ready(scope, actor.userId);
  return { service, scope, actor };
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
    // come from here, so installing one needs no key entry (ADR 0010).
    const owner = ownerUser(requireSqlite(app.hub.database));
    const port: AgentModelsPort = {
      environmentFor(workspace, declared, extra) {
        const service = contextOf(app);
        service.readyById(workspace, owner?.id ?? 'system');
        return service.environmentFor(workspace, declared, extra);
      },
      defaultModelFor(workspace, adapterKind, pinnedModelId) {
        const service = contextOf(app);
        service.readyById(workspace, owner?.id ?? 'system');
        if (pinnedModelId) {
          const pinned = service.refForModelId(workspace, pinnedModelId);
          if (pinned) return pinned;
        }
        return service.defaultRefFor(workspace, adapterKind);
      },
      roleForAdapter,
    };
    registerAgentModelsPort(app.hub.io, port);

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
      operationId: 'models.createProvider',
      status: 201,
      handler: (request, { body }) => {
        const { service, scope, actor } = enter(request);
        return service.createProvider(scope, actor, body as ProviderCreateInput).provider;
      },
    });

    defineRoute(app, deps, {
      operationId: 'models.updateProvider',
      handler: (request, { params, body }) => {
        const { service, scope, actor } = enter(request);
        return service.updateProvider(
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

    defineRoute(app, deps, {
      operationId: 'models.getSpeech',
      handler: (request) => {
        const { service, scope, actor } = enter(request);
        return service.getSpeech(scope, actor.userId);
      },
    });

    defineRoute(app, deps, {
      operationId: 'models.updateSpeech',
      handler: (request, { body }) => {
        const { service, scope, actor } = enter(request);
        return service.updateSpeech(scope, actor, body as SpeechPatchInput);
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
  },
  registerEvents(_io: SocketServer) {
    // This module does not stream (ARCHITECTURE §Realtime). A catalogue refresh is a job
    // and reports itself on `/rt/jobs` like every other 202.
  },
});

export const registerRoutes = modelsModule.registerRoutes.bind(modelsModule);
export const registerEvents = modelsModule.registerEvents.bind(modelsModule);
