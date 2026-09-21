// HTTP routes of the `auth` tag (packages/contracts/openapi.yaml). Thin: validate, call a
// service, serialize. Guards come from principal.ts; every route here is `x-scope: global`.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { isUlid } from '../../db/ids.js';
import { HubError } from '../../lib/errors.js';
import { REALTIME_NAMESPACES } from '../../lib/module.js';
import { parse } from '../../lib/validate.js';
import {
  CAPABILITY_KINDS,
  DEVICE_KINDS,
  DEVICE_PLATFORMS,
  revokeDeviceByToken,
  serializeDevice,
} from '../devices/index.js';
import { AuditService } from '../audit/index.js';
import { decodeAvatarDataUrl, deleteAvatar, readAvatar } from './avatars.js';
import type { AuthContext } from './context.js';
import {
  assertNotLocked,
  clearFailures,
  clearLockouts,
  listLockouts,
  recordFailure,
} from './lockouts.js';
import {
  PAIRING_DEFAULT_TTL_SECONDS,
  PAIRING_MAX_TTL_SECONDS,
  PAIRING_MIN_TTL_SECONDS,
  cancelPairing,
  claimPairing,
  createPairing,
  findPairing,
} from './pairing.js';
import { verifyPassword } from './passwords.js';
import { requireRole, requireUser, type Principal } from './principal.js';
import {
  createProfile,
  deleteProfile,
  patchProfileSettings,
  statsOf,
  updateProfile,
  type HubSettingsPatch,
} from './profiles.js';
import { APP_TOKEN_SCOPES, LOCALES, PAIRING_CONNECTIONS, appTokens, workspaces } from './schema.js';
import {
  hubSettingsOf,
  preferencesOf,
  serializeAppToken,
  serializeLockout,
  serializePairing,
  serializeProfile,
  serializeProfileSettings,
  type UserRow,
  type WorkspaceRow,
} from './serialize.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  APP_TOKEN_PREFIX,
  DEVICE_TOKEN_TTL_MS,
  generateOpaqueToken,
  hashToken,
  signAccessToken,
  tokenPrefix,
} from './tokens.js';
import {
  changePassword,
  createSession,
  createUser,
  deleteUser,
  findUser,
  findUserByUsername,
  listUsers,
  ownerUser,
  presentUser,
  revokeToken,
  rotateSession,
  savePreferences,
  setupRequired,
  touchLogin,
  updateSelf,
  updateUserAsAdmin,
} from './users.js';
import { canEnter, defaultWorkspace, findWorkspace, listWorkspacesFor } from './workspace.js';
import { emitToUser } from './sockets.js';

// ---------------------------------------------------------------- request schemas

const ProfileSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const Username = z.string().regex(/^[a-z0-9._-]{2,40}$/);
const Password = z.string().min(8).max(1024);
const Timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'ISO-8601 timestamp');
const Ulid = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const Locale = z.enum(LOCALES);
const AvatarInput = z.union([
  z.object({ kind: z.literal('image'), data_url: z.string().min(1) }),
  z.object({ kind: z.literal('generated'), seed: z.string().optional() }),
  z.null(),
]);

const LoginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
});
const RefreshBody = z.object({ refresh_token: z.string().min(1) });
const UserSelfPatch = z.object({
  display_name: z.string().max(80).optional(),
  username: Username.optional(),
  current_password: z.string().optional(),
  locale: Locale.optional(),
  avatar: AvatarInput.optional(),
  default_profile: ProfileSlug.optional(),
});
const PasswordChange = z.object({ current_password: z.string().min(1), new_password: Password });
const Preferences = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  locale: Locale,
  text_scale: z.number().min(0.85).max(1.45),
  link_target: z.enum(['in_app', 'browser']),
  busy_input_mode: z.enum(['queue', 'next', 'interrupt']),
  streaming: z.boolean(),
  compact: z.boolean(),
  show_reasoning: z.boolean(),
  show_tool_calls: z.boolean(),
  show_cost: z.boolean(),
  inline_diffs: z.boolean(),
  sound_on_complete: z.boolean(),
  notify_on_complete: z.boolean(),
  notify_on_approval: z.boolean(),
  reasoning_effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'max']).nullable(),
  voice: z.object({
    input_mode: z.enum(['device', 'server']),
    dictation_language: z.string().min(1).max(32),
    output_mode: z.enum(['device', 'server']),
    auto_speak: z.boolean(),
  }),
});
const UserCreate = z.object({
  username: Username,
  password: Password,
  display_name: z.string().max(80).optional(),
  role: z.enum(['admin', 'member']),
  profiles: z.array(ProfileSlug).optional(),
  default_profile: ProfileSlug.optional(),
  locale: Locale.optional(),
});
const UserAdminPatch = z.object({
  display_name: z.string().max(80).optional(),
  role: z.enum(['admin', 'member']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  profiles: z.array(ProfileSlug).optional(),
  default_profile: ProfileSlug.optional(),
  password: Password.optional(),
});
const ListQuery = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const AppTokenCreate = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.enum(APP_TOKEN_SCOPES)).min(1),
  expires_at: Timestamp.nullable().optional(),
});
const PairingCreate = z.object({
  connection: z.enum(PAIRING_CONNECTIONS).default('lan'),
  ttl_seconds: z
    .number()
    .int()
    .min(PAIRING_MIN_TTL_SECONDS)
    .max(PAIRING_MAX_TTL_SECONDS)
    .default(PAIRING_DEFAULT_TTL_SECONDS),
});
const PairingClaim = z.object({
  code: z.string().min(1).max(16),
  device: z.object({
    device_key: z.string().min(1).max(128),
    name: z.string().min(1).max(80),
    platform: z.enum(DEVICE_PLATFORMS),
    kind: z.enum(DEVICE_KINDS),
    brand: z.string().max(80).nullable().optional(),
    model: z.string().max(120).nullable().optional(),
    app_version: z.string().max(32).nullable().optional(),
    capabilities: z.array(z.enum(CAPABILITY_KINDS)).default([]),
  }),
});
const ModelRef = z.object({ provider_id: Ulid, model: z.string().min(1).max(200) });
const ProfileCreate = z.object({
  slug: ProfileSlug,
  name: z.string().min(1).max(80),
  clone_from: ProfileSlug.nullable().optional(),
});
const ProfilePatch = z.object({
  slug: ProfileSlug.optional(),
  name: z.string().min(1).max(80).optional(),
  avatar: AvatarInput.optional(),
  default_model: ModelRef.nullable().optional(),
});
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const ProfileSettingsPatch = z.object({
  proxy: z
    .object({
      https_proxy: z.string().max(512).nullable().optional(),
      http_proxy: z.string().max(512).nullable().optional(),
      all_proxy: z.string().max(512).nullable().optional(),
      no_proxy: z.string().max(512).nullable().optional(),
    })
    .optional(),
  compression: z
    .object({
      enabled: z.boolean().optional(),
      threshold: z.number().min(0).max(1).optional(),
      target_ratio: z.number().min(0).max(1).optional(),
      protect_first: z.number().int().min(0).optional(),
      protect_last: z.number().int().min(0).optional(),
    })
    .optional(),
  privacy: z.object({ redact_pii: z.boolean().optional() }).optional(),
  appearance: z
    .object({
      font_size: z.number().int().min(12).max(20).optional(),
      text_color: Hex.nullable().optional(),
      accent_color: Hex.nullable().optional(),
      background_attachment_id: Ulid.nullable().optional(),
    })
    .optional(),
});
const ProfileImport = z.object({ attachment_id: Ulid, slug: ProfileSlug });

// ---------------------------------------------------------------- helpers

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const noContent = async (reply: FastifyReply) => reply.code(204).send();

function principalOf(request: FastifyRequest): Principal {
  // Guards run first; this keeps handlers free of null checks.
  return request.principal!;
}

function param(request: FastifyRequest, name: string, resource: string): string {
  const value = (request.params as Record<string, string | undefined>)[name];
  if (!value || !isUlid(value))
    throw new HubError('not_found', { details: { resource, id: value } });
  return value;
}

