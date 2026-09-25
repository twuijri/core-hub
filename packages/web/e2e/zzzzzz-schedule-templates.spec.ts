/**
 * Common schedules and the next runs, against the real hub (DECISIONS §53).
 *
 * A person picks «أيام العمل الساعة ٩:٠٠» from «جداول شائعة»: the form's time becomes
 * `0 9 * * 1-5`, and the next three times shown are the hub's own calculation
 * (`schedules.previewTrigger`) in the schedule's timezone — each a weekday at 09:00 there.
 * The schedule saved from it runs next at the first of those times: the preview and the
 * saved `next_run_at` are one calculation. A time the hub cannot read says so before saving.
 *
 * It runs after every journey that photographs the Schedules page, because it adds a schedule
 * to the shared hub.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const ZONE = 'Asia/Riyadh';
const shots = process.env.COREHUB_SHOTS ?? path.resolve('e2e/shots');
mkdirSync(shots, { recursive: true });

// The browser's zone is the one a new schedule is made in.
test.use({ viewport: { width: 1440, height: 900 }, timezoneId: ZONE });

async function login(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('اسم المستخدم').fill('admin');
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/chat$/);
}

/** `2026-09-29T06:00:00Z` → "Tue 09:00", in Riyadh. */
const local = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));

test('a common schedule fills the time, and the next runs are the hub’s', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'الجدولة', exact: true }).click();
  await expect(page).toHaveURL(/\/schedules$/);

  await page.getByTestId('schedule-templates').click();
  await page.getByRole('menuitem', { name: 'أيام العمل الساعة ٩:٠٠' }).click();
  await expect(page.getByTestId('schedule-value')).toHaveValue('0 9 * * 1-5');

  const preview = page.getByTestId('schedule-next-runs');
  await expect(preview).toHaveAttribute('data-trigger', 'cron 0 9 * * 1-5');
  await expect(preview).toHaveAttribute('data-state', 'ready');
  await expect(preview).toContainText(`المرات القادمة (${ZONE})`);
  const runs = preview.getByTestId('schedule-next-run');
  await expect(runs).toHaveCount(3);
  const times = await runs.evaluateAll((items) =>
    items.map((item) => item.getAttribute('data-at') ?? ''),
  );
  for (const at of times) {
    expect(local(at)).toMatch(/^(Mon|Tue|Wed|Thu|Fri) 09:00$/);
    expect(Date.parse(at)).toBeGreaterThan(Date.now());
  }
  expect([...times].sort()).toEqual(times);
  await page.screenshot({
    path: path.join(shots, 'schedule-templates-ar-light.png'),
    fullPage: true,
  });

  // Saved as it is, the schedule's next run is the first time the form showed.
  await page.getByTestId('schedule-name').fill('تقرير أيام العمل');
  await page.getByTestId('schedule-prompt').fill('اكتب تقرير الصباح');
  // The hub's own agent: a schedule the hub fires, with the zone the browser is in.
  await page.getByTestId('schedule-agent').click();
  await page.getByRole('option', { name: /Direct|مباشر/ }).click();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/schedules') && response.request().method() === 'POST',
  );
  await page.getByTestId('schedule-save').click();
  const created = (await (await saved).json()) as {
    next_run_at: string | null;
    trigger: { timezone: string };
  };
  expect(created.trigger.timezone).toBe(ZONE);
  expect(created.next_run_at && Date.parse(created.next_run_at)).toBe(Date.parse(times[0]!));

  // "Every 15 minutes" is an interval; a time the hub cannot read is refused before saving.
  await page.getByTestId('schedule-templates').click();
  await page.getByRole('menuitem', { name: 'كل ١٥ دقيقة' }).click();
  await expect(page.getByTestId('schedule-value')).toHaveValue('15');
  await expect(preview).toHaveAttribute('data-trigger', 'interval 15');
  await expect(preview).toHaveAttribute('data-state', 'ready');
  await expect(runs).toHaveCount(3);

  await page.getByTestId('schedule-templates').click();
  await page.getByRole('menuitem', { name: 'كل ساعة' }).click();
  await page.getByTestId('schedule-value').fill('0 25 * * *');
  await expect(preview).toHaveAttribute('data-state', 'error');
  await expect(page.getByTestId('schedule-next-runs-error')).toContainText(
    'لا يستطيع الخادم قراءة هذا',
  );
  await expect(runs).toHaveCount(0);
});
