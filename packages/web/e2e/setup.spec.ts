// Journey 4: a fresh install. The hub boots with no owner and no HUB_ADMIN_PASSWORD, so for
// the first hour after it started setup is open to whoever arrives first (ADR 0019): the browser
// creates the owner with a name and a password, no token, and is signed in. The claim token is
// still written to the data directory as the fallback for after the window. Nothing here is
// faked: the reply comes from the real `auth.completeSetup`.
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { setupBaseURL, setupDataDir } from '../playwright.config.js';

const shots = process.env.COREHUB_SHOTS ?? path.resolve('e2e/shots');
mkdirSync(shots, { recursive: true });

const OWNER = { username: 'tariq', password: 'first-run-owner-password' };

test.use({ baseURL: setupBaseURL });

test.describe('web smoke journeys (a hub with no owner)', () => {
  test('4. first run: inside the open window the owner is created with no token and signed in', async ({
    page,
    request,
  }) => {
    // The hub needs an owner, and setup is open without a token for a while.
    const state = await request.get('/api/v1/auth/setup');
    expect(await state.json()).toEqual({ required: true });
    const meta = await (await request.get('/api/v1/meta')).json();
    expect(meta).toMatchObject({ setup_required: true, setup_open: true });
    expect(Date.parse(meta.setup_open_until)).toBeGreaterThan(Date.now());
    // The fallback for after the window is on disk all the same.
    const tokenFile = path.join(setupDataDir, 'setup-token.txt');
    expect(existsSync(tokenFile)).toBe(true);

    // Opening the hub lands on the setup screen, not on sign-in.
    await page.goto('/');
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByRole('heading', { name: 'إنشاء حساب المالك' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    // It says plainly that setup is open to whoever arrives first, and how long is left.
    await expect(
      page.getByText('التسجيل مفتوح لأول شخص يفتح هذه الصفحة — أكمله الآن'),
    ).toBeVisible();
    await expect(page.getByTestId('setup-remaining')).toContainText(/\d{2}:\d{2}/);
    await expect(page.getByLabel('رمز التهيئة', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: path.join(shots, 'setup-ar-light.png'), fullPage: true });

    await page.getByLabel('اسم المستخدم', { exact: true }).fill(OWNER.username);
    await page.getByLabel('اسم البروفايل (اختياري)', { exact: true }).fill('بروفايلي');
    await page.getByLabel('كلمة المرور', { exact: true }).fill(OWNER.password);
    await page.getByLabel('تأكيد كلمة المرور', { exact: true }).fill(OWNER.password);
    await page.getByRole('button', { name: 'أنشئ الحساب وادخل' }).click();

    // Signed in immediately: the chat screen, with the owner in the sidebar.
    await expect(page).toHaveURL(/\/chat$/);
    await expect(page.getByText(OWNER.username).first()).toBeVisible();
    await page.screenshot({ path: path.join(shots, 'setup-done-ar-light.png'), fullPage: true });

    // First run is over for everybody: the hub says so, the token file is gone, a second
    // setup is refused even inside the window, /setup redirects, and the password works.
    expect(await (await request.get('/api/v1/auth/setup')).json()).toEqual({ required: false });
    expect(await (await request.get('/api/v1/meta')).json()).toMatchObject({
      setup_required: false,
      setup_open: false,
      setup_open_until: null,
    });
    expect(existsSync(tokenFile)).toBe(false);
    const replay = await request.post('/api/v1/auth/setup', {
      data: { username: 'intruder', password: 'another-password' },
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
