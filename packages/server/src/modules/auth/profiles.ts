// Workspaces ("profiles" in the contract): the filter every scoped row carries (ADR 0005).
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ModuleDb } from '../../lib/db.js';
import { HubError } from '../../lib/errors.js';
import { deleteAvatar, writeAvatar, type DecodedAvatar } from './avatars.js';
import {
  users,
  workspaceMembers,
  workspaces,
  type ModelRef,
  type WorkspaceHubSettings,
} from './schema.js';
import { mirrorDisplayName } from './profile-mirror.js';
import { hubSettingsOf, type ProfileStats, type WorkspaceRow } from './serialize.js';
import { findWorkspace } from './workspace.js';

/**
 * `agent_count` / `session_count` belong to other modules. They register a provider here;
 * until they do, both counts are 0.
 */
export type WorkspaceStatsProvider = (workspaceId: string) => Partial<ProfileStats>;

/**
 * Several modules contribute: `agents` knows `agent_count`, `sessions` knows
 * `session_count`. They are merged in registration order, so each module answers for its
 * own field and a module that has not landed simply leaves its count at 0. A provider
 * that throws (an app closed while its provider is still registered, which happens in the
 * test suite) is skipped rather than failing the whole read.
 */
const statsProviders: WorkspaceStatsProvider[] = [];

export function registerWorkspaceStatsProvider(provider: WorkspaceStatsProvider): void {
  statsProviders.push(provider);
}

/**
 * A profile just came into existence — made here, or made as a copy of `source`. Other
 * modules copy what they keep per profile (`models`: a copy carries its source's own
 * providers and keys, contract decision §37) and prepare the runtime's profile. `auth`
 * knows nothing of what they do; a listener that throws is logged and skipped.
 */
export interface ProfileCreatedEvent {
  profile: WorkspaceRow;
  source: WorkspaceRow | null;
  actorId: string;
}
export type ProfileCreatedListener = (
  app: FastifyInstance,
  event: ProfileCreatedEvent,
) => void | Promise<void>;

const createdListeners: ProfileCreatedListener[] = [];

/** Wired once, from `modules/index.ts`. */
export function onProfileCreated(listener: ProfileCreatedListener): void {
  createdListeners.push(listener);
}

export async function profileCreated(
  app: FastifyInstance,
  event: ProfileCreatedEvent,
): Promise<void> {
  // The runtime shows the name the hub gave it (created or imported under a name).
  await mirrorDisplayName(app, event.profile);
  for (const listener of createdListeners) {
    try {
      await listener(app, event);
    } catch (error) {
      app.log.warn(
        { err: error, profile: event.profile.slug },
        'auth: a module could not finish setting up a new profile',
      );
    }
  }
}

export function statsOf(workspaceId: string): ProfileStats {
  let stats: ProfileStats = { agentCount: 0, sessionCount: 0 };
  for (const provider of statsProviders) {
    try {
      stats = { ...stats, ...provider(workspaceId) };
    } catch {
      // A stale provider cannot make a profile unreadable.
    }
  }
  return stats;
}

export interface ProfileCreateInput {
  slug: string;
  name: string;
  cloneFrom?: string | null;
}

export function createProfile(
  db: ModuleDb,
  actorId: string,
  input: ProfileCreateInput,
): WorkspaceRow {
  if (slugTaken(db, input.slug)) throw new HubError('conflict', { messageKey: 'auth.slug_taken' });
  let settings = {};
  if (input.cloneFrom) {
    const source = findWorkspace(db, input.cloneFrom);
    if (!source) {
      throw new HubError('validation_failed', {
        messageKey: 'auth.profile_unknown',
        details: { profiles: [input.cloneFrom] },
      });
    }
    // Agent settings and models live in other modules; they copy on their side when they exist.
    settings = structuredClone(source.settings);
  }
  return db
    .insert(workspaces)
    .values({ ownerId: actorId, slug: input.slug, name: input.name, settings })
    .returning()
    .get();
}

