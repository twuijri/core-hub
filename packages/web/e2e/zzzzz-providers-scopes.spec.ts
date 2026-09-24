/**
 * Two provider scopes, against the real hub (contract decision §37, owner 2026-09-24).
 *
 * The owner's design as a journey: in a second profile, «إضافة مزوّد» asks «لمن هذا
 * المزوّد؟». A provider for every profile is badged «مشترك» and is on the default profile's
 * page too, with nothing typed twice; one for this profile only is badged «Studio فقط» and
 * nobody else sees it. The second profile's Defaults tab shows the model it inherits from
 * the default profile. Then Studio is exported «مع المزوّدين» — the dialog warns that keys
 * travel — and the file, imported as a new profile, brings those providers as its own.
 *
 * It runs last on purpose (`zzzzz-`): it adds providers and profiles to the shared hub, and
 * every journey before it photographs a Models page with no provider on it.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

async function profilesPage(page: Page) {
  await page.getByRole('link', { name: 'الإعدادات' }).first().click();
  await page.getByTestId('settings-nav').getByRole('link', { name: 'البروفايلات' }).click();
  await expect(page.getByTestId('workspace-list')).toBeVisible();
}

/** A second profile, made the way a person makes one. */
async function ensureStudio(page: Page) {
  await profilesPage(page);
  if ((await page.getByTestId('workspace-list').getByText('Studio').count()) === 0) {
    await page.getByTestId('add-workspace').click();
    await page.getByLabel('الاسم').fill('Studio');
    await expect(page.getByLabel('المعرّف')).toHaveValue('studio');
    await page.getByTestId('save-workspace').click();
    await expect(page.getByTestId('workspace-list')).toContainText('Studio');
  }
  await page.getByTestId('back-to-chats').click();
}

/** The top selector onto one profile, then Settings → Models. */
async function modelsIn(page: Page, profileName: string) {
  await page.goto('/chat');
  const top = page.getByTestId('workspace-switcher').first();
  if (!(await top.textContent())?.includes(profileName)) {
    await top.click();
    await page.getByRole('option', { name: profileName, exact: true }).click();
  }
  await expect(top).toContainText(profileName);
  await page.getByRole('link', { name: 'الإعدادات' }).first().click();
  await page.getByTestId('settings-nav').getByRole('link', { name: 'النماذج' }).click();
  await expect(page.getByTestId('open-add-provider')).toBeVisible();
}

/** Adds LM Studio for the scope asked, from the dialog. */
async function addLmStudio(page: Page, scope: 'all' | 'profile') {
  await page.getByTestId('open-add-provider').click();
  const dialog = page.getByTestId('add-provider-dialog');
  await expect(dialog).toContainText('لمن هذا المزوّد؟');
  await dialog.getByTestId(scope === 'all' ? 'add-scope-all' : 'add-scope-profile').click();
  await dialog.getByTestId('add-preset').click();
  await page.getByRole('option', { name: 'LM Studio' }).click();
  await dialog.getByTestId('add-submit').click();
  await expect(dialog).toHaveCount(0);
}

const scopes = (page: Page) =>
  page.getByTestId('provider-list').getByTestId('provider-scope').allTextContents();

test.describe('providers for every profile, and a profile’s own', () => {
  test('a shared provider is on every profile, a profile’s own stays in it, and an export with providers brings them to an imported profile', async ({
    page,
  }) => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'majlis-e2e-scopes-'));
    try {
      await login(page);
      await ensureStudio(page);

      // In Studio: one provider for every profile, one for Studio only.
      await modelsIn(page, 'Studio');
      await addLmStudio(page, 'all');
      await expect(page.getByTestId('provider-list')).toContainText('LM Studio');
      await addLmStudio(page, 'profile');
      await expect.poll(() => scopes(page)).toEqual(['\u200f\u2068Studio\u2069 فقط', 'مشترك']);
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(shots, 'providers-scopes-studio-ar-light.png') });

      // Studio chose no model of its own: its Defaults tab shows the default profile's — the
      // first model of the shared provider, once its list has arrived — and says so.
      await expect
        .poll(async () => {
          await page.reload();
          await page.getByTestId('models-tabs').getByText('الافتراضيات').click();
          await page.getByTestId('default-chat').waitFor();
          return page.getByTestId('default-chat-inherited').count();
        })
        .toBe(1);
      await expect(page.getByTestId('default-chat-inherited')).toHaveText('من البروفايل الافتراضي');

      // The default profile has the shared one — nobody added it there — and not Studio's.
      await modelsIn(page, 'Default');
      await expect.poll(() => scopes(page)).toEqual(['مشترك']);

      // Export Studio with its providers: the dialog warns that keys travel.
      await profilesPage(page);
      const studio = page.getByTestId('workspace-list').locator('li').filter({ hasText: 'Studio' });
      await studio.first().getByTestId('export-workspace').click();
      const exportDialog = page.getByTestId('export-workspace-dialog');
      await expect(exportDialog.getByTestId('export-keys-warning')).toHaveCount(0);
      await exportDialog.getByTestId('export-with-providers').click();
      await expect(exportDialog.getByTestId('export-keys-warning')).toContainText('مكشوفة');
      await page.waitForTimeout(300);
      await exportDialog.screenshot({
        path: path.join(shots, 'profile-export-providers-ar-light.png'),
      });
      const downloaded = page.waitForEvent('download');
      await exportDialog.getByTestId('start-export').click();
      await expect(exportDialog.getByTestId('export-providers-carried')).toContainText('1');
      const download = await downloaded;
      const archive = path.join(scratch, download.suggestedFilename());
      await download.saveAs(archive);
      const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
      expect(entries).toContain('studio/majlis-providers.json');
      execFileSync('tar', ['-xzf', archive, '-C', scratch]);
      const bundle = JSON.parse(
        readFileSync(path.join(scratch, 'studio', 'majlis-providers.json'), 'utf8'),
      ) as { providers: { slug: string }[] };
      // What Studio uses: its own LM Studio, which wins over the shared one of that preset.
      expect(bundle.providers.map((p) => p.slug)).toEqual(['lmstudio']);
      await exportDialog.getByRole('button', { name: 'إغلاق' }).first().click();

      // Import it as a new profile: the providers it carried are that profile's own.
      await page.getByTestId('import-workspace').click();
      const importDialog = page.getByTestId('import-workspace-dialog');
      await importDialog.getByTestId('import-file').setInputFiles(archive);
      await importDialog.getByLabel('المعرّف').fill('studio-copy');
      await importDialog.getByLabel('الاسم').fill('Studio Copy');
      await importDialog.getByTestId('start-import').click();
      await expect(importDialog).toHaveCount(0);
      await expect(page.getByTestId('workspace-list')).toContainText('Studio Copy');
      await page.getByTestId('back-to-chats').click();
      await modelsIn(page, 'Studio Copy');
      await expect.poll(() => scopes(page)).toEqual(['\u200f\u2068Studio Copy\u2069 فقط', 'مشترك']);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