function hubUrlOf(request: FastifyRequest): string {
  return `${request.protocol}://${request.host}`;
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AuthContext): void {
  const { db } = ctx;
  const now = () => ctx.now();

  const attributionId = (userId?: string | null) =>
    userId ?? ownerUser(db)?.id ?? '00000000000000000000000000';

  // The audit trail and the job queue belong to `audit` (docs/domain/audit.md).
  const ledger = new AuditService(db);

  const audit = (
    request: FastifyRequest,
    action: string,
    entity: { kind: string; id: string } | null,
    summary: string,
    data: Record<string, unknown> = {},
  ) => {
    const principal = request.principal;
    ledger.record(
      {
        actorKind: principal?.kind === 'app_token' && principal.deviceId ? 'device' : 'user',
        actorId: principal?.user.id ?? null,
        action,
        entityKind: entity?.kind ?? null,
        entityId: entity?.id ?? null,
        summary,
        data,
        deviceId: principal?.deviceId ?? null,
        requestId: request.id,
        ownerId: attributionId(principal?.user.id),
      },
      now(),
    );
  };

  const me = (request: FastifyRequest): UserRow => {
    const row = findUser(db, principalOf(request).user.id);
    if (!row) throw new HubError('unauthorized', { messageKey: 'auth.token_revoked' });
    return row;
  };

  const tokenPair = async (user: UserRow, sessionId: string, refreshToken: string | null) => ({
    access_token: await signAccessToken(
      ctx.key,
      { userId: user.id, role: user.role, sessionId },
      now(),
    ),
    refresh_token: refreshToken,
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    user: presentUser(db, user),
  });

  const serverMeta = () => ({
    name: 'Majlis',
    server_version: ctx.version,
    contract_version: ctx.contractVersion,
    api_versions: ['v1'],
    realtime_namespaces: ctx.namespaces(),
    locales: ['ar', 'en'],
    setup_required: setupRequired(db),
  });

  /** A workspace the caller may see, by id; 404 `profile_not_found` otherwise. */
  const workspaceFor = (request: FastifyRequest): WorkspaceRow => {
    const id = param(request, 'profile_id', 'profile');
    const row = db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, id), isNull(workspaces.archivedAt)))
      .get();
    if (!row || !canEnter(db, principalOf(request).user, row.id)) {
      throw new HubError('profile_not_found', { details: { profile: id } });
    }
    return row;
  };

  const userFor = (request: FastifyRequest): UserRow => {
    const id = param(request, 'user_id', 'user');
    const row = findUser(db, id);
    if (!row)
      throw new HubError('not_found', {
        messageKey: 'auth.user_not_found',
        details: { resource: 'user', id },
      });
    return row;
  };

  const revokeAppTokenRow = (request: FastifyRequest, tokenId: string, action: string) => {
    revokeToken(db, tokenId, now());
    const device = revokeDeviceByToken(db, tokenId, now());
    if (device) {
      // Logout keeps the device row (revoked, visible in the list); revoking a token unlinks it.
      const [event, payload] =
        action === 'auth.logout'
          ? [
              'device.updated',
              { device: serializeDevice(device, { online: false, thisDevice: false }) },
            ]
          : ['device.unlinked', { device_id: device.id }];
      emitToUser(ctx.io(), device.ownerId, REALTIME_NAMESPACES.devices, event, payload, now());
    }
    audit(request, action, { kind: 'app_token', id: tokenId }, 'token revoked', {
      device_id: device?.id ?? null,
    });
  };

  const route = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    guards: Guard[],
    handler: Handler,
  ) => app.route({ method, url, preHandler: guards, handler });

  const admin = [requireUser, requireRole('admin')];
  const signedIn = [requireUser];

  // ---------------------------------------------------------------- sign-in

  route('POST', '/auth/login', [], async (request) => {
    const body = parse(LoginBody, request.body);
    const ip = request.ip;
    assertNotLocked(db, 'password', ip, now());
    if (setupRequired(db))
      throw new HubError('unauthorized', { messageKey: 'auth.setup_required' });
    const user = findUserByUsername(db, body.username);
    const ok = user ? await verifyPassword(user.passwordHash, body.password) : false;
    if (!user || !ok) {
      const locked = recordFailure(db, 'password', ip, now(), attributionId(user?.id));
      ledger.record(
        {
          actorKind: 'system',
          action: 'auth.login_failed',
          entityKind: user ? 'user' : null,
          entityId: user?.id ?? null,
          summary: locked ? 'login failed; ip locked' : 'login failed',
          data: { username: body.username, locked },
          requestId: request.id,
          ownerId: attributionId(user?.id),
        },
        now(),
      );
      throw new HubError('unauthorized', { messageKey: 'auth.invalid_credentials' });
    }
    if (user.status !== 'active')
      throw new HubError('unauthorized', { messageKey: 'auth.user_disabled' });
    clearFailures(db, 'password', ip);
    touchLogin(db, user.id, now());
    const agent = String(request.headers['user-agent'] ?? 'web').slice(0, 80);
    const session = createSession(db, user, now(), `web · ${agent}`);
    ledger.record(
      {
        actorKind: 'user',
        actorId: user.id,
        action: 'auth.login',
        entityKind: 'user',
        entityId: user.id,
        summary: 'signed in',
        data: { session_id: session.sessionId },
        requestId: request.id,
        ownerId: user.id,
      },
      now(),
    );
    return tokenPair(findUser(db, user.id)!, session.sessionId, session.refreshToken);
  });

  route('POST', '/auth/refresh', [], async (request) => {
    const body = request.body;
    if (body && typeof body === 'object' && 'refresh_token' in body) {
      const { refresh_token } = parse(RefreshBody, body);
      const rotated = rotateSession(db, refresh_token, now());
      const user = rotated ? findUser(db, rotated.userId) : null;
      if (!rotated || !user)
        throw new HubError('unauthorized', { messageKey: 'auth.refresh_invalid' });
      if (user.status !== 'active')
        throw new HubError('unauthorized', { messageKey: 'auth.user_disabled' });
      return tokenPair(user, rotated.sessionId, rotated.refreshToken);
    }
    const principal = request.principal;
    if (!principal)
      throw (
        request.authError ??
        new HubError('validation_failed', { messageKey: 'auth.refresh_body_required' })
      );
    if (principal.kind !== 'app_token') {
      throw new HubError('validation_failed', { messageKey: 'auth.refresh_body_required' });
    }
    if (principal.tokenKind === 'device') {
      db.update(appTokens)
        .set({ expiresAt: new Date(now() + DEVICE_TOKEN_TTL_MS) })
        .where(eq(appTokens.id, principal.tokenId))
        .run();
    }
    return tokenPair(me(request), principal.tokenId, null);
  });

  route('POST', '/auth/logout', signedIn, async (request, reply) => {
    revokeAppTokenRow(request, principalOf(request).tokenId, 'auth.logout');
    return noContent(reply);
  });

  // ---------------------------------------------------------------- me

  route('GET', '/auth/me', signedIn, async (request) => presentUser(db, me(request)));

  route('PATCH', '/auth/me', signedIn, async (request) => {
    const body = parse(UserSelfPatch, request.body);
    const updated = await updateSelf(db, ctx.dataDir, me(request), {
      ...(body.display_name !== undefined ? { displayName: body.display_name } : {}),
      ...(body.username !== undefined ? { username: body.username } : {}),
      ...(body.current_password !== undefined ? { currentPassword: body.current_password } : {}),
      ...(body.locale !== undefined ? { locale: body.locale } : {}),
      ...(body.default_profile !== undefined ? { defaultProfile: body.default_profile } : {}),
      ...(body.avatar !== undefined
        ? {
            avatar:
              body.avatar === null
                ? null
                : body.avatar.kind === 'image'
                  ? { kind: 'image' as const, dataUrl: body.avatar.data_url }
                  : { kind: 'generated' as const },
          }
        : {}),
    });
    audit(request, 'auth.user_updated', { kind: 'user', id: updated.id }, 'profile updated', {
      fields: Object.keys(body),
    });
    return presentUser(db, updated);
  });

  route('POST', '/auth/me/password', signedIn, async (request, reply) => {
    const body = parse(PasswordChange, request.body);
    const user = me(request);
    await changePassword(
      db,
      user,
      body.current_password,
      body.new_password,
      principalOf(request).tokenId,
      now(),
    );
    audit(request, 'auth.password_changed', { kind: 'user', id: user.id }, 'password changed');
    return noContent(reply);
  });

  route('GET', '/auth/me/preferences', signedIn, async (request) => preferencesOf(me(request)));

  route('PUT', '/auth/me/preferences', signedIn, async (request) => {
    const body = parse(Preferences, request.body);
    return preferencesOf(savePreferences(db, me(request), body, body.locale));
  });

  // ---------------------------------------------------------------- users (admin)

  route('GET', '/auth/users', admin, async (request) => {
    const query = parse(ListQuery, request.query ?? {}, 'query');
    const page = listUsers(db, query.cursor, query.limit);
    return { items: page.items.map((row) => presentUser(db, row)), next_cursor: page.nextCursor };
  });

  route('POST', '/auth/users', admin, async (request, reply) => {
    const body = parse(UserCreate, request.body);
    const row = await createUser(
      db,
      principalOf(request).user.id,
      {
        username: body.username,
        password: body.password,
        role: body.role,
        ...(body.display_name !== undefined ? { displayName: body.display_name } : {}),
        ...(body.profiles !== undefined ? { profiles: body.profiles } : {}),
        ...(body.default_profile !== undefined ? { defaultProfile: body.default_profile } : {}),
        ...(body.locale !== undefined ? { locale: body.locale } : {}),
      },
      now(),
    );
    audit(
      request,
      'auth.user_created',
      { kind: 'user', id: row.id },
      `user ${row.username} created`,
      {
        role: row.role,
      },
    );
    return reply.code(201).send(presentUser(db, row));
  });

  route('GET', '/auth/users/:user_id', admin, async (request) => presentUser(db, userFor(request)));

  route('PATCH', '/auth/users/:user_id', admin, async (request) => {
    const body = parse(UserAdminPatch, request.body);
    const target = userFor(request);
    const updated = await updateUserAsAdmin(
      db,
      principalOf(request).user.id,
      target,
      {
        ...(body.display_name !== undefined ? { displayName: body.display_name } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.profiles !== undefined ? { profiles: body.profiles } : {}),
        ...(body.default_profile !== undefined ? { defaultProfile: body.default_profile } : {}),
        ...(body.password !== undefined ? { password: body.password } : {}),
      },
      now(),
    );
    audit(
      request,
      'auth.user_updated',
      { kind: 'user', id: updated.id },
      `user ${updated.username} updated`,
      {
        fields: Object.keys(body).filter((key) => key !== 'password'),
        password_reset: body.password !== undefined,
      },
    );
    return presentUser(db, updated);
  });

  route('DELETE', '/auth/users/:user_id', admin, async (request, reply) => {
    const target = userFor(request);
    const deviceTokens = db
      .select({ id: appTokens.id })
      .from(appTokens)
      .where(
        and(
          eq(appTokens.userId, target.id),
          eq(appTokens.kind, 'device'),
          isNull(appTokens.revokedAt),
        ),
      )
      .all();
    for (const token of deviceTokens) revokeDeviceByToken(db, token.id, now());
    deleteUser(db, principalOf(request).user.id, target);
    deleteAvatar(ctx.dataDir, 'users', target.id);
    audit(
      request,
      'auth.user_deleted',
      { kind: 'user', id: target.id },
      `user ${target.username} deleted`,
      {
        devices_revoked: deviceTokens.length,
      },
    );
    return noContent(reply);
  });

  route('GET', '/auth/users/:user_id/avatar', signedIn, async (request, reply) => {
    const user = userFor(request);
    const bytes = user.avatarMime ? readAvatar(ctx.dataDir, 'users', user.id) : null;
    if (!user.avatarMime || !bytes)
      throw new HubError('not_found', { messageKey: 'auth.avatar_none' });
    return reply.type(user.avatarMime).send(bytes);
  });

  // ---------------------------------------------------------------- lockouts (admin)

  route('GET', '/auth/lockouts', admin, async () => ({
    items: listLockouts(db, now()).map(serializeLockout),
  }));

  route('DELETE', '/auth/lockouts', admin, async (request) => {
    const ip = (request.query as { ip?: string } | undefined)?.ip?.trim() || undefined;
    return { cleared: clearLockouts(db, now(), ip) };
  });

  // ---------------------------------------------------------------- app tokens

  route('GET', '/auth/app-tokens', signedIn, async (request) => ({
    items: db
      .select()
      .from(appTokens)
      .where(
        and(
          eq(appTokens.userId, principalOf(request).user.id),
          inArray(appTokens.kind, ['personal', 'device']),
          isNull(appTokens.revokedAt),
        ),
      )
      .orderBy(desc(appTokens.createdAt), desc(appTokens.id))
      .limit(100)
      .all()
      .map(serializeAppToken),
  }));

  route('POST', '/auth/app-tokens', signedIn, async (request, reply) => {
    const body = parse(AppTokenCreate, request.body);
    const user = me(request);
    const token = generateOpaqueToken(APP_TOKEN_PREFIX);
    const row = db
      .insert(appTokens)
      .values({
        ownerId: user.id,
        userId: user.id,
        kind: 'personal',
        name: body.name,
        tokenHash: hashToken(token),
        tokenPrefix: tokenPrefix(token),
        scopes: body.scopes,
        expiresAt: body.expires_at ? new Date(body.expires_at) : null,
      })
      .returning()
      .get();
    audit(
      request,
      'auth.token_created',
      { kind: 'app_token', id: row.id },
      `app token ${row.name} created`,
      {
        scopes: row.scopes,
      },
    );
    return reply.code(201).send({ ...serializeAppToken(row), token });
  });

  route('DELETE', '/auth/app-tokens/:token_id', signedIn, async (request, reply) => {
    const id = param(request, 'token_id', 'app_token');
    const row = db
      .select()
      .from(appTokens)
      .where(
        and(
          eq(appTokens.id, id),
          eq(appTokens.userId, principalOf(request).user.id),
          isNull(appTokens.revokedAt),
        ),
      )
      .get();
    if (!row || row.kind === 'web')
      throw new HubError('not_found', { messageKey: 'auth.token_not_found' });
    revokeAppTokenRow(request, row.id, 'auth.token_revoked');
    return noContent(reply);
  });

  // ---------------------------------------------------------------- pairing

  route('POST', '/auth/pairings', signedIn, async (request, reply) => {
    const body = parse(PairingCreate, request.body ?? {});
    const user = me(request);
    const row = createPairing(
      db,
      {
        userId: user.id,
        connection: body.connection,
        ttlSeconds: body.ttl_seconds,
        hubUrl: hubUrlOf(request),
        initialWorkspaceId: user.defaultWorkspaceId ?? defaultWorkspace(db)?.id ?? null,
      },
      now(),
    );
    audit(request, 'auth.pairing_created', { kind: 'pairing', id: row.id }, 'pairing started', {
      connection: row.connection,
    });
    return reply.code(201).send(serializePairing(row, now()));
  });

  const pairingFor = (request: FastifyRequest) => {
    const id = param(request, 'pairing_id', 'pairing');
    const row = findPairing(db, id);
    const principal = principalOf(request);
    if (!row || (row.createdByUserId !== principal.user.id && principal.user.role === 'member')) {
      throw new HubError('not_found', {
        messageKey: 'auth.pairing_not_found',
        details: { resource: 'pairing', id },
      });
    }
    return row;
  };

  route('GET', '/auth/pairings/:pairing_id', signedIn, async (request) =>
    serializePairing(pairingFor(request), now()),
  );

  route('DELETE', '/auth/pairings/:pairing_id', signedIn, async (request, reply) => {
    cancelPairing(db, pairingFor(request), now());
    return noContent(reply);
  });

  route('POST', '/auth/pairings/:pairing_id/claim', [], async (request, reply) => {
    const body = parse(PairingClaim, request.body);
    const pairingId = param(request, 'pairing_id', 'pairing');
    const result = claimPairing(
      db,
      {
        pairingId,
        code: body.code,
        ip: request.ip,
        device: {
          deviceKey: body.device.device_key,
          name: body.device.name,
          platform: body.device.platform,
          kind: body.device.kind,
          brand: body.device.brand ?? null,
          model: body.device.model ?? null,
          appVersion: body.device.app_version ?? null,
          capabilities: body.device.capabilities,
          connection: findPairing(db, pairingId)?.connection ?? 'lan',
        },
      },
      now(),
    );
    const device = serializeDevice(result.device, { online: false, thisDevice: false });
    emitToUser(
      ctx.io(),
      result.user.id,
      REALTIME_NAMESPACES.devices,
      'pairing.claimed',
      {
        pairing: serializePairing(result.pairing, now()),
        device,
      },
      now(),
    );
    emitToUser(
      ctx.io(),
      result.user.id,
      REALTIME_NAMESPACES.devices,
      'device.linked',
      { device },
      now(),
    );
    ledger.record(
      {
        actorKind: 'device',
        actorId: result.user.id,
        action: 'auth.pairing_claimed',
        entityKind: 'device',
        entityId: result.device.id,
        summary: `device ${result.device.name} paired`,
        data: {
          pairing_id: result.pairing.id,
          token_id: result.tokenId,
          platform: result.device.platform,
        },
        deviceId: result.device.id,
        requestId: request.id,
        ownerId: result.user.id,
      },
      now(),
    );
    return reply.code(201).send({
      app_token: result.token,
      token_id: result.tokenId,
      expires_at: result.expiresAt.toISOString(),
      device: serializeDevice(result.device, { online: false, thisDevice: true }),
      user: presentUser(db, result.user),
      server: serverMeta(),
    });
  });

  // ---------------------------------------------------------------- profiles (workspaces)

  const profileView = (row: WorkspaceRow) => serializeProfile(row, statsOf(row.id));

  route('GET', '/profiles', signedIn, async (request) => ({
    items: listWorkspacesFor(db, principalOf(request).user).map(profileView),
  }));

  route('POST', '/profiles', admin, async (request, reply) => {
    const body = parse(ProfileCreate, request.body);
    const row = createProfile(db, principalOf(request).user.id, {
      slug: body.slug,
      name: body.name,
      cloneFrom: body.clone_from ?? null,
    });
    audit(
      request,
      'auth.profile_created',
      { kind: 'profile', id: row.id },
      `workspace ${row.slug} created`,
      {
        clone_from: body.clone_from ?? null,
      },
    );
    return reply.code(201).send(profileView(row));
  });

  route('GET', '/profiles/:profile_id', signedIn, async (request) =>
    profileView(workspaceFor(request)),
  );

  route('PATCH', '/profiles/:profile_id', admin, async (request) => {
    const body = parse(ProfilePatch, request.body);
    const row = workspaceFor(request);
    const updated = updateProfile(db, ctx.dataDir, row, {
      ...(body.slug !== undefined ? { slug: body.slug } : {}),
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.default_model !== undefined
        ? {
            defaultModel: body.default_model
              ? { providerId: body.default_model.provider_id, model: body.default_model.model }
              : null,
          }
        : {}),
      ...(body.avatar !== undefined
        ? {
            avatar:
              body.avatar === null
                ? null
                : body.avatar.kind === 'image'
                  ? { kind: 'image' as const, avatar: decodeAvatarDataUrl(body.avatar.data_url) }
                  : { kind: 'generated' as const },
          }
        : {}),
    });
    audit(
      request,
      'auth.profile_updated',
      { kind: 'profile', id: row.id },
      `workspace ${updated.slug} updated`,
      {
        fields: Object.keys(body),
      },
    );
    return profileView(updated);
  });

  route('DELETE', '/profiles/:profile_id', admin, async (request, reply) => {
    const row = workspaceFor(request);
    deleteProfile(db, row, now());
    audit(
      request,
      'auth.profile_deleted',
      { kind: 'profile', id: row.id },
      `workspace ${row.slug} archived`,
    );
    return noContent(reply);
  });

  route('GET', '/profiles/:profile_id/settings', signedIn, async (request) =>
    serializeProfileSettings(hubSettingsOf(workspaceFor(request))),
  );

  route('PATCH', '/profiles/:profile_id/settings', admin, async (request) => {
    const body = parse(ProfileSettingsPatch, request.body);
    const row = workspaceFor(request);
    const patch: HubSettingsPatch = {};
    if (body.proxy) {
      patch.proxy = {
        ...(body.proxy.https_proxy !== undefined ? { httpsProxy: body.proxy.https_proxy } : {}),
        ...(body.proxy.http_proxy !== undefined ? { httpProxy: body.proxy.http_proxy } : {}),
        ...(body.proxy.all_proxy !== undefined ? { allProxy: body.proxy.all_proxy } : {}),
        ...(body.proxy.no_proxy !== undefined ? { noProxy: body.proxy.no_proxy } : {}),
      };
    }
    if (body.compression) {
      patch.compression = {
        ...(body.compression.enabled !== undefined ? { enabled: body.compression.enabled } : {}),
        ...(body.compression.threshold !== undefined
          ? { threshold: body.compression.threshold }
          : {}),
        ...(body.compression.target_ratio !== undefined
          ? { targetRatio: body.compression.target_ratio }
          : {}),
        ...(body.compression.protect_first !== undefined
          ? { protectFirst: body.compression.protect_first }
          : {}),
        ...(body.compression.protect_last !== undefined
          ? { protectLast: body.compression.protect_last }
          : {}),
      };
    }
    if (body.privacy?.redact_pii !== undefined)
      patch.privacy = { redactPii: body.privacy.redact_pii };
    if (body.appearance) {
      patch.appearance = {
        ...(body.appearance.font_size !== undefined ? { fontSize: body.appearance.font_size } : {}),
        ...(body.appearance.text_color !== undefined
          ? { textColor: body.appearance.text_color }
          : {}),
        ...(body.appearance.accent_color !== undefined
          ? { accentColor: body.appearance.accent_color }
          : {}),
        ...(body.appearance.background_attachment_id !== undefined
          ? { backgroundAttachmentId: body.appearance.background_attachment_id }
          : {}),
      };
    }
    const { settings } = patchProfileSettings(db, row, patch);
    audit(
      request,
      'auth.profile_settings_updated',
      { kind: 'profile', id: row.id },
      `workspace ${row.slug} settings updated`,
      {
        sections: Object.keys(body),
      },
    );
    // No agent runtime exists to restart yet; the agents module fills this once it owns runtimes.
    return { settings: serializeProfileSettings(settings), restart_job_id: null };
  });

  route('POST', '/profiles/:profile_id/export', admin, async (request, reply) => {
    const row = workspaceFor(request);
    const jobId = ledger.createJob({
      ownerId: principalOf(request).user.id,
      workspace: row.id,
      kind: 'auth.profile_export',
      entityKind: 'profile',
      entityId: row.id,
      input: { slug: row.slug },
    });
    return reply.code(202).send({ job_id: jobId });
  });

  route('POST', '/profile-imports', admin, async (request, reply) => {
    const body = parse(ProfileImport, request.body);
    if (findWorkspace(db, body.slug))
      throw new HubError('conflict', { messageKey: 'auth.slug_taken' });
    const jobId = ledger.createJob({
      ownerId: principalOf(request).user.id,
      workspace: null,
      kind: 'auth.profile_import',
      entityKind: 'attachment',
      entityId: body.attachment_id,
      input: { attachment_id: body.attachment_id, slug: body.slug },
    });
    return reply.code(202).send({ job_id: jobId });
  });
}
