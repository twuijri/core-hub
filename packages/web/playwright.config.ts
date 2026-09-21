import { defineConfig } from '@playwright/test';

// Three smoke journeys against the real hub (e2e/hub.ts boots it with the scripted runner and
// serves the built client from /). `pnpm build` must have run first.
const port = Number(process.env.MAJLIS_E2E_PORT ?? 8791);
const baseURL = `http://127.0.0.1:${port}`;

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
  webServer: {
    command: `node --import tsx e2e/hub.ts`,
    url: `${baseURL}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { MAJLIS_E2E_PORT: String(port) },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
