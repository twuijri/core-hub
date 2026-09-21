/**
 * `ModelsService` — the hub's one provider and credential store (ADR 0010).
 *
 * It owns four things and hands out a fifth:
 *   1. providers (the bundled catalogue seeded per workspace, plus custom ones),
 *   2. the encrypted key behind each credential family (`secrets.ts`, `crypto.ts`),
 *   3. the model catalogue each provider itself reported (`adapters/`),
 *   4. defaults, ensembles and the speech configuration,
 *   5. propagation: the environment every agent starts with, and Hermes's own `.env`
 *      (`propagation.ts`) — so nobody configures a provider twice.
 *
 * Every write that can change what an agent should be using ends in `propagate()`. That
 * is the whole of the owner's requirement, in one call site per mutation.
 */
import type { FastifyBaseLogger } from 'fastify';
import { eq } from 'drizzle-orm';
import type { ModuleDb } from '../../lib/db.js';
import { HubError, conflict, notFound, validationFailed } from '../../lib/errors.js';
import { clampLimit } from '../../lib/pagination.js';
import { newUlid } from '../../db/ids.js';
import type { WorkspaceScope } from '../auth/index.js';
import type { AuditService, JobRow, JobRunner } from '../audit/index.js';
import { providerAdapter } from './adapters/index.js';
import type { DiscoveredVoice, ProviderContext, SynthesizeResult } from './adapters/types.js';
import { catalogueEntry, secretNameOf, type ProviderCatalogueEntry } from './catalogue.js';
import { isMask } from './crypto.js';
import { AUXILIARY_TASKS, isAuxiliaryKey, roleForAdapter } from './defaults.js';
import {
  agentEnvironment,
  writeHermesConfiguration,
  type HermesModelChoice,
  type PropagationState,
  type ResolvedCredential,
} from './propagation.js';
import {
  ensembles,
  models,
  providers,
  speechSettings,
  type EnsembleMemberValue,
  type ModelRole,
  type ModelRow,
  type ProviderRow,
} from './schema.js';
import type { SecretStore } from './secrets.js';
import { ModelsStore } from './store.js';
import {
  modelKeyOf,
  serializeEnsemble,
  serializeModel,
  serializeProvider,
  serializeSpeechProvider,
  type ContractEnsemble,
  type ContractModel,
  type ContractProvider,
  type ContractSpeechProvider,
} from './serialize.js';

export interface Actor {
  userId: string;
}

/** What the service needs to reach the Hermes runtime without importing its module. */
export interface HermesTarget {
  /** The home the supervised gateway reads, or null when there is none to write to. */
  home(): string | null;
  /** Recycle the gateway so a changed `.env` takes effect; false when it cannot. */
  restart(): Promise<boolean>;
}

export interface ModelsServiceOptions {
  db: ModuleDb;
  log: FastifyBaseLogger;
  secrets: SecretStore;
  audit: AuditService;
  jobs: JobRunner;
  hermes: HermesTarget;
  /** Injected in every test; the suite never reaches the network. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface ProviderCreateInput {
  label: string;
  kind: 'llm' | 'stt' | 'tts';
  base_url?: string | null;
  api_key?: string | null;
  api_mode?: 'chat_completions' | 'responses';
}

export interface ProviderPatchInput {
  label?: string;
  enabled?: boolean;
  api_key?: string | null;
  base_url?: string | null;
  api_mode?: 'native' | 'chat_completions' | 'responses';
  visibility?: { mode: 'all' | 'include'; models: string[] };
}

export interface ModelPatchInput {
  alias?: string | null;
  visible?: boolean;
  context_window?: number | null;
  custom?: boolean;
}

export interface ModelRefInput {
  provider_id: string;
  model: string;
}

export interface DefaultsWriteInput {
  default?: ModelRefInput | null;
  fallbacks?: ModelRefInput[];
  assignments?: Record<string, ModelRefInput | null>;
}

export interface EnsembleWriteInput {
  name?: string;
  enabled?: boolean;
  active?: boolean;
  members?: (ModelRefInput & { reasoning_effort?: string | null })[];
  aggregator?: ModelRefInput & { reasoning_effort?: string | null };
  max_tokens?: number | null;
}

export interface SpeechPatchInput {
  stt_provider_id?: string | null;
  tts_provider_id?: string | null;
  providers?: {
    id: string;
    api_key?: string | null;
    settings?: Record<string, unknown>;
  }[];
}

export interface TestOutcome {
  ok: boolean;
  /** i18n key under `models.test.*`; the route translates it. */
  reasonKey: string;
  detail: string | null;
  durationMs: number;
}

