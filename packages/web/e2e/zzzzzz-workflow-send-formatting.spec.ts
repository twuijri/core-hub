/**
 * 34c. Telegram formatting of a "Send message" step (DECISIONS §137), against the real hub and
 * its fake Telegram (e2e/hub.ts), which parses `parse_mode` HTML / MarkdownV2 as Telegram does.
 *
 * In Arabic: a new workflow with a Send message step to a Telegram group. Plain by default: the
 * preview says so and the test arrives with the tags as written and no `parse_mode`. HTML: the
 * preview says "تنسيق تيليجرام: HTML" and draws the words bold, and the test arrives bold. Broken
 * HTML is flagged in the preview, and its test fails with the mode and Telegram's own words, with
 * no message id. MarkdownV2 is drawn too. Saved and run, the step sends with its formatting.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const CHAT = '-1005550001111';
const shots = process.env.COREHUB_SHOTS ?? path.resolve('e2e/shots');
mkdirSync(shots, { recursive: true });

test.use({ viewport: { width: 1440, height: 1100 } });

interface Sent {
  chat_id: string;
  text: string;
  parse_mode: string | null;
  has_parse_mode: boolean;
  plain: string;
  entities: Array<{ type: string; offset: number; length: number }>;
  message_id: number;
}

async function login(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('اسم المستخدم').fill('admin');
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/chat$/);
}

async function inDefault(page: Page) {
  const top = page.getByTestId('workspace-switcher').first();
  if ((await top.count()) && !(await top.textContent())?.includes('Default')) {
    await top.click();
    await page.getByRole('option', { name: 'Default', exact: true }).click();
  }
}

async function sentToTelegram(page: Page): Promise<Sent[]> {
  const res = await page.request.get('/__e2e/telegram');
  return ((await res.json()) as { sent: Sent[] }).sent;
}

test('34c. Telegram formatting: the selector, the preview label, and the test send', async ({
  page,
}) => {
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));
  await login(page);
  await inDefault(page);
  const before = (await sentToTelegram(page)).length;

  await page.getByTestId('rail').getByRole('link', { name: 'سير العمل', exact: true }).click();
  await page.getByTestId('workflow-new').click();
  const editor = page.getByTestId('workflow-editor');
  await page.getByTestId('workflow-name').fill('تنسيق تيليجرام');
  await page.getByTestId('workflow-add-send').click();
  const words = page.getByTestId('workflow-step-text');
  await words.fill('<b>اختبار</b>');
  await page.getByTestId('workflow-send-telegram').click();
  await page.getByTestId('workflow-send-chat').fill(CHAT);

  const label = page.getByTestId('workflow-send-formatting-label');
  const preview = page.getByTestId('workflow-send-preview');
  const send = page.getByTestId('workflow-send-test');
  const result = page.getByTestId('workflow-send-test-result');

  // Plain by default: said, and the tags go as written, with no parse_mode at all.
  await expect(label).toHaveText('تنسيق تيليجرام: نص عادي');
  await expect(page.getByTestId('workflow-send-formatting-plain')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(preview).toHaveText('<b>اختبار</b>');
  await send.click();
  await expect(result).toHaveAttribute('data-status', 'sent');
  let sent = (await sentToTelegram(page)).slice(before);
  expect(sent.at(-1)).toMatchObject({
    chat_id: CHAT,
    text: '<b>اختبار</b>',
    has_parse_mode: false,
    plain: '<b>اختبار</b>',
    entities: [],
  });

  // HTML: the label, the words drawn bold, and the test arrives bold.
  await page.getByTestId('workflow-send-formatting-html').click();
  await expect(label).toHaveText('تنسيق تيليجرام: HTML');
  await expect(page.getByTestId('workflow-send-formatting-html')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByTestId('workflow-send-formatting-example')).toContainText('<b>bold</b>');
  await expect(preview.locator('strong')).toHaveText('اختبار');
  await expect(preview).toHaveText('اختبار');
  await page.getByTestId('workflow-send-formatting-field').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, 'workflow-send-formatting-html.png') });
  await send.click();
  await expect(result).toHaveAttribute('data-status', 'sent');
  await expect(result.getByTestId('workflow-send-test-ids')).toBeVisible();
  sent = (await sentToTelegram(page)).slice(before);
  expect(sent.at(-1)).toMatchObject({
    chat_id: CHAT,
    parse_mode: 'HTML',
    plain: 'اختبار',
    entities: [{ type: 'bold', offset: 0, length: 6 }],
  });
  const count = sent.length;

  // Broken HTML: flagged in the preview; the test fails in words that name the mode, no id.
  await words.fill('<b>بلا إغلاق');
  await expect(page.getByTestId('workflow-send-preview-invalid')).toContainText(
    'سيرفض تيليجرام تنسيق HTML',
  );
  await send.click();
  await expect(result).toHaveAttribute('data-status', 'failed');
  await expect(result).toContainText("Telegram HTML formatting failed: can't parse entities");
  await expect(result.getByTestId('workflow-send-test-ids')).toHaveCount(0);
  expect((await sentToTelegram(page)).slice(before)).toHaveLength(count);

  // MarkdownV2 is drawn too.
  await page.getByTestId('workflow-send-formatting-markdown_v2').click();
  await words.fill('*عريض* و _مائل_ انتهى\\.');
  await expect(label).toHaveText('تنسيق تيليجرام: MarkdownV2');
  await expect(preview.locator('strong')).toHaveText('عريض');
  await expect(preview.locator('em')).toHaveText('مائل');

  // Saved with HTML and run: the run sends with its formatting.
  await page.getByTestId('workflow-send-formatting-html').click();
  await words.fill('<b>{{input}}</b> تم');
  await expect(page.getByTestId('workflow-check')).toHaveAttribute('data-valid', 'true');
  await page.getByTestId('workflow-save').click();
  await expect(editor).not.toHaveAttribute('data-workflow-id', 'new');
  await page.getByTestId('workflow-run-input').fill('الإصدار');
  await page.getByTestId('workflow-run').click();
  await expect(
    page.getByTestId('workflow-run-view').getByTestId('workflow-run-state'),
  ).toContainText('تم', { timeout: 20_000 });
  sent = (await sentToTelegram(page)).slice(before);
  expect(sent.at(-1)).toMatchObject({
    chat_id: CHAT,
    parse_mode: 'HTML',
    plain: 'الإصدار تم',
    entities: [{ type: 'bold', offset: 0, length: 7 }],
  });

  // Opened again: the step still says HTML.
  await page.reload();
  await page.getByTestId('workflow-modes').getByRole('tab', { name: 'تحرير' }).click();
  await page.getByTestId('workflow-canvas').locator('[data-node-id="notify_1"]').first().click();
  await expect(page.getByTestId('workflow-send-formatting-label')).toHaveText(
    'تنسيق تيليجرام: HTML',
  );
  expect(crashes).toEqual([]);
});
