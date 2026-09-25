/**
 * Journey 41: more messaging platforms linked from the web like Telegram — Discord, against the
 * real hub, with Discord's `/users/@me` scripted (`e2e/hub.ts`):
 *
 * - «منصات أخرى» offers «ربط ديسكورد»; its dialog explains the developer portal in plain steps;
 * - a token Discord refuses is said in Discord's words; the right one links the bot, named;
 * - Discord's own settings: «في القنوات: الرد عند الإشارة فقط» switched off and a channel allowed,
 *   saved together and read back after a reload;
 * - Unlink, behind a confirm, forgets the bot and brings «ربط ديسكورد» back.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const TOKEN = 'fake-discord-token-for-e2e-only-000000000000000000000000000000001';
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

async function openChannels(page: Page) {
  await page.getByTestId('rail').getByRole('link', { name: 'الوكلاء' }).click();
  await page.getByTestId('agent-menu').getByRole('link', { name: 'القنوات' }).first().click();
  await expect(page).toHaveURL(/\/channels$/);
}

test('41. Discord linked like Telegram: the steps, the bot named, its settings, and Unlink', async ({
  page,
}) => {
  await login(page);
  await openChannels(page);

  // ---- The catalog offers it; the dialog explains the developer portal.
  const open = page.getByTestId('platform-link-discord');
  await expect(open).toHaveText('ربط ديسكورد');
  await expect(page.getByTestId('platform-generic')).toContainText('Signal');
  await open.click();
  const dialog = page.getByTestId('platform-link');
  await expect(dialog).toContainText('ربط ديسكورد');
  await expect(page.getByTestId('platform-steps')).toContainText('Message Content Intent');
  await expect(page.getByTestId('platform-allowlist-empty')).toBeVisible();

  // ---- A refused token, in Discord's words.
  await page
    .getByTestId('platform-field-DISCORD_BOT_TOKEN')
    .fill('fake-discord-token-for-e2e-only-0000000000000000000000000000000bad');
  await page.getByTestId('platform-allowed').fill('111222333444555666');
  await page.getByTestId('platform-link-submit').click();
  await expect(page.getByTestId('platform-link-error')).toContainText('401: Unauthorized');
  await shot(page, 'agent-channels-discord-link-ar-light');

  // ---- The right token: the bot is named.
  await page.getByTestId('platform-field-DISCORD_BOT_TOKEN').fill(TOKEN);
  await page.getByTestId('platform-link-submit').click();
  await expect(page.getByTestId('platform-link-done')).toContainText('@corehub_discord');
  await page.getByTestId('platform-link-close').click();

  await expect(page.getByTestId('channel-link-discord')).toHaveText('مربوط');
  await expect(page.getByTestId('channel-account-discord')).toContainText('@corehub_discord');
  await expect(page.getByTestId('channel-account-discord')).toContainText('مساعد ديسكورد');
  await expect(page.getByTestId('platform-how-discord')).toBeVisible();
  await expect(page.getByTestId('platform-link-discord')).toHaveCount(0);
  await shot(page, 'agent-channels-discord-linked-ar-light');

  // ---- Discord's own settings, saved together and read back.
  await page.getByTestId('channel-settings-discord').click();
  const mention = page.getByTestId('discord-setting-require_mention');
  await expect(page.getByTestId('discord-settings-groups')).toContainText(
    'في القنوات: الرد عند الإشارة فقط',
  );
  await expect(mention).toHaveAttribute('aria-checked', 'true');
  await mention.click();
  await page.getByTestId('discord-setting-allowed_channels').fill('1111, 2222');
  await page.getByTestId('discord-settings-save').click();
  await expect(page.getByTestId('discord-settings-saved')).toBeVisible();
  await shot(page, 'agent-channels-discord-settings-ar-light');
  await page.reload();
  await page.getByTestId('channel-settings-discord').click();
  await expect(page.getByTestId('discord-setting-require_mention')).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await expect(page.getByTestId('discord-setting-allowed_channels')).toHaveValue('1111, 2222');

  // ---- Unlink, behind a confirm.
  await page.getByTestId('channel-unlink-discord').click();
  await expect(page.getByTestId('confirm-dialog')).toContainText('ديسكورد');
  await page.getByTestId('confirm-yes').click();
  await expect(page.getByTestId('channel-link-discord')).toHaveText('غير مربوط');
  await expect(page.getByTestId('platform-link-discord')).toBeVisible();
});
