/**
 * Subscriptions signed in to through the hub's model gateway (DECISIONS §143), against the real
 * hub with the gateway's translator stand-in (`e2e/hub.ts`): the owner's two journeys.
 *
 * 1. «إضافة مزوّد» → «الدخول باشتراك»: ChatGPT by a short code (the one CLIProxyAPI prints on its
 *    command line), then Claude by a link whose landing address is pasted back.
 * 2. Clicking the ChatGPT card opens its dialog — not a page: the account, its status, its usage
 *    window with what is left and when it resets, its requests, «افحص الآن», turning it off.
 *
 * It runs late (`zzzz…`): it adds providers to the shared hub, and the journeys before it
 * photograph a Models page with none.
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

async function models(page: Page) {
  await page.getByRole('link', { name: 'الإعدادات' }).first().click();
  await page.getByTestId('settings-nav').getByRole('link', { name: 'النماذج' }).click();
  await expect(page.getByTestId('open-add-provider')).toBeVisible();
}

async function subscriptionChoice(page: Page, name: string) {
  await page.getByTestId('open-add-provider').click();
  const dialog = page.getByTestId('add-provider-dialog');
  await dialog.getByTestId('add-mode-subscription').click();
  const vendors = dialog.getByTestId('subscription-vendors');
  await expect(vendors.getByTestId('subscription-note')).toContainText('بعض المزوّدين');
  await vendors.getByText(name, { exact: true }).click();
  return dialog;
}

test.describe('subscriptions through Core Hub’s gateway', () => {
  test('signs in to ChatGPT by a code and Claude by a pasted address, and the card opens its accounts dialog', async ({
    page,
  }) => {
    await login(page);
    await models(page);

    // Hermes on Core Hub's models: a new hub with a gateway starts on it.
    await expect(page.getByTestId('hermes-source-switch')).toHaveAttribute('data-state', 'checked');

    // 1. ChatGPT by a short code.
    let dialog = await subscriptionChoice(page, 'ChatGPT (Plus / Pro / Business)');
    await dialog.getByTestId('subscription-continue').click();
    const panel = dialog.getByTestId('sign-in-panel');
    await expect(panel.getByTestId('sign-in-code')).toHaveText('FAKE-CODEX1');
    await expect(panel.getByTestId('sign-in-link')).toHaveAttribute(
      'href',
      'https://auth.openai.com/codex/device',
    );
    await page.waitForTimeout(200);
    await dialog.screenshot({ path: path.join(shots, 'subscription-code-ar-light.png') });
    await expect(panel.getByTestId('sign-in-approved')).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    const card = page.locator('[data-provider-slug="chatgpt-subscription"]');
    await expect(card.getByTestId('provider-accounts-count')).toHaveText('1 (الجاهز 1)', {
      timeout: 20_000,
    });

    // 2. Clicking the card opens its dialog.
    await card.locator('.provider-facts').click();
    const accounts = page.getByTestId('provider-accounts-dialog');
    await expect(accounts).toBeVisible();
    const account = accounts.getByTestId('account');
    await expect(account).toContainText('person@example.com');
    await expect(account.getByTestId('account-status')).toHaveText('يعمل');
    await expect(account.locator('[data-window="primary"]').getByTestId('window-left')).toHaveText(
      'المتبقي 88%',
    );
    await expect(account.getByTestId('account-buckets').locator('.account-bucket')).toHaveCount(20);
    await account.getByTestId('account-check').click();
    await expect(
      account.locator('[data-window="secondary"]').getByTestId('window-left'),
    ).toHaveText('المتبقي 45%');
    await page.waitForTimeout(200);
    await accounts.screenshot({ path: path.join(shots, 'subscription-accounts-ar-light.png') });
    await account.getByTestId('account-enabled').click();
    await expect(account.getByTestId('account-status')).toHaveText('متوقف');
    await account.getByTestId('account-enabled').click();
    await expect(account.getByTestId('account-status')).toHaveText('يعمل');
    await page.keyboard.press('Escape');
    await expect(accounts).toHaveCount(0);

    // 3. Claude by a link, and the address the browser landed on pasted back.
    dialog = await subscriptionChoice(page, 'Claude (Pro / Max)');
    await dialog.getByTestId('subscription-continue').click();
    const link = dialog.getByTestId('sign-in-link');
    await expect(link).toHaveAttribute('href', /authorize\?state=/);
    const state = new URL((await link.getAttribute('href'))!).searchParams.get('state');
    await expect(dialog.getByTestId('sign-in-paste')).toBeVisible();
    await dialog
      .getByTestId('sign-in-paste')
      .fill(`http://localhost:54545/callback?code=abc&state=${state}`);
    await page.waitForTimeout(200);
    await dialog.screenshot({ path: path.join(shots, 'subscription-link-ar-light.png') });
    await dialog.getByTestId('sign-in-paste-submit').click();
    await expect(dialog.getByTestId('sign-in-approved')).toBeVisible({ timeout: 20_000 });
  });
});
