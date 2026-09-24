/**
 * `ModelsService` — the hub's one provider and credential store (ADR 0010).
 *
 * It owns four things and hands out a fifth:
 *   1. providers — the rows a person added, from a preset or as their own endpoint,
 *      and the presets themselves (`catalogue.ts`), which are a list, not rows,
 *   2. the encrypted key behind each credential family (`secrets.ts`, `crypto.ts`),
 *   3. the model catalogue each provider itself reported (`adapters/`),
 *   4. defaults, ensembles and the speech configuration,
 *   5. propagation: the environment every agent starts with, and Hermes's own `.env`
 *      (`propagation.ts`) — so nobody configures a provider twice.
 *
 * Every write that can change what an agent should be using ends in `propagate()`. That
 * is the whole of the owner's requirement, in one call site per mutation.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { eq } from 'drizzle-orm';
import type { ModuleDb } from '../../lib/db.js';
import { HubError, conflict, notFound, validationFailed } from '../../lib/errors.js';
import { clampLimit } from '../../lib/pagination.js';
import { newUlid } from '../../db/ids.js';
import type { WorkspaceScope } from '../auth/index.js';
import type { AuditService, JobRow, JobRunner } from '../audit/index.js';
import { providerAdapter } from './adapters/index.js';
import type {
  ChatFailureReason,
  ChatMessage,
  DiscoveredVoice,
  ProviderContext,
  SynthesizeResult,
} from './adapters/types.js';
import {
  PROVIDER_CATALOGUE,
  authKindOf,
  catalogueEntry,
  familyEntries,
  hermesApiModeOf,
  hermesBaseUrlOf,
  hermesKeyEnvOf,
  hermesProviderNameOf,
  hermesRouteOf,
  secretNameOf,
  type ProviderCatalogueEntry,
} from './catalogue.js';
import { isMask } from './crypto.js';
import { parseEnv } from './dotenv.js';
import { AUXILIARY_TASKS, isAuxiliaryKey, roleForAdapter } from './defaults.js';
import {
  agentEnvironment,
  hermesEnvPlan,
  writeHermesConfiguration,
  writeHermesEnv,
  writeHermesProviders,
  type HermesModelChoice,
  type HermesProviderRoute,
  type PropagationState,
  type ResolvedCredential,
} from './propagation.js';
import {
  ensembles,
  models,
  providers,
  speechSettings,
  type EnsembleMemberValue,
  type ModelDefaultRow,
  type ModelPricing,
  type ModelRole,
  type ModelRow,
  type ProviderCapabilities,
  type ProviderRow,
  type SpeechProviderSettings,
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
  /** Whether a turn is in flight right now — a restart would kill it. */
  busy?(): boolean;
  /**
   * Hands the runtime the provider credentials for its **own process environment**, not
   * just its files. Returns true when they changed. This is the link ADR 0010 left
   * implicit: Hermes does read its `.env`, but a running gateway that depends on
   * somebody else's loader is a chain that can break quietly — and did, as
   * `HTTP 401: Missing Authentication header` (the owner's report of 2026-09-22).
   */
  applyEnvironment?(env: Record<string, string>): boolean;
  /** How the hub relates to this runtime, for the self-check. Defaults from `home()`. */
  mode?(): 'managed' | 'external' | 'absent';
  /** When the process last (re)started, in ms — what "it took the files" means. */
  reloadedAt?(): number | null;
  /**
   * The homes of Hermes's named profiles (ADR 0014). A conversation runs in its workspace's
   * profile (stage 3), which reads its own `config.yaml`; the hub's endpoints are written
   * there too, so a turn that names one finds it in whichever profile it runs.
   */
  profileHomes?(): string[];
}

/** The contract's `RuntimeCheck` and `RuntimeReport` (`models.getRuntime`). */
export interface ContractRuntimeCheck {
  id:
    | 'runtime_writable'
    | 'provider_keys'
    | 'provider_verified'
    | 'model_selected'
    | 'gateway_reloaded';
  ok: boolean;
  detail: string | null;
}

export interface ContractRuntimeReport {
  agent: string;
  mode: 'managed' | 'external' | 'absent';
  ready: boolean;
  reloaded_at: string | null;
  checks: ContractRuntimeCheck[];
}

/**
 * The provider credentials as environment variables, under every name the runtime reads
 * each family's key from — the same set the `.env` merge owns, so the file and the
 * process can never disagree.
 */
function hermesProcessEnv(state: PropagationState): Record<string, string> {
  const env: Record<string, string> = {};
  for (const credential of state.credentials) {
    for (const name of credential.hermesEnvVars) env[name] = credential.value;
  }
  return env;
}

/** The `.env` as it is on disk, or empty when there is none to read. */
function readEnvFile(file: string): Map<string, string> {
  try {
    return parseEnv(readFileSync(file, 'utf8'));
  } catch {
    return new Map();
  }
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
  /**
   * How long to wait after the last write before recycling the runtime, and how long to
   * wait between polls while a run is in flight. A test sets it to 0 to stay synchronous.
   */
  restartDelayMs?: number;
  now?: () => Date;
  /**
   * The profile the **shared** providers are stored under: the default profile, which
   * always exists and can never be renamed or archived (contract decision §37). Null only
   * before the owner exists; the caller's own profile stands in then.
   */
  hubScope?: () => WorkspaceScope | null;
  /**
   * The workspace id behind a named Hermes profile (its slug), or null when the hub has
   * none: that profile then uses the shared providers only.
   */
  profileWorkspace?: (profile: string) => string | null;
}

/** Where a provider row is stored: the shared scope, or one profile's own (decision §37). */
interface ProviderOwner {
  workspace: string;
  shared: boolean;
}

export const PROVIDER_BUNDLE_FORMAT = 'majlis-providers';

/**
 * A profile's providers with their keys, as an export that carries them writes them into
 * the archive (`majlis-providers.json`, decision §37). Keys are in the clear: the dialog
 * that asks for this says so.
 */
export interface ProviderBundle {
  format: typeof PROVIDER_BUNDLE_FORMAT;
  version: 1;
  providers: ProviderBundleItem[];
}

export interface ProviderBundleItem {
  slug: string;
  label: string;
  kind: ProviderRow['kind'];
  family: string;
  builtin: boolean;
  enabled: boolean;
  base_url: string | null;
  api_mode: ProviderRow['apiMode'];
  auth_kind: ProviderRow['authKind'];
  headers: Record<string, string>;
  capabilities: ProviderCapabilities;
  settings: SpeechProviderSettings;
  visibility_mode: ProviderRow['visibilityMode'];
  visible_models: string[];
  api_key: string | null;
  models: {
    model_key: string;
    label: string;
    alias: string | null;
    kind: ModelRow['kind'];
    context_window: number | null;
    max_output_tokens: number | null;
    pricing: ModelPricing;
    capabilities: ModelRow['capabilities'];
    enabled: boolean;
    visible: boolean;
    preview: boolean;
    source: ModelRow['source'];
  }[];
}

/** Reads a bundle from an archive somebody uploaded: only the shape the hub writes. */
export function parseProviderBundle(value: unknown): ProviderBundle {
  const bad = (why: string) => validationFailed({ field: 'majlis-providers.json', reason: why });
  if (!value || typeof value !== 'object') throw bad('not an object');
  const bundle = value as Partial<ProviderBundle>;
  if (bundle.format !== PROVIDER_BUNDLE_FORMAT || bundle.version !== 1) {
    throw bad('not a provider list this hub writes');
  }
  if (!Array.isArray(bundle.providers)) throw bad('no providers');
  const kinds = new Set(['llm', 'stt', 'tts']);
  for (const item of bundle.providers) {
    if (
      !item ||
      typeof item.slug !== 'string' ||
      !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(item.slug) ||
      typeof item.label !== 'string' ||
      typeof item.family !== 'string' ||
      !kinds.has(item.kind) ||
      !Array.isArray(item.models) ||
      (item.api_key !== null && typeof item.api_key !== 'string')
    ) {
      throw bad('a provider entry is not one this hub writes');
    }
  }
  return bundle as ProviderBundle;
}

/**
 * How many times a pending restart steps aside for a live turn before going ahead. With
 * the default delay that is a little over two minutes, which is longer than a turn and
 * much shorter than "the key never took effect".
 */
const RESTART_BUSY_ATTEMPTS = 80;

export interface ProviderCreateInput {
  /** A `ProviderPreset.id`; absent for a bare OpenAI-compatible endpoint. */
  preset?: string | null;
  label: string;
  kind: 'llm' | 'stt' | 'tts';
  base_url?: string | null;
  api_key?: string | null;
  api_mode?: 'chat_completions' | 'responses';
  /** Who it is for: every profile (the default), or only the one in `X-Hub-Profile` (§37). */
  scope?: 'all' | 'profile';
}

/** One entry of `models.listProviderPresets`. */
export interface ContractProviderPreset {
  id: string;
  label: string;
  kind: string;
  api_mode: string;
  base_url: string | null;
  base_url_required: boolean;
  key: 'required' | 'optional';
  local: boolean;
  repeatable: boolean;
  keys_url: string | null;
}

export interface ProviderHostInfo {
  containerized: boolean;
  loopback_alias: string;
}

