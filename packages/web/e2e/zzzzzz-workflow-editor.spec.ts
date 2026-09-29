/**
 * 32. A workflow drawn on the canvas, against the real hub (2026-09-25, DECISIONS §52).
 *
 * In Arabic, so the canvas runs right-to-left: a new workflow on the Workflows page, an Agent
 * step and a Notify step added from the canvas's "Add step" list, each edited in its dialog,
 * connected by
 * dragging from the agent's success dot onto the notice, the notice reading the agent's
 * answer (`{{steps.agent_1.output}}`), saved, run — the agent step is a real turn of the
 * scripted runner — and the run shown on the canvas: both steps done, the connection taken,
 * and the notice's output with the agent's words in it.
 *
 * It runs after every journey that photographs the Schedules page, because it adds a
 * workflow to the shared hub.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { addStep, closeDialog, connect, runByHand } from './workflow-canvas.js';

const PASSWORD = 'e2e-owner-password';
/** A Telegram group the e2e hub's own Bot API answers for (journey 34). */
const GROUP = '-1009876543210';
const shots = process.env.COREHUB_SHOTS ?? path.resolve('e2e/shots');
mkdirSync(shots, { recursive: true });
const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });

test.use({ viewport: { width: 1440, height: 1000 } });

async function login(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('اسم المستخدم').fill('admin');
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/chat$/);
}

/** The top selector on Default, where the journeys before this one may have left it. */
async function inDefault(page: Page) {
  const top = page.getByTestId('workspace-switcher').first();
  if ((await top.count()) && !(await top.textContent())?.includes('Default')) {
    await top.click();
    await page.getByRole('option', { name: 'Default', exact: true }).click();
  }
}

