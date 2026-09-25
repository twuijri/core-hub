// Row -> contract shape (packages/contracts/openapi.yaml, tag `auth`). snake_case keys,
// ISO-8601 UTC timestamps, never a hash or a secret.
import { derived } from '@corehub/contracts';
import type {
  appTokens,
  loginLockouts,
  pairingCodes,
  users,
  workspaces,
  UserPreferences,
  WorkspaceHubSettings,
} from './schema.js';

export type UserRow = typeof users.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type AppTokenRow = typeof appTokens.$inferSelect;
export type PairingRow = typeof pairingCodes.$inferSelect;
export type LockoutRow = typeof loginLockouts.$inferSelect;

export const iso = (date: Date | null | undefined): string | null =>
  date ? date.toISOString() : null;

export function userAvatarUrl(userId: string): string {
  return `/api/v1/auth/users/${userId}/avatar`;
}

export interface UserContext {
  /** Slugs the user may enter, display order. */
  profiles: string[];
  defaultProfile: string;
}

export function serializeUser(row: UserRow, context: UserContext) {
  return {
    id: row.id,
    username: row.username,
    display_name: row.displayName ?? row.username,
    role: row.role,
    status: row.status,
    locale: row.locale,
    avatar: row.avatarMime
      ? { kind: 'image' as const, url: userAvatarUrl(row.id), seed: null }
      : { kind: 'generated' as const, url: null, seed: row.username },
    profiles: context.profiles,
    default_profile: context.defaultProfile,
    last_login_at: iso(row.lastLoginAt),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export interface ProfileStats {
  agentCount: number;
  sessionCount: number;
}

export function serializeProfile(row: WorkspaceRow, stats: ProfileStats) {
  const model = row.settings.defaultModel ?? null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    avatar: row.avatarMime
      ? { kind: 'image' as const, url: null, seed: null }
      : { kind: 'generated' as const, url: null, seed: row.slug },
    default_model: model ? { provider_id: model.providerId, model: model.model } : null,
    agent_count: stats.agentCount,
    session_count: stats.sessionCount,
    owner_id: row.ownerId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export const HUB_SETTINGS_DEFAULTS: WorkspaceHubSettings = {
  proxy: { httpsProxy: null, httpProxy: null, allProxy: null, noProxy: null },
  compression: {
    enabled: true,
    threshold: 0.5,
    targetRatio: 0.2,
    protectFirst: 3,
    protectLast: 20,
    contextLength: null,
  },
  privacy: { redactPii: false },
  appearance: { fontSize: 14, textColor: null, accentColor: null, backgroundAttachmentId: null },
};

export function hubSettingsOf(row: WorkspaceRow): WorkspaceHubSettings {
  const stored = row.settings.hub ?? {};
  return {
    proxy: { ...HUB_SETTINGS_DEFAULTS.proxy, ...stored.proxy },
    compression: { ...HUB_SETTINGS_DEFAULTS.compression, ...stored.compression },
    privacy: { ...HUB_SETTINGS_DEFAULTS.privacy, ...stored.privacy },
    appearance: { ...HUB_SETTINGS_DEFAULTS.appearance, ...stored.appearance },
  };
}

export function serializeProfileSettings(settings: WorkspaceHubSettings) {
  return {
    proxy: {
      https_proxy: settings.proxy.httpsProxy,
      http_proxy: settings.proxy.httpProxy,
      all_proxy: settings.proxy.allProxy,
      no_proxy: settings.proxy.noProxy,
    },
    compression: {
      enabled: settings.compression.enabled,
      threshold: settings.compression.threshold,
      target_ratio: settings.compression.targetRatio,
      protect_first: settings.compression.protectFirst,
      protect_last: settings.compression.protectLast,
      context_length: settings.compression.contextLength,
    },
    privacy: { redact_pii: settings.privacy.redactPii },
    appearance: {
      font_size: settings.appearance.fontSize,
      text_color: settings.appearance.textColor,
      accent_color: settings.appearance.accentColor,
      background_attachment_id: settings.appearance.backgroundAttachmentId,
    },
  };
}

/** The contract's `Preferences` with every key present. */
export const PREFERENCES_DEFAULTS = {
  theme: 'system',
  locale: 'ar',
  text_scale: 1.0,
  link_target: 'in_app',
  busy_input_mode: 'queue',
  streaming: true,
  compact: false,
  show_reasoning: true,
  show_tool_calls: true,
  show_cost: false,
  inline_diffs: true,
  sound_on_complete: false,
  notify_on_complete: true,
  notify_on_approval: true,
  reasoning_effort: null,
  voice: {
    input_mode: 'device',
    dictation_language: 'auto',
    output_mode: 'server',
    auto_speak: false,
  },
} as const;

export function preferencesOf(row: UserRow): Record<string, unknown> {
  const stored: UserPreferences = row.preferences ?? {};
  const voice =
    stored.voice && typeof stored.voice === 'object'
      ? (stored.voice as Record<string, unknown>)
      : {};
  return {
    ...PREFERENCES_DEFAULTS,
    locale: row.locale,
    ...stored,
    voice: { ...PREFERENCES_DEFAULTS.voice, ...voice },
  };
}

export function serializeAppToken(row: AppTokenRow) {
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes,
    device_id: row.deviceId ?? null,
    last_used_at: iso(row.lastUsedAt),
    expires_at: iso(row.expiresAt),
    created_at: row.createdAt.toISOString(),
  };
}

export type PairingStatus = 'pending' | 'claimed' | 'expired' | 'cancelled';

export function pairingStatus(row: PairingRow, now: number): PairingStatus {
  if (row.cancelledAt) return 'cancelled';
  if (row.consumedAt) return 'claimed';
  if (row.expiresAt.getTime() <= now) return 'expired';
  return 'pending';
}

export function qrPayload(row: PairingRow): string {
  return JSON.stringify({
    type: derived.pairingType,
    hub_url: row.hubUrl,
    pairing_id: row.id,
    code: row.code,
    expires_at: row.expiresAt.toISOString(),
  });
}

export function serializePairing(row: PairingRow, now: number) {
  return {
    id: row.id,
    status: pairingStatus(row, now),
    code: row.code,
    connection: row.connection,
    qr_payload: qrPayload(row),
    expires_at: row.expiresAt.toISOString(),
    device_id: row.deviceId ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

export function serializeLockout(row: LockoutRow) {
  return {
    ip: row.subject,
    kind: row.kind,
    failures: row.failures,
    locked_until: (row.lockedUntil ?? row.createdAt).toISOString(),
  };
}
