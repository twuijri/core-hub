// Serves the built web client (packages/web/dist) from `/` with an SPA fallback. Never shadows
// `/api/*` (unknown API paths keep the JSON 404 envelope) or `/rt` (Socket.IO owns it on the raw
// http server). When the directory is absent — a hub built without the web client — nothing is
// mounted and `/` stays a 404 like before. No new configuration (ARCHITECTURE invariant 5).
import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { packageRoot } from './db.js';

export const DEFAULT_WEB_DIR = path.resolve(packageRoot, '..', 'web', 'dist');
export const API_ROOT = '/api/';
export const SOCKET_ROOT = '/rt';

export interface WebOptions {
  /** Directory holding index.html; defaults to packages/web/dist next to the server package. */
  dir?: string;
}

/** True when the request is for the API or the realtime engine and must never get index.html. */
export function isReservedPath(url: string): boolean {
  const pathname = url.split('?')[0] ?? url;
  return (
    pathname.startsWith(API_ROOT) ||
    pathname === SOCKET_ROOT ||
    pathname.startsWith(`${SOCKET_ROOT}/`)
  );
}

export async function registerWebClient(
  app: FastifyInstance,
  options: WebOptions = {},
): Promise<boolean> {
  const dir = options.dir ?? DEFAULT_WEB_DIR;
  const index = path.join(dir, 'index.html');
  if (!existsSync(index)) return false;

  await app.register(fastifyStatic, {
    root: dir,
    prefix: '/',
    wildcard: false,
    index: false,
    // Vite fingerprints everything under assets/; index.html must always be revalidated.
    setHeaders(reply, filePath) {
      void reply.header(
        'Cache-Control',
        filePath.includes(`${path.sep}assets${path.sep}`)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      );
    },
  });

  app.get('/*', async (request, reply) => {
    if (isReservedPath(request.url)) return reply.callNotFound();
    const accept = request.headers.accept ?? '*/*';
    if (!accept.includes('text/html') && !accept.includes('*/*')) return reply.callNotFound();
    return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
  });
  return true;
}
