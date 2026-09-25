/**
 * Journey 31: Telegram linked from the web (the owner, 2026-09-24: «ابي تربط التليجرام … لانه ما
 * سويت الا واتساب وانا احتاج تليجرام») — against the real hub, with Telegram's `getMe` and
 * Hermes's pairing scripted (`e2e/hub.ts`):
 *
 * - «ربط منصة» → Telegram explains @BotFather in plain steps; a token Telegram refuses is said in
 *   words;
 * - the right token links the bot, named with its @username, and its card says how to start —
 *   open t.me/<bot>, send a message, approve the request below;
 * - the Telegram stranger waiting for approval is approved in the same list as WhatsApp's;
 * - Telegram's settings: «إظهار تفكير النموذج» and «الرد عند الإشارة فقط» in groups are switched
 *   on, saved together, and read back after a reload;
 * - Unlink, behind a confirm, forgets the bot and the row leaves the list.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const TOKEN = '7012345678:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';
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

test('31. Telegram linked by a bot token: the steps, the bot named, approvals, and Unlink', async ({
  page,
}) => {
  await login(page);
  await openChannels(page);
  // ---- «ربط منصة», then Telegram: the steps, in plain words; a refused token is said in words.
  await page.getByTestId('platform-picker-open').click();
  await page.getByTestId('platform-option-telegram').click();
  const dialog = page.getByTestId('telegram-link');
  await expect(dialog).toContainText('@BotFather');
  await expect(dialog).toContainText('/newbot');
  await page.getByTestId('telegram-token').fill('7000000000:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  await page.getByTestId('telegram-link-submit').click();
  await expect(page.getByTestId('telegram-link-error')).toContainText('Unauthorized');
  await shot(page, 'agent-channels-telegram-link-ar-light');

  // ---- The right token: the bot is named, and the page says how to start.
  await page.getByTestId('telegram-token').fill(TOKEN);
  await page.getByTestId('telegram-link-submit').click();
  await expect(page.getByTestId('telegram-link-done')).toContainText('@corehub_e2e_bot');
  await page.getByTestId('telegram-link-close').click();

  await expect(page.getByTestId('channel-link-telegram')).toHaveText('مربوط');
  await expect(page.getByTestId('channel-account-telegram')).toContainText('@corehub_e2e_bot');
  await expect(page.getByTestId('channel-account-telegram')).toContainText('مساعد المركز');
  await expect(page.getByTestId('telegram-bot-link')).toHaveAttribute(
    'href',
    'https://t.me/corehub_e2e_bot',
  );
  await expect(page.getByTestId('channel-list').getByTestId('telegram-how-to-use')).toContainText(
    'رمز اقتران',
  );

  await shot(page, 'agent-channels-telegram-linked-ar-light');

  // ---- The stranger who messaged the bot waits under «الموافقات», and is approved there.
  await page.getByTestId('approvals-open').click();
  const noura = page.getByTestId('pairing-request-5d1e2f3a4b5c6d7e');
  await expect(noura).toContainText('تيليجرام', { timeout: 15_000 });
  await expect(noura).toContainText('Noura');
  await expect(page.getByTestId('pairing-pending-telegram')).toBeVisible();
  await page.getByTestId('pairing-approve-5d1e2f3a4b5c6d7e').click();
  await expect(noura).toHaveCount(0);
  await expect(page.getByTestId('pairing-sender-555666777')).toContainText('تيليجرام');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('approvals-sheet')).toHaveCount(0);

  // ---- Telegram's own settings: show the model's thinking, and answer in groups only when
  // mentioned — saved together, read back from the profile's files.
  await page.getByTestId('channel-settings-telegram').click();
  const settings = page.getByTestId('telegram-settings');
  await expect(settings.getByTestId('telegram-settings-replies')).toContainText(
    'إظهار تفكير النموذج',
  );
  await expect(page.getByTestId('telegram-setting-shared-voice_auto_tts')).toBeVisible();
  const thinking = page.getByTestId('telegram-setting-show_reasoning');
  const mention = page.getByTestId('telegram-setting-require_mention');
  await expect(thinking).toHaveAttribute('aria-checked', 'false');
  await thinking.click();
  await mention.click();
  await page.getByTestId('telegram-settings-save').click();
  await expect(page.getByTestId('telegram-settings-saved')).toBeVisible();
  await shot(page, 'agent-channels-telegram-settings-ar-light');
  await page.reload();
  await page.getByTestId('channel-settings-telegram').click();
  await expect(page.getByTestId('telegram-setting-show_reasoning')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByTestId('telegram-setting-require_mention')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByTestId('telegram-setting-reset-show_reasoning')).toBeVisible();

  // ---- Unlink, behind a confirm.
  await page.getByTestId('channel-unlink-telegram').click();
  await expect(page.getByTestId('confirm-dialog')).toContainText('BotFather');
  await page.getByTestId('confirm-yes').click();
  await expect(page.getByTestId('channel-unlinked')).toBeVisible();
  await expect(page.getByTestId('channel-link-telegram')).toHaveCount(0);
  await expect(page.getByTestId('telegram-how-to-use')).toHaveCount(0);
  await expect(page.getByTestId('platform-picker-open')).toBeVisible();
});
