#!/usr/bin/env node
// A local preview of site/dist (run `pnpm --filter @corehub/site build` first):
//   pnpm --filter @corehub/site serve            → http://127.0.0.1:4173/
// Served under /core-hub/ as well, the path GitHub Pages uses, so relative links are checked too.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const port = Number(process.env.PORT ?? 4173);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let rel = decodeURIComponent(url.pathname).replace(/^\/core-hub(?=\/|$)/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = path.join(dist, path.normalize(rel));
  if (!file.startsWith(dist + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type':
        TYPES[/** @type {keyof typeof TYPES} */ (path.extname(file))] ?? 'application/octet-stream',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`site: http://127.0.0.1:${port}/`));
