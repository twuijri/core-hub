// Socket.IO composition. Engine path is /rt; namespaces mirror the streaming modules
// (ARCHITECTURE §Realtime). Events are `<entity>.<verb>` and declared in packages/contracts/events.
import type { FastifyInstance } from 'fastify';
import { Server as SocketServer } from 'socket.io';
import type { HubModule } from '../lib/module.js';
import { REALTIME_NAMESPACES, SOCKET_PATH } from '../lib/module.js';

export { SOCKET_PATH };

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
  requirePrincipal(io);
  return registered;
}

/**
 * The last handshake middleware on every namespace, after every module's: a socket that no
 * middleware admitted (no principal) is refused. `auth` already refuses such a socket; this
 * keeps the hub closed if a composition ever leaves `auth` out, instead of open. The main
 * namespace `/` carries nothing and no middleware admits anyone there, so it is closed too.
 */
function requirePrincipal(io: SocketServer): void {
  for (const namespace of ['/', ...Object.values(REALTIME_NAMESPACES)]) {
    io.of(namespace).use((socket, next) => {
      if ((socket.data as { principal?: unknown }).principal) return next();
      next(Object.assign(new Error('unauthorized'), { data: { code: 'unauthorized' } }));
    });
  }
}

export function listNamespaces(io: SocketServer): string[] {
  return [...io._nsps.keys()].filter((name) => name !== '/').sort();
}
