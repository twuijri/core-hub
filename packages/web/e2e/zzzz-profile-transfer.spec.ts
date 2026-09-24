/**
 * Export and import of a profile, against the real hub (ADR 0014 stage 2). Hermes's own
 * archive writer is scripted in `e2e/hub.ts` (the e2e hub runs no Hermes); everything after
 * it is the hub's: the job on `/rt/jobs`, the check that leaves the `.env` out, the file
 * kept for its requester, the upload, and the new profile in the list.
 *
 * The journey: open Settings → Profiles, export the default profile — the dialog says keys
 * stay behind, shows the job's progress, and the browser saves the archive with the `.env`
 * left out — then import that very file under a new slug and see the profile appear.
 *
 * It runs last (`zzzz-`): it adds a profile to the shared hub, which every journey before
 * it would otherwise photograph.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

test.describe('profile export and import', () => {
  test('exports a profile without its keys, and imports the file as a new profile', async ({
    page,
  }) => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'majlis-e2e-transfer-'));
    try {
      await login(page);
      await page.getByRole('link', { name: 'الإعدادات' }).first().click();
      await page.getByTestId('settings-nav').getByRole('link', { name: 'البروفايلات' }).click();
      const list = page.getByTestId('workspace-list');
      await expect(list).toBeVisible();

      // Export the default profile.
      const card = list.locator('li').first();
      await card.getByTestId('export-workspace').click();
      const exportDialog = page.getByTestId('export-workspace-dialog');
      await expect(exportDialog).toContainText('المفاتيح لا تخرج');
      const downloaded = page.waitForEvent('download');
      await exportDialog.getByTestId('start-export').click();
      await expect(exportDialog.getByTestId('export-ready')).toBeVisible();
      await expect(exportDialog).toContainText('استُبعد: \u2066default/.env\u2069');
      const download = await downloaded;
      expect(download.suggestedFilename()).toMatch(/^default-\d{8}-\d{6}\.tar\.gz$/);
      const archive = path.join(scratch, download.suggestedFilename());
      await download.saveAs(archive);
      const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
      expect(entries).toContain('default/SOUL.md');
      expect(entries).toContain('default/memories/MEMORY.md');
      expect(entries.some((entry) => entry.endsWith('.env'))).toBe(false);
      await page.waitForTimeout(300);
      await exportDialog.screenshot({ path: path.join(shots, 'profile-export-ar-light.png') });
      await exportDialog.getByRole('button', { name: 'إغلاق' }).first().click();
      await expect(exportDialog).toHaveCount(0);

      // Import the same file under a new slug.
      await page.getByTestId('import-workspace').click();
      const importDialog = page.getByTestId('import-workspace-dialog');
      await importDialog.getByTestId('import-file').setInputFiles(archive);
      await expect(importDialog.getByTestId('import-file-name')).toHaveText(
        download.suggestedFilename(),
      );
      // `default` is taken, so the suggestion is the next free slug.
      await expect(importDialog.getByLabel('المعرّف')).toHaveValue('default-2');
      await importDialog.getByLabel('المعرّف').fill('restored');
      await importDialog.getByLabel('الاسم').fill('المستعاد');
      await page.waitForTimeout(300);
      await importDialog.screenshot({ path: path.join(shots, 'profile-import-ar-light.png') });
      await importDialog.getByTestId('start-import').click();
      await expect(importDialog).toHaveCount(0);
      await expect(list).toContainText('المستعاد');
      await expect(list).toContainText('restored');

      // The same slug again is refused on the spot, before anything is sent.
      await page.getByTestId('import-workspace').click();
      await importDialog.getByTestId('import-file').setInputFiles(archive);
      await importDialog.getByLabel('المعرّف').fill('restored');
      await expect(importDialog).toContainText('هذا المعرّف مستخدم');
      await expect(importDialog.getByTestId('start-import')).toBeDisabled();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
