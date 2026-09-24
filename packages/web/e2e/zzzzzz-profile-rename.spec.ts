/**
 * Renaming the default profile, against the real hub (contract decision §44): Settings →
 * Profiles → Rename on the default profile, «الرئيسي» typed, and the top profile chip says it
 * at once. The dialog says the id stays; the card keeps showing `default` as the id.
 *
 * It runs last (`zzzzzz-`) and puts the old name back, because every journey before it names
 * the default profile «Default».
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

async function rename(page: Page, to: string) {
  const card = page.getByTestId('workspace-list').locator('li').first();
  await card.getByTestId('rename-workspace').click();
  const dialog = page.getByTestId('rename-workspace-dialog');
  await expect(dialog).toBeVisible();
  const input = dialog.getByTestId('workspace-name-input');
  await input.fill(to);
  return dialog;
}

test.describe('renaming a profile', () => {
  test('renames the default profile to «الرئيسي» and the top chip says it', async ({ page }) => {
    await login(page);
    await page.getByRole('link', { name: 'الإعدادات' }).first().click();
    await page.getByTestId('settings-nav').getByRole('link', { name: 'البروفايلات' }).click();
    const list = page.getByTestId('workspace-list');
    await expect(list).toBeVisible();
    const switcher = page.getByTestId('workspace-switcher');
    await expect(switcher).toContainText('Default');

    const dialog = await rename(page, 'الرئيسي');
    // The id stays, and the dialog says so.
    await expect(dialog).toContainText('المعرّف ⁦default⁩ لا يتغيّر');
    await page.waitForTimeout(300);
    await dialog.screenshot({ path: path.join(shots, 'profile-rename-ar-light.png') });
    await dialog.getByTestId('save-workspace-name').click();
    await expect(dialog).toHaveCount(0);

    await expect(switcher).toContainText('الرئيسي');
    const card = list.locator('li').first();
    await expect(card).toContainText('الرئيسي');
    await expect(card).toContainText('default');

    // Back as it was, for whatever runs after.
    const back = await rename(page, 'Default');
    await back.getByTestId('save-workspace-name').click();
    await expect(back).toHaveCount(0);
    await expect(switcher).toContainText('Default');
  });
});
