// Users: first boot, sign-in sessions, self-service and admin management.
import { and, asc, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import type { ModuleDb } from '../../lib/db.js';
import { HubError } from '../../lib/errors.js';
import { newUlid } from '../../db/ids.js';
import { decodeAvatarDataUrl, deleteAvatar, writeAvatar, type DecodedAvatar } from './avatars.js';
import { hashPassword, verifyPassword } from './passwords.js';
import {
  appTokens,
  users,
  workspaceMembers,
  workspaces,
  type Locale,
  type UserPreferences,
  type UserRole,
  type UserStatus,
} from './schema.js';
import { serializeUser, type UserRow } from './serialize.js';
import {
  REFRESH_TOKEN_PREFIX,
  REFRESH_TOKEN_TTL_MS,
  generateOpaqueToken,
  hashToken,
  tokenPrefix,
} from './tokens.js';
import {
  DEFAULT_WORKSPACE_SLUG,
  canEnter,
  defaultWorkspace,
  findWorkspace,
  listWorkspacesFor,
} from './workspace.js';

export const BOOTSTRAP_USERNAME = 'admin';

export interface BootstrapResult {
  ownerCreated: boolean;
  workspaceCreated: boolean;
  setupRequired: boolean;
}

/** First boot (invariant 5): the `default` workspace and, given a password, the owner. */
export async function bootstrap(
  db: ModuleDb,
  bootstrapPassword: string | undefined,
  now: number,
): Promise<BootstrapResult> {
  const result: BootstrapResult = {
    ownerCreated: false,
    workspaceCreated: false,
    setupRequired: false,
  };
  const anyUser = db.select({ id: users.id }).from(users).limit(1).get();
  let ownerId = anyUser?.id;
  if (!anyUser) {
    if (!bootstrapPassword) {
      result.setupRequired = true;
    } else {
      ownerId = newUlid(now);
      db.insert(users)
        .values({
          id: ownerId,
          ownerId,
          username: BOOTSTRAP_USERNAME,
          displayName: 'Admin',
          role: 'owner',
          status: 'active',
          passwordHash: await hashPassword(bootstrapPassword),
          passwordChangedAt: new Date(now),
          locale: 'ar',
        })
        .run();
      result.ownerCreated = true;
    }
  }
  if (ownerId && !defaultWorkspace(db)) {
    db.insert(workspaces)
      .values({
        ownerId,
        slug: DEFAULT_WORKSPACE_SLUG,
        name: 'Default',
        isDefault: true,
        settings: {},
      })
      .run();
    result.workspaceCreated = true;
  }
  return result;
}

/**
 * No owner account: a fresh hub, or one whose owner `COREHUB_RESET_OWNER` just stepped down
 * (ADR 0019) — other accounts may exist, but nobody owns the hub until setup runs again.
 */
export function setupRequired(db: ModuleDb): boolean {
  return db.select({ id: users.id }).from(users).where(eq(users.role, 'owner')).get() === undefined;
}

export function findUser(db: ModuleDb, id: string): UserRow | null {
  return db.select().from(users).where(eq(users.id, id)).get() ?? null;
}

export function findUserByUsername(db: ModuleDb, username: string): UserRow | null {
  return db.select().from(users).where(eq(users.username, username)).get() ?? null;
}

export function ownerUser(db: ModuleDb): UserRow | null {
  return db.select().from(users).where(eq(users.role, 'owner')).get() ?? null;
}

/** Contract `User` for a row: profiles the user may enter and the default one. */
export function presentUser(db: ModuleDb, row: UserRow) {
  const enterable = listWorkspacesFor(db, { id: row.id, role: row.role });
  const profiles = enterable.map((w) => w.slug);
  const preferred = enterable.find((w) => w.id === row.defaultWorkspaceId);
  const defaultProfile = preferred?.slug ?? profiles[0] ?? DEFAULT_WORKSPACE_SLUG;
  return serializeUser(row, { profiles, defaultProfile });
}

// ---------------------------------------------------------------- sign-in sessions

export interface IssuedSession {
  sessionId: string;
  refreshToken: string;
  expiresAt: Date;
}

/** A `web` app_token row is the refresh token; the JWT's `sid` points at it. */
export function createSession(db: ModuleDb, user: UserRow, now: number, label: string) {
  const refreshToken = generateOpaqueToken(REFRESH_TOKEN_PREFIX);
  const row = db
    .insert(appTokens)
    .values({
      ownerId: user.id,
      userId: user.id,
      kind: 'web',
      name: label,
      tokenHash: hashToken(refreshToken),
      tokenPrefix: tokenPrefix(refreshToken),
      scopes: ['read', 'write', 'device', 'admin'],
      expiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
      lastUsedAt: new Date(now),
    })
    .returning()
    .get();
  return { sessionId: row.id, refreshToken, expiresAt: row.expiresAt! } satisfies IssuedSession;
}

/** Rotates the refresh token in place; null when it is unknown, revoked or expired. */
export function rotateSession(db: ModuleDb, refreshToken: string, now: number) {
  const row = db
    .select()
    .from(appTokens)
    .where(
      and(
        eq(appTokens.tokenHash, hashToken(refreshToken)),
        eq(appTokens.kind, 'web'),
        isNull(appTokens.revokedAt),
        gt(appTokens.expiresAt, new Date(now)),
      ),
    )
    .get();
  if (!row) return null;
  const next = generateOpaqueToken(REFRESH_TOKEN_PREFIX);
  db.update(appTokens)
    .set({
      tokenHash: hashToken(next),
      tokenPrefix: tokenPrefix(next),
      expiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
      lastUsedAt: new Date(now),
    })
    .where(eq(appTokens.id, row.id))
    .run();
  return { sessionId: row.id, userId: row.userId, refreshToken: next };
}

export function revokeToken(db: ModuleDb, tokenId: string, now: number): void {
  db.update(appTokens)
    .set({ revokedAt: new Date(now) })
    .where(and(eq(appTokens.id, tokenId), isNull(appTokens.revokedAt)))
    .run();
}

/** Revokes every web session of the user except `keepTokenId` (password change). */
export function revokeOtherSessions(
  db: ModuleDb,
  userId: string,
  keepTokenId: string | null,
  now: number,
): void {
  const where = keepTokenId
    ? and(
        eq(appTokens.userId, userId),
        eq(appTokens.kind, 'web'),
        isNull(appTokens.revokedAt),
        ne(appTokens.id, keepTokenId),
      )
    : and(eq(appTokens.userId, userId), eq(appTokens.kind, 'web'), isNull(appTokens.revokedAt));
  db.update(appTokens)
    .set({ revokedAt: new Date(now) })
    .where(where)
    .run();
}

export function touchLogin(db: ModuleDb, userId: string, now: number): void {
  db.update(users)
    .set({ lastLoginAt: new Date(now) })
    .where(eq(users.id, userId))
    .run();
}

// ---------------------------------------------------------------- memberships

/** Resolves slugs to workspace ids; unknown slugs are a validation error. */
export function resolveSlugs(db: ModuleDb, slugs: readonly string[]): string[] {
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const slug of slugs) {
    const row = findWorkspace(db, slug);
    if (row) ids.push(row.id);
    else unknown.push(slug);
  }
  if (unknown.length > 0) {
    throw new HubError('validation_failed', {
      messageKey: 'auth.profile_unknown',
      details: { profiles: unknown },
    });
  }
  return ids;
}

