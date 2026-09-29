/**
 * 34b. "Send test message" as the owner's tester used it (2026-09-29), against the real hub
 * with its fake Telegram (e2e/hub.ts: chat `-100404` is one Telegram does not know).
 *
 * A saved workflow "test": an agent step, then a "Send message" step whose words are
 * `{{steps.agent_1.output}}`, to a Telegram group whose id was copied out of right-to-left
 * text (an invisible mark in front). Run once, then the page is opened again, as the tester
 * did: "Use the last run's values" fills the value and the page stays; the test sends the
 * agent's answer and shows "Sent", where, and Telegram's message id; a chat Telegram does not
 * know shows Telegram's own words; plain words with no variable send too. None of it is saved
 * into the step.
 */
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const CHAT = '-1003938641118';
const ANSWER = 'القائمة سليمة: ثلاثة بنود جاهزة.';

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
  return (
    (await res.json()) as { sent: Array<{ chat_id: string; text: string; message_id: number }> }
  ).sent;
}

test('34b. Send test message always ends in a visible result, and the last run fills its values', async ({
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
  const canvas = page.getByTestId('workflow-canvas');
  await page.getByTestId('workflow-name').fill('test');
  await page.getByTestId('workflow-add-agent').click();
  await page.getByTestId('workflow-step-agent').click();
  await page.getByRole('option', { name: /Direct|مباشر/ }).click();
  await page.getByTestId('workflow-step-prompt').fill('راجع قائمة الإصدار وقل ما فيها');
  await page.getByTestId('workflow-add-send').click();
  // Nothing to send to yet: the button is off and says why.
  await expect(page.getByTestId('workflow-send-test')).toBeDisabled();
  await expect(page.getByTestId('workflow-send-blocked')).toContainText('اختر أولًا أين تُرسل');
  await page.getByTestId('workflow-step-text').fill('{{steps.agent_1.output}}');
  await page.getByTestId('workflow-send-telegram').click();
  await page.getByTestId('workflow-send-chat').fill(`‎${CHAT}`);
  const port = canvas
    .locator('[data-node-id="agent_1"]')
    .first()
    .getByTestId('workflow-port-success');
  const from = (await port.boundingBox())!;
  const to = (await canvas.locator('[data-node-id="notify_1"]').first().boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('workflow-edge')).toHaveCount(1);
  await expect(page.getByTestId('workflow-check')).toHaveAttribute('data-valid', 'true');
  await page.getByTestId('workflow-save').click();
  await expect(editor).not.toHaveAttribute('data-workflow-id', 'new');
  await page.getByTestId('workflow-run').click();
  await expect(
    page.getByTestId('workflow-run-view').getByTestId('workflow-run-state'),
  ).toContainText('تم', { timeout: 20_000 });
  // The run itself reached the group, the invisible mark notwithstanding.
  expect((await sentToTelegram(page)).slice(before).map((m) => [m.chat_id, m.text])).toEqual([
    [CHAT, ANSWER],
  ]);

  // Opened again, as the tester did.
  await page.reload();
  await page.getByTestId('workflow-modes').getByRole('tab', { name: 'تحرير' }).click();
  await canvas.locator('[data-node-id="notify_1"]').first().click();
  await expect(page.getByTestId('workflow-send-sample')).toBeVisible();
  const send = page.getByTestId('workflow-send-test');
  await expect(send).toBeDisabled();

  // (d) The last run's values: filled, and the page is still there.
  await page.getByTestId('workflow-send-last-run').click();
  await expect(page.getByTestId('workflow-send-value-steps.agent_1.output')).toHaveValue(ANSWER);
  await expect(page.getByTestId('workflow-send-preview')).toHaveText(ANSWER);
  await expect(editor).toBeVisible();
  await expect(page.getByTestId('workflow-panel-failed')).toHaveCount(0);

  // (b) The variable filled from the last run: sent, where, and Telegram's message id.
  await expect(send).toBeEnabled();
  await send.click();
  const result = page.getByTestId('workflow-send-test-result');
  await expect(result).toHaveAttribute('data-status', 'sent');
  await expect(result).toContainText('أُرسلت');
  await expect(result.getByTestId('workflow-send-test-delivered')).toContainText(
    `telegram:${CHAT}`,
  );
  let sent = (await sentToTelegram(page)).slice(before);
  expect(sent.map((m) => [m.chat_id, m.text])).toEqual([
    [CHAT, ANSWER],
    [CHAT, ANSWER],
  ]);
  await expect(result.getByTestId('workflow-send-test-ids')).toContainText(
    String(sent[1]!.message_id),
  );

  // (c) A chat Telegram does not know: its own words, never silence.
  await page.getByTestId('workflow-send-chat').fill('-100404');
  await send.click();
  await expect(result).toHaveAttribute('data-status', 'failed');
  await expect(result).toContainText('لم تُرسل');
  await expect(result).toContainText('Bad Request: chat not found');

  // (a) Plain words, no variable: sent, with its message id.
  await page.getByTestId('workflow-send-chat').fill(CHAT);
  await page.getByTestId('workflow-step-text').fill('CORE_HUB_TELEGRAM_TEST_OK');
  await expect(page.getByTestId('workflow-send-sample')).toHaveCount(0);
  await send.click();
  await expect(result).toHaveAttribute('data-status', 'sent');
  sent = (await sentToTelegram(page)).slice(before);
  expect(sent.at(-1)).toMatchObject({ chat_id: CHAT, text: 'CORE_HUB_TELEGRAM_TEST_OK' });
  await expect(result.getByTestId('workflow-send-test-ids')).toContainText(
    String(sent.at(-1)!.message_id),
  );

  // The tests saved nothing: opened again, the step's words are as they were saved.
  await page.reload();
  await page.getByTestId('workflow-modes').getByRole('tab', { name: 'تحرير' }).click();
  await canvas.locator('[data-node-id="notify_1"]').first().click();
  await expect(page.getByTestId('workflow-step-text')).toHaveValue('{{steps.agent_1.output}}');
  expect(crashes).toEqual([]);
});