test('32. a two-step workflow drawn on the canvas runs, and its run is read on the canvas', async ({
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
  const canvas = page.getByTestId('workflow-canvas');
  await expect(canvas).toHaveAttribute('data-direction', 'rtl');

  await page.getByTestId('workflow-name').fill('مراجعة ثم إشعار');

  // Step one: an agent, the Direct one, asked a question the scripted runner answers.
  await addStep(page, 'agent');
  await page.getByTestId('workflow-step-agent').click();
  await page.getByRole('option', { name: /Direct|مباشر/ }).click();
  await page.getByTestId('workflow-step-prompt').fill('راجع قائمة الإصدار وقل ما فيها');

  // Step two: a notice that reads what the agent said.
  await addStep(page, 'notify');
  await page.getByTestId('workflow-step-text').fill('اكتملت المراجعة: {{steps.agent_1.output}}');
  await shot(page, 'workflow-step-dialog-ar-light');
  await closeDialog(page);

  // Connected by drawing: from the agent's success dot onto the notice.
  const agentNode = canvas.locator('[data-node-id="agent_1"]').first();
  const notifyNode = page.getByTestId('workflow-node').filter({ hasText: 'إشعار' });
  const port = agentNode.getByTestId('workflow-port-success');
  const from = (await port.boundingBox())!;
  const to = (await notifyNode.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('workflow-edge')).toHaveCount(1);

  // The hub checked the drawing: nothing refuses it.
  await expect(page.getByTestId('workflow-check')).toHaveAttribute('data-valid', 'true');
  await shot(page, 'workflow-editor-ar-light');

  await page.getByTestId('workflow-save').click();
  await expect(editor).not.toHaveAttribute('data-workflow-id', 'new');
  await expect(page).toHaveURL(/workflow=[0-9A-Z]{26}/);

  // The workflow's own limits (decision §102) are in its settings, by the name; Run has a
  // companion that sets them for one run only.
  await page.getByTestId('workflow-settings-open').click();
  const settings = page.getByTestId('workflow-settings');
  await expect(settings.getByTestId('workflow-limits-form')).toBeVisible();
  await shot(page, 'workflow-limits-ar-light');
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await page.getByTestId('workflow-run-with-limits').click();
  const limits = page.getByTestId('workflow-run-limits-dialog');
  await expect(limits).toBeVisible();
  await limits.getByTestId('workflow-run-limit-time').fill('30');
  await limits.screenshot({ path: path.join(shots, 'workflow-run-limits-ar-light.png') });
  await limits.getByRole('button', { name: 'إلغاء' }).first().click();
  await expect(limits).toHaveCount(0);

  // Run: the canvas turns into the run, and both steps end done.
  await page.getByTestId('workflow-run').click();
  const run = page.getByTestId('workflow-run-view');
  await expect(run).toBeVisible();
  const nodes = run.getByTestId('workflow-node');
  await expect(nodes).toHaveCount(2);
  await expect(
    run.locator('[data-testid="workflow-node"][data-node-id="agent_1"]'),
  ).toHaveAttribute('data-state', 'done', { timeout: 20_000 });
  await expect(
    run.locator('[data-testid="workflow-node"][data-node-id="notify_1"]'),
  ).toHaveAttribute('data-state', 'done', { timeout: 20_000 });
  await expect(run.getByTestId('workflow-run-state')).toContainText('تم');
  await expect(run.getByTestId('workflow-edge')).toHaveAttribute('data-taken', 'true');

  // The notice's output carries the agent's words.
  await run.locator('[data-testid="workflow-node"][data-node-id="notify_1"]').click();
  await expect(run.getByTestId('workflow-step-output')).toContainText(
    'اكتملت المراجعة: القائمة سليمة: ثلاثة بنود جاهزة.',
  );
  await shot(page, 'workflow-run-ar-light');

  // Back in the list, the workflow is there with its run.
  await page.getByTestId('workflow-back').click();
  await expect(
    page.getByTestId('workflow-card').filter({ hasText: 'مراجعة ثم إشعار' }),
  ).toContainText('عدد مرات التشغيل: 1');
});

test('32b. a new workflow is checked before it has a name, then named, saved and run by hand', async ({
  page,
}) => {
  await login(page);
  await inDefault(page);
  await page.getByTestId('rail').getByRole('link', { name: 'سير العمل', exact: true }).click();
  await page.getByTestId('workflow-new').click();
  const editor = page.getByTestId('workflow-editor');
  await expect(editor).toHaveAttribute('data-workflow-id', 'new');
  // The name is empty: a hint by the name field says so, not an error about the drawing.
  await expect(page.getByTestId('workflow-name')).toHaveValue('');
  await expect(editor.getByText('سمِّ سير العمل قبل الحفظ.')).toBeVisible();

  // Five steps, one of each kind, each added after the one selected.
  await addStep(page, 'agent');
  await page.getByTestId('workflow-step-agent').click();
  await page.getByRole('option', { name: /Direct|مباشر/ }).click();
  await page.getByTestId('workflow-step-prompt').fill('راجع قائمة الإصدار وقل ما فيها');
  await addStep(page, 'condition');
  await addStep(page, 'delay');
  await page.getByTestId('workflow-delay-unit').click();
  await page.getByRole('option', { name: 'ثوانٍ', exact: true }).click();
  await page.getByTestId('workflow-delay-amount').fill('1');
  await addStep(page, 'approval');
  await page.getByTestId('workflow-step-question').fill('هل ننشر الإصدار؟');
  await addStep(page, 'notify');
  await page.getByTestId('workflow-step-text').fill('نُشر: {{steps.agent_1.output}}');
  await closeDialog(page);
  await expect(page.getByTestId('workflow-node')).toHaveCount(5);

  // The hub's check of the whole drawing, sent while the name is still empty.
  const checked = page.waitForResponse((response) => {
    if (!response.url().includes('/workflows/validate')) return false;
    const sent = JSON.parse(response.request().postData() ?? '{}') as {
      name?: string;
      nodes?: unknown[];
      edges?: unknown[];
    };
    return sent.nodes?.length === 5 && sent.edges?.length === 4 && !sent.name;
  });
  await connect(page, 'agent_1', 'شرط');
  await connect(page, 'condition_1', 'انتظار');
  await connect(page, 'delay_1', 'موافقة');
  await connect(page, 'approval_1', 'إشعار');
  await expect(page.getByTestId('workflow-edge')).toHaveCount(4);

  // Still no name, and the hub checked the drawing without refusing it.
  const check = await checked;
  expect(check.status()).toBe(200);
  expect(await check.json()).toEqual({ valid: true, problems: [], warnings: [] });
  await expect(page.getByTestId('workflow-issue')).toHaveCount(0);
  await expect(page.getByTestId('workflow-check')).toHaveAttribute('data-valid', 'true');
  await expect(page.getByTestId('workflow-check-error')).toHaveCount(0);
  await expect(editor.getByText('تعذّر فحص الرسم', { exact: false })).toHaveCount(0);
  await expect(page.getByTestId('workflow-save')).toBeDisabled();
  await shot(page, 'workflow-editor-unnamed-ar-light');

  await page.getByTestId('workflow-name').fill('خمس خطوات قبل الاسم');
  await expect(editor.getByText('سمِّ سير العمل قبل الحفظ.')).toHaveCount(0);
  await page.getByTestId('workflow-save').click();
  await expect(editor).not.toHaveAttribute('data-workflow-id', 'new');
  await expect(page).toHaveURL(/workflow=[0-9A-Z]{26}/);
  await expect(page.getByTestId('workflow-check-error')).toHaveCount(0);

  // Run by hand, with words the condition finds; it waits at the approval, then finishes.
  await runByHand(page, 'الإصدار 1.2');
  const run = page.getByTestId('workflow-run-view');
  await expect(run).toBeVisible();
  await expect(run.getByTestId('workflow-node')).toHaveCount(5);
  const step = (id: string) => run.locator(`[data-testid="workflow-node"][data-node-id="${id}"]`);
  await expect(step('approval_1')).toHaveAttribute('data-state', 'waiting', { timeout: 30_000 });
  for (const id of ['agent_1', 'condition_1', 'delay_1'])
    await expect(step(id)).toHaveAttribute('data-state', 'done');
  await run.getByTestId('workflow-approve').first().click();
  await expect(step('notify_1')).toHaveAttribute('data-state', 'done', { timeout: 20_000 });
  await expect(run.getByTestId('workflow-run-state')).toContainText('تم');
  await step('notify_1').click();
  await expect(run.getByTestId('workflow-step-output')).toContainText(
    'نُشر: القائمة سليمة: ثلاثة بنود جاهزة.',
  );
});

async function sentToTelegram(page: Page) {
  const res = await page.request.get('/__e2e/telegram');
  return ((await res.json()) as { sent: Array<{ chat_id: string; text: string }> }).sent;
}

test('32c. like n8n: a trigger node, steps added with its +, a step edited in its dialog, Save by the name, and leaving unsaved asks first', async ({
  page,
}) => {
  await login(page);
  await inDefault(page);
  const before = (await sentToTelegram(page)).length;
  await page.getByTestId('rail').getByRole('link', { name: 'سير العمل', exact: true }).click();
  await page.getByTestId('workflow-new').click();
  const editor = page.getByTestId('workflow-editor');
  const canvas = page.getByTestId('workflow-canvas');
  await expect(editor).toHaveAttribute('data-workflow-id', 'new');

  // Empty: one big "Add a trigger" in the middle — where the tester looked for it.
  await expect(canvas.getByTestId('workflow-trigger-node')).toHaveCount(0);
  await shot(page, 'workflow-empty-ar-light');
  await page.getByTestId('workflow-add-first').click();
  const picker = page.getByTestId('workflow-node-picker');
  await picker.getByTestId('workflow-picker-search').fill('يدوي');
  await expect(picker.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('workflow-manual-run')).toBeDisabled();
  await closeDialog(page);
  await expect(canvas.getByTestId('workflow-trigger-node')).toHaveAttribute(
    'data-trigger-kind',
    'manual',
  );

  // The trigger's +: the first step, an agent, edited in the dialog that opens on it.
  await canvas.getByTestId('workflow-trigger-add-step').click();
  await page.getByTestId('workflow-pick-agent').click();
  const dialog = page.getByTestId('workflow-node-dialog');
  await expect(dialog.getByTestId('workflow-panel')).toHaveAttribute('data-node-id', 'agent_1');
  await dialog.getByTestId('workflow-step-agent').click();
  await page.getByRole('option', { name: /Direct|مباشر/ }).click();
  await dialog.getByTestId('workflow-step-prompt').fill('راجع قائمة الإصدار وقل ما فيها');
  await dialog.getByTestId('workflow-step-title').fill('مراجعة');
  await closeDialog(page);
  await expect(
    canvas.locator('[data-testid="workflow-trigger-edge"][data-to="agent_1"]'),
  ).toHaveCount(1);

  // The agent's +: a "Send message" step after it, connected on success.
  await canvas.locator('[data-node-id="agent_1"]').first().getByTestId('workflow-node-add').click();
  await page.getByTestId('workflow-pick-send').click();
  await dialog.getByTestId('workflow-step-text').fill('المراجعة: {{steps.agent_1.output}}');
  await dialog.getByTestId('workflow-send-telegram').click();
  await dialog.getByTestId('workflow-send-chat').fill(GROUP);
  await shot(page, 'workflow-send-dialog-ar-light');
  await closeDialog(page);
  await expect(page.getByTestId('workflow-edge')).toHaveCount(1);

  // A ClickUp trigger too: not saved yet, it waits for the first save and says so.
  await page.getByTestId('workflow-add-trigger').click();
  await page.getByTestId('workflow-pick-trigger-clickup').click();
  await expect(page.getByTestId('workflow-pending-trigger')).toBeVisible();
  await closeDialog(page);
  const hook = canvas.locator('[data-testid="workflow-trigger-node"][data-trigger-kind="webhook"]');
  await expect(hook).toHaveAttribute('data-pending', 'true');
  // A trigger's line cannot start a step in the middle: dropped on the notice, it says why.
  const port = canvas
    .locator('[data-trigger-node]:has([data-trigger-kind="webhook"])')
    .getByTestId('workflow-trigger-port');
  const from = (await port.boundingBox())!;
  const to = (await canvas.locator('[data-node-id="notify_1"]').first().boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('workflow-canvas-hint')).toBeVisible();
  await expect(page.getByTestId('workflow-edge')).toHaveCount(1);

  // Unsaved, and nameless: the mark by the name says so, and Save waits for a name.
  await expect(page.getByTestId('workflow-unsaved')).toBeVisible();
  await expect(page.getByTestId('workflow-save')).toBeDisabled();
  await page.getByTestId('workflow-name').fill('مراجعة ثم تيليجرام');
  await expect(page.getByTestId('workflow-check')).toHaveAttribute('data-valid', 'true');
  await shot(page, 'workflow-n8n-ar-light');

  // Leaving now asks first: Stay keeps everything where it was.
  await page.getByTestId('rail').getByRole('link', { name: 'الجدولة', exact: true }).click();
  const ask = page.getByTestId('workflow-leave-dialog');
  await expect(ask).toBeVisible();
  await shot(page, 'workflow-leave-ar-light');
  await ask.getByTestId('workflow-leave-stay').click();
  await expect(ask).toHaveCount(0);
  await expect(page).toHaveURL(/\/workflows\?workflow=new/);
  await expect(page.getByTestId('workflow-node')).toHaveCount(2);

  // Saved with the button by the name; the waiting trigger is made with it.
  await page.getByTestId('workflow-save').click();
  await expect(editor).not.toHaveAttribute('data-workflow-id', 'new');
  await expect(page.getByTestId('workflow-all-saved')).toBeVisible();
  await expect(editor).toHaveAttribute('data-unsaved', 'false');
  await expect(hook).not.toHaveAttribute('data-pending', 'true');
  await hook.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('workflow-trigger-url')).toHaveValue(
    /\/api\/v1\/workflow-hooks\/[0-9A-Z]{26}$/,
  );
  await closeDialog(page);

  // Run by hand: the agent answers and the message reaches Telegram.
  await runByHand(page, 'الإصدار');
  const run = page.getByTestId('workflow-run-view');
  await expect(run.getByTestId('workflow-run-state')).toContainText('تم', { timeout: 20_000 });
  expect((await sentToTelegram(page)).slice(before).map((m) => [m.chat_id, m.text])).toEqual([
    [GROUP, 'المراجعة: القائمة سليمة: ثلاثة بنود جاهزة.'],
  ]);

  // Nothing unsaved now: leaving does not ask.
  await page.getByTestId('workflow-back').click();
  await expect(page).toHaveURL(/\/workflows$/);
});

