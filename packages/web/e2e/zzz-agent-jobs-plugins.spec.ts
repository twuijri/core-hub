/**
 * Journey 28: the last two pages of an agent, in the agent's own side list, against the real hub
 * with Hermes's scheduler and Hermes's `hermes plugins` command scripted (`e2e/hub.ts`):
 *
 * - Jobs: a schedule made for Hermes on the Schedules page is, on Hermes's Jobs page, a job in
 *   Hermes's own scheduler — run now, paused, and deleted from there; the page leads back to
 *   Schedules for making and editing.
 * - Plugins: Hermes's plugins in the profile with Hermes's own status; one switched on, one
 *   installed from the catalog (a job, installed switched off), and that one removed again —
 *   while what Hermes ships offers no removal.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const shots = process.env.MAJLIS_SHOTS ?? path.resolve('e2e/shots');
mkdirSync(shots, { recursive: true });

const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });

async function login(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('اسم المستخدم').fill('admin');
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/chat$/);
}

/** Hermes's card chip opens the page; inside an agent the side list moves between pages. */
async function openHermesPage(page: Page, name: string, url: RegExp) {
  const sections = page.getByTestId('agent-sections');
  if ((await sections.count()) > 0) {
    await sections.getByRole('link', { name }).click();
  } else {
    await page.getByTestId('rail').getByRole('link', { name: 'الوكلاء' }).click();
    const hermes = page.locator('[data-testid="agent-card"][data-agent-slug="hermes"]');
    await hermes.getByTestId('agent-menu').getByRole('link', { name }).first().click();
  }
  await expect(page).toHaveURL(url);
}

test("28. Hermes's Jobs and Plugins: its scheduler's jobs run and paused, a plugin switched on, installed and removed", async ({
  page,
}) => {
  await login(page);

  // ---- A schedule for Hermes, made where schedules are made.
  await page.getByRole('link', { name: 'الجدولة' }).click();
  await page.getByTestId('schedule-name').fill('موجز الأخبار');
  await page.getByTestId('schedule-value').fill('30 6 * * *');
  await page.getByTestId('schedule-prompt').fill('اجمع أهم أخبار الصباح في خمس نقاط');
  await page.getByTestId('schedule-save').click();
  // Hermes runs every cron in its own zone and says which; take it.
  await page.getByTestId('schedule-use-zone').click();
  await expect(
    page.locator('[data-external="hermes"]').filter({ hasText: 'موجز الأخبار' }),
  ).toBeVisible();

  // ---- Jobs: the same job, on Hermes's own page.
  await openHermesPage(page, 'المهام المجدولة', /\/jobs$/);
  const sections = page.getByTestId('agent-sections');
  await expect(sections.getByRole('link', { name: 'المهام المجدولة' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const job = page.getByTestId('agent-job').filter({ hasText: 'موجز الأخبار' });
  await expect(job).toBeVisible();
  await expect(job).toContainText('في مجدول هرمز');
  await expect(job).toContainText('30 6 * * * · Pacific/Chatham');
  await expect(job).toContainText('اجمع أهم أخبار الصباح');

  // Run now: Hermes fires it on its next tick.
  await job.getByRole('button', { name: 'شغّله الآن' }).click();
  await expect(page.getByTestId('agent-jobs-fired')).toBeVisible();

  // Pause: Hermes holds it, and the row says so.
  await job.getByRole('switch').click();
  await expect(job).toContainText('موقوف');
  await expect(job).not.toHaveAttribute('data-enabled', 'true');
  await page.waitForTimeout(300);
  await shot(page, 'agent-jobs-ar-light');

  // The page leads to Schedules, where the same job is paused too.
  await page.getByTestId('agent-jobs-schedules').click();
  await expect(page).toHaveURL(/\/schedules$/);
  const card = page.locator('[data-external="hermes"]').filter({ hasText: 'موجز الأخبار' });
  await expect(card).toContainText('موقوف');

  // Delete it from Hermes's page: gone from Hermes's scheduler and from both pages.
  await openHermesPage(page, 'المهام المجدولة', /\/jobs$/);
  await job.getByRole('button', { name: 'حذف' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('تُحذف من مجدول هرمز أيضًا.');
  await confirm.getByRole('button', { name: 'حذف' }).click();
  await expect(job).toHaveCount(0);

  // ---- Plugins: Hermes's list in this profile, in Hermes's words.
  await openHermesPage(page, 'الإضافات', /\/plugins$/);
  const guidance = page.locator('[data-testid="agent-plugin"][data-plugin="security-guidance"]');
  await expect(guidance).toHaveAttribute('data-status', 'not_enabled');
  await expect(guidance).toContainText('غير مفعّلة');
  await expect(guidance).toContainText('تأتي مع هرمز');
  // What Hermes ships is switched off, never removed.
  await expect(page.getByTestId('agent-plugin-remove-security-guidance')).toHaveCount(0);

  await page.getByTestId('agent-plugin-toggle-security-guidance').click();
  await expect(guidance).toHaveAttribute('data-status', 'enabled');
  await expect(guidance).toContainText('مفعّلة');

  // Install from Hermes's catalog: a job, and the plugin arrives switched off.
  await page.getByTestId('agent-plugin-identifier').fill('chrome-profiles');
  await page.getByTestId('agent-plugin-install').click();
  await expect(page.getByTestId('agent-plugin-install-progress')).toBeVisible();
  const result = page.getByTestId('agent-plugin-install-result');
  await expect(result).toHaveAttribute('data-ok', 'true');
  await expect(result).toContainText('chrome-profiles');
  const chrome = page.locator('[data-testid="agent-plugin"][data-plugin="chrome-profiles"]');
  await expect(chrome).toHaveAttribute('data-status', 'not_enabled');
  await expect(chrome).toContainText('مثبّتة');
  await shot(page, 'agent-plugins-ar-light');

  // A name Hermes cannot fetch fails in Hermes's own words.
  await page.getByTestId('agent-plugin-identifier').fill('nobody/nothing');
  await page.getByTestId('agent-plugin-install').click();
  await expect(result).toHaveAttribute('data-ok', 'false');
  await expect(result).toContainText("repository 'nobody/nothing' not found");

  // And what was installed can be removed.
  await page.getByTestId('agent-plugin-remove-chrome-profiles').click();
  const remove = page.getByRole('alertdialog');
  await expect(remove).toContainText('إزالة chrome-profiles؟');
  await remove.getByRole('button', { name: 'أزِل' }).click();
  await expect(chrome).toHaveCount(0);
});
