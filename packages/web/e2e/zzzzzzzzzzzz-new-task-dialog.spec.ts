/**
 * The New task dialog against the real hub (owner, 2026-09-29: a task with only a name is
 * useless). "New task" opens it; an empty title is refused in words; a refusal from the hub is
 * shown in the dialog and Save again goes through; the whole task — description, agent,
 * priority, due, tags, subtasks, definition of done, constraints, where it waits — lands in the
 * column it was put in, with its agent and priority on the card.
 *
 * The model picker and "Start now" are covered by `tests/new-task-dialog.test.tsx` (the e2e hub
 * has no model catalogue to choose from).
 *
 * Shots: the filled dialog, top and bottom, Arabic light, 1440×900.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const shots = process.env.COREHUB_SHOTS ?? path.resolve('e2e/shots');
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

async function choose(page: Page, trigger: ReturnType<Page['getByTestId']>, name: string | RegExp) {
  await trigger.click();
  await page.getByRole('option', { name }).click();
}

test('38. a new task is written whole in its dialog and lands where it was put', async ({
  page,
}) => {
  const title = `صفحة الأسعار ${Date.now().toString(36)}`;
  await login(page);
  await page.goto('/tasks');
  await page.getByTestId('new-task').click();
  const dialog = page.getByTestId('new-task-dialog');
  await expect(dialog).toBeVisible();

  // No title: said in words, on the field, and nothing is sent.
  await dialog.getByTestId('new-task-save').click();
  await expect(dialog.getByText('اكتب عنوانًا للمهمة.')).toBeVisible();
  await expect(dialog.getByTestId('new-task-title')).toHaveAttribute('aria-invalid', 'true');

  await dialog.getByTestId('new-task-title').fill(title);
  await dialog
    .getByTestId('new-task-description')
    .fill('صمّم صفحة الأسعار بثلاث خطط، واكتب النصوص بالعربية والإنجليزية.');
  await choose(page, dialog.getByTestId('new-task-agent'), /Direct|مباشر/);
  await choose(page, dialog.getByTestId('new-task-priority'), 'مرتفعة');
  await dialog.getByTestId('new-task-due').fill('2030-01-15T10:30');
  await dialog.getByTestId('new-task-tags').fill('web، تصميم');
  await dialog.getByTestId('task-subtasks-input').fill('جدول المقارنة');
  await dialog.getByTestId('task-subtasks-input').press('Enter');
  await dialog.getByTestId('task-dod-input').fill('تعمل على شاشة الهاتف');
  await dialog.getByTestId('task-dod-input').press('Enter');
  await dialog.getByTestId('task-constraints-input').fill('لا تضف مكتبات جديدة');
  await dialog.getByTestId('task-constraints-input').press('Enter');
  // Not started now: it waits in Ready, next in line.
  await dialog.getByRole('radio', { name: 'ليس الآن' }).click();
  await choose(page, dialog.getByTestId('new-task-status'), 'جاهزة');
  await dialog.getByTestId('new-task-title').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, 'task-new-dialog-ar-light.png') });
  await dialog.getByTestId('new-task-save').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, 'task-new-dialog-when-ar-light.png') });

  // The hub refuses once: its words are shown in the dialog, which stays open.
  await page.route('**/api/v1/tasks', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({
      status: 503,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'about:blank',
        title: 'Unavailable',
        status: 503,
        code: 'unavailable',
        message: 'The hub is busy.',
      }),
    });
  });
  await dialog.getByTestId('new-task-save').click();
  await expect(dialog.getByTestId('new-task-error')).toBeVisible();
  await expect(dialog).toBeVisible();
  await page.unroute('**/api/v1/tasks');

  await dialog.getByTestId('new-task-save').click();
  await expect(dialog).toBeHidden();

  // In the queue, Ready, with its agent and priority, its subtask and its definition of done.
  const card = page.locator('[data-column="queue"] [data-testid="task-card"]').filter({
    hasText: title,
  });
  await expect(card).toHaveAttribute('data-status', 'ready');
  await expect(card).toHaveAttribute('data-fresh', 'true');
  await expect(card.getByTestId('task-agent')).toHaveText(/Direct|مباشر/);
  await expect(card).toContainText('مرتفعة');
  await expect(card).toContainText('0/1');
  await expect(card.getByTestId('task-dod-badge')).toHaveText('0/1');

  // What was written is what the hub kept.
  await card.getByTestId('task-more').click();
  await page.getByRole('menuitem', { name: 'التفاصيل…' }).click();
  const details = page.getByTestId('task-dialog');
  await expect(details.getByTestId('task-dialog-description')).toHaveValue(
    'صمّم صفحة الأسعار بثلاث خطط، واكتب النصوص بالعربية والإنجليزية.',
  );
  await expect(details.getByTestId('task-constraints-text')).toHaveValue('لا تضف مكتبات جديدة');
});
