// Registry row -> the contract's `Agent`. Pure; unit-tested against the states the
// install lifecycle can be in (docs/domain/agents.md).
import { iso } from '../../lib/time.js';
import { catalogEntry, pinnedVersion } from './catalog/index.js';
import type { agents, agentSettings } from './schema.js';
import { compareVersions } from './update-policy.js';

/**
 * The contract's `Avatar`: an uploaded picture (`avatars.ts`), fetched from
 * `agents.getAvatar`, or a `generated` avatar the client draws from the slug — the same
 * shape `auth` uses for a user without an uploaded image.
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
    pinned_version: string | null;
    newer_than_tested: boolean;
    auto_update: boolean;
    auto_update_supported: boolean;
    checked_at: string | null;
    error: string | null;
  };
  runtime: {
    state: 'running' | 'stopped' | 'starting' | 'error' | 'not_applicable';
    url: string | null;
    error: string | null;
    gateways?: MessagingGatewayView[];
  };
  capabilities: string[];
  sections: string[];
  /** What this workspace's providers resolve to for this agent (ADR 0010). */
  default_model: { provider_id: string; model: string } | null;
  limited: boolean;
  subagents: 'full' | 'observe' | 'none';
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

/** One messaging gateway on Hermes's card (the contract's `MessagingGateway`). */
export interface MessagingGatewayView {
  profile: string;
  state: 'running' | 'starting' | 'stopped' | 'error';
  pid: number | null;
  restarts: number;
  started_at: string | null;
  error: string | null;
  channels: string[];
  scheduled_jobs: number;
}

/** The runtime block, kept out of the row so an unreachable gateway is not a broken agent. */
export interface RuntimeState {
  state: ContractAgent['runtime']['state'];
  url: string | null;
  error: string | null;
  gateways?: MessagingGatewayView[];
}

export function serializeAgent(
  row: AgentRow,
  options: {
    profile: string;
    /** An uploaded picture exists (`avatars.ts`). */
    hasAvatar?: boolean;
    settings: AgentSettingsRow | undefined;
    runtime: RuntimeState;
    /**
     * The model this agent inherits from the workspace, or the one pinned to it
     * (ADR 0010). Null when the workspace has chosen none — a client then shows
     * "inherits nothing yet" rather than a guess.
     */
    defaultModel?: { provider_id: string; model: string } | null;
    /**
     * The name to show, when it is not the row's own: the catalog's Arabic name for an
     * agent whose name is a word rather than a brand (`service.ts` §`displayName`).
     */
    name?: string;
  },
): ContractAgent {
  const enabled = options.settings?.enabled ?? true;
  // The catalog's pin is the tested baseline; an agent the catalog no longer carries has none.
  const entry = catalogEntry(row.slug);
  const pinned = entry ? pinnedVersion(entry) : null;
  return {
    id: row.id,
    profile: options.profile,
    owner_id: row.ownerId,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
    slug: row.slug,
    name: options.name ?? row.name,
    vendor: row.vendor,
    kind: row.adapterKind,
    avatar: options.hasAvatar
      ? { kind: 'image', url: `/api/v1/agents/${row.id}/avatar`, seed: null }
      : generatedAvatar(row.slug),
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
      update_available:
        !!row.latestVersion && !!row.version && compareVersions(row.latestVersion, row.version) > 0,
      pinned_version: pinned,
      // Past the pin the owner tested: said in the UI, never hidden (`update-policy.ts`).
      newer_than_tested:
        row.source === 'managed' &&
        !!pinned &&
        !!row.version &&
        compareVersions(row.version, pinned) > 0,
      auto_update: row.autoUpdate,
      auto_update_supported: row.packageName !== null,
      // The agent keeps its own vendor account, and the hub can start its sign-in.
      ...(entry?.signIn ? { sign_in: true } : {}),
      checked_at: iso(row.checkedAt),
      error: row.lastError,
    },
    runtime: options.runtime,
    capabilities: [...row.capabilities],
    sections: [...row.sections],
    default_model: options.defaultModel ?? null,
    limited: row.limited,
    subagents: subagentSupport(row),
  };
}

/**
 * What the agent lets a person do with its subagents (§56): its catalog entry's word, or for an
 * agent found on the host rather than in the catalog, its adapter's — Hermes reports them all,
 * an unknown ACP agent is not trusted to.
 */
export function subagentSupport(
  row: Pick<AgentRow, 'slug' | 'adapterKind'>,
): 'full' | 'observe' | 'none' {
  const entry = catalogEntry(row.slug);
  if (entry) return entry.subagents;
  return row.adapterKind === 'hermes' ? 'full' : 'none';
}
