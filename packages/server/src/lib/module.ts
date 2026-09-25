// The shape every server module exports from its index.ts (ARCHITECTURE §Modules).
// Modules import this file and nothing from app/.
import type { FastifyInstance } from 'fastify';
import type { Server as SocketServer } from 'socket.io';

export const MODULE_NAMES = [
  'auth',
  'agents',
  'sessions',
  'rooms',
  'tasks',
  'schedules',
  'knowledge',
  'models',
  'devices',
  'notify',
  'updates',
  'audit',
  'plugins',
  'terminal',
] as const;
export type ModuleName = (typeof MODULE_NAMES)[number];

/**
 * Socket.IO namespaces: the modules that stream (ARCHITECTURE §Realtime) plus `/rt/jobs`,
 * the profile-wide "is it done" channel every `202` ends on
 * (`packages/contracts/events/README.md`; `Meta.realtime_namespaces` in the contract).
 */
export const REALTIME_NAMESPACES = {
  sessions: '/rt/sessions',
  rooms: '/rt/rooms',
  tasks: '/rt/tasks',
  schedules: '/rt/schedules',
  devices: '/rt/devices',
  // Not a module of its own: the jobs kernel lives in `audit`, but the namespace is named
  // after what it carries, as the contract declares it.
  jobs: '/rt/jobs',
  // The owner's web terminal (DECISIONS §60). Always declared, so `auth` authenticates it like
  // every other namespace; the terminal module then refuses anyone but the owner, and everyone
  // while the hub runs without `COREHUB_WEB_TERMINAL=1`.
  terminal: '/rt/terminal',
} as const satisfies Partial<Record<ModuleName | 'jobs', string>>;
export type RealtimeNamespace = (typeof REALTIME_NAMESPACES)[keyof typeof REALTIME_NAMESPACES];

/** Socket.IO engine path. Declared here so a module never has to import `app/`. */
export const SOCKET_PATH = '/rt';

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
