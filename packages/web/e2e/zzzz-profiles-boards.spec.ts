/**
 * 26. Tasks and Schedules across profiles, against the real hub (ADR 0016 stage 2).
 *
 * The owner: «الكرون جوب والمهام المفروض تطلع كل البروفايلات بدون تصنيف». With two profiles,
 * the board and the Schedules page hold both, with no profile filter; each card and schedule
 * carries its profile's badge. A new task or schedule is made in the profile the top selector
 * is on — and the screen names it — while a card from another profile is assigned, started
 * and opened in its own profile, without the top selector moving.
 *
 * It runs last (`zzzz-`): it adds a profile and cards to the shared hub, and every journey
 * before it photographs pages those would change.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const shots = process.env.MAJLIS_SHOTS ?? path.resolve('e2e/shots');
mkdirSync(shots, { recursive: true });

test.use({ viewport: { width: 1440, height: 900 } });

async function login(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('اسم المستخدم').fill('admin');
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/chat$/);
}

/** The second profile, made the way a person makes one (ADR 0014: from scratch). */
async function ensureDesigner(page: Page) {
  await page.getByRole('link', { name: 'الإعدادات' }).first().click();
  await page.getByTestId('settings-nav').getByRole('link', { name: 'البروفايلات' }).click();
  await expect(page.getByTestId('workspace-list')).toBeVisible();
  if ((await page.getByTestId('workspace-list').getByText('Designer').count()) === 0) {
    await page.getByTestId('add-workspace').click();
    await page.getByLabel('الاسم').fill('Designer');
    await expect(page.getByLabel('المعرّف')).toHaveValue('designer');
    await page.getByTestId('save-workspace').click();
    await expect(page.getByTestId('workspace-list')).toContainText('Designer');
  }
  await page.getByTestId('back-to-chats').click();
}

/** Put the top selector on a profile — the one where new things are made. */
async function enter(page: Page, name: string) {
  const top = page.getByTestId('workspace-switcher').first();
  if (!(await top.textContent())?.includes(name)) {
    await top.click();
    await page.getByRole('option', { name, exact: true }).click();
  }
  await expect(top).toContainText(name);
}

async function newTask(page: Page, slug: string, title: string) {
  const input = page.getByTestId('new-task-input');
  // Where it is made is said on the screen: the top profile, nothing else.
  await expect(input).toHaveAttribute('data-profile', slug);
  await input.fill(title);
  await page.getByTestId('new-task').click();
}

async function newSchedule(page: Page, slug: string, name: string) {
  await expect(page.getByTestId('schedule-new-profile')).toHaveAttribute('data-profile', slug);
  await page.getByTestId('schedule-name').fill(name);
  await page.getByTestId('schedule-value').fill('0 9 * * *');
  await page.getByTestId('schedule-prompt').fill('لخّص ما جرى');
  // Not Hermes (journey 18 covers Hermes's own scheduler and its zone).
  await page.getByTestId('schedule-agent').click();
  await page.getByRole('option', { name: /Direct|مباشر/ }).click();
  await page.getByTestId('schedule-save').click();
  await expect(page.getByTestId('schedule-card').filter({ hasText: name })).toBeVisible();
}

test('26. the Tasks board and the Schedules page hold every profile, each item badged and acted on in its own', async ({
  page,
}) => {
  await login(page);
  await ensureDesigner(page);
  const word = Date.now().toString(36);
  const top = page.getByTestId('workspace-switcher').first();

  // ---------------------------------------------------------------- Tasks
  await page.getByRole('link', { name: 'المهام' }).click();
  await enter(page, 'Default');
  await newTask(page, 'default', `مهمة الافتراضي ${word}`);
  await enter(page, 'Designer');
  await newTask(page, 'designer', `مهمة المصمم ${word}`);
  await page.getByTestId('task-intake-toggle').click();

  // Both on the one board, whichever profile the top says, each with its badge; no filter.
  const inDefault = page.getByTestId('task-card').filter({ hasText: `مهمة الافتراضي ${word}` });
  const inDesigner = page.getByTestId('task-card').filter({ hasText: `مهمة المصمم ${word}` });
  await expect(inDefault.getByTestId('task-profile')).toHaveAttribute('data-profile', 'default');
  await expect(inDesigner.getByTestId('task-profile')).toHaveAttribute('data-profile', 'designer');
  await expect(page.getByTestId('profile-filter')).toHaveCount(0);
  await enter(page, 'Default');
  await expect(inDesigner).toBeVisible();
  await expect(inDefault).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, 'all-profiles-tasks-ar-light.png') });

  // The designer's card, assigned and started from Default: it runs in the designer profile.
  await inDesigner.getByTestId('task-more').click();
  await page.getByRole('menuitem', { name: 'إسناد إلى وكيل…' }).click();
  const dialog = page.getByTestId('task-assign-dialog');
  await expect(dialog.getByTestId('task-assign-agent')).not.toBeEmpty();
  await dialog.getByTestId('task-assign-start').click();
  await expect(dialog).toBeHidden();
  await expect(inDesigner).toHaveAttribute('data-status', 'review', { timeout: 20_000 });
  // The agent's name came from the hub.
  await expect(inDesigner.getByTestId('task-agent')).not.toHaveText(/^[0-9A-Z]{26}$/);

  // Its conversation opens where it lives, and the person stays in Default.
  await inDesigner.getByTestId('task-session').click();
  await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}\?profile=designer$/);
  await expect(page.getByTestId('chat-profile')).toHaveAttribute('data-profile', 'designer');
  await expect(page.getByTestId('message-assistant').last()).toHaveAttribute(
    'data-status',
    'complete',
  );
  await expect(top).toContainText('Default');

  // ------------------------------------------------------------ Schedules
  await page.getByRole('link', { name: 'الجدولة' }).first().click();
  await expect(page).toHaveURL(/\/schedules$/);
  await newSchedule(page, 'default', `جدول الافتراضي ${word}`);
  await enter(page, 'Designer');
  await newSchedule(page, 'designer', `جدول المصمم ${word}`);
  await expect(page.getByTestId('schedule-filter')).toHaveCount(0);
  await enter(page, 'Default');
  const sDefault = page.getByTestId('schedule-card').filter({ hasText: `جدول الافتراضي ${word}` });
  const sDesigner = page.getByTestId('schedule-card').filter({ hasText: `جدول المصمم ${word}` });
  await expect(sDefault.getByTestId('schedule-profile')).toHaveAttribute('data-profile', 'default');
  await expect(sDesigner.getByTestId('schedule-profile')).toHaveAttribute(
    'data-profile',
    'designer',
  );

  // Acting on the designer's schedule from Default: it is paused where it lives.
  await sDesigner.getByTestId('schedule-enabled').click();
  await expect(sDesigner).toContainText('موقوف');
  await page.reload();
  await expect(sDesigner).toContainText('موقوف');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, 'all-profiles-schedules-ar-light.png') });
  await expect(top).toContainText('Default');
});