export function setMemberships(
  db: ModuleDb,
  user: Pick<UserRow, 'id'>,
  ownerId: string,
  workspaceIds: readonly string[],
): void {
  db.delete(workspaceMembers).where(eq(workspaceMembers.userId, user.id)).run();
  for (const workspace of workspaceIds) {
    db.insert(workspaceMembers).values({ ownerId, workspace, userId: user.id }).run();
  }
}

function resolveDefaultProfile(
  db: ModuleDb,
  user: Pick<UserRow, 'id' | 'role'>,
  slug: string,
): string {
  const row = findWorkspace(db, slug);
  if (!row || !canEnter(db, user, row.id)) {
    throw new HubError('validation_failed', {
      messageKey: 'auth.default_profile_outside',
      details: { profile: slug },
    });
  }
  return row.id;
}

// ---------------------------------------------------------------- admin management

export interface UserCreateInput {
  username: string;
  password: string;
  displayName?: string;
  role: Exclude<UserRole, 'owner'>;
  profiles?: string[];
  defaultProfile?: string;
  locale?: Locale;
}

export async function createUser(
  db: ModuleDb,
  actorId: string,
  input: UserCreateInput,
  now: number,
): Promise<UserRow> {
  // A member enters only what they are given, so a member is not created with nothing to
  // enter: the list is required and explicit (owner, 2026-09-24). Owners and admins enter
  // every workspace and need none.
  if (input.role === 'member' && (input.profiles ?? []).length === 0) {
    throw new HubError('validation_failed', {
      messageKey: 'auth.member_needs_profile',
      details: { field: 'profiles' },
    });
  }
  if (findUserByUsername(db, input.username)) {
    throw new HubError('conflict', { messageKey: 'auth.username_taken' });
  }
  const workspaceIds = resolveSlugs(db, input.profiles ?? []);
  const passwordHash = await hashPassword(input.password);
  return db.transaction((tx) => {
    const row = tx
      .insert(users)
      .values({
        ownerId: actorId,
        username: input.username,
        displayName: input.displayName ?? null,
        role: input.role,
        status: 'active',
        passwordHash,
        passwordChangedAt: new Date(now),
        locale: input.locale ?? 'ar',
      })
      .returning()
      .get();
    setMemberships(tx as ModuleDb, row, actorId, workspaceIds);
    if (input.defaultProfile) {
      const defaultWorkspaceId = resolveDefaultProfile(tx as ModuleDb, row, input.defaultProfile);
      tx.update(users).set({ defaultWorkspaceId }).where(eq(users.id, row.id)).run();
      row.defaultWorkspaceId = defaultWorkspaceId;
    }
    return row;
  });
}

