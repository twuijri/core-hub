// Socket.IO composition. Engine path is /rt; namespaces mirror the streaming modules
// (ARCHITECTURE §Realtime). Events are `<entity>.<verb>` and declared in packages/contracts/events.
import type { FastifyInstance } from 'fastify';
import { Server as SocketServer } from 'socket.io';
import type { HubModule } from '../lib/module.js';
import { REALTIME_NAMESPACES } from '../lib/module.js';

export const SOCKET_PATH = '/rt';

export function createSockets(app: FastifyInstance): SocketServer {
  const io = new SocketServer(app.server, {
    path: SOCKET_PATH,
    serveClient: false,
    cors: { origin: false },
  });
  for (const namespace of Object.values(REALTIME_NAMESPACES)) {
    io.of(namespace);
  }
  app.addHook('onClose', async () => {
    await io.close();
  });
  return io;
}

export async function registerModuleEvents(
  io: SocketServer,
  modules: readonly HubModule[],
): Promise<string[]> {
  const registered: string[] = [];
  for (const module of modules) {
    await module.registerEvents(io);
    registered.push(module.name);
  }
  return registered;
}

export function listNamespaces(io: SocketServer): string[] {
  return [...io._nsps.keys()].filter((name) => name !== '/').sort();
}
