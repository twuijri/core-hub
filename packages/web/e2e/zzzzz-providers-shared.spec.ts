/**
 * Providers are the hub's, not a profile's (contract decision §34, ADR 0010), against the
 * real hub.
 *
 * The owner's rule as a journey: a provider added while in a second profile is on the Models
 * page of the default profile too, with nothing typed twice; the page says the list is shared
 * by every profile; and the second profile's Defaults tab shows the model it inherits from the
 * default profile, saying where it came from.
 *
 * It runs last on purpose (`zzzzz-`): it adds a provider and a profile to the shared hub, and
 * every journey before it photographs a Models page with no provider on it.
 */
import { mkdirSync } from 'node:fs';
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

/** A second profile, made the way a person makes one. */
async function ensureStudio(page: Page) {
  await page.getByRole('link', { name: 'الإعدادات' }).first().click();
  await page.getByTestId('settings-nav').getByRole('link', { name: 'البروفايلات' }).click();
  await expect(page.getByTestId('workspace-list')).toBeVisible();
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

test.describe('one provider list for every profile', () => {
  test('a provider added in a second profile is on the default profile too, and the second profile says which model it inherits', async ({
    page,
  }) => {
    await login(page);
    await ensureStudio(page);

    // In Studio: the page says the list is every profile's, then LM Studio is added.
    await modelsIn(page, 'Studio');
    await expect(page.getByText(/مشتركون بين كل البروفايلات/)).toBeVisible();
    await page.getByTestId('open-add-provider').click();
    await page.getByTestId('add-preset').click();
    await page.getByRole('option', { name: 'LM Studio' }).click();
    await page.getByTestId('add-submit').click();
    await expect(page.getByTestId('add-provider-dialog')).toHaveCount(0);
    const list = page.getByTestId('provider-list');
    await expect(list).toContainText('LM Studio');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(shots, 'providers-shared-studio-ar-light.png') });

    // Studio chose no model of its own: its Defaults tab shows the default profile's — the
    // first model of the first provider, set once the provider's list has arrived — and says
    // so. The list arrives as a job, so the page is read again once it has.
    await expect
      .poll(async () => {
        await page.reload();
        await page.getByTestId('models-tabs').getByText('الافتراضيات').click();
        await page.getByTestId('default-chat').waitFor();
        return page.getByTestId('default-chat-inherited').count();
      })
      .toBe(1);
    await expect(page.getByTestId('default-chat-inherited')).toHaveText('من البروفايل الافتراضي');

    // The default profile has the same provider — nobody added it there.
    await modelsIn(page, 'Default');
    await expect(page.getByTestId('provider-list')).toContainText('LM Studio');
    // And adding it again from here is not offered: it is already the hub's.
    await page.getByTestId('open-add-provider').click();
    await page.getByTestId('add-preset').click();
    await expect(page.getByRole('option', { name: 'LM Studio' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('add-provider-dialog')).toHaveCount(0);

    // In the default profile the choice is its own: nothing inherited to point at.
    await page.getByTestId('models-tabs').getByText('الافتراضيات').click();
    await expect(page.getByTestId('default-chat')).toBeVisible();
    await expect(page.getByTestId('default-chat-inherited')).toHaveCount(0);
  });
});