export interface UserAdminPatchInput {
  displayName?: string;
  role?: Exclude<UserRole, 'owner'>;
  status?: UserStatus;
  profiles?: string[];
  defaultProfile?: string;
  password?: string;
}

export async function updateUserAsAdmin(
  db: ModuleDb,
  actorId: string,
  target: UserRow,
  input: UserAdminPatchInput,
  now: number,
  /** The caller's own token, kept when the owner sets their own password here. */
  keepTokenId: string | null = null,
): Promise<UserRow> {
  // The owner's role and status never change. Their password does — by the owner alone
  // (owner decision, 2026-09-23: «خل اقدر اعدل باسوورد اي احد حتى حسابي لاني انا سوبر ادمن»);
  // an admin still cannot touch the owner's account.
  const ownerSetsOwn = target.role === 'owner' && target.id === actorId;
  if (
    target.role === 'owner' &&
    (input.role || input.status || (input.password && !ownerSetsOwn))
  ) {
    throw new HubError('forbidden', { messageKey: 'auth.owner_immutable' });
  }
  if (target.id === actorId && input.status === 'disabled') {
    throw new HubError('forbidden', { messageKey: 'auth.self_immutable' });
  }
  // Making an admin a member decides, in the same request, what the member may enter: an
  // admin holds no list (they enter everything), so a bare `{ role: 'member' }` would leave
  // them with none — or, before 2026-09-24, with every profile implicitly.
  if (
    input.role === 'member' &&
    target.role !== 'member' &&
    (input.profiles === undefined || input.profiles.length === 0)
  ) {
    throw new HubError('validation_failed', {
      messageKey: 'auth.member_needs_profile',
      details: { field: 'profiles' },
    });
  }
  const workspaceIds = input.profiles ? resolveSlugs(db, input.profiles) : null;
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  return db.transaction((tx) => {
    const patch: Partial<typeof users.$inferInsert> = {};
    if (input.displayName !== undefined) patch.displayName = input.displayName;
    if (input.role !== undefined) patch.role = input.role;
    if (input.status !== undefined) patch.status = input.status;
    if (passwordHash) {
      patch.passwordHash = passwordHash;
      patch.passwordChangedAt = new Date(now);
    }
    if (workspaceIds) setMemberships(tx as ModuleDb, target, actorId, workspaceIds);
    if (input.defaultProfile !== undefined) {
      const role = input.role ?? target.role;
      patch.defaultWorkspaceId = resolveDefaultProfile(
        tx as ModuleDb,
        { id: target.id, role },
        input.defaultProfile,
      );
    }
    if (Object.keys(patch).length > 0) {
      tx.update(users).set(patch).where(eq(users.id, target.id)).run();
    }
    // Every other session of that person ends; the one making the change stays when it is
    // their own account, as on the Account page.
    if (passwordHash)
      revokeOtherSessions(
        tx as ModuleDb,
        target.id,
        target.id === actorId ? keepTokenId : null,
        now,
      );
    return tx.select().from(users).where(eq(users.id, target.id)).get()!;
  });
}

