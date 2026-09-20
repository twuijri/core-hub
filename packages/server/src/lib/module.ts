// The shape every server module exports from its index.ts (ARCHITECTURE §Modules).
// Modules import this file and nothing from app/.
import type { FastifyInstance } from 'fastify';
import type { Server as SocketServer } from 'socket.io';

export const MODULE_NAMES = [
  'auth',
  'agents',
  'sessions',
  'rooms',
  'board',
  'schedules',
  'knowledge',
  'models',
  'devices',
  'notify',
  'updates',
  'audit',
  'plugins',
] as const;
export type ModuleName = (typeof MODULE_NAMES)[number];

/** Socket.IO namespaces, mirroring the modules that stream (ARCHITECTURE §Realtime). */
export const REALTIME_NAMESPACES = {
  sessions: '/rt/sessions',
  rooms: '/rt/rooms',
  board: '/rt/board',
  schedules: '/rt/schedules',
  devices: '/rt/devices',
} as const satisfies Partial<Record<ModuleName, string>>;
export type RealtimeNamespace = (typeof REALTIME_NAMESPACES)[keyof typeof REALTIME_NAMESPACES];

export interface HubModule {
  readonly name: ModuleName;
  /** Mount the module's HTTP routes under the `/api/v1` prefix the app provides. */
  registerRoutes(app: FastifyInstance): void | Promise<void>;
  /** Attach the module's realtime handlers to its namespace(s). */
  registerEvents(io: SocketServer): void | Promise<void>;
}

export function defineModule(module: HubModule): HubModule {
  return module;
}
