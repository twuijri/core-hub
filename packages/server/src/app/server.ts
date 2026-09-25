// Builds the hub: logger, database, Fastify, Socket.IO, modules, routes. `main.ts` calls this
// and listens; tests call it and inject requests.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Server as SocketServer } from 'socket.io';
import { LEGACY, derived, loadOpenApiDocument, type OpenApiDocument } from '@corehub/contracts';
import { createLogger, logRingOf, type Logger } from '../lib/logger.js';
import { LogRing } from '../lib/log-ring.js';
import type { HubModule } from '../lib/module.js';
import { modules as allModules } from '../modules/index.js';
import { ownerUser, setupMetaFor } from '../modules/auth/index.js';
import { requireSqlite } from '../lib/db.js';
import { loadConfig, type HubConfig } from './config.js';
import { createDatabase, packageRoot, type HubDatabase } from './db.js';
import { registerRoutes, type RoutesReport } from './routes.js';
import { createSockets, listNamespaces, registerModuleEvents } from './sockets.js';
import { registerWebClient } from './web.js';

export interface HubState {
  config: HubConfig;
  database: HubDatabase;
  io: SocketServer;
  modules: string[];
  namespaces: string[];
  stubs: string[];
  version: string;
  /** True when the built web client is served from `/`. */
  web: boolean;
  /** The recent log lines the Logs screen reads (`lib/log-ring.ts`). */
  logs: LogRing;
}

declare module 'fastify' {
  interface FastifyInstance {
    hub: HubState;
  }
}

export interface BuildOptions {
  config?: HubConfig;
  logger?: Logger;
  modules?: readonly HubModule[];
  /** Defaults to packages/contracts/openapi.yaml; `null` disables the 501 stubs. */
  contract?: OpenApiDocument | null;
  migrate?: boolean;
  /** Directory of the built web client; `null` never serves it (tests), undefined = packages/web/dist. */
  webDir?: string | null;
}

/**
 * The version this hub is running.
 *
 * The workspace's `package.json` files stay at `0.0.0` on purpose — a release is a git tag,
 * not a commit that bumps five files — so the number a person sees has to come from the
 * build. `COREHUB_VERSION` is stamped into the image by `packages/server/Dockerfile` from
 * the tag being released, and is what `/api/v1/health` and `/api/v1/meta` then report.
 * Outside an image there is no release, and `0.0.0` is the honest answer for a working
 * tree (owner decision, 2026-09-22: the footer must say which version is running).
 */
export function readVersion(stamped?: string | undefined): string {
  if (stamped && stamped.trim() !== '') return stamped.trim();
  try {
    const pkg = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export async function buildServer(options: BuildOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger({ pretty: process.stdout.isTTY });
  if (config.deprecatedEnv && config.deprecatedEnv.length > 0) {
    // Said once, at boot: the value is used, and the stack should be told the new name.
    logger.warn(
      {
        variables: config.deprecatedEnv,
        rename: config.deprecatedEnv.map((name) =>
          name.startsWith(LEGACY.envPrefix)
            ? `${derived.envPrefix}${name.slice(LEGACY.envPrefix.length)}`
            : name,
        ),
      },
      `config: read under the old ${LEGACY.name} name; rename these variables (ADR 0017)`,
    );
  }
  const database = createDatabase(config.database, logger);
  if (options.migrate ?? true) await database.migrate();

  const app: FastifyInstance = Fastify<Server, IncomingMessage, ServerResponse, FastifyBaseLogger>({
    loggerInstance: logger,
    trustProxy: true,
  });
  const modules = options.modules ?? allModules;
  const contract = options.contract === undefined ? loadOpenApiDocument() : options.contract;
  const version = readVersion(config.version);

  const io = createSockets(app);
  // Decorated before the modules register so a module can reach the database and the
  // configuration while mounting (first-boot tasks); the report fields are filled below.
  const hub: HubState = {
    config,
    database,
    io,
    modules: [],
    namespaces: [],
    stubs: [],
    version,
    web: false,
    // The logger's own ring when it made one; a logger from elsewhere writes to no ring,
    // and Hermes's TUI gateway, which writes to this one directly, still has somewhere to.
    logs: logRingOf(logger) ?? new LogRing(),
  };
  app.decorate('hub', hub);
  const events = await registerModuleEvents(io, modules);
  const routes: RoutesReport = await registerRoutes(app, {
    version,
    database,
    modules,
    contract,
    // `auth` owns the question; the app only forwards it, so `/meta` does not have to
    // know what an owner is (ADR 0011).
    setupMeta: () =>
      setupMetaFor(io) ?? {
        setup_required: ownerUser(requireSqlite(database)) === null,
        setup_open: false,
        setup_open_until: null,
      },
  });
  hub.modules = routes.modules.filter((name) => events.includes(name));
  hub.namespaces = listNamespaces(io);
  hub.stubs = routes.stubs;
  // After the API so `/api/v1/*` and the 501 stubs exist before the SPA fallback.
  hub.web =
    options.webDir === null
      ? false
      : await registerWebClient(app, options.webDir ? { dir: options.webDir } : {});

  app.addHook('onClose', async () => {
    await database.close();
  });

  return app;
}