export function deleteUser(db: ModuleDb, actorId: string, target: UserRow): void {
  if (target.role === 'owner')
    throw new HubError('forbidden', { messageKey: 'auth.owner_immutable' });
  if (target.id === actorId) throw new HubError('forbidden', { messageKey: 'auth.self_immutable' });
  // app_tokens, workspace_members and pairing_codes cascade (schema.ts); avatar file is removed by the caller.
  db.delete(users).where(eq(users.id, target.id)).run();
}

export interface UserPage {
  items: UserRow[];
  nextCursor: string | null;
}

/** Cursor = the last id of the previous page (ULIDs sort by creation). */
export function listUsers(db: ModuleDb, cursor: string | undefined, limit: number): UserPage {
  const rows = db
    .select()
    .from(users)
    .where(cursor ? gt(users.id, cursor) : undefined)
    .orderBy(asc(users.id))
    .limit(limit + 1)
    .all();
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items[items.length - 1]!.id : null };
}

export function activeTokenIdsOf(db: ModuleDb, userId: string): string[] {
  return db
    .select({ id: appTokens.id })
    .from(appTokens)
    .where(and(eq(appTokens.userId, userId), isNull(appTokens.revokedAt)))
    .all()
    .map((row) => row.id);
}

// ---------------------------------------------------------------- self-service

export interface UserSelfPatchInput {
  displayName?: string;
  username?: string;
  currentPassword?: string;
  locale?: Locale;
  avatar?: { kind: 'image'; dataUrl: string } | { kind: 'generated' } | null;
  defaultProfile?: string;
}

export async function updateSelf(
  db: ModuleDb,
  dataDir: string,
  me: UserRow,
  input: UserSelfPatchInput,
): Promise<UserRow> {
  const patch: Partial<typeof users.$inferInsert> = {};
  if (input.username !== undefined && input.username !== me.username) {
    if (!input.currentPassword) {
      throw new HubError('validation_failed', { messageKey: 'auth.current_password_required' });
    }
    if (!(await verifyPassword(me.passwordHash, input.currentPassword))) {
      throw new HubError('unauthorized', { messageKey: 'auth.current_password_wrong' });
    }
    if (findUserByUsername(db, input.username)) {
      throw new HubError('conflict', { messageKey: 'auth.username_taken' });
    }
    patch.username = input.username;
  }
  if (input.displayName !== undefined) patch.displayName = input.displayName;
  if (input.locale !== undefined) patch.locale = input.locale;
  if (input.defaultProfile !== undefined) {
    patch.defaultWorkspaceId = resolveDefaultProfile(db, me, input.defaultProfile);
  }
  let avatar: DecodedAvatar | null | undefined;
  if (input.avatar !== undefined) {
    if (input.avatar && input.avatar.kind === 'image') {
      avatar = decodeAvatarDataUrl(input.avatar.dataUrl);
      patch.avatarMime = avatar.mime;
    } else {
      avatar = null;
      patch.avatarMime = null;
    }
  }
  if (Object.keys(patch).length > 0) {
    db.update(users).set(patch).where(eq(users.id, me.id)).run();
  }
  if (avatar) writeAvatar(dataDir, 'users', me.id, avatar);
  else if (avatar === null) deleteAvatar(dataDir, 'users', me.id);
  return findUser(db, me.id)!;
}

export async function changePassword(
  db: ModuleDb,
  me: UserRow,
  currentPassword: string,
  newPassword: string,
  keepTokenId: string,
  now: number,
): Promise<void> {
  if (!(await verifyPassword(me.passwordHash, currentPassword))) {
    throw new HubError('unauthorized', { messageKey: 'auth.current_password_wrong' });
  }
  const passwordHash = await hashPassword(newPassword);
  db.transaction((tx) => {
    tx.update(users)
      .set({ passwordHash, passwordChangedAt: new Date(now) })
      .where(eq(users.id, me.id))
      .run();
    revokeOtherSessions(tx as ModuleDb, me.id, keepTokenId, now);
  });
}

export function savePreferences(
  db: ModuleDb,
  me: UserRow,
  preferences: UserPreferences,
  locale: Locale,
): UserRow {
  db.update(users).set({ preferences, locale }).where(eq(users.id, me.id)).run();
  return findUser(db, me.id)!;
}

export function usersInWorkspaces(db: ModuleDb, workspaceIds: readonly string[]): string[] {
  if (workspaceIds.length === 0) return [];
  return db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(inArray(workspaceMembers.workspace, workspaceIds))
    .all()
    .map((row) => row.userId);
}
