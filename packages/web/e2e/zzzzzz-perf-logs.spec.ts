/**
 * 30. Settings → Logs, live (DECISIONS §51), against the real hub: lines the hub and a
 * profile's Hermes gateway wrote are listed with where they came from, the search narrows
 * them on the hub, and "errors only" keeps every source's errors; Performance shows the
 * host and the hub measured live.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const shots = process.env.COREHUB_SHOTS ?? path.resolve('e2e/shots');
mkdirSync(shots, { recursive: true });
const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });

test.use({ viewport: { width: 1440, height: 900 } });

async function login(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('اسم المستخدم').fill('admin');
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/chat$/);
}

test('30. Logs: filter by source and search the lines the hub keeps', async ({ page }) => {
  const seeded = await page.request.post('/__e2e/seed-logs', {
    data: {
      lines: [
        { level: 'info', source: 'hub', message: 'perf-e2e: the hub is listening' },
        {
          level: 'warn',
          source: 'hermes',
          profile: 'work',
          message: 'perf-e2e: WARNING slow reply',
        },
        {
          level: 'error',
          source: 'hermes',
          profile: 'work',
          message: 'perf-e2e: ERROR whatsapp bridge exited',
        },
        { level: 'error', source: 'hub', message: 'perf-e2e: database is locked' },
      ],
    },
  });
  expect(seeded.ok()).toBe(true);

  await login(page);
  await page.goto('/settings/logs');
  const lines = page.getByTestId('logs-lines');
  await expect(lines.getByText('perf-e2e: the hub is listening')).toBeVisible();
  await expect(lines.getByText('هرمز · work').first()).toBeVisible();

  await page.getByTestId('logs-search').fill('PERF-E2E: whatsapp');
  await expect(lines.getByText('perf-e2e: ERROR whatsapp bridge exited')).toBeVisible();
  await expect(lines.getByText('perf-e2e: the hub is listening')).toHaveCount(0);

  await page.getByTestId('logs-search').fill('perf-e2e');
  await page.getByTestId('logs-source-errors').click();
  await expect(lines.getByText('perf-e2e: database is locked')).toBeVisible();
  await expect(lines.getByText('perf-e2e: ERROR whatsapp bridge exited')).toBeVisible();
  await expect(lines.getByText('perf-e2e: WARNING slow reply')).toHaveCount(0);
  await expect(lines.getByText('perf-e2e: the hub is listening')).toHaveCount(0);

  await page.getByTestId('logs-source-hub').click();
  await expect(lines.getByText('perf-e2e: the hub is listening')).toBeVisible();
  await expect(lines.getByText('perf-e2e: WARNING slow reply')).toHaveCount(0);
  await shot(page, '30-settings-logs');

  await page.goto('/settings/performance');
  await expect(page.getByTestId('performance-host')).toBeVisible();
  await expect(page.getByTestId('perf-hub-rss')).toBeVisible();
  await expect(page.getByTestId('perf-profiles')).toContainText('default');
  await shot(page, '30-settings-performance');
});
