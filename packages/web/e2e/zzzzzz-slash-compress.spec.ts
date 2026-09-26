/**
 * 32. The composer's `/` commands and the context meter (decision §57): a conversation whose
 *     agent reports a window three quarters full shows it on the meter; typing `/` opens the
 *     menu of the agent's commands, `/compress` is picked from it with the keyboard, the chat
 *     says the context is being compressed, and the meter drops to what the agent reports
 *     afterwards — its details say how much it was before and after.
 *
 * The agent is the e2e hub's scripted runner (`e2e/hub.ts`, "املأ السياق" and `compress`).
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

test('32. / opens the commands, /compress shows its progress, and the meter drops', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('link', { name: 'محادثة جديدة' }).first().click();
  await expect(page).toHaveURL(/\/new$/);
  await expect(async () => {
    await page.getByTestId('composer-input').fill('املأ السياق بالملفات كلها');
    await expect(page.getByTestId('send')).toBeEnabled({ timeout: 1_000 });
  }).toPass();
  await page.getByTestId('send').click();
  await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}(\?profile=[a-z0-9-]+)?$/);
  await expect(page.getByTestId('chat-screen').getByText('السياق ممتلئ تقريبًا')).toBeVisible();

  // The agent's own count: three quarters of its window.
  const ring = page.getByTestId('context-ring');
  await expect(ring).toHaveAttribute('data-percent', '75');
  await expect(ring).toHaveAttribute('data-source', 'reported');

  // `/` opens the menu; the agent's commands are there, described in Arabic.
  const input = page.getByTestId('composer-input');
  await input.fill('/');
  const menu = page.getByTestId('slash-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByText('الأوامر')).toBeVisible();
  await expect(page.getByTestId('slash-option-compress')).toContainText('اضغط سياق هذه المحادثة');
  await expect(page.getByTestId('slash-option-steer')).toBeVisible();
  await expect(page.getByTestId('slash-option-new')).toBeVisible();

  // Filtered as one types, picked with the keyboard.
  await input.pressSequentially('comp');
  await expect(menu.getByRole('option')).toHaveCount(1);
  await expect(page.getByTestId('slash-option-compress')).toHaveAttribute('aria-selected', 'true');
  await input.press('Enter');
  await expect(menu).toBeHidden();
  await expect(input).toHaveValue('');

  // The chat says it is compressing while the agent works, then the meter drops.
  const status = page.getByTestId('compression-status');
  await expect(status).toBeVisible();
  await expect(status).toContainText('يُضغط سياق المحادثة');
  await expect(status).toBeHidden({ timeout: 10_000 });
  await expect(ring).toHaveAttribute('data-percent', '12');

  // Its details: the new figure, where it came from, and what the compression did.
  await ring.click();
  const details = page.getByTestId('context-details');
  await expect(details).toBeVisible();
  await expect(page.getByTestId('context-percent')).toContainText('12');
  await expect(page.getByTestId('context-last-compression')).toContainText('Compressed: 40 → 6');
  await expect(page.getByTestId('context-compress')).toBeEnabled();

  // What fills the window, by category, as the agent counts it (decision §102).
  const breakdown = page.getByTestId('context-breakdown');
  await expect(breakdown).toBeVisible();
  await expect(breakdown.getByTestId('context-category')).toHaveCount(5);
  await expect(breakdown.getByTestId('context-category').nth(1)).toContainText('تعريفات الأدوات');
  await details.screenshot({ path: path.join(shots, 'context-breakdown-ar-light.png') });
});
