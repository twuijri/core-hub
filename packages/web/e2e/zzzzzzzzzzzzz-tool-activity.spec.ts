/**
 * The tool activity of a turn (owner, 2026-09-26): while the agent works only the latest four
 * steps are in view — plus a failed one, which stays until the turn ends — and the earlier ones
 * are one "+k earlier steps" line; when the turn ends every step folds into one row that says
 * how many, how long and how many failed, and opens to the full list.
 *
 * Runs after the other journeys (`zzzz…-`), which count the rows of the session list.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const shots = process.env.COREHUB_SHOTS ?? path.resolve('e2e/shots');
mkdirSync(shots, { recursive: true });

async function login(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('اسم المستخدم').fill('admin');
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/chat$/);
}

test('the live window keeps the latest steps and a failure; the finished turn folds into one row', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('link', { name: 'محادثة جديدة' }).first().click();
  await expect(page).toHaveURL(/\/new$/);
  await expect(async () => {
    await page.getByTestId('composer-input').fill('نفّذ خطوات كثيرة');
    await expect(page.getByTestId('send')).toBeEnabled({ timeout: 1_000 });
  }).toPass();
  await page.getByTestId('send').click();
  await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}(\?profile=[a-z0-9-]+)?$/);

  // Live: six calls, the sixth still running. The last four are in view, and the first one
  // too, because it failed; the one left over is the "+1 earlier step" line.
  const group = page.getByTestId('tool-group');
  await expect(group).toHaveAttribute('data-live', 'true');
  const rows = group.getByTestId('tool-call');
  await expect(group.locator('[data-status="running"]')).toContainText('web_search');
  await expect(rows).toHaveCount(5);
  await expect(rows.first()).toHaveAttribute('data-status', 'failed');
  await expect(page.getByTestId('tool-group-earlier')).toHaveText(/خطوة سابقة/);
  await page.screenshot({ path: path.join(shots, 'tool-activity-live-ar-light.png') });

  // Finished: one row — six steps, one failed, the latest tools — closed until clicked.
  const summary = page.getByTestId('tool-group-summary');
  await expect(group).toHaveAttribute('data-live', 'false', { timeout: 20_000 });
  await expect(summary).toContainText('6 خطوات');
  await expect(page.getByTestId('tool-group-failed')).toContainText('فشلت خطوة');
  await expect(summary).toContainText('web_search');
  await expect(page.getByTestId('tool-group-time')).toBeVisible();
  await expect(rows.first()).toBeHidden();
  await page.screenshot({ path: path.join(shots, 'tool-activity-folded-ar-light.png') });

  await summary.click();
  await expect(rows).toHaveCount(6);
  await expect(rows.first()).toBeVisible();
  await expect(rows.first()).toHaveAttribute('data-status', 'failed');
  await page.screenshot({ path: path.join(shots, 'tool-activity-open-ar-light.png') });
});
