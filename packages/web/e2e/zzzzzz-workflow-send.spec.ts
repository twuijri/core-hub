/**
 * 34. A "Send message" step, against the real hub (2026-09-28, DECISIONS §124).
 *
 * In Arabic: a conversation started in the chat; a new workflow with a "Send message" step
 * whose words read the run's input, sent to a Telegram group (the e2e hub answers Telegram's
 * Bot API itself) and posted in that conversation. "Send test message" goes to both; a chat
 * Telegram does not know comes back with Telegram's own words and "sent to some targets
 * only"; the workflow saved and run by hand puts the message in Telegram once and in the
 * conversation, where it is read in the chat. The test never sends `{{input}}` as it is: it
 * waits for a value — typed, then taken from the run — and previews the words (2026-09-29).
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const GROUP = '-1009876543210';
const shots = process.env.COREHUB_SHOTS ?? path.resolve('e2e/shots');
mkdirSync(shots, { recursive: true });
const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });

test.use({ viewport: { width: 1440, height: 1100 } });

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

async function sentToTelegram(page: Page) {
  const res = await page.request.get('/__e2e/telegram');
  return ((await res.json()) as { sent: Array<{ chat_id: string; text: string }> }).sent;
}

test('34. a Send message step sends to Telegram and posts in a conversation', async ({ page }) => {
  await login(page);
  await inDefault(page);
  const before = (await sentToTelegram(page)).length;

  // A conversation to post in.
  await page.getByRole('link', { name: 'محادثة جديدة' }).first().click();
  await expect(page.getByTestId('composer-input')).toBeEnabled();
  await page.getByTestId('composer-input').fill('محادثة التقارير اليومية');
  await page.getByTestId('send').click();
  await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}/);
  const chatUrl = page.url();

  // The workflow: one "Send message" step.
  await page.getByTestId('rail').getByRole('link', { name: 'سير العمل', exact: true }).click();
  await page.getByTestId('workflow-new').click();
  const editor = page.getByTestId('workflow-editor');
  await page.getByTestId('workflow-name').fill('تقرير إلى تيليجرام');
  await page.getByTestId('workflow-add-send').click();
  await page.getByTestId('workflow-step-text').fill('التقرير: {{input}}');
  await page.getByTestId('workflow-send-telegram').click();
  await page.getByTestId('workflow-send-chat').fill('-100404');
  await page.getByTestId('workflow-send-conversation').click();
  // The profile's conversations load once the target is ticked; the one just started is there.
  const picker = page.getByTestId('workflow-send-session');
  await expect(async () => {
    await picker.click();
    // The first item is the placeholder; a conversation follows it.
    await expect(page.getByRole('listbox').getByRole('option').nth(1)).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 15_000 });
  await page.getByRole('listbox').getByRole('option').nth(1).click();
  await expect(picker).not.toContainText('اختر محادثة');

  // The words read `{{input}}`: nothing is sent until it has a value (2026-09-29). No run yet,
  // so the value is typed; the preview shows what will go.
  const send = page.getByTestId('workflow-send-test');
  await expect(page.getByTestId('workflow-send-no-run')).toBeVisible();
  await expect(page.getByTestId('workflow-send-preview')).toHaveText('التقرير: {{input}}');
  await expect(page.getByTestId('workflow-send-missing')).toContainText('{{input}}');
  await expect(send).toBeDisabled();
  await page.getByTestId('workflow-send-value-input').fill('تجربة يدوية');
  await expect(page.getByTestId('workflow-send-preview')).toHaveText('التقرير: تجربة يدوية');
  await expect(page.getByTestId('workflow-send-missing')).toHaveCount(0);
  await expect(send).toBeEnabled();

  // A chat Telegram does not know: its words, and the conversation still took it.
  await page.getByTestId('workflow-send-test').click();
  const result = page.getByTestId('workflow-send-test-result');
  await expect(result).toContainText('أُرسلت إلى بعض الوجهات فقط');
  await expect(result).toContainText('Bad Request: chat not found');

  // The group: both take it.
  await page.getByTestId('workflow-send-chat').fill(GROUP);
  await page.getByTestId('workflow-send-test').click();
  await expect(result).toContainText('أُرسلت');
  await expect(result).not.toContainText('Bad Request');
  expect((await sentToTelegram(page)).slice(before).map((m) => [m.chat_id, m.text])).toEqual([
    [GROUP, 'التقرير: تجربة يدوية'],
  ]);
  await expect(page.getByTestId('workflow-check')).toHaveAttribute('data-valid', 'true');
  await shot(page, 'workflow-send-ar-light');

  await page.getByTestId('workflow-save').click();
  await expect(editor).not.toHaveAttribute('data-workflow-id', 'new');
  await page.getByTestId('workflow-run-input').fill('كل المهام تمت');
  await page.getByTestId('workflow-run').click();
  const run = page.getByTestId('workflow-run-view');
  await expect(run.getByTestId('workflow-run-state')).toContainText('تم', { timeout: 20_000 });
  expect((await sentToTelegram(page)).slice(before).map((m) => m.text)).toEqual([
    'التقرير: تجربة يدوية',
    'التقرير: كل المهام تمت',
  ]);

  // Back to the drawing: the test takes its value from that run.
  await page.getByTestId('workflow-modes').getByRole('tab', { name: 'تحرير' }).click();
  await page.getByTestId('workflow-node').first().click();
  await expect(page.getByTestId('workflow-send-value-input')).toHaveValue('');
  await expect(send).toBeDisabled();
  await page.getByTestId('workflow-send-last-run').click();
  await expect(page.getByTestId('workflow-send-value-input')).toHaveValue('كل المهام تمت');
  await expect(page.getByTestId('workflow-send-preview')).toHaveText('التقرير: كل المهام تمت');
  await shot(page, 'workflow-send-sample-ar-light');
  await send.click();
  await expect(page.getByTestId('workflow-send-test-result')).toContainText('أُرسلت');
  expect((await sentToTelegram(page)).slice(before).map((m) => m.text)).toEqual([
    'التقرير: تجربة يدوية',
    'التقرير: كل المهام تمت',
    'التقرير: كل المهام تمت',
  ]);

  // The conversation shows what the step posted.
  await page.goto(chatUrl);
  await expect(page.getByText('التقرير: كل المهام تمت')).toBeVisible();
});
