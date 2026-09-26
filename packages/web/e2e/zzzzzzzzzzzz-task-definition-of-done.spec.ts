/**
 * A task's definition of done and constraints (contract decision §104), and several cards at
 * once (§103), against the real hub: the lists are written in the details dialog and kept,
 * the card counts the ticked lines, and "Select" gives many cards one priority.
 *
 * Shots: the details dialog with both lists, and the board while selecting (Arabic, light).
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

async function newTask(page: Page, title: string) {
  await page.getByTestId('new-task-input').fill(title);
  await page.getByTestId('new-task').click();
  const card = page.getByTestId('task-card').filter({ hasText: title });
  await expect(card).toHaveCount(1);
  return card;
}

test('36. a definition of done and constraints are written, kept and counted; many cards take one priority', async ({
  page,
}) => {
  await login(page);
  await page.goto('/tasks');
  // Intake is where a new task lands; open it to see the cards.
  await page.getByTestId('task-intake-toggle').click();
  const first = await newTask(page, 'صفحة الإعدادات للهاتف');
  const second = await newTask(page, 'ترجمة الصفحة');

  await first.getByTestId('task-more').click();
  await page.getByRole('menuitem', { name: 'التفاصيل…' }).click();
  const details = page.getByTestId('task-dialog');
  const dod = details.getByTestId('task-dod');
  await dod.getByTestId('task-dod-input').fill('الاختبارات تنجح');
  await dod.getByTestId('task-dod-add').click();
  await dod.getByTestId('task-dod-input').fill('تعمل على شاشة الهاتف');
  await dod.getByTestId('task-dod-input').press('Enter');
  const constraints = details.getByTestId('task-constraints');
  await constraints.getByTestId('task-constraints-input').fill('لا تضف مكتبات جديدة');
  await constraints.getByTestId('task-constraints-add').click();
  // The ticks are the reviewer's: not before the task is in review.
  await expect(dod.getByTestId('task-dod-tick').first()).toBeDisabled();
  await page.screenshot({ path: path.join(shots, 'task-definition-of-done-ar-light.png') });
  await details.getByTestId('task-dialog-save').click();
  await expect(details.getByTestId('task-dialog-save')).toBeDisabled();
  await page.keyboard.press('Escape');
  // Kept by the hub, and counted on the card.
  await expect(first.getByTestId('task-dod-badge')).toHaveText('0/2');
  await page.reload();
  await page.getByTestId('task-intake-toggle').click();
  await expect(first.getByTestId('task-dod-badge')).toHaveText('0/2');

  // Several cards at once: one priority.
  await page.getByTestId('task-select').click();
  await first.getByTestId('task-tick').click();
  await second.getByTestId('task-tick').click();
  await expect(page.getByTestId('task-bulk-count')).toHaveText('2 محدّدة');
  await page.screenshot({ path: path.join(shots, 'task-bulk-select-ar-light.png') });
  await page.getByTestId('task-bulk-priority').click();
  await page.getByRole('option', { name: 'عاجلة' }).click();
  await expect(first).toContainText('عاجلة');
  await expect(second).toContainText('عاجلة');
});