export interface ProviderProbeInput {
  preset?: string | null;
  base_url?: string | null;
  api_key?: string | null;
  api_mode?: string | null;
  kind?: string | null;
}

export interface ProbeOutcome {
  ok: boolean;
  /** i18n key under `models.probe.*`; the route translates it. `null` when it worked. */
  reasonKey: string | null;
  detail: string | null;
  durationMs: number;
  models: { id: string; label: string }[];
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
  /** The adapter's bare word (`ok`, `no_key`, `unauthorized`, `unreachable`, …). */
  reason: string;
  /** i18n key under `models.test.*`; the route translates it. */
  reasonKey: string;
  detail: string | null;
  durationMs: number;
}

/**
 * A key the provider itself refused. Its own words travel verbatim in `details.detail`:
 * the hub says what happened, the provider says why, and neither speaks for the other.
 */
function rejectedKey(provider: string, detail: string | null): HubError {
  return new HubError('provider_unauthorized', {
    messageKey: 'models.test.unauthorized',
    details: { provider, detail, reason: 'unauthorized' },
  });
}

export class ModelsService {
  private readonly store: ModelsStore;
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;
  /**
   * When the hub last changed something in the runtime's home, in ms. The self-check
   * compares it with when the runtime last started: a write the running process has not
   * read yet is the difference between "configured" and "in effect".
   */
  private lastWriteAt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartPending = false;
  private readonly restartDelayMs: number;

  constructor(private readonly options: ModelsServiceOptions) {
    this.store = new ModelsStore({
      db: options.db,
      ...(options.now ? { now: options.now } : {}),
    });
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.restartDelayMs = options.restartDelayMs ?? 1_500;
  }

  /**
   * Every provider key this hub stores, in plaintext, for the one check that must see them:
   * a profile export overwrites them wherever they appear (ADR 0010). Never logged, never
   * returned by a route.
   */
  storedSecretValues(): string[] {
    return this.options.secrets.revealEvery();
  }

  private get db(): ModuleDb {
    return this.options.db;
  }

  private hubCache: WorkspaceScope | null = null;

  /**
   * The default profile: where the **shared** providers, their models and their keys are
   * stored (contract decision §37). Cached — that profile's id never changes. `fallback` is
   * the caller's own profile, used only on a hub that has no default profile yet.
   */
  private hub(fallback?: Pick<WorkspaceScope, 'id'> & Partial<WorkspaceScope>): WorkspaceScope {
    if (this.hubCache) return this.hubCache;
    const found = this.options.hubScope?.() ?? null;
    if (found) {
      this.hubCache = found;
      return found;
    }
    return {
      id: fallback?.id ?? '',
      slug: fallback?.slug ?? 'default',
      name: fallback?.name ?? 'default',
      isDefault: fallback?.isDefault ?? true,
    };
  }

  /** Where a new provider of this scope is stored: shared, or the profile's own. */
  private ownerFor(scope: Pick<WorkspaceScope, 'id'>, shared: boolean): ProviderOwner {
    return shared
      ? { workspace: this.hub(scope).id, shared: true }
      : { workspace: scope.id, shared };
  }

  private ownerOf(row: ProviderRow): ProviderOwner {
    return { workspace: row.workspace, shared: row.shared };
  }

  /**
   * Every live provider a profile can see: its own and the shared ones, both listed (each
   * says which it is), own first when a slug is both.
   */
  private visibleRows(workspace: string, kind?: string): ProviderRow[] {
    const own = this.store.scopeRows(workspace, false, kind);
    const shared = this.store.scopeRows(this.hub({ id: workspace }).id, true, kind);
    return [...own, ...shared].sort(
      (a, b) => a.slug.localeCompare(b.slug) || Number(a.shared) - Number(b.shared),
    );
  }

