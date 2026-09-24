/**
 * 31. The Trajectory tab (owner, 2026-09-25; contract decision §42): a scripted run that
 *     reads a file, runs a command that fails and answers is followed live on the tab — three
 *     lanes on one time axis, the failed call in the danger state — a tool step opens to its
 *     arguments and result, the filters narrow the list, and the session log downloads.
 *
 * Runs after the other journeys (`zzzzzz-`), which count the rows of the session list.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const shots = process.env.MAJLIS_SHOTS ?? path.resolve('e2e/shots');
mkdirSync(shots, { recursive: true });

async function login(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('اسم المستخدم').fill('admin');
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/chat$/);
}

test('31. the Trajectory tab follows a run, opens a step, filters, and downloads the log', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('link', { name: 'محادثة جديدة' }).first().click();
  await expect(page).toHaveURL(/\/new$/);
  await expect(async () => {
    await page.getByTestId('composer-input').fill('ارسم المسار لهذه المهمة');
    await expect(page.getByTestId('send')).toBeEnabled({ timeout: 1_000 });
  }).toPass();
  await page.getByTestId('send').click();
  await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}(\?profile=[a-z0-9-]+)?$/);

  // Switch while the run is still going: the tab follows it to the end.
  const tabs = page.getByTestId('chat-tabs');
  await expect(tabs).toBeVisible();
  await expect(page.getByTestId('chat-tabs-chat')).toHaveText('المحادثة');
  await page.getByTestId('chat-tabs-trajectory').click();
  await expect(page).toHaveURL(/[?&]view=trajectory/);
  const view = page.getByTestId('trajectory');
  await expect(view).toHaveAttribute('data-live', 'false', { timeout: 20_000 });

  // Three lanes, and the command that failed is in the danger state.
  for (const lane of ['input', 'model', 'tools']) {
    await expect(page.getByTestId(`trajectory-lane-${lane}`)).toBeVisible();
  }
  const toolBars = page.getByTestId('trajectory-lane-tools').getByTestId('trajectory-bar');
  await expect(toolBars).toHaveCount(2);
  await expect(toolBars.nth(1)).toHaveAttribute('data-status', 'failed');
  // RTL: time flows with the reading direction, so the later call sits further left.
  const [first, second] = await Promise.all([
    toolBars.nth(0).boundingBox(),
    toolBars.nth(1).boundingBox(),
  ]);
  expect(first && second && second.x < first.x).toBe(true);

  // input, reasoning, turn, read_file, a silent turn that only calls the next tool, shell, turn.
  const steps = page.getByTestId('trajectory-step');
  await expect(steps).toHaveCount(7);
  await expect(steps.nth(4)).toContainText('استدعاء أداة فقط');
  const shell = steps.filter({ hasText: 'pnpm test' });
  await expect(shell).toHaveAttribute('data-status', 'failed');
  await shell.getByTestId('trajectory-step-toggle').click();
  const body = shell.getByTestId('trajectory-step-body');
  await expect(body).toContainText('"command": "pnpm test"');
  await expect(body).toContainText('2 failed, 118 passed');

  // Clicking a bar brings its step into view.
  await page.getByTestId('trajectory-lane-tools').getByTestId('trajectory-bar').first().click();
  await expect(steps.filter({ hasText: 'README.md' })).toBeInViewport();

  // Filters: calls only, then words.
  await page.getByTestId('trajectory-filter-calls').click();
  await expect(steps).toHaveCount(2);
  await page.getByTestId('trajectory-search').fill('README');
  await expect(steps).toHaveCount(1);
  await page.getByTestId('trajectory-search').fill('');
  await page.getByTestId('trajectory-filter-calls').click();
  await expect(steps).toHaveCount(7);

  // The metrics the hub has: tokens and the cache rate, which the script reported.
  const metrics = page.getByTestId('trajectory-metrics');
  await expect(metrics.locator('[data-metric="turns"]')).toBeVisible();
  await expect(metrics.locator('[data-metric="tool_time"]')).toBeVisible();
  await expect(metrics.locator('[data-metric="cache_hit"]')).toBeVisible();
  await expect(metrics.locator('[data-metric="input_tokens"]')).toBeVisible();
  await page.screenshot({ path: path.join(shots, 'chat-trajectory-ar-light.png'), fullPage: true });

  // The session log.
  const downloaded = page.waitForEvent('download');
  await page.getByTestId('trajectory-download').click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toMatch(/^session-[0-9A-Z]{26}-log\.json$/);
  const log = JSON.parse(readFileSync((await file.path()) as string, 'utf8')) as {
    steps: unknown[];
    metrics: { failed_tool_calls: number; tool_calls: number };
    timing: string;
  };
  expect(log.timing).toBe('full');
  expect(log.steps).toHaveLength(7);
  expect(log.metrics).toMatchObject({ tool_calls: 2, failed_tool_calls: 1 });

  // Back to the conversation: it is where it was.
  await page.getByTestId('chat-tabs-chat').click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await expect(page).not.toHaveURL(/view=trajectory/);
});
