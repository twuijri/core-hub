/**
 * 33. A workflow started by ClickUp, against the real hub (2026-09-28, DECISIONS §123).
 *
 * In Arabic: a new workflow whose condition step holds a rule (`trigger.event == taskCreated`)
 * and a notice that reads the task; saved; a ClickUp trigger added in the side panel, its
 * secret stored (and never shown again), a test event sent through the whole receiving path
 * and its run opened from the delivery log; an event the trigger does not take, filtered out;
 * then two real deliveries signed over their raw bytes the way ClickUp signs them — a task
 * event the workflow's rule says no to (the run ends "filtered") and the same bytes again (a
 * repeat, ignored).
 */
import { createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { addStep, closeDialog, connect } from './workflow-canvas.js';

const PASSWORD = 'e2e-owner-password';
const SECRET = 'e2e-clickup-webhook-secret';
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

test('33. a ClickUp trigger starts the workflow; a test event, a filtered event and a repeat are logged', async ({
  page,
}) => {
  await login(page);
  await inDefault(page);
  // Workflows has its own entry under «الأدوات» since 2026-09-28 (DECISIONS §126).
  await page.getByTestId('rail').getByRole('link', { name: 'سير العمل', exact: true }).click();
  await expect(page).toHaveURL(/\/workflows$/);
  await page.getByTestId('workflow-new').click();
  const editor = page.getByTestId('workflow-editor');
  await expect(editor).toHaveAttribute('data-workflow-id', 'new');
  await page.getByTestId('workflow-name').fill('من ClickUp إلى إشعار');

  // The filter: a condition with one rule, the trigger's event must be taskCreated.
  await addStep(page, 'condition');
  await page.getByTestId('workflow-condition-rules').click();
  const rules = page.getByTestId('workflow-rules');
  await rules.getByTestId('workflow-rule-add').click();
  await rules
    .getByTestId('workflow-rule')
    .nth(1)
    .getByTestId('workflow-rule-value')
    .fill('taskCreated');
  await rules.getByTestId('workflow-rule').nth(0).getByTestId('workflow-rule-remove').click();
  await expect(rules.getByTestId('workflow-rule')).toHaveCount(1);
  await expect(rules.getByTestId('workflow-rule-path')).toHaveValue('trigger.event');

  // What follows a yes: a notice that reads the task.
  await addStep(page, 'notify');
  await page.getByTestId('workflow-step-text').fill('مهمة جديدة {{trigger.task_id}}');
  await connect(page, 'condition_1', 'إشعار');
  await expect(page.getByTestId('workflow-edge')).toHaveCount(1);
  await expect(page.getByTestId('workflow-check')).toHaveAttribute('data-valid', 'true');

  await page.getByTestId('workflow-save').click();
  await expect(editor).not.toHaveAttribute('data-workflow-id', 'new');

  // The trigger is added on the canvas, like a step, and opens in its own dialog.
  await page.getByTestId('workflow-add-trigger').click();
  await page.getByTestId('workflow-pick-trigger-clickup').click();
  const card = page.getByTestId('workflow-trigger-dialog').getByTestId('workflow-trigger');
  await expect(card).toHaveAttribute('data-preset', 'clickup');
  const url = await card.getByTestId('workflow-trigger-url').inputValue();
  expect(url).toMatch(/\/api\/v1\/workflow-hooks\/[0-9A-Z]{26}$/);
  await expect(card.getByTestId('workflow-trigger-test')).toBeDisabled();

  // The secret ClickUp made when the webhook was registered: stored, never shown again.
  await card.getByTestId('workflow-trigger-secret').fill(SECRET);
  await card.getByTestId('workflow-trigger-secret-save').click();
  await expect(card.getByTestId('workflow-trigger-secret')).toHaveAttribute(
    'placeholder',
    '[stored]',
  );
  await expect(card.getByTestId('workflow-trigger-secret')).toHaveValue('');

  // A test event: through the whole path, a run the rule says yes to.
  await card.getByTestId('workflow-trigger-test').click();
  await expect(card.getByTestId('workflow-trigger-test-result')).toHaveText('بدأ التشغيل');
  const lines = card.getByTestId('workflow-trigger-delivery');
  await expect(lines.first()).toHaveAttribute('data-status', 'run_succeeded', {
    timeout: 20_000,
  });

  // An event the trigger does not take.
  await card.getByTestId('workflow-trigger-test-event').fill('taskDeleted');
  await card.getByTestId('workflow-trigger-test').click();
  await expect(card.getByTestId('workflow-trigger-test-result')).toHaveText('حدث لا يأخذه');

  // Two real deliveries, signed over their raw bytes as ClickUp signs them.
  const raw = JSON.stringify({
    event: 'taskStatusUpdated',
    task_id: 'e2e-task-7',
    webhook_id: 'e2e-webhook',
    history_items: [{ id: '4200000000000000001', field: 'status' }],
  });
  const signature = createHmac('sha256', SECRET).update(raw).digest('hex');
  const headers = { 'content-type': 'application/json', 'x-signature': signature };
  const first = await page.request.post(url, { data: raw, headers });
  expect(first.status()).toBe(202);
  const again = await page.request.post(url, { data: raw, headers });
  expect(again.status()).toBe(200);
  expect(await again.json()).toMatchObject({ status: 'duplicate' });
  const forged = await page.request.post(url, {
    data: raw,
    headers: { ...headers, 'x-signature': '0'.repeat(64) },
  });
  expect(forged.status()).toBe(401);

  await expect(card.locator('[data-status="signature_rejected"]')).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect(card.locator('[data-status="duplicate"]')).toHaveCount(1);
  await expect(card.locator('[data-status="filtered_out"]')).toHaveCount(1);
  const quiet = card.locator('[data-status="run_succeeded"][data-filtered="true"]');
  await expect(quiet).toHaveCount(1, { timeout: 20_000 });
  await expect(quiet).toContainText('task e2e-task-7');
  await shot(page, 'workflow-triggers-ar-light');
  // On the canvas: the trigger before the condition, with a line to it.
  await closeDialog(page);
  const node = page.getByTestId('workflow-trigger-node').filter({ hasText: 'ClickUp' });
  await expect(node).toHaveAttribute('data-trigger-kind', 'webhook');
  await expect(
    page.locator('[data-testid="workflow-trigger-edge"][data-to="condition_1"]'),
  ).toHaveCount(2);
  await shot(page, 'workflow-trigger-node-ar-light');
  await node.focus();
  await page.keyboard.press('Enter');

  // The filtered run opens from its line: succeeded, filtered, about that task.
  await quiet.getByTestId('workflow-delivery-run').click();
  const run = page.getByTestId('workflow-run-view');
  await expect(run.getByTestId('workflow-run-filtered')).toBeVisible();
  await expect(run.getByTestId('workflow-run-task')).toContainText('e2e-task-7');
  await expect(run.getByTestId('workflow-run-state')).toContainText('تم');
});
