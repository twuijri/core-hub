// Journey 4: a fresh install. The hub boots with no owner and no HUB_ADMIN_PASSWORD, writes
// its claim token into the data directory, and the browser turns that token into the owner
// account and a signed-in session (ADR 0011). Nothing here is faked: the token is read from
// the file the real server wrote, and the reply comes from the real `auth.completeSetup`.
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { setupBaseURL, setupDataDir } from '../playwright.config.js';

const shots = process.env.COREHUB_SHOTS ?? path.resolve('e2e/shots');
mkdirSync(shots, { recursive: true });

const OWNER = { username: 'tariq', password: 'first-run-owner-password' };

test.use({ baseURL: setupBaseURL });

test.describe('web smoke journeys (a hub with no owner)', () => {
  test('4. first run: the setup token from /data creates the owner and signs in', async ({
    page,
    request,
  }) => {
    // The hub says setup is still open, and says nothing else.
    const state = await request.get('/api/v1/auth/setup');
    expect(await state.json()).toEqual({ required: true });

    // Opening the hub lands on the setup screen, not on sign-in.
    await page.goto('/');
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByRole('heading', { name: 'إنشاء حساب المالك' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    // The screen itself says where to read the token.
    await expect(page.getByText('docker compose exec hub cat /data/setup-token.txt')).toBeVisible();
    await page.screenshot({ path: path.join(shots, 'setup-ar-light.png'), fullPage: true });

    // A wrong token is refused and nothing is created.
    await page.getByLabel('رمز التهيئة', { exact: true }).fill('0'.repeat(48));
    await page.getByLabel('اسم المستخدم', { exact: true }).fill(OWNER.username);
    await page.getByLabel('كلمة المرور', { exact: true }).fill(OWNER.password);
    await page.getByLabel('تأكيد كلمة المرور', { exact: true }).fill(OWNER.password);
    await page.getByRole('button', { name: 'أنشئ الحساب وادخل' }).click();
    await expect(page.getByRole('alert')).toContainText('رمز التهيئة غير صحيح');
    await expect(page).toHaveURL(/\/setup$/);

    // The real token, from the file the hub wrote.
    const token = readFileSync(path.join(setupDataDir, 'setup-token.txt'), 'utf8').trim();
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    await page.getByLabel('رمز التهيئة', { exact: true }).fill(token);
    await page.getByLabel('اسم البروفايل (اختياري)', { exact: true }).fill('بروفايلي');
    await page.getByRole('button', { name: 'أنشئ الحساب وادخل' }).click();

    // Signed in immediately: the chat screen, with the owner in the sidebar.
    await expect(page).toHaveURL(/\/chat$/);
    await expect(page.getByText(OWNER.username).first()).toBeVisible();
    await page.screenshot({ path: path.join(shots, 'setup-done-ar-light.png'), fullPage: true });

    // First run is over for everybody: the hub says so, /setup redirects, and the password works.
    expect(await (await request.get('/api/v1/auth/setup')).json()).toEqual({ required: false });
    const replay = await request.post('/api/v1/auth/setup', {
      data: { token, username: 'intruder', password: 'another-password' },
      failOnStatusCode: false,
    });
    expect(replay.status()).toBe(409);
    await page.goto('/setup');
    await expect(page).toHaveURL(/\/chat$/);

    // Sign out, then sign in with the password just chosen: the account really exists.
    await page.getByRole('button', { name: 'تسجيل الخروج' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel('اسم المستخدم', { exact: true }).fill(OWNER.username);
    await page.getByLabel('كلمة المرور').fill(OWNER.password);
    await page.getByRole('button', { name: 'دخول' }).click();
    await expect(page).toHaveURL(/\/chat$/);
  });
});