  /**
   * The providers a profile actually uses: its own, and every shared one whose slug it has
   * no own row for — a profile's own provider of the same preset wins (decision §37).
   */
  private effectiveRows(workspace: string, kind?: string): ProviderRow[] {
    const own = this.store.scopeRows(workspace, false, kind);
    const mine = new Set(own.map((row) => row.slug));
    const shared = this.store
      .scopeRows(this.hub({ id: workspace }).id, true, kind)
      .filter((row) => !mine.has(row.slug));
    return [...own, ...shared].sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /** A live row this profile can see (its own, or a shared one), by id. */
  private visibleRow(workspace: string, id: string): ProviderRow | undefined {
    const row = this.store.providerById(id);
    if (!row || row.archivedAt) return undefined;
    if (
      row.shared ? row.workspace === this.hub({ id: workspace }).id : row.workspace === workspace
    ) {
      return row;
    }
    return undefined;
  }

  /**
   * The row this profile uses for the provider a stored id names: the one of the same slug
   * it actually uses — its own over a shared one. A session, a default or a pin that named
   * the shared row keeps working, and runs on the profile's own provider once it has one.
   */
  private effectiveFor(workspace: string, providerId: string): ProviderRow | undefined {
    const row = this.store.providerById(providerId);
    if (!row) return undefined;
    return this.effectiveRows(workspace).find((candidate) => candidate.slug === row.slug);
  }

  // ------------------------------------------------- a profile's own, copied and moved

  /**
   * A profile made as a copy of another gets the source's **own** providers, with their
   * keys and their models (owner, 2026-09-24: «علشان لو الكي نسيته ما ابلش وينه» — so a key
   * is not lost by making a copy; the owner removes what the copy should not keep). The
   * shared providers it already has. Returns how many rows were copied.
   */
  copyOwnProviders(sourceWorkspace: string, targetWorkspace: string, actor: Actor): number {
    const bundle = this.providerBundle(sourceWorkspace, { ownOnly: true });
    return this.restoreProviderBundle(targetWorkspace, actor, bundle);
  }

  /**
   * The providers a profile uses, with their keys in the clear, for an export that carries
   * them (decision §37): its own, and the shared ones it has no own row of the same slug for
   * — every one written as a provider of that profile alone, because that is what it
   * becomes where the archive is imported.
   */
  exportProviders(workspace: string): ProviderBundle {
    return this.providerBundle(workspace, { ownOnly: false });
  }

  /** An imported archive's providers become the imported profile's own (decision §37). */
  importProviders(workspace: string, actor: Actor, bundle: unknown): number {
    return this.restoreProviderBundle(workspace, actor, parseProviderBundle(bundle));
  }

  private providerBundle(workspace: string, options: { ownOnly: boolean }): ProviderBundle {
    const rows = options.ownOnly
      ? this.store.scopeRows(workspace, false)
      : this.effectiveRows(workspace);
    return {
      format: PROVIDER_BUNDLE_FORMAT,
      version: 1,
      providers: rows.map((row) => ({
        slug: row.slug,
        label: row.label,
        kind: row.kind,
        family: row.family,
        builtin: row.builtin,
        enabled: row.enabled,
        base_url: row.baseUrl,
        api_mode: row.apiMode,
        auth_kind: row.authKind,
        headers: { ...row.headers },
        capabilities: { ...row.capabilities },
        settings: { ...row.settings },
        visibility_mode: row.visibilityMode,
        visible_models: [...row.visibleModels],
        api_key: row.apiKeySecretId
          ? this.options.secrets.reveal(row.workspace, row.apiKeySecretId)
          : null,
        models: this.store.modelsOf(row.id).map((model) => ({
          model_key: model.modelKey,
          label: model.label,
          alias: model.alias,
          kind: model.kind,
          context_window: model.contextWindow,
          max_output_tokens: model.maxOutputTokens,
          pricing: { ...model.pricing },
          capabilities: [...model.capabilities],
          enabled: model.enabled,
          visible: model.visible,
          preview: model.preview,
          source: model.source,
        })),
      })),
    };
  }

  private restoreProviderBundle(workspace: string, actor: Actor, bundle: ProviderBundle): number {
    const owner: ProviderOwner = { workspace, shared: false };
    const at = this.now();
    let copied = 0;
    for (const item of bundle.providers) {
      // A profile's own row of that slug is already there: it stays as it is.
      const existing = this.store.scopeRowBySlug(workspace, false, item.slug);
      if (existing && !existing.archivedAt) continue;
      const id = this.materialize(owner, actor, {
        slug: item.slug,
        label: item.label,
        kind: item.kind,
        family: item.family,
        baseUrl: item.base_url ?? '',
        apiMode: item.api_mode,
        authKind: item.auth_kind,
        builtin: item.builtin,
        capabilities: item.capabilities,
        settings: item.settings,
        at,
      });
      this.db
        .update(providers)
        .set({
          enabled: item.enabled,
          baseUrl: item.base_url,
          headers: item.headers,
          visibilityMode: item.visibility_mode,
          visibleModels: item.visible_models,
          catalogueStatus: item.models.length > 0 ? 'ready' : 'loading',
          catalogueRefreshedAt: item.models.length > 0 ? at : null,
        })
        .where(eq(providers.id, id))
        .run();
      for (const model of item.models) {
        if (this.store.model(id, model.model_key)) continue;
        this.db
          .insert(models)
          .values({
            id: newUlid(),
            ownerId: actor.userId,
            workspace,
            createdAt: at,
            updatedAt: at,
            providerId: id,
            modelKey: model.model_key,
            label: model.label,
            alias: model.alias,
            kind: model.kind,
            contextWindow: model.context_window,
            maxOutputTokens: model.max_output_tokens,
            pricing: model.pricing,
            capabilities: model.capabilities,
            enabled: model.enabled,
            visible: model.visible,
            preview: model.preview,
            source: model.source,
          })
          .run();
      }
      if (item.api_key) this.storeKey(owner, actor, item.family, item.api_key);
      copied += 1;
    }
    if (copied > 0) {
      this.options.audit.record({
        workspace,
        ownerId: actor.userId,
        actorKind: 'user',
        actorId: actor.userId,
        action: 'provider.created',
        entityKind: 'workspace',
        entityId: workspace,
        summary: `${String(copied)} provider(s) added to the profile as its own`,
        // Never a key; only which providers arrived.
        data: { slugs: bundle.providers.map((item) => item.slug), scope: 'profile' },
      });
    }
    return copied;
  }

  // ------------------------------------------------------------------ providers

  /**
   * The provider *types* a person can add. Not the same list as `listProviders`, which
   * answers "what did I configure" (contract decision §26).
   */
  listPresets(filter: { kind?: string } = {}): {
    items: ContractProviderPreset[];
    host: ProviderHostInfo;
  } {
    const items = PROVIDER_CATALOGUE.filter(
      (entry) => !filter.kind || entry.kind === filter.kind,
    ).map((entry) => ({
      id: entry.slug,
      label: entry.label,
      kind: entry.kind,
      api_mode: entry.apiMode,
      base_url: entry.baseUrl,
      // No default address means the person must give one; there is nothing to prefill.
      base_url_required: entry.baseUrl === null,
      key: entry.keyRequirement,
      local: entry.local === true,
      repeatable: entry.repeatable === true,
      keys_url: entry.keysUrl,
    }));
    return { items, host: hostInfo() };
  }

  /** The shared providers and this profile's own, each saying which (decision §37). */
  listProviders(scope: WorkspaceScope, filter: { kind?: string } = {}): ContractProvider[] {
    return this.visibleRows(scope.id, filter.kind).map((row) => this.present(scope, row));
  }

  getProvider(scope: WorkspaceScope, id: string): ContractProvider {
    return this.present(scope, this.loadProvider(scope, id));
  }

  /**
   * The one way a provider row comes into existence.
   *
   * With a preset the slug, protocol, credential family and default address come from the
   * catalogue, and the **sibling rows of the same family are created in the same call** —
   * OpenAI chat, dictation and speech are three rows and one key (ADR 0010 §2), so adding
   * OpenAI must not leave the speech tabs empty.
   *
   * Without a preset it is somebody's own OpenAI-compatible endpoint: its own credential
   * family, because sharing a key with a built-in provider of a similar name is a guess.
   */
  async createProvider(
    scope: WorkspaceScope,
    actor: Actor,
    input: ProviderCreateInput,
  ): Promise<{ provider: ContractProvider; job: JobRow | null }> {
    const presetId = input.preset?.trim();
    const preset = presetId ? catalogueEntry(presetId) : undefined;
    if (presetId && !preset) {
      throw validationFailed({
        field: 'preset',
        reason: 'not a provider type this hub knows',
        known: PROVIDER_CATALOGUE.map((entry) => entry.slug),
      });
    }
    const label = input.label.trim() || preset?.label || '';
    if (!label) throw validationFailed({ field: 'label', reason: 'empty' });
    const baseUrl = (input.base_url ?? '').trim() || preset?.baseUrl || '';
    if (!baseUrl) {
      throw validationFailed({
        field: 'base_url',
        reason: preset
          ? 'this provider has no address anybody could guess; give the one it listens on'
          : 'a custom provider needs the base URL of its OpenAI-compatible endpoint',
      });
    }
    try {
      void new URL(baseUrl);
    } catch {
      throw validationFailed({ field: 'base_url', reason: 'not a URL' });
    }
    const apiKey = input.api_key?.trim() ?? '';
    if (preset?.keyRequirement === 'required' && !apiKey) {
      throw validationFailed({ field: 'api_key', reason: 'this provider needs a key to answer' });
    }

    // The key is checked against the provider **before** anything is stored. A key the
    // provider itself refuses is not a key: writing it into the runtime turns one wrong
    // paste into an agent error minutes later, which is what happened on 2026-09-22 (a
    // key for one provider pasted into another's dialog). Only an outright refusal
    // blocks the save — an endpoint that is down, slow or unreachable does not, because
    // that says nothing about the key.
    const verdict = apiKey ? await this.checkKey(preset, baseUrl, apiKey) : null;
    if (verdict && !verdict.ok && verdict.reason === 'unauthorized') {
      throw rejectedKey(preset?.slug ?? label, verdict.detail);
    }

    // A preset that may be added more than once behaves like a custom endpoint: the
    // person names each instance, and each instance owns its own key.
    const repeatable = !preset || preset.repeatable === true;
    const at = this.now();
    // Who it is for (decision §37): every profile (the default), or only this one.
    const owner = this.ownerFor(scope, (input.scope ?? 'all') === 'all');
    const primarySlug = repeatable ? this.freeSlug(scope.id, owner, label) : preset.slug;
    const family = repeatable ? `custom:${primarySlug}` : preset.family;
    const kind = preset && !repeatable ? preset.kind : input.kind;

    const existing = this.store.scopeRowBySlug(owner.workspace, owner.shared, primarySlug);
    if (existing && !existing.archivedAt) {
      throw conflict({
        reason: 'provider_exists',
        detail: owner.shared
          ? `${primarySlug} is already added for every profile`
          : `${primarySlug} is already added to this profile`,
      });
    }

    const primaryId = this.materialize(owner, actor, {
      slug: primarySlug,
      label,
      kind,
      family,
      baseUrl,
      apiMode: (preset && !repeatable ? preset.apiMode : input.api_mode) ?? 'chat_completions',
      // Without a preset the hub cannot know whether the endpoint wants a key, so it does
      // not demand one — and the field is still there (contract decision §26).
      authKind: preset && !repeatable ? authKindOf(preset) : 'none',
      builtin: Boolean(preset) && !repeatable,
      capabilities:
        preset && !repeatable ? preset.capabilities : { chat: kind === 'llm', listModels: true },
      settings: preset?.settings ?? {},
      at,
    });

    // The rest of the credential family: one key, several rows.
    const siblings: string[] = [];
    if (preset && !repeatable) {
      for (const entry of familyEntries(preset.family)) {
        if (entry.slug === preset.slug || entry.repeatable) continue;
        const row = this.store.scopeRowBySlug(owner.workspace, owner.shared, entry.slug);
        if (row && !row.archivedAt) continue;
        siblings.push(
          this.materialize(owner, actor, {
            slug: entry.slug,
            label: entry.label,
            kind: entry.kind,
            family: entry.family,
            baseUrl: entry.baseUrl ?? baseUrl,
            apiMode: entry.apiMode,
            authKind: authKindOf(entry),
            builtin: true,
            capabilities: entry.capabilities,
            settings: entry.settings ?? {},
            at,
          }),
        );
      }
    }

    if (apiKey) this.storeKey(owner, actor, family, apiKey);
    // The card shows what the provider answered, without a second click on Test.
    if (verdict) this.recordCheck(primaryId, verdict);
    this.options.audit.record({
      workspace: scope.id,
      ownerId: actor.userId,
      actorKind: 'user',
      actorId: actor.userId,
      action: 'provider.created',
      entityKind: 'provider',
      entityId: primaryId,
      summary: `provider ${primarySlug} added`,
      // Never the key; only that one arrived with it.
      data: {
        slug: primarySlug,
        kind,
        preset: preset?.slug ?? null,
        scope: owner.shared ? 'all' : 'profile',
        key_set: apiKey !== '',
      },
    });
    // The endpoint itself reaches Hermes even before a key does: a local server that
    // needs none is otherwise added, listed and unusable.
    this.propagate(scope, actor);
    const job = this.refreshProvider(scope, actor, primaryId);
    for (const id of siblings) this.refreshProvider(scope, actor, id);
    // A provider added back after being removed already has its models; the refresh job
    // above would set the default a moment later, but only if it has one to run.
    this.ensureChatDefault(scope, actor, primaryId);
    return { provider: this.getProvider(scope, primaryId), job };
  }

  /**
   * Insert a provider row, or bring back the archived row that already holds its slug —
   * `(workspace, shared, slug)` is unique, so a provider that was removed and is being added
   * again to the same scope is the same row with its history reset.
   */
  private materialize(
    owner: ProviderOwner,
    actor: Actor,
    row: {
      slug: string;
      label: string;
      kind: 'llm' | 'stt' | 'tts';
      family: string;
      baseUrl: string;
      apiMode: 'native' | 'chat_completions' | 'responses';
      authKind: 'api_key' | 'oauth' | 'none';
      builtin: boolean;
      capabilities: ProviderCapabilities;
      settings: SpeechProviderSettings;
      at: Date;
    },
  ): string {
    const values = {
      ownerId: actor.userId,
      workspace: owner.workspace,
      shared: owner.shared,
      updatedAt: row.at,
      slug: row.slug,
      label: row.label,
      kind: row.kind,
      builtin: row.builtin,
      enabled: true,
      baseUrl: row.baseUrl,
      apiMode: row.apiMode,
      authKind: row.authKind,
      family: row.family,
      capabilities: row.capabilities,
      settings: row.settings,
      catalogueStatus: (row.capabilities.listModels === false ? 'unsupported' : 'loading') as
        'loading' | 'unsupported',
      catalogueError: null,
      catalogueRefreshedAt: null,
      status: 'unconfigured' as const,
      lastError: null,
      archivedAt: null,
    };
    const existing = this.store.scopeRowBySlug(owner.workspace, owner.shared, row.slug);
    if (existing) {
      this.db.update(providers).set(values).where(eq(providers.id, existing.id)).run();
      return existing.id;
    }
    const id = newUlid();
    this.db
      .insert(providers)
      .values({ id, createdAt: row.at, ...values })
      .run();
    return id;
  }

  async updateProvider(
    scope: WorkspaceScope,
    actor: Actor,
    id: string,
    patch: ProviderPatchInput,
  ): Promise<ContractProvider> {
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
    let verdict: TestOutcome | null = null;
    if (patch.api_key !== undefined && !isMask(patch.api_key)) {
      const value = patch.api_key?.trim() ?? '';
      if (value !== '') {
        const baseUrl = (patch.base_url ?? row.baseUrl ?? this.entryOf(row)?.baseUrl ?? '').trim();
        verdict = await this.checkKey(this.entryOf(row), baseUrl, value, row);
        if (!verdict.ok && verdict.reason === 'unauthorized') {
          throw rejectedKey(row.slug, verdict.detail);
        }
      }
      // `auth_kind` is what the provider *requires*, which storing a key does not change.
      // Flipping it was the 2026-09-22 defect: a keyless custom provider that had been
      // given a key still read as "no key needed", and one that had not been given a key
      // was told "Missing API key" by a check the hub had no business making.
      if (value === '') {
        this.clearKey(this.ownerOf(row), row.family);
        changes.status = 'unconfigured';
        changes.lastError = null;
      } else {
        this.storeKey(this.ownerOf(row), actor, row.family, value);
        // Nothing has been proven yet: the status stays `unconfigured` until a test or a
        // refresh actually reaches the provider.
        changes.status = 'unconfigured';
        changes.lastError = null;
      }
      keyChanged = true;
    }

    this.db.update(providers).set(changes).where(eq(providers.id, row.id)).run();
    if (verdict) this.recordCheck(row.id, verdict);
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
      if (keyChanged && this.hasKey(scope, fresh)) this.refreshFamily(scope, actor, fresh);
    }
    return this.getProvider(scope, row.id);
  }

