/**
 * Module `terminal`: the owner's web terminal (DECISIONS §60).
 *
 * The owner asked for a terminal in the web and said who it is for (2026-09-25): «الا خله
 * للمشرف الرئيسي بس» — the one account with role `owner`; not admins, not members.
 *
 *   terminal.get   GET /terminal   owner only: is it on, and the owner's live sessions
 *   /rt/terminal   open · attach · input · resize · close  (events/README.md)
 *
 * Every gate is here, on the hub, and the web only mirrors it:
 * - off unless the hub runs with `COREHUB_WEB_TERMINAL=1` — the route answers `403` with
 *   `reason: terminal_disabled`, and the namespace refuses every handshake;
 * - only the owner, signed in from a browser: the contract's `x-roles: [owner]` refuses an
 *   admin or a member, and an app token (a paired phone, an integration) is refused too — a
 *   leaked integration token must not be a shell;
 * - at most three sessions at once, and one nobody typed into for the idle timeout (15 minutes
 *   by default) is closed;
 * - every start and end is in the audit log (`terminal.opened`, `terminal.closed`): who, when,
 *   in which folder, and why it ended.
 *
 * The shell runs as the hub's own user (never root in the image) in
 * `DATA_DIR/workspaces/<profile>`. The image's code stays sealed: `/app` and `/opt/hermes` are
 * root's and read-only to that user, and a shell cannot change that
 * (`scripts/image-sealed-check.mjs`).
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Server as SocketServer, Socket } from 'socket.io';
import { loadOpenApiDocument } from '@corehub/contracts';
import { createContractIndex } from '../../lib/contract.js';
import { requireSqlite, type ModuleDb } from '../../lib/db.js';
import { HubError } from '../../lib/errors.js';
import { defineModule, REALTIME_NAMESPACES } from '../../lib/module.js';
import { createRealtime, type Realtime } from '../../lib/realtime.js';
import { defineRoute } from '../../lib/route.js';
import { t, type Language } from '../../i18n/index.js';
import { auditFor, type AuditService } from '../audit/index.js';
import {
  requireRole,
  requireUser,
  requireWorkspace,
  resolveWorkspaceFor,
  type AuthSocketData,
  type Principal,
} from '../auth/index.js';
import { TerminalManager, type ExitReason, type TerminalSession } from './manager.js';
import { hostSpawner, pipeSpawner, shellEnv, type ShellSpawner } from './shell.js';

export { TerminalManager, BACKLOG_LIMIT, clampSize } from './manager.js';
export type { ExitReason, TerminalSession } from './manager.js';
export {
  SHELL_ENV_KEYS,
  defaultShell,
  hostSpawner,
  loadNodePty,
  pipeSpawner,
  ptySpawner,
  shellEnv,
} from './shell.js';
export type { ShellProcess, ShellSpawner } from './shell.js';

const NAMESPACE = REALTIME_NAMESPACES.terminal;

/** What the module reads of `hub.config.webTerminal` (declared here: no module imports `app/`). */
interface TerminalConfig {
  enabled: boolean;
  idleMs: number;
  maxSessions: number;
}

/** The largest single `input` accepted: a big paste, not a file upload. */
export const MAX_INPUT_CHARS = 64 * 1024;

interface TerminalContext {
  config: TerminalConfig;
  db: ModuleDb;
  dataDir: string;
  manager: TerminalManager;
  realtime: Realtime;
  audit: AuditService;
  io: SocketServer;
}

/** One context per Socket.IO server, like `audit` and `auth`, so hubs in one process stay apart. */
const contexts = new WeakMap<SocketServer, TerminalContext>();

/** Tests hand in a scripted shell; the hub uses the host's (node-pty, or the pipe fallback). */
let spawnerOverride: (() => ShellSpawner) | null = null;
export function overrideTerminal(next: { spawner?: () => ShellSpawner } = {}): void {
  spawnerOverride = next.spawner ?? null;
}

/** The live manager of this app, for tests; null before the routes are mounted. */
export function terminalManagerFor(app: FastifyInstance): TerminalManager | null {
  return contexts.get(app.hub.io)?.manager ?? null;
}

const roomOf = (id: string) => `terminal:${id}`;

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function serialize(context: TerminalContext, session: TerminalSession) {
  const attached = (context.io.of(NAMESPACE).adapter.rooms.get(roomOf(session.id))?.size ?? 0) > 0;
  return {
    id: session.id,
    profile: session.profile,
    cwd: session.cwd,
    cols: session.cols,
    rows: session.rows,
    attached,
    started_at: iso(session.startedAt),
    last_active_at: iso(session.lastActiveAt),
  };
}

