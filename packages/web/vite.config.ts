import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

// In development the hub runs separately (`pnpm dev` at the root, port 8080); Vite proxies
// `/api` and `/rt` (websocket) to it so the app is same-origin in both modes. In production
// the hub serves `dist/` itself (packages/server/src/app/web.ts).
const hub = process.env.MAJLIS_HUB ?? 'http://127.0.0.1:8080';
const here = path.dirname(fileURLToPath(import.meta.url));
// The version the client prints when the hub has not answered yet. Stamped by the image
// build (`MAJLIS_VERSION`); a working tree has no release, so it stays 0.0.0.
const pkg = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8')) as {
  version: string;
};
const version = process.env.MAJLIS_VERSION?.trim() || pkg.version;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    port: 5173,
    fs: { allow: [path.resolve(here, '../..')] },
    proxy: {
      '/api': { target: hub, changeOrigin: false },
      '/rt': { target: hub, ws: true, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: true, emptyOutDir: true },
});
