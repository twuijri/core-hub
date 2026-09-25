/**
 * 33. Telegram conversations in the chats list (contract decision §55), against the real hub
 *     with a scripted Hermes behind it: a conversation Hermes keeps for Telegram shows under
 *     «تيليجرام», and opens as a read-only transcript — the person's message and the agent's
 *     reply, and in the composer's place the banner «محادثة من تيليجرام — للقراءة فقط؛ الرد
 *     يكون من تيليجرام».
 *
 * The scripted Hermes is off for every other journey (`/__e2e/channels`), so their lists do not
 * change; this one turns it on and off again. Runs last (`zzzzzzzz-`).
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const CONVERSATION = '20260925_091500_e2e0tg01';
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

test('33. a Telegram conversation shows under «تيليجرام» and opens read-only', async ({
  page,
  request,
}) => {
  expect((await request.post('/__e2e/channels', { data: { on: true } })).ok()).toBe(true);
  try {
    await login(page);
    const list = page.getByTestId('session-list');
    const telegram = list
      .getByTestId('session-group')
      .filter({ has: page.getByTestId('session-group-toggle').getByText('تيليجرام') });
    await expect(telegram).toHaveCount(1);
    const row = telegram.getByTestId('channel-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('أحمد من تيليجرام');
    // The latest message, the agent's, as plain words.
    await expect(row).toContainText('موعد التسليم يوم الخميس');

    await row.getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`/chat/${CONVERSATION}\\?source=channel`));
    const screen = page.getByTestId('channel-screen');
    await expect(screen.getByTestId('message-user')).toContainText('متى موعد التسليم؟');
    await expect(screen.getByTestId('message-assistant')).toContainText(
      'موعد التسليم يوم الخميس، وسأذكّرك قبله بيوم.',
    );
    await expect(page.getByTestId('channel-readonly')).toHaveText(
      'محادثة من تيليجرام — للقراءة فقط؛ الرد يكون من تيليجرام',
    );
    // Read-only: there is nothing to write with, and the row shows as the one open.
    await expect(page.getByTestId('composer-input')).toHaveCount(0);
    await expect(row).toHaveAttribute('data-active', 'true');
    await page.screenshot({ path: path.join(shots, 'channel-conversation-ar-light.png') });

    // A reload opens it again from the address alone.
    await page.reload();
    await expect(page.getByTestId('channel-readonly')).toBeVisible();

    // «أكمل في كور هب» (§58): a new chat in this profile whose first message carries the
    // summary, the note and the transcript, sent by the chat once it listens.
    await page.getByTestId('channel-continue').click();
    await page.getByTestId('channel-continue-note').fill('جهّز له ردًّا.');
    await page.getByTestId('channel-continue-go').click();
    await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}(\?profile=[a-z0-9-]+)?$/);
    const first = page.getByTestId('message-user').first();
    await expect(first).toContainText('نكمل هنا محادثة من تيليجرام مع «أحمد');
    await expect(first).toContainText('جهّز له ردًّا.');
    await expect(first).toContainText('telegram-');
    await expect(page.getByTestId('message-assistant').last()).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: path.join(shots, 'channel-continue-ar-light.png') });
  } finally {
    await request.post('/__e2e/channels', { data: { on: false } });
  }
});