  /**
   * A provider a person added is a provider they can remove — preset or not. The key
   * survives while another row of the same credential family still uses it (removing the
   * OpenAI chat row must not silently sign the dictation row out).
   */
  deleteProvider(scope: WorkspaceScope, actor: Actor, id: string): void {
    const row = this.loadProvider(scope, id);
    const at = this.now();
    this.db
      .update(providers)
      .set({ archivedAt: at, enabled: false, updatedAt: at })
      .where(eq(providers.id, row.id))
      .run();
    const remaining = this.store
      .scopeFamilyRows(row.workspace, row.shared, row.family)
      .filter((sibling) => sibling.id !== row.id && !sibling.archivedAt);
    if (remaining.length === 0) this.clearKey(this.ownerOf(row), row.family);
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

  /**
   * Asks the provider, once, whether this key is a key it accepts — before the hub
   * stores it and long before a run depends on it. Never throws: an endpoint that is
   * unreachable answers `ok: false` with its own reason, which the caller reads.
   */
  private async checkKey(
    entry: ProviderCatalogueEntry | undefined,
    baseUrl: string,
    apiKey: string,
    row?: ProviderRow,
  ): Promise<TestOutcome> {
    const adapter = providerAdapter(entry?.protocol ?? 'openai');
    const started = Date.now();
    try {
      const result = await adapter.test({
        slug: entry?.slug ?? row?.slug ?? 'provider',
        label: entry?.label ?? row?.label ?? baseUrl,
        baseUrl: baseUrl || (entry?.baseUrl ?? ''),
        apiKey,
        requiresKey: entry ? entry.keyRequirement === 'required' : false,
        headers: { ...(row?.headers ?? {}) },
        settings: { ...(row?.settings ?? {}) },
        fetchImpl: this.fetchImpl,
      });
      return {
        ok: result.ok,
        reason: result.reason,
        reasonKey: `models.test.${result.reason}`,
        detail: result.detail,
        durationMs: result.durationMs,
      };
    } catch (error) {
      // A check that itself fell over must not stop a person saving a key.
      return {
        ok: false,
        reason: 'unreachable',
        reasonKey: 'models.test.unreachable',
        detail: error instanceof Error ? error.message : null,
        durationMs: Date.now() - started,
      };
    }
  }

  /** Puts a check's verdict on the row, so the card shows it without a second click. */
  private recordCheck(providerId: string, outcome: TestOutcome): void {
    const at = this.now();
    this.db
      .update(providers)
      .set({
        status: outcome.ok ? 'ok' : 'error',
        lastCheckedAt: at,
        lastError: outcome.ok ? null : (outcome.detail ?? outcome.reason ?? null),
        updatedAt: at,
      })
      .where(eq(providers.id, providerId))
      .run();
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
      reason: result.reason,
      reasonKey: `models.test.${result.reason}`,
      detail: result.detail,
      durationMs: result.durationMs,
    };
  }

