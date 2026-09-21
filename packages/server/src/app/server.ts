// Builds the hub: logger, database, Fastify, Socket.IO, modules, routes. `main.ts` calls this
// and listens; tests call it and inject requests.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Server as SocketServer } from 'socket.io';
import { loadOpenApiDocument, type OpenApiDocument } from '@majlis/contracts';
import { createLogger, type Logger } from '../lib/logger.js';
import type { HubModule } from '../lib/module.js';
import { modules as allModules } from '../modules/index.js';
import { loadConfig, type HubConfig } from './config.js';
import { createDatabase, packageRoot, type HubDatabase } from './db.js';
import { registerRoutes, type RoutesReport } from './routes.js';
import { createSockets, listNamespaces, registerModuleEvents } from './sockets.js';

export interface HubState {
  config: HubConfig;
  database: HubDatabase;
  io: SocketServer;
  modules: string[];
  namespaces: string[];
  stubs: string[];
  version: string;
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
}

export function readVersion(): string {
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
  const database = createDatabase(config.database, logger);
  if (options.migrate ?? true) await database.migrate();

  const app: FastifyInstance = Fastify<Server, IncomingMessage, ServerResponse, FastifyBaseLogger>({
    loggerInstance: logger,
    trustProxy: true,
  });
  const modules = options.modules ?? allModules;
  const contract = options.contract === undefined ? loadOpenApiDocument() : options.contract;
  const version = readVersion();

  const io = createSockets(app);
  // Decorated before the modules register so a module can reach the database and the
  // configuration while mounting (first-boot tasks); the report fields are filled below.
  const hub: HubState = { config, database, io, modules: [], namespaces: [], stubs: [], version };
  app.decorate('hub', hub);
  const events = await registerModuleEvents(io, modules);
  const routes: RoutesReport = await registerRoutes(app, { version, database, modules, contract });
  hub.modules = routes.modules.filter((name) => events.includes(name));
  hub.namespaces = listNamespaces(io);
  hub.stubs = routes.stubs;

  app.addHook('onClose', async () => {
    await database.close();
  });

  return app;
}
