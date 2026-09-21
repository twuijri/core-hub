import path from 'node:path';
import { defineConfig } from '@playwright/test';

// Four smoke journeys against the real hub (e2e/hub.ts boots it with the scripted runner and
// serves the built client from /). `pnpm build` must have run first.
// Two hubs: the signed-in one (an owner from HUB_ADMIN_PASSWORD) and, for journey 4, one with
// no owner and no password at all, whose data directory the test reads the claim token from
// (ADR 0011). The second is wiped and re-created every time it starts, so a retry is the same
// journey as the first run.
const port = Number(process.env.MAJLIS_E2E_PORT ?? 8791);
const baseURL = `http://127.0.0.1:${port}`;
export const setupPort = Number(process.env.MAJLIS_E2E_SETUP_PORT ?? 8792);
export const setupBaseURL = `http://127.0.0.1:${setupPort}`;
export const setupDataDir = path.resolve('e2e/.setup-data');

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'ar',
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  },
  webServer: [
    {
      command: `node --import tsx e2e/hub.ts`,
      url: `${baseURL}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { MAJLIS_E2E_PORT: String(port) },
    },
    {
      command: `node --import tsx e2e/hub.ts`,
      url: `${setupBaseURL}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        MAJLIS_E2E_PORT: String(setupPort),
        MAJLIS_E2E_MODE: 'setup',
        MAJLIS_E2E_DATA_DIR: setupDataDir,
      },
    },
  ],
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