  /**
   * The add-provider dialog's **Fetch**: the model list of an endpoint that is not saved
   * yet, so a default model can be chosen in the same dialog that types the URL.
   *
   * Nothing is stored — not the key, not a row, not a model. A provider that cannot be
   * reached comes back `ok: false` carrying its own words; an empty list is an empty
   * list and is never drawn as success by a client that reads `ok`.
   */
  async probeProvider(input: ProviderProbeInput): Promise<ProbeOutcome> {
    const presetId = input.preset?.trim();
    const preset = presetId ? catalogueEntry(presetId) : undefined;
    if (presetId && !preset) {
      throw validationFailed({
        field: 'preset',
        reason: 'not a provider type this hub knows',
        known: PROVIDER_CATALOGUE.map((entry) => entry.slug),
      });
    }
    const baseUrl = (input.base_url ?? '').trim() || preset?.baseUrl || '';
    if (!baseUrl) {
      throw validationFailed({ field: 'base_url', reason: 'nothing says where to ask' });
    }
    try {
      void new URL(baseUrl);
    } catch {
      throw validationFailed({ field: 'base_url', reason: 'not a URL' });
    }
    const adapter = providerAdapter(preset?.protocol ?? 'openai');
    const apiKey = input.api_key?.trim() ?? '';
    const started = Date.now();
    const result = await adapter.listModels({
      slug: preset?.slug ?? 'probe',
      label: preset?.label ?? baseUrl,
      baseUrl,
      apiKey: apiKey || null,
      // A preset that does not demand a key must not be told it is missing one.
      requiresKey: preset ? preset.keyRequirement === 'required' : false,
      headers: {},
      settings: {},
      fetchImpl: this.fetchImpl,
    });
    const durationMs = Date.now() - started;
    if (!result.supported) {
      return {
        ok: false,
        reasonKey: 'models.probe.failed',
        detail: result.reason,
        durationMs,
        models: [],
      };
    }
    return {
      ok: true,
      reasonKey: null,
      detail: null,
      durationMs,
      models: result.models.map((model) => ({ id: model.key, label: model.label })),
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
          { workspace: row.workspace, ownerId: actor.userId },
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
        // The models just arrived. If this workspace still has no chat default, the
        // provider that was added a moment ago becomes it — otherwise the owner adds a
        // provider, watches its models load, sends a message and is told by Hermes that
        // no provider is configured, with nothing in the hub having said a word.
        this.ensureChatDefault(scope, actor, row.id);
        return { ...report, models: result.models.length };
      },
    );
  }

  /** Every provider of one credential family gets its catalogue refreshed. */
  private refreshFamily(scope: WorkspaceScope, actor: Actor, of: ProviderRow): void {
    for (const row of this.store.scopeFamilyRows(of.workspace, of.shared, of.family)) {
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
    // The models of the providers this profile uses: its own, and the shared ones it has no
    // own row of the same slug for (decision §37) — so a `Model.key` names one model.
    const asked = query.provider_id ? this.visibleRow(scope.id, query.provider_id) : undefined;
    const rows = query.provider_id ? (asked ? [asked] : []) : this.effectiveRows(scope.id);
    const bySlug = new Map(rows.map((row) => [row.id, row]));
    const needle = query.q?.trim().toLowerCase();
    const visible = query.visible ?? true;
    // The catalogue is ordered by (provider, model), so its cursor is that pair rather
    // than a row id (`store.ts` §allModels).
    const after = decodeCatalogueCursor(query.cursor);
    const limit = clampLimit(query.limit);
    const matching = this.store
      .modelsOfProviders([...bySlug.keys()])
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
          workspace: provider.workspace,
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
    // A model typed by hand on a provider that lists none (`listModels: false`) is still
    // the workspace's first model, and it should be usable without a second screen.
    this.ensureChatDefault(scope, actor, provider.id);
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

  /**
   * The profile's model choices, as they are in effect. A role this profile chose is its
   * own; a role it left alone is the default profile's, and `inherited` names it (`default`
   * for the chat model, else the auxiliary key) so a client can say where it came from
   * (contract decision §37). In the default profile nothing is inherited.
   */
  getDefaults(scope: WorkspaceScope): {
    default: ModelRefInput | null;
    fallbacks: ModelRefInput[];
    auxiliary: {
      tasks: { key: string; label: { ar: string; en: string } }[];
      assignments: Record<string, ModelRefInput>;
    };
    inherited: string[];
  } {
    const inherited: string[] = [];
    const chat = this.effectiveDefault(scope.id, 'chat');
    if (chat?.inherited) inherited.push('default');
    const assignments: Record<string, ModelRefInput> = {};
    for (const task of AUXILIARY_TASKS) {
      const found = this.effectiveDefault(scope.id, task.key);
      const ref = found ? this.refOf(scope, found.row.modelId) : null;
      if (!ref || !found) continue;
      assignments[task.key] = ref;
      if (found.inherited) inherited.push(task.key);
    }
    const fallbacks: ModelRefInput[] = [];
    for (const modelId of chat?.row.fallbackModelIds ?? []) {
      const ref = this.refOf(scope, modelId);
      if (ref) fallbacks.push(ref);
    }
    return {
      default: chat ? this.refOf(scope, chat.row.modelId) : null,
      fallbacks,
      auxiliary: {
        tasks: AUXILIARY_TASKS.map((task) => ({ key: task.key, label: task.label })),
        assignments,
      },
      inherited,
    };
  }

  /**
   * One role's choice in effect for a profile: its own row, else the default profile's.
   * A row whose model is gone does not count — the next one down answers instead.
   */
  private effectiveDefault(
    workspace: string,
    role: ModelRole,
  ): { row: ModelDefaultRow; inherited: boolean } | null {
    const own = this.store.defaultFor(workspace, role);
    if (own && this.refOf({ id: workspace }, own.modelId)) return { row: own, inherited: false };
    const hubId = this.hub({ id: workspace }).id;
    if (hubId === workspace) return null;
    // The default profile's choice, as this profile can use it: the same model on the
    // provider of the same slug this profile uses (its own or a shared one).
    const shared = this.store.defaultFor(hubId, role);
    if (shared && this.refOf({ id: workspace }, shared.modelId))
      return { row: shared, inherited: true };
    return null;
  }

  setDefaults(scope: WorkspaceScope, actor: Actor, body: DefaultsWriteInput) {
    if (body.default !== undefined) {
      if (body.default === null) {
        this.store.clearDefault(scope.id, 'chat');
      } else {
        const model = this.requireModel(scope, body.default);
        this.requireExpressible(scope, model.providerId);
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
    const chosen = this.speechChoice(scope, ownerId);
    return {
      stt: this.speechSide(scope, 'stt', chosen.stt),
      tts: this.speechSide(scope, 'tts', chosen.tts),
    };
  }

  /**
   * Which speech providers a profile speaks with: its own choice, else the default
   * profile's — the same rule as the model defaults (contract decision §37).
   */
  private speechChoice(
    scope: WorkspaceScope,
    ownerId: string,
  ): { stt: string | null; tts: string | null } {
    const own = this.store.ensureSpeech({ workspace: scope.id, ownerId });
    const hubId = this.hub(scope).id;
    const shared = hubId === scope.id ? undefined : this.store.speech(hubId);
    return {
      stt: own.sttProviderId ?? shared?.sttProviderId ?? null,
      tts: own.ttsProviderId ?? shared?.ttsProviderId ?? null,
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
        if (value === '') this.clearKey(this.ownerOf(row), row.family);
        else this.storeKey(this.ownerOf(row), actor, row.family, value);
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
    const id = request.providerId ?? this.speechChoice(scope, ownerId).tts;
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

  // ------------------------------------------------------------ the first default

  /**
   * Gives a workspace that has no chat default one, from the provider just configured.
   *
   * The rule is exactly "the first one, once": a workspace with a chat default is never
   * touched, so a second provider added later cannot steal it, and the owner's own choice
   * on the Defaults screen is never overwritten. Without this, "a provider with models"
   * and "a workspace that can answer" were two different states, and nothing in the
   * product said so — the run just failed in Hermes's words (the defect of 2026-09-22).
   *
   * Which model: the first the provider listed that this workspace would actually show
   * in a picker — enabled, visible, and passing the provider's visibility choice, which
   * is how the model the person picked in the Add-provider dialog wins when they narrowed
   * the list there.
   */
  ensureChatDefault(scope: WorkspaceScope, actor: Actor, providerId: string): ContractModel | null {
    // A shared provider gives the default profile its first model — and every profile that
    // has not chosen its own uses that. A profile's own provider gives that profile its own,
    // when it has no model in effect yet (decision §37).
    const row = this.store.providerById(providerId);
    if (!row || row.archivedAt || !row.enabled || row.kind !== 'llm') return null;
    const target = row.shared ? this.hub(scope).id : row.workspace;
    if (this.effectiveDefault(target, 'chat')) return null;
    const model = this.store
      .modelsOf(row.id)
      .find(
        (candidate) =>
          !candidate.archivedAt &&
          candidate.enabled &&
          candidate.visible &&
          candidate.kind === 'chat' &&
          this.passesVisibility(row, candidate.modelKey),
      );
    if (!model) return null;
    this.store.setDefault({ workspace: target, ownerId: actor.userId }, 'chat', model.id, []);
    this.options.audit.record({
      workspace: target,
      ownerId: actor.userId,
      actorKind: 'system',
      actorId: actor.userId,
      action: 'model_default.updated',
      entityKind: 'workspace',
      entityId: target,
      summary: `chat default set to ${row.slug}/${model.modelKey}`,
      data: { role: 'chat', provider: row.slug, model: model.modelKey, reason: 'first_provider' },
    });
    this.propagate(scope, actor);
    return serializeModel(model, row.slug);
  }

  /**
   * The self-check behind "I added a provider and nothing happened".
   *
   * Propagation used to be entirely invisible: the hub wrote two files and restarted a
   * process, and if any of that did not happen the only sign was a run failing in the
   * runtime's own words, with nothing in the product to look at. Every check here is
   * answered from the files and the process **as they are now** — a stored snapshot
   * would go stale exactly when it mattered.
   */
  runtimeReport(workspace: string): ContractRuntimeReport {
    const home = this.options.hermes.home();
    const mode = this.options.hermes.mode?.() ?? (home ? 'managed' : 'absent');
    const state = home ? this.state(workspace) : null;
    const checks: ContractRuntimeCheck[] = [];

    // 1. Is there a runtime whose files this hub may write at all? An `external` gateway
    //    is somebody else's process (ADR 0010 §3); `absent` is no Hermes on this host.
    checks.push({
      id: 'runtime_writable',
      ok: home !== null,
      detail: mode,
    });

    // 2. The keys, read back from the file the runtime reads — not from what we meant to
    //    write. A workspace whose providers all take no key passes with none. The root
    //    `.env` is the default profile's (decision §37); a named profile's own keys are
    //    checked in its own `.env` before each of its turns (`prepareProfile`).
    const rootState = home ? this.state(this.hub({ id: workspace }).id) : null;
    const wanted = rootState ? hermesEnvPlan(home as string, rootState) : null;
    const onDisk = home ? readEnvFile(path.join(home, '.env')) : new Map<string, string>();
    const missingKeys = wanted
      ? wanted.owned.filter((name) => onDisk.get(name) !== wanted.values[name])
      : [];
    checks.push({
      id: 'provider_keys',
      ok: home !== null && missingKeys.length === 0,
      detail: wanted ? (missingKeys[0] ?? String(wanted.owned.length)) : null,
    });

    // 3. Did the provider itself accept the key? Stored when it was saved and refreshed
    //    by every Test; a provider that has never answered is not a failure, only
    //    unproven — the endpoint may simply be one that is asked nothing until a run.
    const rows = this.effectiveRows(workspace).filter((row) => row.enabled && !row.archivedAt);
    const rejected = rows.filter((row) => row.status === 'error');
    checks.push({
      id: 'provider_verified',
      ok: rejected.length === 0,
      detail: rejected[0]?.slug ?? null,
    });

    // 4. A model the runtime will actually serve. `blocked` is the honest refusal: the
    //    provider is one the hub cannot say to this runtime at all.
    checks.push({
      id: 'model_selected',
      ok: Boolean(state?.hermesModel),
      detail: state?.hermesModel
        ? `${state.hermesModel.provider}/${state.hermesModel.model}`
        : (state?.hermesModelBlocked ?? null),
    });

    // 5. Did the process take the files? It reads them at start, so "reloaded after the
    //    last write" is the question, and the runtime is the only one who knows.
    const reloadedAt = this.options.hermes.reloadedAt?.() ?? null;
    checks.push({
      id: 'gateway_reloaded',
      ok: mode === 'external' || (reloadedAt !== null && reloadedAt >= this.lastWriteAt),
      detail: null,
    });

    return {
      agent: 'hermes',
      mode,
      ready: checks.every((check) => check.ok),
      reloaded_at: reloadedAt === null ? null : new Date(reloadedAt).toISOString(),
      checks,
    };
  }

  /**
   * Reconciles Hermes's own files with this workspace's providers, without any of them
   * having changed (ADR 0010 §Propagation).
   *
   * Called once at boot. A restored volume, an image upgrade or a `config.yaml` somebody
   * edited by hand all leave Hermes describing a world that is no longer this one; the
   * hub writes what it knows and recycles the gateway only if that actually changed
   * something. Never throws: a hub whose Hermes home is unwritable still serves.
   */
  reconcile(scope: WorkspaceScope, actor: Actor): void {
    if (!this.options.hermes.home()) return;
    this.options.log.info(
      { workspace: scope.id },
      'models: reconciling the Hermes configuration with the stored providers',
    );
    this.propagate(scope, actor);
  }

  // ---------------------------------------------------------------- propagation

  /**
   * What every agent should be using right now. Read by the propagation calls below and
   * by the `agents` module at process start.
   */
  state(workspace: string): PropagationState {
    const credentials: ResolvedCredential[] = [];
    const hermesProviders: HermesProviderRoute[] = [];
    const seen = new Set<string>();
    const named = new Set<string>();
    // The providers this profile uses: its own first, then the shared ones it has no own row
    // of the same slug for — so its own key wins wherever both name one variable (§37).
    const effective = this.effectiveRows(workspace);
    const ordered = [
      ...effective.filter((row) => !row.shared),
      ...effective.filter((row) => row.shared),
    ];
    for (const row of ordered) {
      if (!row.enabled) continue;
      const entry = this.entryOf(row);
      const route = hermesRouteOf(entry);

      // The endpoint itself, for the providers Hermes has no provider of its own for.
      // This runs whether or not there is a key: LM Studio and Ollama answer without one,
      // and a route the hub did not write is a run that cannot reach them at all.
      if (route === 'openai-compatible' && row.kind === 'llm' && (row.baseUrl ?? entry?.baseUrl)) {
        const name = hermesProviderNameOf(row.slug, entry);
        if (name) {
          hermesProviders.push({
            name,
            baseUrl: hermesBaseUrlOf((row.baseUrl ?? entry?.baseUrl) as string, entry),
            apiMode: entry?.hermesApiMode ?? hermesApiModeOf(row.apiMode),
            keyEnv: hermesKeyEnvOf(row.slug, entry),
          });
        }
      }

      const familyKey = `${String(row.shared)}:${row.family}`;
      if (seen.has(familyKey) || !row.apiKeySecretId) continue;
      const value = this.options.secrets.reveal(row.workspace, row.apiKeySecretId);
      if (!value) continue;
      seen.add(familyKey);
      // A provider with no world-wide variable name still has one Hermes reads it by: the
      // `key_env` of its own `providers:` block. Skipping those rows was why a key typed
      // into a custom or local provider reached nothing (the defect of 2026-09-22).
      const envVar = entry?.envVar ?? hermesKeyEnvOf(row.slug, entry);
      const hermesEnvVars = (
        entry && entry.hermesEnvVars.length > 0 ? [...entry.hermesEnvVars] : [envVar]
      ).filter((name) => !named.has(name));
      if (hermesEnvVars.length === 0) continue;
      for (const name of hermesEnvVars) named.add(name);
      credentials.push({ family: row.family, envVar, hermesEnvVars, value });
    }
    const chat = this.hermesModelChoice(workspace);
    return {
      credentials,
      hermesProviders,
      hermesModel: chat.choice,
      hermesModelBlocked: chat.blocked,
      ownedEnv: this.ownedEnvNames(),
    };
  }

  /**
   * Every variable name the hub writes a provider key under — for the providers it has and
   * for the ones it had (a removed provider's row stays, archived). These are the names the
   * hub owns in Hermes's `.env`: a key that is gone from the hub is removed from the file,
   * and none of them may sit in a named profile's own `.env`, where Hermes would read it
   * before the process environment the hub hands every profile.
   */
  private ownedEnvNames(): string[] {
    const names = new Set<string>();
    // Every row of every profile, removed ones included: a name the hub once wrote is one
    // it owns, so a key taken away is taken out of the files too.
    for (const row of this.store.everyProviderRow()) {
      const entry = this.entryOf(row);
      if (entry && entry.hermesEnvVars.length > 0) {
        for (const name of entry.hermesEnvVars) names.add(name);
      } else {
        names.add(entry?.envVar ?? hermesKeyEnvOf(row.slug, entry));
      }
    }
    return [...names].sort();
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
   * What a client named, back to a provider row and the model id that provider serves.
   *
   * Accepts either shape a client can hold: the catalogue's `Model.key`
   * (`"<provider slug>/<model>"`, which is what a `<Select>` value has to be) or a bare
   * model id. `null` when this workspace has no such model — the caller passes the name
   * through rather than inventing one.
   *
   * The split is on the **first** slash, because a model id legitimately contains them
   * (`meta-llama/llama-3.1-70b`), and the left side is only accepted when it is actually
   * one of this workspace's provider slugs.
   */
  resolveModelKey(workspace: string, key: string): ModelRefInput | null {
    const trimmed = key.trim();
    if (!trimmed) return null;
    const slash = trimmed.indexOf('/');
    // The providers this profile uses: a slug names its own row over a shared one (§37).
    const effective = this.effectiveRows(workspace);
    if (slash > 0) {
      const slug = trimmed.slice(0, slash);
      const provider = effective.find((row) => row.slug === slug);
      const modelKey = trimmed.slice(slash + 1);
      if (provider && !provider.archivedAt && modelKey) {
        const row = this.store.model(provider.id, modelKey);
        if (row && !row.archivedAt) return { provider_id: provider.id, model: row.modelKey };
      }
    }
    // A bare id: the workspace's own catalogue decides which provider serves it.
    for (const provider of [
      ...effective.filter((row) => !row.shared),
      ...effective.filter((row) => row.shared),
    ]) {
      if (provider.archivedAt || !provider.enabled) continue;
      const row = this.store.model(provider.id, trimmed);
      if (row && !row.archivedAt) return { provider_id: provider.id, model: row.modelKey };
    }
    return null;
  }

  // ------------------------------------------------- the direct path (ADOPTION §2.15)

  /**
   * What the `direct` agent needs to know about a model before it builds a prompt: the
   * names to show, and whether an image may be sent at all.
   *
   * `null` when this workspace has no such model row. The caller then refuses the turn
   * rather than guessing — an image posted to a model that cannot see is a paid request
   * that comes back confused.
   */
  modelFacts(workspace: string, providerId: string, model: string): DirectModelFacts | null {
    const provider = this.effectiveFor(workspace, providerId);
    if (!provider || provider.archivedAt) return null;
    const row = this.store.model(provider.id, model);
    if (!row || row.archivedAt) return null;
    return {
      providerSlug: provider.slug,
      providerLabel: provider.label,
      modelLabel: row.alias ?? row.label,
      vision: row.capabilities.includes('vision'),
      maxOutputTokens: row.maxOutputTokens,
    };
  }

  /**
   * One streamed turn, straight from the hub to the provider (ADOPTION-BACKLOG §2.15).
   *
   * This is the whole of what crosses the module boundary for the `direct` agent: the
   * caller names a provider row and a model, and gets events. It never sees the row, the
   * key, or which adapter answered — ADR 0010's direction, unchanged.
   *
   * Nothing thrown: every refusal is a final `failed` event with one of the contract's
   * error codes and the provider's own sentence, because a run loop that has to catch is
   * a run loop that will one day forget to.
   */
  async *chat(workspace: string, request: DirectChatRequest): AsyncIterable<DirectChatEvent> {
    const provider = this.effectiveFor(workspace, request.providerId);
    if (!provider || provider.archivedAt || !provider.enabled) {
      yield {
        type: 'failed',
        code: 'provider_not_configured',
        message: provider
          ? `the provider "${provider.label}" is disabled`
          : 'the hub has no such provider',
      };
      return;
    }
    const entry = this.entryOf(provider);
    const ctx = this.contextOf({ id: workspace } as WorkspaceScope, provider);
    const adapter = providerAdapter(entry?.protocol ?? 'openai');
    const row = this.store.model(provider.id, request.model);
    const modelLabel = row?.alias ?? row?.label ?? request.model;

    for await (const event of adapter.chat(ctx, {
      model: request.model,
      messages: request.messages,
      ...(request.reasoningEffort !== undefined
        ? { reasoningEffort: request.reasoningEffort }
        : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      ...(row?.maxOutputTokens ? { maxOutputTokens: row.maxOutputTokens } : {}),
    })) {
      if (event.type === 'usage') {
        yield {
          ...event,
          modelLabel,
          providerId: provider.id,
          ...costOf(row?.pricing, event),
        };
        continue;
      }
      if (event.type === 'failed') {
        yield {
          type: 'failed',
          code: DIRECT_ERROR_CODES[event.reason],
          // The provider's own words when it sent any; ours only when it sent none.
          message: event.detail ?? directFailureText(event.reason, provider.label),
        };
        return;
      }
      yield event;
    }
  }

  /**
   * Writes the shared credentials and the chat default into the Hermes home this hub
   * supervises, then recycles the gateway so the change is live. Never throws: a hub
   * without Hermes, or a read-only volume, must not make "save the key" fail.
   */
  propagate(scope: WorkspaceScope, actor: Actor): void {
    const home = this.options.hermes.home();
    if (!home) return;
    // Hermes's root home is its `default` profile, which is the hub's default profile —
    // whichever profile the person saving happens to be in: the providers and keys it uses
    // (its own over the shared ones) and its model. Another profile's never land there (the
    // defect of 2026-09-24: the last profile to save a provider set everyone's model).
    const state = this.state(this.hub(scope).id);
    if (state.hermesModelBlocked) {
      this.options.log.warn(
        { provider: state.hermesModelBlocked },
        'models: Hermes cannot be told about the chat default provider; its model selection is left as it is',
      );
    }
    // The environment first: a running gateway holds its variables from spawn time, so
    // this is what the restart below actually makes live. The `.env` is written all the
    // same — `hermes model`, `hermes config` and a shell in the container read it.
    const envChanged = this.options.hermes.applyEnvironment?.(hermesProcessEnv(state)) ?? false;
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
    this.propagateToProfiles(state);
    if (!result.dirty && !envChanged) return;
    this.lastWriteAt = this.now().getTime();
    const changed = [...result.env.changed, ...result.config.changed];
    const removed = [...result.env.removed, ...result.config.removed];
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
      summary: 'Hermes received the profile providers',
      data: { changed, removed },
    });
    this.scheduleRestart();
  }

  /** Every named Hermes profile, made ready against the root it falls back on. */
  private propagateToProfiles(root: PropagationState): void {
    for (const profileHome of this.options.hermes.profileHomes?.() ?? []) {
      this.prepareProfileWith(profileHome, root);
    }
  }

  /**
   * Makes one named Hermes profile ready for a turn with the providers **it** uses
   * (contract decision §37): its own, and the shared ones it has no own row of the same
   * slug for.
   *
   * - `config.yaml`: the endpoints (`providers:` blocks) of those providers — a turn that
   *   names `majlis-<slug>` finds it, with this profile's address when it has its own.
   * - `.env`: Hermes reads a profile's `.env` **before** the process environment
   *   (`agent/secret_scope.py` §get_secret), and the process environment is the root's —
   *   Hermes loads the root `.env` into it at start. So for every variable the hub owns, the
   *   profile's `.env` says what differs from the root: its own key (which then wins), the
   *   shared key where the root has its own instead, or an empty value where the root has a
   *   key this profile must not use. A variable whose value is the root's is left out — the
   *   shared keys stay in one place. Every other line of the file is left as it is, and a
   *   copy of `default` (`--clone-from`) loses the keys it copied that are not its own.
   *
   * Called for every named profile on each save, right after the hub makes a profile, and
   * for one profile before each of its turns (`prepareProfile`), so a profile made later —
   * by the hub, by Hermes, or on first use — is right before it runs. Never throws.
   */
  prepareProfile(profileHome: string): void {
    this.prepareProfileWith(profileHome, this.state(this.hub().id));
  }

  private prepareProfileWith(profileHome: string, root: PropagationState): void {
    const profile = path.basename(profileHome);
    try {
      const workspace = this.options.profileWorkspace?.(profile) ?? `hermes-profile:${profile}`;
      const mine = this.state(workspace);
      const written = writeHermesProviders(profileHome, mine.hermesProviders);
      const rootValues = hermesProcessEnv(root);
      const ownValues = hermesProcessEnv(mine);
      const owned = [
        ...new Set([
          ...(root.ownedEnv ?? []),
          ...Object.keys(rootValues),
          ...Object.keys(ownValues),
        ]),
      ];
      const values: Record<string, string> = {};
      for (const name of owned) {
        if (ownValues[name] === rootValues[name]) continue;
        // Empty blocks the root's key: this profile has no key of that name to use.
        values[name] = ownValues[name] ?? '';
      }
      const env = writeHermesEnv({ file: path.join(profileHome, '.env'), owned, values });
      if (written.dirty || env.dirty) {
        this.options.log.info(
          // Names only, never a value.
          {
            profile,
            changed: [...written.changed, ...env.changed],
            removed: [...written.removed, ...env.removed],
          },
          'models: Hermes profile made ready for its providers',
        );
      }
    } catch (error) {
      this.options.log.warn(
        { err: error, profile },
        'models: could not prepare a Hermes profile; its configuration is unchanged',
      );
    }
  }

  /**
   * Recycles the runtime once, a moment after the writing stops.
   *
   * Saving a provider is several writes in a row — the key, then the models the refresh
   * found, then the default that follows from them — and each used to restart the gateway.
   * Three restarts for one action is thrash, and each one can land on top of a turn
   * somebody is watching. So: coalesce them into one, and wait while a run is in flight.
   * The files are already on disk; only the moment the process re-reads them moves.
   */
  private scheduleRestart(): void {
    this.restartPending = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.drainRestart(0);
    }, this.restartDelayMs);
    // A timer must never hold the process open: the hub exiting is the gateway exiting too.
    this.restartTimer.unref?.();
  }

  /**
   * The one pending restart, waiting for the runtime to be idle.
   *
   * `restartTimer` being set means a newer write has re-armed the debounce; that timer
   * owns the restart and this chain steps aside, so several saves in a row can never
   * leave two chains racing to recycle the same process.
   */
  private async drainRestart(attempt: number): Promise<void> {
    if (this.restartTimer || !this.restartPending) return;
    // A turn takes seconds; a person waits for it. Past the cap the change wins — a key
    // that never takes effect is worse than one interrupted turn, and the cap is minutes.
    if ((this.options.hermes.busy?.() ?? false) && attempt < RESTART_BUSY_ATTEMPTS) {
      const timer = setTimeout(() => void this.drainRestart(attempt + 1), this.restartDelayMs);
      timer.unref?.();
      return;
    }
    if (attempt >= RESTART_BUSY_ATTEMPTS) {
      this.options.log.warn(
        { attempts: attempt },
        'models: recycling the Hermes gateway although a run is in flight; the change has waited long enough',
      );
    }
    this.restartPending = false;
    try {
      await this.options.hermes.restart();
    } catch (error) {
      this.options.log.warn({ err: error }, 'models: the Hermes gateway did not restart');
    }
  }

  // -------------------------------------------------------------------- helpers

  private present(scope: WorkspaceScope, row: ProviderRow): ContractProvider {
    const entry = this.entryOf(row);
    return serializeProvider(row, {
      // A shared row is stored under the default profile; an own row is the asking one's.
      profile: row.shared ? this.hub(scope).slug : scope.slug,
      models: this.store.modelsOf(row.id),
      keyStored: this.hasKey(scope, row),
      refreshable: entry ? entry.capabilities.listModels !== false : true,
    });
  }

  /** A live provider this profile can see — its own, or a shared one (decision §37). */
  private loadProvider(scope: WorkspaceScope, id: string): ProviderRow {
    const row = this.visibleRow(scope.id, id);
    if (!row) throw notFound({ resource: 'provider', id });
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

  private contextOf(_scope: Pick<WorkspaceScope, 'id'>, row: ProviderRow): ProviderContext {
    const entry = this.entryOf(row);
    return {
      slug: row.slug,
      label: row.label,
      baseUrl: row.baseUrl ?? entry?.baseUrl ?? '',
      // A key is stored where its row is: the default profile for a shared one.
      apiKey: row.apiKeySecretId
        ? this.options.secrets.reveal(row.workspace, row.apiKeySecretId)
        : null,
      // `auth_kind` is the requirement, not "has a key": a provider that does not demand
      // one is asked without one, and whatever the endpoint answers is the answer.
      requiresKey: row.authKind === 'api_key',
      headers: { ...row.headers },
      settings: { ...row.settings },
      fetchImpl: this.fetchImpl,
    };
  }

  private hasKey(_scope: Pick<WorkspaceScope, 'id'>, row: ProviderRow): boolean {
    return this.options.secrets.has(row.workspace, row.apiKeySecretId);
  }

  /**
   * Stores one key for a whole credential family **of one scope** and points every row of
   * that family in that scope at it. This is the line that makes the OpenAI key entered on
   * the chat tab the same key the dictation tab uses (ADR 0010 §One key, many rows) — and
   * that keeps a profile's own OpenAI key apart from the shared one (decision §37).
   */
  private storeKey(owner: ProviderOwner, actor: Actor, family: string, plaintext: string): void {
    const secretId = this.options.secrets.put(
      { workspace: owner.workspace, ownerId: actor.userId },
      secretNameOf(family, owner.shared),
      plaintext,
      'api_key',
    );
    const at = this.now();
    for (const row of this.store.scopeFamilyRows(owner.workspace, owner.shared, family)) {
      this.db
        .update(providers)
        .set({ apiKeySecretId: secretId, updatedAt: at })
        .where(eq(providers.id, row.id))
        .run();
    }
  }

  private clearKey(owner: ProviderOwner, family: string): void {
    const rows = this.store.scopeFamilyRows(owner.workspace, owner.shared, family);
    const secretId = rows.find((row) => row.apiKeySecretId)?.apiKeySecretId;
    if (secretId) this.options.secrets.wipe(owner.workspace, secretId);
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

  /**
   * A stored model id, as this profile can run it: the model of that name on the provider of
   * that slug the profile uses — its own over a shared one (decision §37). Null when the
   * profile has no such provider or model, or the provider was removed.
   */
  private refOf(scope: Pick<WorkspaceScope, 'id'>, modelId: string): ModelRefInput | null {
    const row = this.store.modelRowById(modelId);
    if (!row || row.archivedAt) return null;
    const provider = this.effectiveFor(scope.id, row.providerId);
    if (!provider) return null;
    const model =
      provider.id === row.providerId ? row : this.store.model(provider.id, row.modelKey);
    if (!model || model.archivedAt) return null;
    return { provider_id: provider.id, model: model.modelKey };
  }

  /** The role's model in effect for a profile: its own choice, else the default profile's. */
  private refOfRole(workspace: string, role: ModelRole): ModelRefInput | null {
    const found = this.effectiveDefault(workspace, role);
    return found ? this.refOf({ id: workspace }, found.row.modelId) : null;
  }

  /**
   * The workspace's chat default expressed the way Hermes names a model.
   *
   * `blocked` is the honest half, and it is now a much shorter list than it was: Hermes
   * understands any OpenAI-compatible endpoint given a `providers:` block, so Groq,
   * Mistral, LM Studio, LiteLLM, Ollama and somebody's own address all reach it. What
   * stays blocked is a provider that is not a chat route at all. Nothing is ever guessed:
   * Hermes's `openai` id is an alias of **OpenRouter**, so a slug is only ever written
   * when the catalogue declares it.
   */
  private hermesModelChoice(workspace: string): {
    choice: HermesModelChoice | null;
    blocked: string | null;
  } {
    const ref = this.refOfRole(workspace, 'chat');
    if (!ref) return { choice: null, blocked: null };
    const provider = this.store.providerById(ref.provider_id);
    if (!provider) return { choice: null, blocked: null };
    const name = this.hermesNameOfProvider(provider);
    if (!name) return { choice: null, blocked: provider.slug };
    return { choice: { provider: name, model: ref.model }, blocked: null };
  }

  /**
   * The name Hermes knows one of this workspace's providers by, or null when it cannot be
   * told about it. Public so a run can name its own provider per request rather than
   * inheriting whatever the last default write left in `config.yaml` (ADR 0008 §1: the
   * run surface takes `provider` and `model` on every `POST /v1/runs`).
   */
  hermesProviderName(workspace: string, providerId: string): string | null {
    // The provider of that slug this profile uses: its own over a shared one (§37).
    const row = this.effectiveFor(workspace, providerId);
    if (!row || row.archivedAt) return null;
    return this.hermesNameOfProvider(row);
  }

  /**
   * Refuses a chat default the hub could not tell the runtime about.
   *
   * Silence was the defect: a provider with no name in Hermes was made the workspace
   * default, the hub logged one line nobody reads, wrote nothing, and the run went out on
   * a *different* provider's configuration. Every chat provider is expressible now
   * (`catalogue.ts` guards it), so this can only fire for a provider that is not a chat
   * route at all — and it fires loudly rather than accepting a default that cannot work.
   */
  private requireExpressible(scope: WorkspaceScope, providerId: string): void {
    const row = this.loadProvider(scope, providerId);
    if (this.hermesNameOfProvider(row)) return;
    throw validationFailed({
      field: 'default',
      reason: 'the agent runtime cannot be told about this provider, so it cannot be the default',
      provider: row.slug,
    });
  }

  private hermesNameOfProvider(row: ProviderRow): string | null {
    const entry = this.entryOf(row);
    if (hermesRouteOf(entry) === 'openai-compatible' && row.kind !== 'llm') return null;
    return hermesProviderNameOf(row.slug, entry);
  }

  private requireModel(scope: WorkspaceScope, ref: ModelRefInput): ModelRow {
    const provider = this.loadProvider(scope, ref.provider_id);
    const row = this.store.model(provider.id, ref.model);
    if (!row || row.archivedAt) {
      throw validationFailed({
        field: 'model',
        reason: 'the profile has no such model on that provider',
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
    const rows = this.visibleRows(scope.id, kind);
    const list = rows.map((row) =>
      serializeSpeechProvider(row, { keyStored: this.hasKey(scope, row) }),
    );
    const activeRowId = activeId ? this.effectiveFor(scope.id, activeId)?.id : undefined;
    const active = activeRowId ? rows.find((row) => row.id === activeRowId) : undefined;
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

  /**
   * A slug for somebody's own endpoint, free in the scope it goes to and among what the
   * asking profile sees — two providers one profile lists never share a name.
   */
  private freeSlug(workspace: string, owner: ProviderOwner, label: string): string {
    const base =
      `custom-${label}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 36) || 'custom-provider';
    let candidate = base;
    for (let n = 2; n < 100; n += 1) {
      const taken =
        this.store.scopeRowBySlug(owner.workspace, owner.shared, candidate) ??
        this.visibleRows(workspace).find((row) => row.slug === candidate);
      if (!taken) return candidate;
      candidate = `${base}-${n}`;
    }
    throw conflict({ reason: 'slug_exhausted', detail: label });
  }
}

/** The host name a container reaches its host machine by, on Docker and Podman alike. */
export const LOOPBACK_ALIAS = 'host.docker.internal';

/**
 * Whether the hub is running inside a container — the fact a client needs to warn that
 * `http://127.0.0.1:1234/v1` is the *container's* loopback, not the person's machine.
 * The hub reports it and never rewrites a URL somebody typed.
 */
export function hostInfo(exists: (path: string) => boolean = existsSync): ProviderHostInfo {
  // Docker writes `/.dockerenv`; Podman writes `/run/.containerenv`. Neither is a
  // guarantee, which is why the client *warns* instead of acting — and why this is not a
  // configuration variable: the four in `app/config.ts` are the whole configuration
  // (ARCHITECTURE invariant 5), and a fifth one people had to set would be a trap.
  const containerized = exists('/.dockerenv') || exists('/run/.containerenv');
  return { containerized, loopback_alias: LOOPBACK_ALIAS };
}

// ------------------------------------------------- the direct path (ADOPTION §2.15)

/** What `modelFacts` tells the `direct` agent about the model a turn will run on. */
export interface DirectModelFacts {
  providerSlug: string;
  providerLabel: string;
  modelLabel: string;
  /** True only when the model row itself declares `vision`. Never inferred from a name. */
  vision: boolean;
  maxOutputTokens: number | null;
}

export interface DirectChatRequest {
  /** A `providers` row id in this workspace, as `resolveModelKey` returned it. */
  providerId: string;
  model: string;
  messages: ChatMessage[];
  reasoningEffort?: string | null;
  signal?: AbortSignal;
}

export type DirectChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'usage';
      modelLabel: string;
      providerId: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      reasoningTokens?: number;
      costMicroUsd?: number;
      costSource?: 'provider' | 'estimated' | 'unknown';
    }
  | { type: 'completed' }
  | { type: 'failed'; code: string; message: string };

/**
 * An adapter's reason for stopping, as one of the contract's `ErrorCode`s.
 *
 * `cancelled` is not a contract code and never reaches a client as one: the caller (the
 * `direct` adapter) reads it as "the hub asked for this" and reports an interrupted run,
 * which is what the run state machine already knows how to end.
 */
const DIRECT_ERROR_CODES: Record<ChatFailureReason, string> = {
  no_key: 'provider_not_configured',
  unauthorized: 'provider_unauthorized',
  rate_limited: 'rate_limited',
  unreachable: 'agent_unavailable',
  http_error: 'agent_error',
  unsupported: 'agent_error',
  model_not_found: 'not_found',
  cancelled: 'cancelled',
};

/** Used only when the provider sent no words of its own. */
function directFailureText(reason: ChatFailureReason, provider: string): string {
  switch (reason) {
    case 'no_key':
      return `${provider} needs an API key and this profile has none stored`;
    case 'unauthorized':
      return `${provider} refused the stored key`;
    case 'rate_limited':
      return `${provider} is rate limiting this key`;
    case 'unreachable':
      return `${provider} could not be reached`;
    case 'model_not_found':
      return `${provider} does not know this model`;
    case 'cancelled':
      return 'the turn was cancelled';
    default:
      return `${provider} refused the turn`;
  }
}

/**
 * What the turn cost, from the model row's own prices.
 *
 * `costSource: 'estimated'` is the honest label: the number is the hub multiplying the
 * provider's published price by the provider's own token counts, not an invoice. A model
 * whose row carries no price reports `unknown` and no number, rather than zero — zero is
 * a claim, and a wrong one.
 */
function costOf(
  pricing: ModelPricing | undefined,
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
): { costMicroUsd?: number; costSource: 'estimated' | 'unknown' } {
  if (!pricing) return { costSource: 'unknown' };
  const parts: Array<[number | undefined, number | undefined]> = [
    [usage.inputTokens, pricing.inputPerMillion],
    [usage.outputTokens, pricing.outputPerMillion],
    [usage.cacheReadTokens, pricing.cacheReadPerMillion],
    [usage.cacheWriteTokens, pricing.cacheWritePerMillion],
  ];
  let total = 0;
  let priced = false;
  for (const [tokens, perMillion] of parts) {
    if (!tokens || perMillion === undefined) continue;
    priced = true;
    // `perMillion` is micro-USD per million tokens (`adapters/openai.ts`
    // §perMillionMicroUsd), so micro-USD for n tokens is n × perMillion ÷ 1e6.
    total += (tokens * perMillion) / 1_000_000;
  }
  return priced
    ? { costMicroUsd: Math.round(total), costSource: 'estimated' }
    : { costSource: 'unknown' };
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
