// Module `auth`: owns users, roles (owner, admin, member), passwords, app tokens, device pairing (QR),
// workspaces (profiles) and per-user preferences.
// Public surface of the module: other modules and app/ import this file only. See README.md.
import type { Server as SocketServer } from 'socket.io';
import { loadOpenApiDocument } from '@majlis/contracts';
import { requireSqlite } from '../../lib/db.js';
import { defineModule } from '../../lib/module.js';
import type { AuthContext } from './context.js';
import { authenticateHook } from './principal.js';
import { registerAuthRoutes } from './routes.js';
import { clearSetupToken, issueSetupToken, setupTokenLog } from './setup.js';
import { registerSocketAuth } from './sockets.js';
import { loadOrCreateSigningKey } from './tokens.js';
import { bootstrap } from './users.js';

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
    };
    contexts.set(hub.io, ctx);

    const boot = await bootstrap(db, hub.config.bootstrapAdminPassword, ctx.now());
    if (boot.ownerCreated) app.log.info('auth: owner account created from HUB_ADMIN_PASSWORD');
    if (boot.workspaceCreated) app.log.info('auth: default workspace created');
    if (boot.setupRequired) {
      // First run without HUB_ADMIN_PASSWORD: the owner is created from the browser with a
      // claim token (ADR 0011). A fresh token on every boot; the old one stops working.
      app.log.info(setupTokenLog(hub.config.dataDir, issueSetupToken(hub.config.dataDir)));
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
  findWorkspace,
  listWorkspacesFor,
  requireWorkspace,
  resolveWorkspaceFor,
  type WorkspaceScope,
} from './workspace.js';
export { registerWorkspaceStatsProvider, type WorkspaceStatsProvider } from './profiles.js';
export {
  ProfileMirrorError,
  RUNTIME_DEFAULT_PROFILE,
  registerProfileMirror,
  type ProfileMirror,
  type ProfileOrigin,
} from './profile-mirror.js';
export {
  principalScopeResolver,
  type PrincipalScope,
  type PrincipalScopeResolver,
} from './scopes.js';
export { findUser, ownerUser, presentUser } from './users.js';
export { emitToUser, userRoom } from './sockets.js';
export type { UserRole, UserStatus, AppTokenScope, Locale } from './schema.js';