/** Why this caller may not use the terminal, or null when they may. */
function refusalFor(config: TerminalConfig, principal: Principal): HubError | null {
  if (principal.user.role !== 'owner') {
    return new HubError('forbidden', {
      messageKey: 'terminal.owner_only',
      details: { reason: 'owner_only', required_role: 'owner' },
    });
  }
  if (!config.enabled) {
    return new HubError('forbidden', {
      messageKey: 'terminal.disabled',
      details: { reason: 'terminal_disabled' },
    });
  }
  if (principal.kind !== 'user') {
    return new HubError('forbidden', {
      messageKey: 'terminal.web_only',
      details: { reason: 'web_session_required' },
    });
  }
  return null;
}

function createContext(app: FastifyInstance): TerminalContext {
  const { hub } = app;
  const existing = contexts.get(hub.io);
  if (existing) return existing;
  const db = requireSqlite(hub.database);
  const realtime = createRealtime(hub.io);
  const audit = auditFor(app);
  const config = hub.config.webTerminal;
  // The native PTY is loaded only on a hub that has the terminal on; one without it never
  // opens a session, so it never needs one.
  const spawner = spawnerOverride
    ? spawnerOverride()
    : config.enabled
      ? hostSpawner()
      : pipeSpawner();
  const context: TerminalContext = {
    config,
    db,
    dataDir: hub.config.dataDir,
    realtime,
    audit,
    io: hub.io,
    manager: new TerminalManager({
      spawner,
      // Read on every countdown, so the value is the hub's configuration as it is now.
      get idleMs() {
        return config.idleMs;
      },
      maxSessions: config.maxSessions,
      env: shellEnv(hub.config.hostEnv.inherited),
      events: {
        output(session, data) {
          realtime.emit(
            NAMESPACE,
            'terminal.output',
            { profile: session.profile, room: roomOf(session.id) },
            { terminal_id: session.id, data },
          );
        },
        closed(session, reason, exitCode) {
          realtime.emit(
            NAMESPACE,
            'terminal.exited',
            { profile: session.profile, room: roomOf(session.id) },
            { terminal_id: session.id, reason, exit_code: exitCode },
          );
          hub.io.of(NAMESPACE).in(roomOf(session.id)).socketsLeave(roomOf(session.id));
          recordClosed(audit, session, reason, exitCode, Date.now(), app);
        },
      },
    }),
  };
  contexts.set(hub.io, context);
  if (config.enabled) {
    app.log.warn(
      { pty: spawner.pty, shell: spawner.shell, idle_minutes: config.idleMs / 60_000 },
      "terminal: the owner's web terminal is ON (COREHUB_WEB_TERMINAL=1) — a shell on this host from the browser",
    );
    if (!spawner.pty) {
      app.log.warn('terminal: node-pty did not load; sessions are a plain shell without a PTY');
    }
  }
  return context;
}

function recordClosed(
  audit: AuditService,
  session: TerminalSession,
  reason: ExitReason,
  exitCode: number | null,
  now: number,
  app: FastifyInstance,
): void {
  try {
    audit.record(
      {
        // The owner closed it; the shell, the idle timer or the hub stopping did otherwise.
        actorKind: reason === 'closed' ? 'user' : 'system',
        actorId: reason === 'closed' ? session.ownerId : null,
        ownerId: session.ownerId,
        workspace: session.workspaceId,
        action: 'terminal.closed',
        entityKind: 'terminal',
        entityId: session.id,
        summary: `terminal closed (${reason}) in ${session.cwd}`,
        data: {
          cwd: session.cwd,
          profile: session.profile,
          reason,
          exit_code: exitCode,
          duration_seconds: Math.round((now - session.startedAt) / 1000),
        },
      },
      now,
    );
  } catch (error) {
    // The hub is closing its database under a session that ended with it; say so in the log.
    app.log.warn({ err: error, terminal: session.id, reason }, 'terminal: close not audited');
  }
}

// ------------------------------------------------------------------------- socket handlers

type Ack = (reply: Record<string, unknown>) => void;

function refusalOf(error: unknown, language: Language): Record<string, unknown> {
  const hubError =
    error instanceof HubError ? error : new HubError('internal', { message: String(error) });
  return { ok: false, ...hubError.toEnvelope(language) };
}

const notFound = (language: Language) => ({
  ok: false,
  error: t('errors.not_found', language),
  code: 'not_found',
});

