// The unified principal: who is calling, backed by which `app_tokens` row, with which scopes.
// One non-throwing `onRequest` hook resolves the bearer (JWT or `hub_at_…`) into
// `request.principal`; the exported guards enforce it per route, so public routes stay public
// and a stale token on a public route is not an error.
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HubError } from '../../lib/errors.js';
import type { AuthContext } from './context.js';
import { assertNotLocked, clearFailures, recordFailure } from './lockouts.js';
import {
  APP_TOKEN_SCOPES,
  appTokens,
  users,
  type AppTokenKind,
  type AppTokenScope,
  type Locale,
  type UserRole,
  type UserStatus,
} from './schema.js';
import { isRunToken, runGrantOf } from './run-tokens.js';
import { hashToken, isAppToken, verifyAccessToken } from './tokens.js';
import { canEnter, type WorkspaceScope } from './workspace.js';

export type PrincipalKind = 'user' | 'app_token';

export interface PrincipalUser {
  id: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  locale: Locale;
  /**
   * Set only for a run token (`run-tokens.ts`): the one workspace this principal may enter.
   * `canEnter` and `listWorkspacesFor` refuse every other, whatever the role says.
   */
  pinnedWorkspaceId?: string;
}

export interface Principal {
  /** `user`: a person signed in with a JWT. `app_token`: a paired device or an integration. */
  kind: PrincipalKind;
  user: PrincipalUser;
  /** The `app_tokens` row behind this request (the web session for a JWT). */
  tokenId: string;
  tokenKind: AppTokenKind;
  deviceId: string | null;
  scopes: readonly AppTokenScope[];
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth module's hook; `null` when no valid bearer was presented. */
    principal: Principal | null;
    /** Why `principal` is null although a bearer was presented (expired, revoked, unknown). */
    authError: HubError | null;
    /** Set by `requireWorkspace` from `X-Hub-Profile` (ADR 0005). */
    workspace: WorkspaceScope | null;
  }
}

const LAST_USED_WRITE_INTERVAL_MS = 60_000;

/** Resolves a bearer string into a principal or throws the reason. Shared by HTTP and sockets. */
export async function resolvePrincipal(
  ctx: AuthContext,
  bearer: string,
  ip: string,
): Promise<Principal> {
  const now = ctx.now();
  const db = ctx.db;
  if (isRunToken(bearer)) {
    // An agent acting for the person whose run it is (contract decision §67): that person,
    // in that run's profile only, and never with more than a member's reach.
    const grant = runGrantOf(bearer, now);
    if (!grant) throw new HubError('unauthorized', { messageKey: 'auth.token_invalid' });
    const person = loadActiveUser(ctx, grant.userId);
    if (!canEnter(db, person, grant.workspaceId)) {
      throw new HubError('unauthorized', { messageKey: 'auth.token_revoked' });
    }
    return {
      kind: 'app_token',
      user: { ...person, role: 'member', pinnedWorkspaceId: grant.workspaceId },
      tokenId: grant.runId,
      tokenKind: 'personal',
      deviceId: null,
      scopes: ['read', 'write'],
    };
  }
  if (isAppToken(bearer)) {
    assertNotLocked(db, 'token', ip, now);
    const row = db
      .select()
      .from(appTokens)
      .where(and(eq(appTokens.tokenHash, hashToken(bearer)), isNull(appTokens.revokedAt)))
      .get();
    if (!row || row.kind === 'web' || (row.expiresAt && row.expiresAt.getTime() <= now)) {
      recordFailure(db, 'token', ip, now, row?.userId ?? SYSTEM_OWNER_FALLBACK);
      throw new HubError(row ? 'token_expired' : 'unauthorized', {
        messageKey: row ? 'errors.token_expired' : 'auth.token_invalid',
      });
    }
    const user = loadActiveUser(ctx, row.userId);
    clearFailures(db, 'token', ip);
    if (!row.lastUsedAt || row.lastUsedAt.getTime() + LAST_USED_WRITE_INTERVAL_MS < now) {
      db.update(appTokens)
        .set({ lastUsedAt: new Date(now) })
        .where(eq(appTokens.id, row.id))
        .run();
    }
    return {
      kind: 'app_token',
      user,
      tokenId: row.id,
      tokenKind: row.kind,
      deviceId: row.deviceId ?? null,
      scopes: row.kind === 'device' ? ['read', 'write', 'device'] : row.scopes,
    };
  }

  const claims = await verifyAccessToken(ctx.key, bearer, now);
  const session = db
    .select()
    .from(appTokens)
    .where(and(eq(appTokens.id, claims.sid), isNull(appTokens.revokedAt)))
    .get();
  if (!session || session.userId !== claims.sub) {
    throw new HubError('unauthorized', { messageKey: 'auth.token_revoked' });
  }
  const user = loadActiveUser(ctx, claims.sub);
  return {
    kind: 'user',
    user,
    tokenId: session.id,
    tokenKind: session.kind,
    deviceId: session.deviceId ?? null,
    scopes: APP_TOKEN_SCOPES,
  };
}

/** Used only to attribute a lockout row when the token matched no user. */
const SYSTEM_OWNER_FALLBACK = '00000000000000000000000000';

function loadActiveUser(ctx: AuthContext, userId: string): PrincipalUser {
  const user = ctx.db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw new HubError('unauthorized', { messageKey: 'auth.token_revoked' });
  if (user.status !== 'active') {
    throw new HubError('unauthorized', { messageKey: 'auth.user_disabled' });
  }
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    locale: user.locale,
  };
}

export function bearerOf(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() || null;
}

/** The `onRequest` hook: never throws; records the failure reason for the guards. */
export function authenticateHook(ctx: AuthContext) {
  return async (request: FastifyRequest): Promise<void> => {
    request.principal = null;
    request.authError = null;
    const bearer = bearerOf(request.headers.authorization);
    if (!bearer) return;
    try {
      request.principal = await resolvePrincipal(ctx, bearer, request.ip);
    } catch (error) {
      request.authError =
        error instanceof HubError
          ? error
          : new HubError('unauthorized', { messageKey: 'auth.token_invalid' });
    }
  };
}

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** A signed-in person or a valid app token. */
export const requireUser: Guard = async (request) => {
  if (request.principal) return;
  throw request.authError ?? new HubError('unauthorized');
};

/** `admin` is satisfied by owner and admin; `owner` by the owner only. */
export function requireRole(role: 'owner' | 'admin'): Guard {
  return async (request, reply) => {
    await requireUser(request, reply);
    const actual = request.principal!.user.role;
    const ok = role === 'owner' ? actual === 'owner' : actual === 'owner' || actual === 'admin';
    if (!ok) {
      throw new HubError('forbidden', {
        messageKey: role === 'owner' ? 'auth.owner_only' : 'auth.admin_only',
        details: { required_role: role },
      });
    }
  };
}

/** Only a `hub_at_…` bearer (paired device or integration), never a web session. */
export const requireAppToken: Guard = async (request, reply) => {
  await requireUser(request, reply);
  if (request.principal!.kind !== 'app_token') {
    throw new HubError('forbidden', { messageKey: 'auth.app_token_required' });
  }
};

/** JWT sessions hold every scope; app tokens must list the scope (`admin` implies all). */
export function requireScope(scope: AppTokenScope): Guard {
  return async (request, reply) => {
    await requireUser(request, reply);
    const scopes = request.principal!.scopes;
    if (scopes.includes(scope) || scopes.includes('admin')) return;
    throw new HubError('forbidden', {
      messageKey: 'auth.scope_insufficient',
      details: { required_scope: scope },
    });
  };
}