export class ModelsService {
  private readonly store: ModelsStore;
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ModelsServiceOptions) {
    this.store = new ModelsStore({
      db: options.db,
      ...(options.now ? { now: options.now } : {}),
    });
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  private get db(): ModuleDb {
    return this.options.db;
  }

  // ------------------------------------------------------------------ providers

  /** Seeds the workspace's provider rows. Called by every route before it reads. */
  ready(scope: WorkspaceScope, ownerId: string): void {
    this.store.seed(scope.id, ownerId);
  }

  /**
   * The same, for a caller that holds a workspace id and no scope — the `agents` module
   * resolving credentials while starting a process, where no request is in flight.
   */
  readyById(workspace: string, ownerId: string): void {
    this.store.seed(workspace, ownerId);
  }

  listProviders(scope: WorkspaceScope, filter: { kind?: string } = {}): ContractProvider[] {
    return this.store.listProviders(scope.id, filter.kind).map((row) => this.present(scope, row));
  }

  getProvider(scope: WorkspaceScope, id: string): ContractProvider {
    return this.present(scope, this.loadProvider(scope, id));
  }

  createProvider(
    scope: WorkspaceScope,
    actor: Actor,
    input: ProviderCreateInput,
  ): { provider: ContractProvider; job: JobRow | null } {
    const label = input.label.trim();
    if (!label) throw validationFailed({ field: 'label', reason: 'empty' });
    const baseUrl = (input.base_url ?? '').trim();
    if (!baseUrl) {
      throw validationFailed({
        field: 'base_url',
        reason: 'a custom provider needs the base URL of its OpenAI-compatible endpoint',
      });
    }
    try {
      void new URL(baseUrl);
    } catch {
      throw validationFailed({ field: 'base_url', reason: 'not a URL' });
    }
    const slug = this.freeSlug(scope.id, label);
    const at = this.now();
    const id = newUlid();
    // A custom provider is its own credential family: it is somebody's own endpoint, and
    // sharing a key with a built-in provider of the same name would be a guess.
    const family = `custom:${slug}`;
    this.db
      .insert(providers)
      .values({
        id,
        ownerId: actor.userId,
        workspace: scope.id,
        createdAt: at,
        updatedAt: at,
        slug,
        label,
        kind: input.kind,
        builtin: false,
        enabled: true,
        baseUrl,
        apiMode: input.api_mode ?? 'chat_completions',
        authKind: input.api_key ? 'api_key' : 'none',
        family,
        capabilities: { chat: input.kind === 'llm', listModels: true },
        catalogueStatus: 'loading',
      })
      .run();
    if (input.api_key) this.storeKey(scope, actor, family, input.api_key);
    this.options.audit.record({
      workspace: scope.id,
      ownerId: actor.userId,
      actorKind: 'user',
      actorId: actor.userId,
      action: 'provider.created',
      entityKind: 'provider',
      entityId: id,
      summary: `provider ${slug} added`,
      data: { slug, kind: input.kind },
    });
    const job = this.refreshProvider(scope, actor, id);
    return { provider: this.getProvider(scope, id), job };
  }

  updateProvider(
    scope: WorkspaceScope,
    actor: Actor,
    id: string,
    patch: ProviderPatchInput,
  ): ContractProvider {
    const row = this.loadProvider(scope, id);
    const changes: Partial<typeof providers.$inferInsert> = { updatedAt: this.now() };
    if (patch.label !== undefined) changes.label = patch.label.trim() || row.label;
    if (patch.enabled !== undefined) changes.enabled = patch.enabled;
    if (patch.base_url !== undefined) changes.baseUrl = patch.base_url?.trim() || null;
    if (patch.api_mode !== undefined) changes.apiMode = patch.api_mode;
    if (patch.visibility !== undefined) {
      changes.visibilityMode = patch.visibility.mode;
      changes.visibleModels = [...patch.visibility.models];
    }

    let keyChanged = false;
    if (patch.api_key !== undefined && !isMask(patch.api_key)) {
      const value = patch.api_key?.trim() ?? '';
      if (value === '') {
        this.clearKey(scope, row.family);
        changes.authKind = row.builtin ? row.authKind : 'none';
        changes.status = 'unconfigured';
        changes.lastError = null;
      } else {
        this.storeKey(scope, actor, row.family, value);
        changes.authKind = 'api_key';
        // Nothing has been proven yet: the status stays `unconfigured` until a test or a
        // refresh actually reaches the provider.
        changes.status = 'unconfigured';
        changes.lastError = null;
      }
      keyChanged = true;
    }

    this.db.update(providers).set(changes).where(eq(providers.id, row.id)).run();
    this.options.audit.record({
      workspace: scope.id,
      ownerId: actor.userId,
      actorKind: 'user',
      actorId: actor.userId,
      action: keyChanged ? 'secret.updated' : 'provider.updated',
      entityKind: 'provider',
      entityId: row.id,
      summary: `provider ${row.slug} updated`,
      // Never the key, never its length: only that one changed.
      data: { slug: row.slug, key_changed: keyChanged },
    });

    if (keyChanged || patch.enabled !== undefined) {
      this.propagate(scope, actor);
      // `row` was read before the write; ask the table what it says now, or a key that
      // just arrived would look absent and its catalogue would never be fetched.
      const fresh = this.loadProvider(scope, row.id);
      // A key that just arrived deserves the model list it unlocks, without a second click.
      if (keyChanged && this.hasKey(scope, fresh)) this.refreshFamily(scope, actor, fresh.family);
    }
    return this.getProvider(scope, row.id);
  }

  deleteProvider(scope: WorkspaceScope, actor: Actor, id: string): void {
    const row = this.loadProvider(scope, id);
    if (row.builtin) {
      throw conflict({
        reason: 'builtin_provider',
        detail: 'a built-in provider can be disabled, never removed',
      });
    }
    const at = this.now();
    this.db
      .update(providers)
      .set({ archivedAt: at, enabled: false, updatedAt: at })
      .where(eq(providers.id, row.id))
      .run();
    this.clearKey(scope, row.family);
    this.options.audit.record({
      workspace: scope.id,
      ownerId: actor.userId,
      actorKind: 'user',
      actorId: actor.userId,
      action: 'provider.deleted',
      entityKind: 'provider',
      entityId: row.id,
      summary: `provider ${row.slug} removed`,
      data: { slug: row.slug },
    });
    this.propagate(scope, actor);
  }

  /** One small authenticated request. A failure is still a `200` with `ok: false`. */
  async testProvider(scope: WorkspaceScope, id: string): Promise<TestOutcome> {
    const row = this.loadProvider(scope, id);
    const entry = this.entryOf(row);
    const adapter = providerAdapter(entry?.protocol ?? 'openai');
    const result = await adapter.test(this.contextOf(scope, row));
    const at = this.now();
    this.db
      .update(providers)
      .set({
        status: result.ok ? 'ok' : 'error',
        lastCheckedAt: at,
        lastError: result.ok ? null : (result.detail ?? result.reason),
        updatedAt: at,
      })
      .where(eq(providers.id, row.id))
      .run();
    return {
      ok: result.ok,
      reasonKey: `models.test.${result.reason}`,
      detail: result.detail,
      durationMs: result.durationMs,
    };
  }

  /**
   * Asks the provider for its own model list, as a job (invariant 4). Returns null when
   * the provider has no list to give — the caller answers `409 state_invalid` rather
   * than starting a job that could only fail.
   */
  refreshProvider(scope: WorkspaceScope, actor: Actor, id: string): JobRow | null {
    const row = this.loadProvider(scope, id);
    const entry = this.entryOf(row);
    if (entry && entry.capabilities.listModels === false) return null;
    const at = this.now();
    this.db
      .update(providers)
      .set({ catalogueStatus: 'loading', catalogueError: null, updatedAt: at })
      .where(eq(providers.id, row.id))
      .run();
    return this.options.jobs.start(
      {
        workspace: scope.id,
        ownerId: actor.userId,
        // The contract's `JobKind` is the verb after the dot (docs/domain/audit.md).
        kind: 'models.refresh_catalogue',
        entityKind: 'provider',
        entityId: row.id,
        input: { slug: row.slug },
      },
      async (handle) => {
        handle.progress(20, `asking ${row.label} for its models`);
        const adapter = providerAdapter(entry?.protocol ?? 'openai');
        const current = this.loadProvider(scope, row.id);
        const result = await adapter.listModels(this.contextOf(scope, current));
        const finishedAt = this.now();
        if (!result.supported) {
          this.db
            .update(providers)
            .set({
              catalogueStatus: 'error',
              catalogueError: result.reason,
              updatedAt: finishedAt,
            })
            .where(eq(providers.id, row.id))
            .run();
          throw new HubError('agent_error', {
            message: `${row.label} did not return a model list`,
            details: { reason: result.reason },
          });
        }
        const report = this.store.replaceCatalogue(
          { workspace: scope.id, ownerId: actor.userId },
          row.id,
          result.models,
        );
        this.db
          .update(providers)
          .set({
            catalogueStatus: 'ready',
            catalogueError: null,
            catalogueRefreshedAt: finishedAt,
            updatedAt: finishedAt,
          })
          .where(eq(providers.id, row.id))
          .run();
        handle.progress(100, `${result.models.length} models`);
        return { ...report, models: result.models.length };
      },
    );
  }

  /** Every provider of one credential family gets its catalogue refreshed. */
  private refreshFamily(scope: WorkspaceScope, actor: Actor, family: string): void {
    for (const row of this.store.familyRows(scope.id, family)) {
      if (row.archivedAt || !row.enabled) continue;
      const entry = this.entryOf(row);
      if (entry && entry.capabilities.listModels === false) continue;
      this.refreshProvider(scope, actor, row.id);
    }
  }

  // --------------------------------------------------------------------- models

  listCatalogue(
    scope: WorkspaceScope,
    query: {
      kind?: string;
      provider_id?: string;
      visible?: boolean;
      q?: string;
      cursor?: string;
      limit?: number;
    },
  ): { items: ContractModel[]; next_cursor: string | null } {
    const bySlug = new Map(this.store.listProviders(scope.id).map((row) => [row.id, row]));
    const needle = query.q?.trim().toLowerCase();
    const visible = query.visible ?? true;
    // The catalogue is ordered by (provider, model), so its cursor is that pair rather
    // than a row id (`store.ts` §allModels).
    const after = decodeCatalogueCursor(query.cursor);
    const limit = clampLimit(query.limit);
    const matching = this.store
      .allModels(scope.id)
      .filter((row) => {
        const provider = bySlug.get(row.providerId);
        if (!provider || !provider.enabled || provider.archivedAt) return false;
        if (query.provider_id && row.providerId !== query.provider_id) return false;
        if (query.kind && row.kind !== query.kind) return false;
        if (visible && (!row.visible || !row.enabled)) return false;
        if (visible && !this.passesVisibility(provider, row.modelKey)) return false;
        if (needle) {
          const haystack = `${row.modelKey} ${row.label} ${row.alias ?? ''} ${provider.slug}`;
          if (!haystack.toLowerCase().includes(needle)) return false;
        }
        return true;
      })
      .filter((row) => !after || catalogueCursorOf(row) > after);
    const page = matching.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => serializeModel(row, bySlug.get(row.providerId)!.slug)),
      next_cursor:
        matching.length > limit && last ? encodeCatalogueCursor(catalogueCursorOf(last)) : null,
    };
  }

  putModel(
    scope: WorkspaceScope,
    actor: Actor,
    providerId: string,
    modelKey: string,
    patch: ModelPatchInput,
  ): ContractModel {
    const provider = this.loadProvider(scope, providerId);
    const at = this.now();
    let row = this.store.model(provider.id, modelKey);
    if (!row) {
      if (patch.custom !== true) {
        throw notFound({
          resource: 'model',
          id: modelKey,
          detail: 'send `custom: true` to register a model the provider does not list',
        });
      }
      this.db
        .insert(models)
        .values({
          id: newUlid(),
          ownerId: actor.userId,
          workspace: scope.id,
          createdAt: at,
          updatedAt: at,
          providerId: provider.id,
          modelKey,
          label: modelKey,
          kind: provider.kind === 'llm' ? 'chat' : provider.kind,
          source: 'manual',
        })
        .run();
      row = this.store.model(provider.id, modelKey);
      if (!row) throw new HubError('internal', { message: 'model row vanished after insert' });
    }
    const changes: Partial<typeof models.$inferInsert> = { updatedAt: at };
    if (patch.alias !== undefined) changes.alias = patch.alias?.trim() || null;
    if (patch.visible !== undefined) changes.visible = patch.visible;
    if (patch.context_window !== undefined) changes.contextWindow = patch.context_window;
    this.db.update(models).set(changes).where(eq(models.id, row.id)).run();
    const updated = this.store.model(provider.id, modelKey);
    if (!updated) throw new HubError('internal', { message: 'model row vanished after update' });
    return serializeModel(updated, provider.slug);
  }

  deleteModel(scope: WorkspaceScope, actor: Actor, providerId: string, modelKey: string): void {
    const provider = this.loadProvider(scope, providerId);
    const row = this.store.model(provider.id, modelKey);
    if (!row) throw notFound({ resource: 'model', id: modelKey });
    if (row.source !== 'manual') {
      throw conflict({
        reason: 'not_custom',
        detail: 'only a model somebody added by hand can be removed; hide the others',
      });
    }
    this.db.delete(models).where(eq(models.id, row.id)).run();
    this.options.audit.record({
      workspace: scope.id,
      ownerId: actor.userId,
      actorKind: 'user',
      actorId: actor.userId,
      action: 'model.deleted',
      entityKind: 'model',
      entityId: row.id,
      summary: `model ${modelKey} removed`,
      data: { provider: provider.slug, model: modelKey },
    });
  }

  // ------------------------------------------------------------------- defaults

  getDefaults(scope: WorkspaceScope): {
    default: ModelRefInput | null;
    fallbacks: ModelRefInput[];
    auxiliary: {
      tasks: { key: string; label: { ar: string; en: string } }[];
      assignments: Record<string, ModelRefInput>;
    };
  } {
    const chat = this.store.defaultFor(scope.id, 'chat');
    const assignments: Record<string, ModelRefInput> = {};
    for (const task of AUXILIARY_TASKS) {
      const row = this.store.defaultFor(scope.id, task.key);
      const ref = row ? this.refOf(scope, row.modelId) : null;
      if (ref) assignments[task.key] = ref;
    }
    const fallbacks: ModelRefInput[] = [];
    for (const modelId of chat?.fallbackModelIds ?? []) {
      const ref = this.refOf(scope, modelId);
      if (ref) fallbacks.push(ref);
    }
    return {
      default: chat ? this.refOf(scope, chat.modelId) : null,
      fallbacks,
      auxiliary: {
        tasks: AUXILIARY_TASKS.map((task) => ({ key: task.key, label: task.label })),
        assignments,
      },
    };
  }

  setDefaults(scope: WorkspaceScope, actor: Actor, body: DefaultsWriteInput) {
    if (body.default !== undefined) {
      if (body.default === null) {
        this.store.clearDefault(scope.id, 'chat');
      } else {
        const model = this.requireModel(scope, body.default);
        const fallbacks = (body.fallbacks ?? []).map((ref) => this.requireModel(scope, ref).id);
        this.store.setDefault(
          { workspace: scope.id, ownerId: actor.userId },
          'chat',
          model.id,
          fallbacks,
        );
      }
    } else if (body.fallbacks !== undefined) {
      const chat = this.store.defaultFor(scope.id, 'chat');
      if (!chat) {
        throw validationFailed({
          field: 'fallbacks',
          reason: 'a fallback chain needs a default model to fall back from',
        });
      }
      const fallbacks = body.fallbacks.map((ref) => this.requireModel(scope, ref).id);
      this.store.setDefault(
        { workspace: scope.id, ownerId: actor.userId },
        'chat',
        chat.modelId,
        fallbacks,
      );
    }

    for (const [key, ref] of Object.entries(body.assignments ?? {})) {
      if (!isAuxiliaryKey(key)) {
        throw validationFailed({
          field: `assignments.${key}`,
          reason: 'not a task this hub assigns a model to',
          known: AUXILIARY_TASKS.map((task) => task.key),
        });
      }
      if (ref === null) {
        this.store.clearDefault(scope.id, key);
        continue;
      }
      const model = this.requireModel(scope, ref);
      this.store.setDefault({ workspace: scope.id, ownerId: actor.userId }, key, model.id, []);
    }

    this.options.audit.record({
      workspace: scope.id,
      ownerId: actor.userId,
      actorKind: 'user',
      actorId: actor.userId,
      action: 'model_default.updated',
      entityKind: 'workspace',
      entityId: scope.id,
      summary: 'model defaults updated',
      data: { roles: Object.keys(body.assignments ?? {}) },
    });
    this.propagate(scope, actor);
    return this.getDefaults(scope);
  }

  // ------------------------------------------------------------------ ensembles

  listEnsembles(scope: WorkspaceScope): ContractEnsemble[] {
    return this.store.listEnsembles(scope.id).map((row) => serializeEnsemble(row, scope.slug));
  }

  createEnsemble(scope: WorkspaceScope, actor: Actor, body: EnsembleWriteInput): ContractEnsemble {
    const name = body.name?.trim();
    if (!name) throw validationFailed({ field: 'name', reason: 'required' });
    if (!body.aggregator) {
      throw validationFailed({
        field: 'aggregator',
        reason: 'an ensemble needs the model that combines the answers',
      });
    }
    const members = (body.members ?? []).map((member) => this.requireMember(scope, member));
    if (members.length === 0) {
      throw validationFailed({ field: 'members', reason: 'an ensemble needs at least one member' });
    }
    const aggregator = this.requireMember(scope, body.aggregator);
    const at = this.now();
    const id = newUlid();
    if (body.active === true) this.deactivateEnsembles(scope.id, at);
    this.db
      .insert(ensembles)
      .values({
        id,
        ownerId: actor.userId,
        workspace: scope.id,
        createdAt: at,
        updatedAt: at,
        name,
        enabled: body.enabled ?? true,
        active: body.active ?? false,
        members,
        aggregator,
        maxTokens: body.max_tokens ?? null,
      })
      .run();
    const row = this.store.ensemble(scope.id, id);
    if (!row) throw new HubError('internal', { message: 'ensemble vanished after insert' });
    return serializeEnsemble(row, scope.slug);
  }

  updateEnsemble(
    scope: WorkspaceScope,
    _actor: Actor,
    id: string,
    body: EnsembleWriteInput,
  ): ContractEnsemble {
    const row = this.store.ensemble(scope.id, id);
    if (!row || row.archivedAt) throw notFound({ resource: 'ensemble', id });
    const at = this.now();
    const changes: Partial<typeof ensembles.$inferInsert> = { updatedAt: at };
    if (body.name !== undefined) changes.name = body.name.trim() || row.name;
    if (body.enabled !== undefined) changes.enabled = body.enabled;
    if (body.max_tokens !== undefined) changes.maxTokens = body.max_tokens;
    if (body.members !== undefined) {
      changes.members = body.members.map((member) => this.requireMember(scope, member));
    }
    if (body.aggregator !== undefined) {
      changes.aggregator = this.requireMember(scope, body.aggregator);
    }
    if (body.active !== undefined) {
      if (body.active) this.deactivateEnsembles(scope.id, at);
      changes.active = body.active;
    }
    this.db.update(ensembles).set(changes).where(eq(ensembles.id, row.id)).run();
    const updated = this.store.ensemble(scope.id, id);
    if (!updated) throw new HubError('internal', { message: 'ensemble vanished after update' });
    return serializeEnsemble(updated, scope.slug);
  }

  deleteEnsemble(scope: WorkspaceScope, _actor: Actor, id: string): void {
    const row = this.store.ensemble(scope.id, id);
    if (!row || row.archivedAt) throw notFound({ resource: 'ensemble', id });
    this.db.delete(ensembles).where(eq(ensembles.id, row.id)).run();
  }

  // --------------------------------------------------------------------- speech

  getSpeech(scope: WorkspaceScope, ownerId: string) {
    const settings = this.store.ensureSpeech({ workspace: scope.id, ownerId });
    return {
      stt: this.speechSide(scope, 'stt', settings.sttProviderId),
      tts: this.speechSide(scope, 'tts', settings.ttsProviderId),
    };
  }

  updateSpeech(scope: WorkspaceScope, actor: Actor, patch: SpeechPatchInput) {
    const settings = this.store.ensureSpeech({ workspace: scope.id, ownerId: actor.userId });
    const at = this.now();
    const changes: Partial<typeof speechSettings.$inferInsert> = { updatedAt: at };
    if (patch.stt_provider_id !== undefined) {
      changes.sttProviderId = patch.stt_provider_id
        ? this.requireSpeechProvider(scope, patch.stt_provider_id, 'stt').id
        : null;
    }
    if (patch.tts_provider_id !== undefined) {
      changes.ttsProviderId = patch.tts_provider_id
        ? this.requireSpeechProvider(scope, patch.tts_provider_id, 'tts').id
        : null;
    }
    this.db.update(speechSettings).set(changes).where(eq(speechSettings.id, settings.id)).run();

    let keyChanged = false;
    for (const entry of patch.providers ?? []) {
      const row = this.loadProvider(scope, entry.id);
      const rowChanges: Partial<typeof providers.$inferInsert> = { updatedAt: at };
      if (entry.settings) {
        rowChanges.settings = {
          ...row.settings,
          ...(typeof entry.settings.model === 'string' || entry.settings.model === null
            ? { model: entry.settings.model }
            : {}),
          ...(typeof entry.settings.language === 'string' || entry.settings.language === null
            ? { language: entry.settings.language }
            : {}),
          ...(typeof entry.settings.voice === 'string' || entry.settings.voice === null
            ? { voice: entry.settings.voice }
            : {}),
        };
        if (typeof entry.settings.base_url === 'string')
          rowChanges.baseUrl = entry.settings.base_url;
      }
      if (entry.api_key !== undefined && !isMask(entry.api_key)) {
        const value = entry.api_key?.trim() ?? '';
        if (value === '') this.clearKey(scope, row.family);
        else this.storeKey(scope, actor, row.family, value);
        keyChanged = true;
      }
      this.db.update(providers).set(rowChanges).where(eq(providers.id, row.id)).run();
    }
    if (keyChanged) this.propagate(scope, actor);
    return this.getSpeech(scope, actor.userId);
  }

  async listVoices(scope: WorkspaceScope, providerId: string): Promise<DiscoveredVoice[]> {
    const row = this.loadProvider(scope, providerId);
    if (row.kind !== 'tts') {
      throw validationFailed({ field: 'provider_id', reason: 'not a text-to-speech provider' });
    }
    const adapter = providerAdapter(this.entryOf(row)?.protocol ?? 'openai');
    const result = await adapter.listVoices(this.contextOf(scope, row));
    // "No voice list" is an allowed answer in the contract, not an error: those providers
    // take a free-form voice id.
    return result.supported ? result.voices : [];
  }

  async synthesize(
    scope: WorkspaceScope,
    ownerId: string,
    request: {
      text: string;
      language: string | null;
      voice: string | null;
      providerId?: string | null;
    },
  ): Promise<{ audio: Uint8Array; contentType: string; provider: string }> {
    const settings = this.store.ensureSpeech({ workspace: scope.id, ownerId });
    const id = request.providerId ?? settings.ttsProviderId;
    if (!id) {
      throw new HubError('agent_unavailable', {
        messageKey: 'models.speech.no_tts_provider',
        details: { reason: 'no_tts_provider' },
      });
    }
    const row = this.requireSpeechProvider(scope, id, 'tts');
    if (!row.enabled) {
      throw new HubError('agent_unavailable', {
        messageKey: 'models.speech.provider_disabled',
        details: { reason: 'provider_disabled', provider: row.slug },
      });
    }
    const adapter = providerAdapter(this.entryOf(row)?.protocol ?? 'openai');
    const result: SynthesizeResult = await adapter.synthesize(this.contextOf(scope, row), {
      text: request.text,
      language: request.language,
      voice: request.voice,
    });
    if (!result.supported) {
      throw new HubError('agent_unavailable', {
        messageKey: 'models.speech.failed',
        details: { reason: result.reason, detail: result.detail ?? null, provider: row.slug },
      });
    }
    return { audio: result.audio, contentType: result.contentType, provider: row.slug };
  }

  // ---------------------------------------------------------------- propagation

  /**
   * What every agent should be using right now. Read by the propagation calls below and
   * by the `agents` module at process start.
   */
  state(workspace: string): PropagationState {
    const credentials: ResolvedCredential[] = [];
    const seen = new Set<string>();
    for (const row of this.store.listProviders(workspace)) {
      if (!row.enabled || seen.has(row.family)) continue;
      const entry = this.entryOf(row);
      const envVar = entry?.envVar;
      if (!envVar || !row.apiKeySecretId) continue;
      const value = this.options.secrets.reveal(workspace, row.apiKeySecretId);
      if (!value) continue;
      seen.add(row.family);
      credentials.push({
        family: row.family,
        envVar,
        hermesEnvVars: entry.hermesEnvVars.length > 0 ? [...entry.hermesEnvVars] : [envVar],
        value,
      });
    }
    const chat = this.hermesModelChoice(workspace);
    return { credentials, hermesModel: chat.choice, hermesModelBlocked: chat.blocked };
  }

  /**
   * The environment a coding agent starts with, derived from the shared providers. The
   * `agents` module calls this at `start()`; nobody enters a key per agent (ADR 0010).
   */
  environmentFor(
    workspace: string,
    declared: Readonly<Record<string, string>>,
    extra: {
      settingsEnv?: Readonly<Record<string, string>>;
      secretRefs?: Readonly<Record<string, string>>;
    } = {},
  ): Record<string, string> {
    const secretRefValues: Record<string, string> = {};
    for (const [name, secretId] of Object.entries(extra.secretRefs ?? {})) {
      const value = this.options.secrets.reveal(workspace, secretId);
      if (value !== null) secretRefValues[name] = value;
    }
    return agentEnvironment({
      credentials: this.state(workspace).credentials,
      declared,
      ...(extra.settingsEnv ? { settingsEnv: extra.settingsEnv } : {}),
      secretRefValues,
    });
  }

  /** The workspace default an agent of this adapter kind inherits, as a `ModelRef`. */
  defaultRefFor(workspace: string, adapterKind: string): ModelRefInput | null {
    const role = roleForAdapter(adapterKind);
    const primary = this.refOfRole(workspace, role);
    // A workspace that set only a chat default still gives its coding agents something.
    return primary ?? (role === 'coding' ? this.refOfRole(workspace, 'chat') : null);
  }

  /** A specific model row, as a `ModelRef` — the per-agent override path. */
  refForModelId(workspace: string, modelId: string): ModelRefInput | null {
    return this.refOf({ id: workspace } as WorkspaceScope, modelId);
  }

  /**
   * Writes the shared credentials and the chat default into the Hermes home this hub
   * supervises, then recycles the gateway so the change is live. Never throws: a hub
   * without Hermes, or a read-only volume, must not make "save the key" fail.
   */
  propagate(scope: WorkspaceScope, actor: Actor): void {
    const home = this.options.hermes.home();
    if (!home) return;
    const state = this.state(scope.id);
    if (state.hermesModelBlocked) {
      this.options.log.warn(
        { provider: state.hermesModelBlocked },
        'models: Hermes has no provider slug for the chat default; its model selection is left as it is',
      );
    }
    let result;
    try {
      result = writeHermesConfiguration(home, state);
    } catch (error) {
      this.options.log.warn(
        { err: error, home },
        'models: could not write the Hermes configuration; its providers are unchanged',
      );
      return;
    }
    if (!result.dirty) return;
    const changed = [...result.env.changed, ...result.model.changed];
    const removed = [...result.env.removed, ...result.model.removed];
    this.options.log.info(
      // Names only. A value never reaches a log line.
      { changed, removed },
      'models: Hermes configuration updated; restarting the gateway',
    );
    this.options.audit.record({
      workspace: scope.id,
      ownerId: actor.userId,
      actorKind: 'system',
      actorId: actor.userId,
      action: 'agent.reconfigured',
      entityKind: 'agent',
      entityId: 'hermes',
      summary: 'Hermes received the workspace providers',
      data: { changed, removed },
    });
    void this.options.hermes.restart().catch((error: unknown) => {
      this.options.log.warn({ err: error }, 'models: the Hermes gateway did not restart');
    });
  }

  // -------------------------------------------------------------------- helpers

  private present(scope: WorkspaceScope, row: ProviderRow): ContractProvider {
    const entry = this.entryOf(row);
    return serializeProvider(row, {
      profile: scope.slug,
      models: this.store.modelsOf(row.id),
      keyStored: this.hasKey(scope, row),
      refreshable: entry ? entry.capabilities.listModels !== false : true,
    });
  }

  private loadProvider(scope: WorkspaceScope, id: string): ProviderRow {
    const row = this.store.provider(scope.id, id);
    if (!row || row.archivedAt) throw notFound({ resource: 'provider', id });
    return row;
  }

  private requireSpeechProvider(
    scope: WorkspaceScope,
    id: string,
    kind: 'stt' | 'tts',
  ): ProviderRow {
    const row = this.loadProvider(scope, id);
    if (row.kind !== kind) {
      throw validationFailed({ field: 'provider_id', reason: `not a ${kind} provider` });
    }
    return row;
  }

  private entryOf(row: ProviderRow): ProviderCatalogueEntry | undefined {
    return catalogueEntry(row.slug);
  }

  private contextOf(scope: WorkspaceScope, row: ProviderRow): ProviderContext {
    const entry = this.entryOf(row);
    return {
      slug: row.slug,
      label: row.label,
      baseUrl: row.baseUrl ?? entry?.baseUrl ?? '',
      apiKey: row.apiKeySecretId ? this.options.secrets.reveal(scope.id, row.apiKeySecretId) : null,
      headers: { ...row.headers },
      settings: { ...row.settings },
      fetchImpl: this.fetchImpl,
    };
  }

  private hasKey(scope: WorkspaceScope, row: ProviderRow): boolean {
    return this.options.secrets.has(scope.id, row.apiKeySecretId);
  }

  /**
   * Stores one key for a whole credential family and points every provider row of that
   * family at it. This is the line that makes the OpenAI key entered on the chat tab the
   * same key the dictation tab uses (ADR 0010 §One key, many rows).
   */
  private storeKey(scope: WorkspaceScope, actor: Actor, family: string, plaintext: string): void {
    const secretId = this.options.secrets.put(
      { workspace: scope.id, ownerId: actor.userId },
      secretNameOf(family),
      plaintext,
      'api_key',
    );
    const at = this.now();
    for (const row of this.store.familyRows(scope.id, family)) {
      this.db
        .update(providers)
        .set({ apiKeySecretId: secretId, updatedAt: at })
        .where(eq(providers.id, row.id))
        .run();
    }
  }

  private clearKey(scope: WorkspaceScope, family: string): void {
    const rows = this.store.familyRows(scope.id, family);
    const secretId = rows.find((row) => row.apiKeySecretId)?.apiKeySecretId;
    if (secretId) this.options.secrets.wipe(scope.id, secretId);
    const at = this.now();
    for (const row of rows) {
      this.db
        .update(providers)
        .set({ apiKeySecretId: null, status: 'unconfigured', updatedAt: at })
        .where(eq(providers.id, row.id))
        .run();
    }
  }

  private passesVisibility(provider: ProviderRow, modelKey: string): boolean {
    if (provider.visibilityMode === 'all') return true;
    return provider.visibleModels.includes(modelKey);
  }

  private refOf(scope: Pick<WorkspaceScope, 'id'>, modelId: string): ModelRefInput | null {
    const row = this.store.modelById(scope.id, modelId);
    if (!row || row.archivedAt) return null;
    return { provider_id: row.providerId, model: row.modelKey };
  }

  private refOfRole(workspace: string, role: ModelRole): ModelRefInput | null {
    const row = this.store.defaultFor(workspace, role);
    if (!row) return null;
    return this.refOf({ id: workspace }, row.modelId);
  }

  /**
   * The workspace's chat default expressed the way Hermes names a model.
   *
   * `blocked` is the honest half: Hermes has no provider slug for Groq, Mistral or a
   * person's own endpoint, and its `openai` id is an alias of **OpenRouter**. Rather than
   * write a slug that would route a run to the wrong account, the hub writes nothing and
   * says which provider it could not express.
   */
  private hermesModelChoice(workspace: string): {
    choice: HermesModelChoice | null;
    blocked: string | null;
  } {
    const ref = this.refOfRole(workspace, 'chat');
    if (!ref) return { choice: null, blocked: null };
    const provider = this.db
      .select()
      .from(providers)
      .where(eq(providers.id, ref.provider_id))
      .get();
    if (!provider) return { choice: null, blocked: null };
    const hermesProvider = catalogueEntry(provider.slug)?.hermesProvider ?? null;
    if (!hermesProvider) return { choice: null, blocked: provider.slug };
    return { choice: { provider: hermesProvider, model: ref.model }, blocked: null };
  }

  private requireModel(scope: WorkspaceScope, ref: ModelRefInput): ModelRow {
    const provider = this.loadProvider(scope, ref.provider_id);
    const row = this.store.model(provider.id, ref.model);
    if (!row || row.archivedAt) {
      throw validationFailed({
        field: 'model',
        reason: 'the workspace has no such model on that provider',
        model: modelKeyOf(provider.slug, ref.model),
      });
    }
    return row;
  }

  private requireMember(
    scope: WorkspaceScope,
    member: ModelRefInput & { reasoning_effort?: string | null },
  ): EnsembleMemberValue {
    const row = this.requireModel(scope, member);
    return {
      provider_id: row.providerId,
      model: row.modelKey,
      reasoning_effort: member.reasoning_effort ?? null,
    };
  }

  private deactivateEnsembles(workspace: string, at: Date): void {
    this.db
      .update(ensembles)
      .set({ active: false, updatedAt: at })
      .where(eq(ensembles.workspace, workspace))
      .run();
  }

  private speechSide(
    scope: WorkspaceScope,
    kind: 'stt' | 'tts',
    activeId: string | null,
  ): {
    active_provider_id: string | null;
    ready: boolean;
    reason: string | null;
    providers: ContractSpeechProvider[];
  } {
    const rows = this.store.listProviders(scope.id, kind);
    const list = rows.map((row) =>
      serializeSpeechProvider(row, { keyStored: this.hasKey(scope, row) }),
    );
    const active = activeId ? rows.find((row) => row.id === activeId) : undefined;
    const configured = active ? active.authKind === 'none' || this.hasKey(scope, active) : false;
    const ready = !!active && active.enabled && configured;
    // `reason` is a key the client localises, not a sentence the server invents in one
    // language (TEAM-RULES §4: no silent empty state).
    const reason = ready
      ? null
      : !active
        ? `models.speech.${kind}.not_chosen`
        : !active.enabled
          ? `models.speech.${kind}.disabled`
          : `models.speech.${kind}.no_key`;
    return { active_provider_id: active?.id ?? null, ready, reason, providers: list };
  }

  private freeSlug(workspace: string, label: string): string {
    const base =
      `custom-${label}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 36) || 'custom-provider';
    let candidate = base;
    for (let n = 2; n < 100; n += 1) {
      if (!this.store.providerBySlug(workspace, candidate)) return candidate;
      candidate = `${base}-${n}`;
    }
    throw conflict({ reason: 'slug_exhausted', detail: label });
  }
}

/**
 * The catalogue's cursor: the `(provider_id, model_key)` pair the list is ordered by,
 * base64url-encoded so a client cannot build one — the same contract the shared row-id
 * cursor offers (`lib/pagination.ts`), for a list that is not ordered by row id.
 */
function catalogueCursorOf(row: ModelRow): string {
  return `${row.providerId}\u0000${row.modelKey}`;
}

function encodeCatalogueCursor(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** Null for an absent or unreadable cursor: a bad cursor restarts the list. */
function decodeCatalogueCursor(cursor: string | undefined): string | null {
  if (!cursor) return null;
  const value = Buffer.from(cursor, 'base64url').toString('utf8');
  return value.includes('\u0000') ? value : null;
}