function idOf(payload: unknown): string | null {
  const id = (payload as { terminal_id?: unknown } | null)?.terminal_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function handleConnection(context: TerminalContext, socket: Socket): void {
  const principal = (socket.data as AuthSocketData).principal!;
  const ownerId = principal.user.id;
  const language: Language = principal.user.locale === 'ar' ? 'ar' : 'en';
  const reply = (ack: unknown, body: Record<string, unknown>) => {
    if (typeof ack === 'function') (ack as Ack)(body);
  };

  socket.on('open', (payload: unknown, ack: unknown) => {
    try {
      const input = (payload ?? {}) as { profile?: unknown; cols?: unknown; rows?: unknown };
      if (typeof input.profile !== 'string' || input.profile.length === 0) {
        throw new HubError('validation_failed', { details: { field: 'profile' } });
      }
      const workspace = resolveWorkspaceFor(context.db, principal.user, input.profile);
      const cwd = path.join(context.dataDir, 'workspaces', workspace.slug);
      mkdirSync(cwd, { recursive: true });
      const session = context.manager.open({
        ownerId,
        workspaceId: workspace.id,
        profile: workspace.slug,
        cwd,
        cols: input.cols,
        rows: input.rows,
      });
      // No session without its line in the audit log: if the line cannot be written, the
      // shell is closed again and the owner is told.
      try {
        context.audit.record({
          actorKind: 'user',
          actorId: ownerId,
          ownerId,
          workspace: workspace.id,
          action: 'terminal.opened',
          entityKind: 'terminal',
          entityId: session.id,
          summary: `terminal opened in ${cwd}`,
          data: {
            cwd,
            profile: workspace.slug,
            pty: context.manager.pty,
            shell: context.manager.shell,
            ip: socket.handshake.address,
          },
        });
      } catch (error) {
        context.manager.close(ownerId, session.id);
        throw error;
      }
      void socket.join(roomOf(session.id));
      reply(ack, { ok: true, session: serialize(context, session) });
    } catch (error) {
      reply(ack, refusalOf(error, language));
    }
  });

  socket.on('attach', (payload: unknown, ack: unknown) => {
    const id = idOf(payload);
    const found = id ? context.manager.attach(ownerId, id) : null;
    if (!id || !found) return reply(ack, notFound(language));
    void socket.join(roomOf(id));
    reply(ack, {
      ok: true,
      session: serialize(context, found.session),
      backlog: found.backlog,
    });
  });

  socket.on('input', (payload: unknown, ack: unknown) => {
    const id = idOf(payload);
    const data = (payload as { data?: unknown } | null)?.data;
    if (typeof data !== 'string' || data.length > MAX_INPUT_CHARS) {
      return reply(
        ack,
        refusalOf(new HubError('validation_failed', { details: { field: 'data' } }), language),
      );
    }
    if (!id || !context.manager.input(ownerId, id, data)) return reply(ack, notFound(language));
    reply(ack, { ok: true });
  });

  socket.on('resize', (payload: unknown, ack: unknown) => {
    const id = idOf(payload);
    const size = (payload ?? {}) as { cols?: unknown; rows?: unknown };
    if (!id || !context.manager.resize(ownerId, id, size.cols, size.rows)) {
      return reply(ack, notFound(language));
    }
    reply(ack, { ok: true });
  });

  socket.on('close', (payload: unknown, ack: unknown) => {
    const id = idOf(payload);
    if (!id || !context.manager.close(ownerId, id)) return reply(ack, notFound(language));
    reply(ack, { ok: true });
  });
}

export const terminalModule = defineModule({
  name: 'terminal',
  registerRoutes(app: FastifyInstance) {
    const document = loadOpenApiDocument();
    if (!document) throw new Error('packages/contracts/openapi.yaml is required (ADR 0003)');
    const context = createContext(app);
    app.addHook('onClose', async () => {
      context.manager.closeAll('shutdown');
    });
    const deps = {
      contract: createContractIndex(document),
      guards: { requireUser, requireWorkspace, requireRole },
    };

    defineRoute(app, deps, {
      operationId: 'terminal.get',
      handler: (request) => {
        const principal = request.principal!;
        const refusal = refusalFor(context.config, principal);
        if (refusal) throw refusal;
        return {
          enabled: true,
          pty: context.manager.pty,
          shell: context.manager.shell,
          idle_timeout_seconds: Math.round(context.manager.idleMs / 1000),
          max_sessions: context.manager.maxSessions,
          sessions: context.manager
            .list(principal.user.id)
            .map((session) => serialize(context, session)),
        };
      },
    });
  },
  registerEvents(io: SocketServer) {
    const namespace = io.of(NAMESPACE);
    // After `auth`'s handshake middleware (it is composed first): the principal is known here.
    namespace.use((socket, next) => {
      const principal = (socket.data as AuthSocketData).principal;
      const context = contexts.get(io);
      if (!principal) return next(); // the app's last middleware refuses it (app/sockets.ts)
      const refusal = context
        ? refusalFor(context.config, principal)
        : new HubError('forbidden', { details: { reason: 'terminal_disabled' } });
      if (!refusal) return next();
      const details = refusal.details as { reason?: string };
      next(
        Object.assign(new Error(refusal.code), {
          data: { code: refusal.code, reason: details.reason },
        }),
      );
    });
    namespace.on('connection', (socket) => {
      const context = contexts.get(io);
      if (!context) return void socket.disconnect(true);
      handleConnection(context, socket);
    });
  },
});

export const registerRoutes = terminalModule.registerRoutes.bind(terminalModule);
export const registerEvents = terminalModule.registerEvents.bind(terminalModule);
