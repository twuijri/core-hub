import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

// The desktop smoke test: the built app (apps/desktop/dist, `pnpm build` first) under Electron,
// against the web e2e hub — the real server with a scripted agent runner, so a chat streams
// without a model. On Linux CI it runs under Xvfb (`xvfb-run`).
const here = path.dirname(fileURLToPath(import.meta.url));
export const hubPort = Number(process.env.COREHUB_DESKTOP_SMOKE_PORT ?? 8793);

export default defineConfig({
  testDir: here,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  outputDir: path.join(here, '../../test-results'),
  webServer: {
    command: 'node --import tsx e2e/hub.ts',
    cwd: path.resolve(here, '../../../../packages/web'),
    url: `http://127.0.0.1:${hubPort}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { COREHUB_E2E_PORT: String(hubPort) },
  },
});
