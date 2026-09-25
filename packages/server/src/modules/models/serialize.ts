// Rows -> the contract's `Provider`, `Model`, `ModelDefaults`, `Ensemble` and
// `SpeechSettings`. Pure functions, unit-tested; the one rule they all obey is that a
// secret leaves as `[stored]` or as `null`, never as itself.
import { iso } from '../../lib/time.js';
import { MASKED } from './crypto.js';
import type {
  EnsembleMemberValue,
  EnsembleRow,
  ModelPricing,
  ModelRow,
  ProviderRow,
} from './schema.js';

export interface ContractMoney {
  amount: string;
  currency: string;
}

export interface ContractModelPricing {
  input_per_million: ContractMoney;
  output_per_million: ContractMoney;
}

export interface ContractModel {
  key: string;
  provider_id: string;
  provider: string;
  model: string;
  alias: string | null;
  kind: string;
  visible: boolean;
  custom: boolean;
  preview: boolean;
  disabled: boolean;
  context_window: number | null;
  capabilities: string[];
  pricing: ContractModelPricing | null;
}

export interface ContractProvider {
  id: string;
  profile: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
  slug: string;
  label: string;
  kind: string;
  /** `all`: every profile's; `profile`: only `profile`'s own (contract decision §37). */
  scope: 'all' | 'profile';
  builtin: boolean;
  enabled: boolean;
  api_key: string | null;
  base_url: string | null;
  api_mode: string;
  auth: { kind: string; signed_in: boolean };
  catalogue: {
    status: string;
    refreshed_at: string | null;
    error: string | null;
    refreshable: boolean;
  };
  visibility: { mode: string; models: string[] };
  models: ContractModel[];
}

export interface ContractSpeechProvider {
  id: string;
  slug: string;
  label: string;
  kind: string;
  configured: boolean;
  api_key: string | null;
  settings: {
    model: string | null;
    language: string | null;
    base_url: string | null;
    voice: string | null;
  };
}

/** Micro-USD per million -> the contract's decimal-string `Money`. */
export function money(microUsd: number | undefined): ContractMoney | null {
  if (microUsd === undefined || !Number.isFinite(microUsd)) return null;
  const amount = (microUsd / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0');
  return { amount, currency: 'USD' };
}

export function serializePricing(pricing: ModelPricing): ContractModelPricing | null {
  const input = money(pricing.inputPerMillion);
  const output = money(pricing.outputPerMillion);
  // The contract requires both halves; a provider that reports one and not the other has
  // not told us a price, so we do not invent the other half.
  if (!input || !output) return null;
  return { input_per_million: input, output_per_million: output };
}

/** `<provider slug>/<model>` — the value sessions and seats store. */
export function modelKeyOf(providerSlug: string, model: string): string {
  return `${providerSlug}/${model}`;
}

export function serializeModel(row: ModelRow, providerSlug: string): ContractModel {
  return {
    key: modelKeyOf(providerSlug, row.modelKey),
    provider_id: row.providerId,
    provider: providerSlug,
    model: row.modelKey,
    alias: row.alias,
    kind: row.kind,
    visible: row.visible,
    custom: row.source === 'manual',
    preview: row.preview,
    disabled: !row.enabled,
    context_window: row.contextWindow,
    capabilities: [...row.capabilities],
    pricing: serializePricing(row.pricing),
  };
}

export interface SerializeProviderOptions {
  profile: string;
  models: ModelRow[];
  /** True when a usable key is stored for this provider's credential family. */
  keyStored: boolean;
  /** True when the adapter can list this provider's models. */
  refreshable: boolean;
}

export function serializeProvider(
  row: ProviderRow,
  options: SerializeProviderOptions,
): ContractProvider {
  return {
    id: row.id,
    profile: options.profile,
    owner_id: row.ownerId,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
    slug: row.slug,
    label: row.label,
    kind: row.kind,
    scope: row.shared ? 'all' : 'profile',
    builtin: row.builtin,
    enabled: row.enabled,
    // The one shape a stored key takes on the way out.
    api_key: options.keyStored ? MASKED : null,
    base_url: row.baseUrl,
    api_mode: row.apiMode,
    auth: {
      kind: row.authKind,
      // A provider that needs no key is always "signed in"; one that does is signed in
      // exactly when a key is stored.
      // A provider signed in to through Hermes is signed in once that sign-in was approved
      // (decision §50); the hub holds no key for it.
      signed_in:
        row.authKind === 'none'
          ? true
          : row.authKind === 'oauth'
            ? row.status === 'ok'
            : options.keyStored,
    },
    catalogue: {
      status: options.refreshable ? row.catalogueStatus : 'unsupported',
      refreshed_at: iso(row.catalogueRefreshedAt),
      error: row.catalogueError,
      refreshable: options.refreshable,
    },
    visibility: { mode: row.visibilityMode, models: [...row.visibleModels] },
    models: options.models.map((model) => serializeModel(model, row.slug)),
  };
}

export function serializeSpeechProvider(
  row: ProviderRow,
  options: { keyStored: boolean },
): ContractSpeechProvider {
  return {
    id: row.id,
    slug: row.slug,
    label: row.label,
    kind: row.kind,
    configured: row.authKind === 'none' ? true : options.keyStored,
    api_key: options.keyStored ? MASKED : null,
    settings: {
      model: row.settings.model ?? null,
      language: row.settings.language ?? null,
      base_url: row.baseUrl,
      voice: row.settings.voice ?? null,
    },
  };
}

export interface ContractEnsembleMember {
  provider_id: string;
  model: string;
  reasoning_effort: string | null;
}

export interface ContractEnsemble {
  id: string;
  profile: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
  name: string;
  enabled: boolean;
  active: boolean;
  members: ContractEnsembleMember[];
  aggregator: ContractEnsembleMember;
  max_tokens: number | null;
}

function member(value: EnsembleMemberValue): ContractEnsembleMember {
  return {
    provider_id: value.provider_id,
    model: value.model,
    reasoning_effort: value.reasoning_effort ?? null,
  };
}

export function serializeEnsemble(row: EnsembleRow, profile: string): ContractEnsemble {
  return {
    id: row.id,
    profile,
    owner_id: row.ownerId,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
    name: row.name,
    enabled: row.enabled,
    active: row.active,
    members: row.members.map(member),
    aggregator: member(row.aggregator),
    max_tokens: row.maxTokens,
  };
}
