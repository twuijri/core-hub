/**
 * 35. A reply's own files are seen on it (owner, 2026-09-26: «سوي صورة قط يطير» — the reply
 *     said the picture was saved, printed `/data/workspaces/…/.corehub/runs/<run>/out/
 *     flying_cat.png`, and showed no picture; «ما فتحلي الصورة»). A scripted run leaves
 *     `flying_cat.png` in the run's output folder and names it by that folder's full path, as the
 *     owner's model did. The picture is drawn in the reply, the words say the file's name — not
 *     the machine's folder — and both open the picture beside the chat; the Files list has it.
 *
 * Runs after the other journeys, which count the rows of the session list.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const shots = process.env.COREHUB_SHOTS ?? path.resolve('e2e/shots');
mkdirSync(shots, { recursive: true });

async function login(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('اسم المستخدم').fill('admin');
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/chat$/);
}

test('35. the picture an agent left for the person is drawn on its reply', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'محادثة جديدة' }).first().click();
  await expect(page).toHaveURL(/\/new$/);
  await expect(async () => {
    await page.getByTestId('composer-input').fill('سوي صورة قط يطير');
    await expect(page.getByTestId('send')).toBeEnabled({ timeout: 1_000 });
  }).toPass();
  await page.getByTestId('send').click();
  await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}(\?profile=[a-z0-9-]+)?$/);

  const reply = page.getByTestId('message-assistant').last();
  const picture = reply.getByTestId('message-image');
  await expect(picture).toBeVisible({ timeout: 20_000 });
  await expect(picture).toHaveAttribute('alt', 'flying_cat.png');
  // The bytes arrived and decoded: a real picture, not a broken frame.
  await expect
    .poll(() => picture.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBe(48);

  // The words name the file, and never the hub's folder on the machine.
  await expect(reply.getByTestId('file-mention')).toHaveText('flying_cat.png');
  await expect(reply).not.toContainText('.corehub');
  await expect(reply).not.toContainText('/data/');
  await page.screenshot({ path: path.join(shots, '35-reply-picture.png') });

  // The picture opens beside the chat, as any file of the conversation does.
  await reply
    .getByRole('button', { name: /flying_cat\.png/ })
    .first()
    .click();
  const pane = page.getByTestId('split-pane');
  await expect(pane.getByTestId('file-name')).toHaveText('flying_cat.png');
  await expect(pane.locator('img')).toBeVisible();

  // …and the conversation's Files list has it.
  await expect(page.getByTestId('chat-files')).toHaveText('الملفات (1)');
});