test('32d. an old workflow opens with its triggers drawn as nodes and runs as before', async ({
  page,
}) => {
  await login(page);
  await inDefault(page);
  const session = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((name) => name.endsWith('.session'))!;
    return JSON.parse(localStorage.getItem(key)!) as { token: string };
  });
  const headers = { authorization: `Bearer ${session.token}`, 'X-Hub-Profile': 'default' };
  // Made the way every client made one before trigger nodes: the drawing, then a trigger and a
  // schedule of their own.
  const step = (id: string, kind: string, title: string, input: string, x: number) => ({
    id,
    kind,
    title,
    agent_id: null,
    model: null,
    provider: null,
    reasoning_effort: null,
    skills: [],
    input,
    approval_required: false,
    position: { x, y: 40 },
  });
  const made = await page.request.post('/api/v1/workflows', {
    headers,
    data: {
      name: 'سير عمل قديم',
      nodes: [
        step('wait', 'delay', 'انتظار', '1', 40),
        step('tell', 'notify', 'إشعار', 'تم {{input}}', 320),
      ],
      edges: [{ id: 'e1', from: 'wait', to: 'tell', route: 'success' }],
    },
  });
  expect(made.status()).toBe(201);
  const workflow = (await made.json()) as { id: string };
  const hook = await page.request.post(`/api/v1/workflows/${workflow.id}/triggers`, {
    headers,
    data: { name: 'GitHub', preset: 'github', events: ['issues'] },
  });
  expect(hook.status()).toBe(201);
  const schedule = await page.request.post('/api/v1/schedules', {
    headers,
    data: {
      name: 'كل صباح',
      enabled: false,
      trigger: {
        kind: 'cron',
        expression: '0 9 * * *',
        every_minutes: null,
        run_at: null,
        timezone: 'Asia/Riyadh',
      },
      target: {
        kind: 'workflow',
        agent_id: null,
        prompt: null,
        model: null,
        provider: null,
        skills: [],
        workflow_id: workflow.id,
        input: null,
      },
    },
  });
  expect(schedule.status()).toBe(201);

  await page.goto(`/workflows?workflow=${workflow.id}&profile=default`);
  const canvas = page.getByTestId('workflow-canvas');
  await expect(canvas.getByTestId('workflow-node')).toHaveCount(2);
  const triggers = canvas.getByTestId('workflow-trigger-node');
  await expect(triggers).toHaveCount(3);
  await expect(triggers.nth(0)).toHaveAttribute('data-trigger-kind', 'manual');
  await expect(triggers.nth(1)).toHaveAttribute('data-trigger-kind', 'webhook');
  await expect(triggers.nth(2)).toHaveAttribute('data-trigger-kind', 'schedule');
  // Each starts the one step nothing leads into; the drawing's own edge is unchanged.
  await expect(canvas.locator('[data-testid="workflow-trigger-edge"][data-to="wait"]')).toHaveCount(
    3,
  );
  await expect(canvas.getByTestId('workflow-edge')).toHaveCount(1);
  await expect(page.getByTestId('workflow-editor')).toHaveAttribute('data-unsaved', 'false');
  await shot(page, 'workflow-old-triggers-ar-light');

  // The schedule opens in the same kind of dialog: when, and off.
  await triggers.nth(2).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('workflow-schedule-when')).toContainText('0 9 * * *');
  await expect(page.getByTestId('workflow-schedule-enabled')).not.toBeChecked();
  await closeDialog(page);

  // Run by hand: the same run as ever.
  await runByHand(page, 'كما كان');
  const run = page.getByTestId('workflow-run-view');
  await expect(run.getByTestId('workflow-run-state')).toContainText('تم', { timeout: 20_000 });
  await run.locator('[data-testid="workflow-node"][data-node-id="tell"]').click();
  await expect(run.getByTestId('workflow-step-output')).toContainText('تم كما كان');
  // The saved drawing is exactly what the API made: opening it changed nothing.
  const after = await page.request.get(`/api/v1/workflows/${workflow.id}`, { headers });
  expect(((await after.json()) as { edges: unknown[] }).edges).toEqual([
    { id: 'e1', from: 'wait', to: 'tell', route: 'success' },
  ]);
});
