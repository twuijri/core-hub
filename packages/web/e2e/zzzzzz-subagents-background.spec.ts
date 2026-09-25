/**
 * 41. Subagents and the Background panel (owner, 2026-09-25; contract decision §56): a scripted
 *     run delegates to two subagents. The conversation's Subagents panel shows both running;
 *     the Background button in the top bar lists the run and the subagents; stopping one in the
 *     panel moves it to Finished, the other then completes and joins it; its step opens in the
 *     Trajectory's own lane.
 *
 * Runs after the other journeys (`zzzzzz-`), which count the rows of the session list.
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

test('41. subagents run, one is stopped, the other finishes, and the Background panel lists the run', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('link', { name: 'محادثة جديدة' }).first().click();
  await expect(page).toHaveURL(/\/new$/);
  await expect(async () => {
    await page.getByTestId('composer-input').fill('وزّع العمل على وكيلين');
    await expect(page.getByTestId('send')).toBeEnabled({ timeout: 1_000 });
  }).toPass();
  await page.getByTestId('send').click();
  await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}(\?profile=[a-z0-9-]+)?$/);

  // Both subagents appear, live, with what they do.
  const panel = page.getByTestId('subagents-panel');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel).toHaveAttribute('data-support', 'full');
  const running = panel.getByTestId('subagent-row');
  await expect(running).toHaveCount(2);
  await expect(running.nth(0)).toHaveAttribute('data-subagent-id', 'sa-0-tests');
  await expect(running.nth(0)).toContainText('راجع ملفات الاختبارات');
  await expect(running.nth(0)).toContainText('read_file');
  await expect(running.nth(1)).toContainText('اكتب ملاحظات الإصدار');
  await page.screenshot({ path: path.join(shots, '41-subagents-panel.png') });

  // The Background button counts the run and both subagents (earlier journeys may have left
  // work of their own running, so this run's items are found by their conversation).
  const sessionId = /\/chat\/([0-9A-Z]{26})/.exec(page.url())?.[1] ?? '';
  const button = page.getByTestId('background-tasks');
  await expect(async () => {
    expect(Number(await button.getAttribute('data-count'))).toBeGreaterThanOrEqual(3);
  }).toPass({ timeout: 15_000 });
  await button.click();
  const sheet = page.getByTestId('background-sheet');
  await expect(sheet).toBeVisible();
  const runningList = sheet.getByTestId('background-running');
  const mine = (list: typeof runningList) => ({
    run: list
      .locator('[data-testid="background-item"][data-kind="chat_run"]')
      .filter({ has: page.locator(`a[href*="${sessionId}"]`) }),
    tests: list.locator(`[data-item-id="subagent:${sessionId}:sa-0-tests"]`),
    notes: list.locator(`[data-item-id="subagent:${sessionId}:sa-1-notes"]`),
  });
  const now = mine(runningList);
  await expect(now.run).toHaveCount(1);
  await expect(now.tests).toHaveCount(1);
  await expect(now.notes).toHaveCount(1);
  await expect(now.tests).toContainText('راجع ملفات الاختبارات');
  await page.screenshot({ path: path.join(shots, '41-background-panel.png') });
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  // Stop the first: it leaves the running list; the second then completes.
  await running.nth(0).getByTestId('subagent-stop').click();
  await expect(panel.getByTestId('subagent-row')).toHaveCount(0, { timeout: 15_000 });
  const toggle = panel.getByTestId('subagents-finished-toggle');
  await expect(toggle).toContainText('(2)');
  await toggle.click();
  const finished = panel.getByTestId('subagent-finished-row');
  await expect(finished).toHaveCount(2);
  await expect(
    panel.locator('[data-testid="subagent-finished-row"][data-subagent-id="sa-0-tests"]'),
  ).toHaveAttribute('data-status', 'interrupted');
  await expect(
    panel.locator('[data-testid="subagent-finished-row"][data-subagent-id="sa-1-notes"]'),
  ).toHaveAttribute('data-status', 'completed');

  // This run's work has left the running list; it is under Finished in the Background panel.
  await expect(async () => {
    if (await sheet.isVisible()) {
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
    }
    await button.click();
    await expect(sheet).toBeVisible();
    await expect(mine(sheet.getByTestId('background-running')).run).toHaveCount(0, {
      timeout: 1_000,
    });
    const more = sheet.getByTestId('background-finished-toggle');
    if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
    const done = mine(sheet.getByTestId('background-finished'));
    await expect(done.run).toHaveCount(1, { timeout: 1_000 });
    await expect(done.tests).toHaveAttribute('data-status', 'cancelled', { timeout: 1_000 });
    await expect(done.notes).toHaveAttribute('data-status', 'succeeded', { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  // A finished subagent opens in full, and from there in the Trajectory's own lane.
  await panel
    .locator('[data-testid="subagent-finished-row"][data-subagent-id="sa-1-notes"]')
    .getByTestId('subagent-view')
    .click();
  const detail = page.getByTestId('subagent-sheet');
  await expect(detail.getByTestId('subagent-summary')).toHaveText('ملاحظات الإصدار جاهزة.');
  await detail.getByTestId('subagent-open-trajectory').click();
  await expect(page).toHaveURL(/[?&]view=trajectory/);
  await expect(page.getByTestId('trajectory-lane-subagents')).toBeVisible();
  await expect(
    page.getByTestId('trajectory-lane-subagents').getByTestId('trajectory-bar'),
  ).toHaveCount(2);
  await expect(page.getByTestId('trajectory-subagent')).toBeVisible();
});