/** Slug taken by any workspace, archived ones included (their rows keep the slug). */
export function slugTaken(db: ModuleDb, slug: string): boolean {
  return (
    db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, slug)).get() !==
    undefined
  );
}

/** A profile's name, as the runtime can carry it too (Hermes's display-name limit). */
export const PROFILE_NAME_MAX = 64;

export interface ProfilePatchInput {
  slug?: string;
  name?: string;
  avatar?: { kind: 'image'; avatar: DecodedAvatar } | { kind: 'generated' } | null;
  defaultModel?: ModelRef | null;
}

export function updateProfile(
  db: ModuleDb,
  dataDir: string,
  row: WorkspaceRow,
  input: ProfilePatchInput,
): WorkspaceRow {
  const patch: Partial<typeof workspaces.$inferInsert> = {};
  if (input.slug !== undefined && input.slug !== row.slug) {
    if (row.isDefault)
      throw new HubError('conflict', { messageKey: 'auth.default_profile_immutable' });
    if (slugTaken(db, input.slug))
      throw new HubError('conflict', { messageKey: 'auth.slug_taken' });
    patch.slug = input.slug;
  }
  if (input.name !== undefined) patch.name = input.name;
  if (input.defaultModel !== undefined) {
    patch.settings = { ...row.settings, defaultModel: input.defaultModel };
  }
  if (input.avatar !== undefined) {
    if (input.avatar && input.avatar.kind === 'image') {
      writeAvatar(dataDir, 'workspaces', row.id, input.avatar.avatar);
      patch.avatarMime = input.avatar.avatar.mime;
    } else {
      deleteAvatar(dataDir, 'workspaces', row.id);
      patch.avatarMime = null;
    }
  }
  if (Object.keys(patch).length > 0) {
    db.update(workspaces).set(patch).where(eq(workspaces.id, row.id)).run();
  }
  return db.select().from(workspaces).where(eq(workspaces.id, row.id)).get()!;
}

/**
 * Archives the workspace and drops its memberships. Purging every scoped row across modules
 * is the owner-only job described in docs/domain/README.md §Archive and delete.
 */
export function deleteProfile(db: ModuleDb, row: WorkspaceRow, now: number): void {
  if (row.isDefault)
    throw new HubError('conflict', { messageKey: 'auth.default_profile_immutable' });
  db.transaction((tx) => {
    tx.update(workspaces)
      .set({ archivedAt: new Date(now) })
      .where(eq(workspaces.id, row.id))
      .run();
    tx.delete(workspaceMembers).where(eq(workspaceMembers.workspace, row.id)).run();
    tx.update(users)
      .set({ defaultWorkspaceId: null })
      .where(eq(users.defaultWorkspaceId, row.id))
      .run();
  });
}

export type HubSettingsPatch = {
  [K in keyof WorkspaceHubSettings]?: Partial<WorkspaceHubSettings[K]>;
};

/** JSON merge-patch per section; returns the full settings and whether `proxy` changed. */
export function patchProfileSettings(
  db: ModuleDb,
  row: WorkspaceRow,
  patch: HubSettingsPatch,
): { settings: WorkspaceHubSettings; proxyChanged: boolean } {
  const current = hubSettingsOf(row);
  const next: WorkspaceHubSettings = {
    proxy: { ...current.proxy, ...patch.proxy },
    compression: { ...current.compression, ...patch.compression },
    privacy: { ...current.privacy, ...patch.privacy },
    appearance: { ...current.appearance, ...patch.appearance },
  };
  db.update(workspaces)
    .set({ settings: { ...row.settings, hub: next } })
    .where(eq(workspaces.id, row.id))
    .run();
  const proxyChanged = JSON.stringify(current.proxy) !== JSON.stringify(next.proxy);
  return { settings: next, proxyChanged };
}
