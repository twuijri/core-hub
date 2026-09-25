// Module `auth`: owns users, roles (owner, admin, member), passwords, app tokens, device pairing (QR),
// workspaces (profiles) and per-user preferences.
// Public surface of the module: other modules and app/ import this file only. See README.md.
import type { Server as SocketServer } from 'socket.io';
import { loadOpenApiDocument } from '@corehub/contracts';
import { requireSqlite } from '../../lib/db.js';
import { defineModule } from '../../lib/module.js';
import type { AuthContext } from './context.js';
import { authenticateHook } from './principal.js';
import { registerAuthRoutes } from './routes.js';
import {
  clearSetupToken,
  issueSetupToken,
  ownerResetLog,
  resetOwnerOnBoot,
  setupMeta,
  setupTokenLog,
  setupWindowUntil,
  type SetupMeta,
} from './setup.js';
import { registerSocketAuth } from './sockets.js';
import { loadOrCreateSigningKey } from './tokens.js';
import { bootstrap, setupRequired } from './users.js';

/** One context per Socket.IO server, so several hubs in one process (tests) do not mix. */
const contexts = new WeakMap<SocketServer, AuthContext>();

export const authModule = defineModule({
  name: 'auth',
  async registerRoutes(app) {
    const { hub } = app;
    const db = requireSqlite(hub.database);
    const ctx: AuthContext = {
      db,
      dataDir: hub.config.dataDir,
      key: loadOrCreateSigningKey(hub.config.dataDir),
      log: app.log,
      io: () => hub.io,
      version: hub.version,
      contractVersion: loadOpenApiDocument()?.info.version ?? '0.0.0',
      namespaces: () => hub.namespaces,
      now: () => Date.now(),
      setupOpenUntil: null,
    };
    contexts.set(hub.io, ctx);

    const boot = await bootstrap(db, hub.config.bootstrapAdminPassword, ctx.now());
    if (boot.ownerCreated) app.log.info('auth: owner account created from HUB_ADMIN_PASSWORD');
    if (boot.workspaceCreated) app.log.info('auth: default workspace created');
    // Recovery (ADR 0019): runs before "does the hub need an owner?" is asked, so a reset
    // reopens setup on this very boot.
    const reset = resetOwnerOnBoot(db, hub.config.dataDir, hub.config.resetOwner, ctx.now());
    const resetMessage = ownerResetLog(reset);
    if (resetMessage) app.log.warn(resetMessage);
    if (setupRequired(db)) {
      // No owner: setup is open to the first comer for a window after this boot, and needs
      // the claim token after it (ADR 0011, 0019). A fresh token on every boot; the old one
      // stops working.
      ctx.setupOpenUntil = setupWindowUntil(ctx.now(), hub.config.setupOpenMinutes);
      const token = issueSetupToken(hub.config.dataDir);
      app.log.info(setupTokenLog(hub.config.dataDir, token, ctx.setupOpenUntil));
    } else {
      // The owner exists: nothing may still be claimable on disk.
      clearSetupToken(hub.config.dataDir);
    }

    app.decorateRequest('principal', null);
    app.decorateRequest('authError', null);
    app.decorateRequest('workspace', null);
    app.addHook('onRequest', authenticateHook(ctx));
    registerAuthRoutes(app, ctx);
  },
  registerEvents(io) {
    // Namespaces exist already (app/sockets.ts); auth adds the token middleware to each.
    registerSocketAuth(io, () => contexts.get(io) ?? null);
  },
});

export const registerRoutes = authModule.registerRoutes.bind(authModule);

/**
 * First-run fields of `meta.get` (ADR 0019) for the hub on this Socket.IO server; `null` when
 * auth is not composed into it. The app forwards them, so `/meta` needs no idea what an owner is.
 */
export function setupMetaFor(io: SocketServer): SetupMeta | null {
  const ctx = contexts.get(io);
  return ctx ? setupMeta(setupRequired(ctx.db), ctx.setupOpenUntil, ctx.now()) : null;
}
export type { SetupMeta } from './setup.js';
export const registerEvents = authModule.registerEvents.bind(authModule);

// ---------------------------------------------------------------- for other modules
export {
  requireAppToken,
  requireRole,
  requireScope,
  requireUser,
  resolvePrincipal,
  type Principal,
  type PrincipalKind,
  type PrincipalUser,
} from './principal.js';
export {
  DEFAULT_WORKSPACE_SLUG,
  canEnter,
  defaultWorkspace,
  findWorkspace,
  listWorkspacesFor,
  requireWorkspace,
  resolveWorkspaceFor,
  type WorkspaceScope,
} from './workspace.js';
export {
  onProfileCreated,
  profileCreated as profileCreatedFor,
  registerWorkspaceStatsProvider,
  type ProfileCreatedEvent,
  type ProfileCreatedListener,
  type WorkspaceStatsProvider,
} from './profiles.js';
export {
  ProfileMirrorError,
  RUNTIME_DEFAULT_PROFILE,
  registerProfileMirror,
  type ProfileMirror,
  type ProfileOrigin,
} from './profile-mirror.js';
export {
  EXPORT_KEEP_MS,
  MAX_EXPORT_BYTES,
  ProfileArchiveRefusal,
  ProfileArchiveUnavailable,
  registerProfileTransfer,
  type ProfileArchiveFiles,
  type ProfileArchiveRuntime,
  type ProfileTransferPorts,
} from './profile-transfer.js';
export {
  principalScopeResolver,
  type PrincipalScope,
  type PrincipalScopeResolver,
} from './scopes.js';
export { findUser, ownerUser, presentUser, revokeToken } from './users.js';
export {
  emitToUser,
  revalidateSockets,
  socketRefusal,
  userRoom,
  type AuthSocketData,
} from './sockets.js';
export type { UserRole, UserStatus, AppTokenScope, Locale } from './schema.js';
