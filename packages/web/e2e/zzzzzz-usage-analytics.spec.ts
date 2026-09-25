/**
 * 32. Usage and Skills usage (contract decision §50): a scripted run loads a skill the way
 *     Hermes does (`skill_view`) and reports its tokens with a cache read. Usage then shows the
 *     cards and the daily chart for the chosen period — switching to 7 days draws seven bars —
 *     and Skills usage shows that skill as the most used, in its table, and from when the hub
 *     has counted.
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

test('32. Usage draws the period chosen, and Skills usage names the skill a run loaded', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('link', { name: 'محادثة جديدة' }).first().click();
  await expect(page).toHaveURL(/\/new$/);
  await expect(async () => {
    await page.getByTestId('composer-input').fill('حمّل المهارة وابحث عن أوراق');
    await expect(page.getByTestId('send')).toBeEnabled({ timeout: 1_000 });
  }).toPass();
  await page.getByTestId('send').click();
  await expect(
    page.getByTestId('message-assistant').getByText('وجدت ثلاث أوراق عن الموضوع.'),
  ).toBeVisible({ timeout: 20_000 });

  // Usage: the cards, and the daily chart of the default 30 days.
  await page.getByRole('link', { name: 'الإعدادات' }).first().click();
  await page
    .getByTestId('settings-nav')
    .getByRole('link', { name: 'الاستخدام', exact: true })
    .click();
  await expect(page).toHaveURL(/\/settings\/usage$/);
  const totals = page.getByTestId('usage-totals');
  await expect(totals).toBeVisible();
  // The script reported a cache read, so the cache is a number here, not "not reported".
  await expect(page.getByTestId('usage-card-cache')).not.toContainText('غير مُبلَّغ');
  await expect(page.getByTestId('usage-chart-bar')).toHaveCount(30);
  await expect(page.getByTestId('usage-days').getByRole('row')).not.toHaveCount(1);
  await expect(page.getByTestId('usage-by-model')).toBeVisible();

  // Seven days: seven bars, and today's is the one read out.
  await page.getByTestId('report-days-7').click();
  await expect(page.getByTestId('usage-chart-bar')).toHaveCount(7);
  await expect(page.getByTestId('usage-chart-readout')).not.toBeEmpty();
  // RTL: the oldest day is at the right, so today's bar is the leftmost.
  const bars = page.getByTestId('usage-chart-bar');
  const [oldest, today] = await Promise.all([
    bars.first().boundingBox(),
    bars.last().boundingBox(),
  ]);
  expect(oldest && today && today.x < oldest.x).toBe(true);
  await page.screenshot({ path: path.join(shots, 'usage-ar-light.png'), fullPage: true });

  // "Show cost" is the person's own preference.
  const showCost = page.getByTestId('usage-show-cost');
  await showCost.click();
  await expect(page.getByTestId('usage-card-cost')).toBeVisible();
  await showCost.click();
  await expect(page.getByTestId('usage-card-cost')).toHaveCount(0);

  // Skills usage: the skill the run loaded is the top one, counted once for the run.
  await page
    .getByTestId('settings-nav')
    .getByRole('link', { name: 'استخدام المهارات', exact: true })
    .click();
  await expect(page).toHaveURL(/\/settings\/skills-usage$/);
  await expect(page.getByTestId('skills-card-top')).toContainText('arxiv');
  await expect(page.getByTestId('skills-table').getByRole('row').nth(1)).toContainText('arxiv');
  await expect(page.getByTestId('skills-counting-since')).toContainText('بدأ العدّ');
  await expect(page.getByTestId('skills-chart')).toBeVisible();
  await page.screenshot({ path: path.join(shots, 'skills-usage-ar-light.png'), fullPage: true });
});
