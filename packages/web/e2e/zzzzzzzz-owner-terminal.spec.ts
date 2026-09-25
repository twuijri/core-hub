/**
 * The owner's web terminal (DECISIONS §60; owner, 2026-09-25: «الا خله للمشرف الرئيسي بس»)
 * against a real hub started with COREHUB_WEB_TERMINAL=1 (the third web server in
 * playwright.config.ts) and a real shell: the owner opens Settings → Terminal, sees the
 * warning, opens a terminal, runs `echo hi` and reads `hi`; after a reload the same terminal
 * is back with what it printed.
 */
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { terminalBaseURL } from '../playwright.config.js';

const PASSWORD = 'e2e-owner-password';
const shots = process.env.COREHUB_SHOTS ?? path.resolve('e2e/shots');

test.use({ baseURL: terminalBaseURL, viewport: { width: 1440, height: 900 } });

async function login(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('اسم المستخدم').fill('admin');
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/chat$/);
}

/** A screen row that reads exactly `text` — not the line that typed it. */
const row = (page: Page, text: string) =>
  page
    .getByTestId('terminal-screen')
    .locator('.xterm-rows > div')
    .filter({ hasText: new RegExp(`^\\s*${text}\\s*$`) });

test('the owner opens the terminal, runs echo hi and sees hi, and a reload brings it back', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('link', { name: 'الإعدادات' }).first().click();
  await page.getByTestId('settings-nav').getByRole('link', { name: 'الطرفية' }).click();
  await expect(page).toHaveURL(/\/settings\/terminal$/);
  await expect(page.getByText('هذه طرفية على الخادم بصلاحيات حساب المركز')).toBeVisible();

  await page.getByTestId('terminal-new').click();
  const screen = page.getByTestId('terminal-screen');
  await expect(screen).toBeVisible();
  await screen.click();
  await page.keyboard.type('echo hi');
  await page.keyboard.press('Enter');
  await expect(row(page, 'hi')).toHaveCount(1);
  await expect(screen).toHaveAttribute('dir', 'ltr');
  await page.screenshot({ path: path.join(shots, 'terminal-ar-light.png') });

  // A reload: the session lives on the hub, so the tab comes back and is repainted.
  await page.reload();
  await expect(page.getByTestId('terminal-tab')).toHaveCount(1);
  await expect(row(page, 'hi')).toHaveCount(1);

  // Closing it ends it on the hub.
  await page.getByRole('button', { name: 'إغلاق طرفية 1' }).click();
  await expect(page.getByTestId('terminal-tab')).toHaveCount(0);
  await expect(page.getByText('لا طرفية مفتوحة')).toBeVisible();
});
