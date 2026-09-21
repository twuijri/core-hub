// Registry row -> the contract's `Agent`. Pure; unit-tested against the states the
// install lifecycle can be in (docs/domain/agents.md).
import { iso } from '../../lib/time.js';
import type { agents, agentSettings } from './schema.js';

/**
 * The contract's `Avatar`. Until the hub stores agent pictures, every agent is a
 * `generated` avatar the client draws from the slug — the same shape `auth` uses for a
 * user without an uploaded image.
 */
export interface ContractAvatar {
  kind: 'image' | 'generated';
  url: string | null;
  seed: string | null;
}

const generatedAvatar = (seed: string): ContractAvatar => ({ kind: 'generated', url: null, seed });

export type AgentRow = typeof agents.$inferSelect;
export type AgentSettingsRow = typeof agentSettings.$inferSelect;

export type ContractAgentStatus =
  'available' | 'not_installed' | 'installing' | 'updating' | 'error' | 'limited' | 'disabled';

export interface ContractAgent {
  id: string;
  profile: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
  slug: string;
  name: string;
  vendor: string | null;
  kind: 'hermes' | 'acp' | 'harness' | 'builtin';
  avatar: ContractAvatar;
  status: ContractAgentStatus;
  enabled: boolean;
  install: {
    source: 'managed' | 'user_cli' | 'builtin' | 'none';
    path: string | null;
    package: string | null;
    command: string | null;
    version: string | null;
    latest_version: string | null;
    update_available: boolean;
    auto_update: boolean;
    auto_update_supported: boolean;
    checked_at: string | null;
    error: string | null;
  };
  runtime: {
    state: 'running' | 'stopped' | 'starting' | 'error' | 'not_applicable';
    url: string | null;
    error: string | null;
  };
  capabilities: string[];
  sections: string[];
  /** What this workspace's providers resolve to for this agent (ADR 0010). */
  default_model: { provider_id: string; model: string } | null;
  limited: boolean;
}

/**
 * The single status a card shows, in precedence order. A moving state wins over a resting
 * one, a broken install wins over "disabled", and `not_installed` is the honest answer for
 * a coding agent that is in the registry but not on the host: ADR 0006 keeps it *visible*,
 * the contract's `AgentStatus` keeps it *truthful* (the client draws an install button
 * from exactly this value).
 */
export function agentStatus(row: AgentRow, enabled: boolean): ContractAgentStatus {
  if (row.installState === 'installing') return 'installing';
  if (row.installState === 'updating') return 'updating';
  if (row.installState === 'failed') return 'error';
  if (row.installState === 'not_installed') return 'not_installed';
  if (!enabled) return 'disabled';
  if (row.limited) return 'limited';
  return 'available';
}

/** The runtime block, kept out of the row so an unreachable gateway is not a broken agent. */
export interface RuntimeState {
  state: ContractAgent['runtime']['state'];
  url: string | null;
  error: string | null;
}

export function serializeAgent(
  row: AgentRow,
  options: {
    profile: string;
    settings: AgentSettingsRow | undefined;
    runtime: RuntimeState;
    /**
     * The model this agent inherits from the workspace, or the one pinned to it
     * (ADR 0010). Null when the workspace has chosen none — a client then shows
     * "inherits nothing yet" rather than a guess.
     */
    defaultModel?: { provider_id: string; model: string } | null;
  },
): ContractAgent {
  const enabled = options.settings?.enabled ?? true;
  return {
    id: row.id,
    profile: options.profile,
    owner_id: row.ownerId,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
    slug: row.slug,
    name: row.name,
    vendor: row.vendor,
    kind: row.adapterKind,
    // No avatar store yet (attachments are Phase 4), so every agent is drawn from its slug.
    avatar: generatedAvatar(row.slug),
    status: agentStatus(row, enabled),
    enabled,
    install: {
      source: row.source,
      path: row.executablePath,
      package: row.packageName,
      // Display only; the hub always starts an agent from the argv array.
      command: row.command.length > 0 ? row.command.join(' ') : null,
      version: row.version,
      latest_version: row.latestVersion,
      update_available: !!row.latestVersion && !!row.version && row.latestVersion !== row.version,
      auto_update: row.autoUpdate,
      auto_update_supported: row.packageName !== null,
      checked_at: iso(row.checkedAt),
      error: row.lastError,
    },
    runtime: options.runtime,
    capabilities: [...row.capabilities],
    sections: [...row.sections],
    default_model: options.defaultModel ?? null,
    limited: row.limited,
  };
}
