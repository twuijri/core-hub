/**
 * Journey 31: Core Hub's own skill library on the Skills page (decision §71), against the real hub.
 *
 * The e2e hub talks to a scripted external Hermes, so nothing is installed at boot (only a Hermes
 * the hub runs itself is seeded): the card says the library is not installed yet and offers
 * Install. Installed, its skills list in the «مكتبة Core Hub» category with the badge; one edited
 * and saved is marked «معدّلة» and offers «استعادة», which asks first and puts the shipped version
 * back; switched off (after asking), its skills leave the profile.
 *
 * It runs after the other agent journeys (`zzzz-`), which photograph the Skills page without it.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const shots = process.env.COREHUB_SHOTS ?? path.resolve('e2e/shots');
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

test('31. Core Hub’s skill library: installed, badged, an edit restored, switched off', async ({
  page,
}) => {
  await login(page);
  await page.getByTestId('rail').getByRole('link', { name: 'الوكلاء' }).click();
  await page.getByTestId('agent-menu').getByRole('link', { name: 'المهارات' }).first().click();
  await expect(page).toHaveURL(/\/skills$/);

  const card = page.getByTestId('skill-library');
  await expect(card).toContainText('لم تُثبَّت بعد في هذا البروفايل');
  await page.getByTestId('skill-library-install').click();
  await expect(card).toContainText('12 من 12 مهارة');

  const library = page.locator('[data-testid="skill-category"][data-category="core-hub"]');
  await expect(library.getByRole('heading', { name: 'مكتبة Core Hub' })).toBeVisible();
  await expect(library.getByTestId('skill-row')).toHaveCount(12);
  await expect(page.getByTestId('skill-library-image-generate')).toHaveText('مكتبة Core Hub');

  // An edit: the skill is the person's now, and says so.
  await library.getByText('summarize', { exact: true }).click();
  const editor = page.getByTestId('skill-content');
  await expect(editor).toHaveValue(/name: summarize/);
  await editor.fill(`${await editor.inputValue()}\nأضف دائمًا سطرًا بالمصدر.\n`);
  await page.getByTestId('save-skill').click();
  const row = page.locator('[data-testid="skill-row"][data-skill="summarize"]');
  await expect(row).toHaveAttribute('data-library', 'edited');
  await expect(row).toContainText('معدّلة');
  await expect(card).toContainText('المعدّلة: 1');
  await shot(page, 'agent-skills-library-ar-light');

  // Restore asks first, then puts the library's version back.
  await page.getByTestId('skill-restore-summarize').click();
  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toContainText('استعادة summarize؟');
  await dialog.getByRole('button', { name: 'استعادة' }).click();
  await expect(row).toHaveAttribute('data-library', 'current');
  await expect(page.getByTestId('skill-restore-summarize')).toHaveCount(0);

  // Off, after asking: the library's skills leave this profile.
  await page.getByTestId('skill-library-toggle').click();
  await expect(dialog).toContainText('إيقاف مكتبة Core Hub؟');
  await dialog.getByRole('button', { name: 'إيقاف' }).click();
  await expect(card).toContainText('مطفأة في هذا البروفايل');
  await expect(library).toHaveCount(0);
});
