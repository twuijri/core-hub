// `X-Hub-Profile` resolution (ADR 0005): the header carries a workspace slug (or id); the
// server resolves it once per request, checks the caller may enter it and exposes it as
// `request.workspace`. Every scoped query in every module filters by `request.workspace.id`.
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ModuleDb } from '../../lib/db.js';
import { HubError } from '../../lib/errors.js';
import type { PrincipalUser } from './principal.js';
import { workspaceMembers, workspaces } from './schema.js';
import type { WorkspaceRow } from './serialize.js';

export interface WorkspaceScope {
  id: string;
  slug: string;
  name: string;
  isDefault: boolean;
}

export const DEFAULT_WORKSPACE_SLUG = 'default';

export function toScope(row: WorkspaceRow): WorkspaceScope {
  return { id: row.id, slug: row.slug, name: row.name, isDefault: row.isDefault };
}

/** Non-archived workspace by slug or id, or null. */
export function findWorkspace(db: ModuleDb, slugOrId: string): WorkspaceRow | null {
  const bySlug = db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.slug, slugOrId), isNull(workspaces.archivedAt)))
    .get();
  if (bySlug) return bySlug;
  return (
    db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, slugOrId), isNull(workspaces.archivedAt)))
      .get() ?? null
  );
}

export function defaultWorkspace(db: ModuleDb): WorkspaceRow | null {
  return (
    db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.isDefault, true), isNull(workspaces.archivedAt)))
      .get() ?? null
  );
}

/**
 * Workspace ids a member is explicitly enrolled in. The list is the whole answer: empty means
 * the member enters **no** workspace. Nothing is ever granted implicitly — not by an empty
 * list, not by a workspace being created later (owner, 2026-09-24).
 */
export function membershipIds(db: ModuleDb, userId: string): string[] {
  return db
    .select({ workspace: workspaceMembers.workspace })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .all()
    .map((row) => row.workspace);
}

/** Who is entering: the role decides, and a run token's pin narrows it to one workspace. */
export type EnteringUser = Pick<PrincipalUser, 'id' | 'role' | 'pinnedWorkspaceId'>;

/** Workspaces the user may enter, default first then by name (docs/domain/auth.md). */
export function listWorkspacesFor(db: ModuleDb, user: EnteringUser): WorkspaceRow[] {
  const all = db
    .select()
    .from(workspaces)
    .where(isNull(workspaces.archivedAt))
    .orderBy(desc(workspaces.isDefault), asc(workspaces.name))
    .all();
  if (user.pinnedWorkspaceId) return all.filter((row) => row.id === user.pinnedWorkspaceId);
  if (user.role !== 'member') return all;
  const allowed = new Set(membershipIds(db, user.id));
  return all.filter((row) => allowed.has(row.id));
}

export function canEnter(db: ModuleDb, user: EnteringUser, workspaceId: string): boolean {
  // A run token entered its one workspace when its run started there (and is checked
  // against the person's own membership on every call, `principal.ts`).
  if (user.pinnedWorkspaceId) return user.pinnedWorkspaceId === workspaceId;
  if (user.role !== 'member') return true;
  return membershipIds(db, user.id).includes(workspaceId);
}

/**
 * The refusal for a workspace the caller may not enter. A member who has been given no
 * workspace at all hears that, not "unknown profile": they can sign in, and the only thing
 * that changes it is an admin granting them one (`details.reason = no_profile_granted`).
 */
export function workspaceRefusal(
  db: ModuleDb,
  user: Pick<PrincipalUser, 'id' | 'role'>,
  slugOrId: string,
): HubError {
  if (user.role === 'member' && membershipIds(db, user.id).length === 0) {
    return new HubError('profile_not_found', {
      messageKey: 'auth.no_profile_granted',
      details: { profile: slugOrId, reason: 'no_profile_granted' },
    });
  }
  return new HubError('profile_not_found', { details: { profile: slugOrId } });
}

/** Resolves the header for the principal; 404 `profile_not_found` when unknown or not enterable. */
export function resolveWorkspaceFor(
  db: ModuleDb,
  user: EnteringUser,
  slugOrId: string | undefined,
): WorkspaceScope {
  if (!slugOrId) throw new HubError('profile_required');
  const row = findWorkspace(db, slugOrId);
  if (!row || !canEnter(db, user, row.id)) throw workspaceRefusal(db, user, slugOrId);
  return toScope(row);
}

/** preHandler: `requireUser` first, then `X-Hub-Profile` -> `request.workspace`. */
export async function requireWorkspace(request: FastifyRequest, _reply: FastifyReply) {
  if (!request.principal) throw request.authError ?? new HubError('unauthorized');
  request.workspace = resolveWorkspaceFor(
    request.server.hub.database.db as ModuleDb,
    request.principal.user,
    request.hubProfile,
  );
}
