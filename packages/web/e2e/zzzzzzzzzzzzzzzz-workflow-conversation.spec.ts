/**
 * 43. An agent step that talks in the same conversation every run (DECISIONS §136), against
 * the real hub (the scripted runner answers "تابع المحادثة: …" with "تمت متابعة: …").
 *
 * In Arabic: a conversation started in the chat; a workflow whose agent step is set to "the
 * same conversation every run" by choosing that conversation from the picker (searched by its
 * title); "Test conversation" says it is ready; two runs by hand put both prompts and both
 * replies, in order, in that one conversation, and each run's step shows its own reply and
 * opens the conversation. A pasted id of a conversation that does not exist is said at once,
 * and a run with it fails saying so — no new conversation is made in silence.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { addStep, closeDialog, openStep, runByHand } from './workflow-canvas.js';

const PASSWORD = 'e2e-owner-password';
const NOWHERE = '01J8QK3ZR2W7M5N4P6T8V9X0ZZ';
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

async function runOnce(page: Page, input: string) {
  await runByHand(page, input);
  const run = page.getByTestId('workflow-run-view');
  await expect(
    run.locator('[data-testid="workflow-node"][data-node-id="agent_1"]'),
  ).toHaveAttribute('data-state', /done|failed/, { timeout: 20_000 });
  return run;
}

test('43. an agent step talks in the same conversation every run', async ({ page }) => {
  await login(page);
  await inDefault(page);

  // The conversation the workflow will talk in, with a title to find it by.
  await page.getByRole('link', { name: 'محادثة جديدة' }).first().click();
  await expect(page.getByTestId('composer-input')).toBeEnabled();
  await page.getByTestId('composer-input').fill('متابعة المهام اليومية');
  await page.getByTestId('send').click();
  await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}/);
  const chatUrl = page.url();
  const chatId = /\/chat\/([0-9A-Z]{26})/.exec(chatUrl)![1]!;

  await page.getByTestId('rail').getByRole('link', { name: 'سير العمل', exact: true }).click();
  await page.getByTestId('workflow-new').click();
  const editor = page.getByTestId('workflow-editor');
  await page.getByTestId('workflow-name').fill('متابعة في محادثة واحدة');
  await addStep(page, 'agent');
  await page.getByTestId('workflow-step-agent').click();
  await page.getByRole('option').nth(1).click();
  await page.getByTestId('workflow-step-prompt').fill('تابع المحادثة: {{input}}');

  // "The same conversation every run": the picker comes first.
  await page.getByRole('radio', { name: 'المحادثة نفسها في كل تشغيل' }).click();
  await expect(page.getByTestId('workflow-conversation-id')).toHaveCount(0);
  await page.getByTestId('workflow-conversation-pick').click();
  // The profile's conversations, newest first, each with when it was last active.
  const options = page
    .getByTestId('workflow-conversation-pick-popup')
    .getByTestId('combobox-option');
  await expect(options.first()).toContainText('آخر نشاط');
  await options.first().click();
  await expect(page.getByTestId('workflow-conversation')).toContainText(chatId);
  const result = page.getByTestId('workflow-conversation-result');
  await expect(result).toHaveAttribute('data-status', 'ready');
  await expect(result).toContainText('جاهزة');
  await page.getByTestId('workflow-conversation-test').click();
  await expect(result).toHaveAttribute('data-status', 'ready');
  await expect(page.getByTestId('workflow-conversation-create')).not.toBeChecked();
  await expect(page.getByTestId('workflow-check')).toHaveAttribute('data-valid', 'true');
  await shot(page, 'workflow-conversation-ar-light');

  await closeDialog(page);
  await page.getByTestId('workflow-save').click();
  await expect(editor).not.toHaveAttribute('data-workflow-id', 'new');

  // Two runs: both land in the one conversation, each step with its own reply.
  let run = await runOnce(page, 'الأولى');
  await run.locator('[data-testid="workflow-node"][data-node-id="agent_1"]').click();
  await expect(run.getByTestId('workflow-step-output')).toHaveText('تمت متابعة: الأولى');
  await expect(run.getByTestId('workflow-step-conversation')).toHaveAttribute(
    'href',
    new RegExp(chatId),
  );
  await page.getByTestId('workflow-modes').getByRole('tab', { name: 'تحرير' }).click();
  run = await runOnce(page, 'الثانية');
  await run.locator('[data-testid="workflow-node"][data-node-id="agent_1"]').click();
  await expect(run.getByTestId('workflow-step-output')).toHaveText('تمت متابعة: الثانية');

  await page.goto(chatUrl);
  const transcript = page.getByTestId('chat-screen');
  for (const text of [
    'تابع المحادثة: الأولى',
    'تمت متابعة: الأولى',
    'تابع المحادثة: الثانية',
    'تمت متابعة: الثانية',
  ]) {
    await expect(transcript.getByText(text, { exact: true })).toBeVisible();
  }
  const order = await transcript.evaluate((node) => node.textContent ?? '');
  const at = (text: string) => order.indexOf(text);
  expect(at('تابع المحادثة: الأولى')).toBeLessThan(at('تمت متابعة: الأولى'));
  expect(at('تمت متابعة: الأولى')).toBeLessThan(at('تابع المحادثة: الثانية'));
  expect(at('تابع المحادثة: الثانية')).toBeLessThan(at('تمت متابعة: الثانية'));

  // A pasted id of a conversation that does not exist: said at once, and the run fails.
  await page.getByTestId('rail').getByRole('link', { name: 'سير العمل', exact: true }).click();
  // One conversation in the chat list, not one per run.
  await page
    .getByTestId('workflow-card')
    .filter({ hasText: 'متابعة في محادثة واحدة' })
    .getByRole('button', { name: 'تحرير' })
    .click();
  await openStep(page, 'agent_1');
  await page.getByTestId('workflow-conversation-manual').click();
  await page.getByTestId('workflow-conversation-id').fill(NOWHERE);
  await expect(result).toHaveAttribute('data-status', 'not_found');
  await expect(result).toContainText('لا توجد محادثة');
  await expect(page.getByTestId('workflow-check')).toHaveAttribute('data-valid', 'true');
  await closeDialog(page);
  await page.getByTestId('workflow-save').click();
  await expect(page.getByTestId('workflow-save')).toBeDisabled();
  run = await runOnce(page, 'الثالثة');
  await expect(
    run.locator('[data-testid="workflow-node"][data-node-id="agent_1"]'),
  ).toHaveAttribute('data-state', 'failed');
  await run.locator('[data-testid="workflow-node"][data-node-id="agent_1"]').click();
  await expect(run.getByTestId('workflow-step-run')).toContainText(
    `the conversation ${NOWHERE} was not found in this profile`,
  );
  await shot(page, 'workflow-conversation-missing-ar-light');
});
