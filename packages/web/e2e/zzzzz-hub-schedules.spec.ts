/**
 * 28–29. The hub fires its own schedules, against the real hub (2026-09-24).
 *
 * 28: a schedule for the Direct agent (not Hermes: the hub runs it itself) — "Run now"
 * starts a real run, its line appears in the schedule's history, and the line opens the
 * run's conversation with the agent's answer in it.
 * 29: a workflow schedule whose second step waits for a person — "Run now", the approval
 * reaches the inbox, the inbox opens the run, and approving it from the run's view lets the
 * run finish.
 *
 * It runs after every journey that photographs the Schedules page (`zzzzz-`), because it
 * adds schedules to the shared hub.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const shots = process.env.MAJLIS_SHOTS ?? path.resolve('e2e/shots');
mkdirSync(shots, { recursive: true });
const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });

test.use({ viewport: { width: 1440, height: 900 } });

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

test('28. a hub schedule runs now: its line in the history opens the conversation', async ({
  page,
}) => {
  await login(page);
  await inDefault(page);
  await page.getByRole('link', { name: 'الجدولة', exact: true }).click();
  await expect(page).toHaveURL(/\/schedules$/);

  await page.getByTestId('schedule-name').fill('ملخص يومي');
  await page.getByTestId('schedule-value').fill('0 8 * * *');
  await page.getByTestId('schedule-prompt').fill('اكتب ملخص الجدولة');
  await page.getByTestId('schedule-agent').click();
  await page.getByRole('option', { name: /Direct|مباشر/ }).click();
  await page.getByTestId('schedule-save').click();

  const card = page.getByTestId('schedule-card').filter({ hasText: 'ملخص يومي' });
  await expect(card).toBeVisible();
  // The hub's own schedule: "Run now" is a real button now.
  await expect(card.getByTestId('schedule-run')).toBeEnabled();
  await card.getByTestId('schedule-run').click();
  await expect(page.getByTestId('schedule-fired')).toContainText('بدأ «ملخص يومي»');

  // The run is in the history, and it ends on its own time.
  const line = card.getByTestId('schedule-run-line').first();
  await expect(line).toBeVisible();
  await expect(line).toHaveAttribute('data-status', 'succeeded', { timeout: 20_000 });
  await expect(line).toContainText('تشغيل يدوي');
  await expect(line).toContainText('ملخص الجدولة: أُنجزت ثلاث مهام');
  await shot(page, 'schedules-hub-run-ar-light');

  // An ordinary conversation: the schedule's prompt, the agent's answer.
  await line.getByTestId('schedule-run-session').click();
  await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}(\?profile=[a-z0-9-]+)?$/);
  await expect(page.getByTestId('message-assistant').last()).toContainText(
    'ملخص الجدولة: أُنجزت ثلاث مهام',
  );
  await expect(page.getByText('اكتب ملخص الجدولة')).toBeVisible();
});

test('29. a workflow step waits for a person: the inbox opens the run, and approving finishes it', async ({
  page,
  request,
}) => {
  const owner = await request.post('/api/v1/auth/login', {
    data: { username: 'admin', password: PASSWORD },
  });
  const headers = {
    authorization: `Bearer ${(await owner.json()).access_token}`,
    'X-Hub-Profile': 'default',
  };
  const node = (id: string, kind: string, title: string, input: string) => ({
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
    position: { x: 0, y: 0 },
  });
  // No drawing surface for workflows yet: the workflow is made over the API, as a client would.
  const workflow = await request.post('/api/v1/workflows', {
    headers,
    data: {
      name: 'نشر الإصدار',
      nodes: [
        node('build', 'notify', 'البناء', 'اكتمل البناء'),
        node('gate', 'approval', 'موافقة النشر', 'هل أنشر الإصدار ٢٫٤؟'),
        node('publish', 'notify', 'النشر', 'نُشر الإصدار'),
      ],
      edges: [
        { id: 'e1', from: 'build', to: 'gate', route: 'success' },
        { id: 'e2', from: 'gate', to: 'publish', route: 'success' },
      ],
    },
  });
  expect(workflow.status()).toBe(201);
  const schedule = await request.post('/api/v1/schedules', {
    headers,
    data: {
      name: 'نشر أسبوعي',
      trigger: {
        kind: 'cron',
        expression: '0 10 * * 0',
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
        workflow_id: (await workflow.json()).id,
        input: null,
      },
    },
  });
  expect(schedule.status()).toBe(201);

  await login(page);
  await inDefault(page);
  await page.getByRole('link', { name: 'الجدولة', exact: true }).click();
  const card = page.getByTestId('schedule-card').filter({ hasText: 'نشر أسبوعي' });
  await card.getByTestId('schedule-run').click();
  await expect(page.getByTestId('schedule-fired')).toContainText('بدأ «نشر أسبوعي»');

  // The approval is in the inbox, where every approval that waits for someone is.
  await page.getByRole('link', { name: 'الإعدادات' }).first().click();
  await page.getByTestId('settings-nav').getByRole('link', { name: 'الإشعارات' }).click();
  const notice = page
    .getByTestId('notice-list')
    .getByRole('listitem')
    .filter({ hasText: 'نشر الإصدار' })
    .first();
  await expect(notice).toContainText('موافقة النشر');
  await notice.getByRole('button').click();

  // The inbox opened the run on the Schedules page: waiting, with the question.
  await expect(page).toHaveURL(/\/schedules\?workflow_run=[0-9A-Z]{26}&profile=default$/);
  const dialog = page.getByTestId('workflow-run-dialog');
  await expect(dialog.getByTestId('workflow-run-status')).toContainText('ينتظر');
  await expect(dialog.getByTestId('workflow-approval-question')).toContainText(
    'هل أنشر الإصدار ٢٫٤؟',
  );
  await shot(page, 'workflow-approval-ar-light');

  await dialog.getByTestId('workflow-approve').click();
  await expect(dialog.getByTestId('workflow-run-status')).toContainText('تم', { timeout: 15_000 });
  await expect(dialog.getByTestId('workflow-approval')).toHaveCount(0);
  await expect(
    dialog.getByTestId('workflow-run-step').filter({ hasText: 'publish' }),
  ).toHaveAttribute('data-status', 'succeeded');

  // The schedule's line settled with the run.
  await dialog
    .getByRole('button', { name: 'Close' })
    .or(dialog.getByRole('button', { name: 'إغلاق' }))
    .first()
    .click();
  await card.getByTestId('schedule-history-toggle').click();
  await expect(card.getByTestId('schedule-run-line').first()).toHaveAttribute(
    'data-status',
    'succeeded',
  );
});

test("30. a schedule's run options: set when it is made, changed from its card, none for Hermes", async ({
  page,
  request,
}) => {
  await login(page);
  await inDefault(page);
  await page.getByRole('link', { name: 'الجدولة', exact: true }).click();
  await expect(page).toHaveURL(/\/schedules$/);

  // Hermes is the form's first agent, and Hermes's scheduler decides both itself.
  await page.getByTestId('schedule-agent').click();
  await page.getByRole('option', { name: 'Hermes', exact: true }).click();
  await expect(page.getByTestId('schedule-new-options')).toHaveCount(0);

  // The hub's own agent: the options appear with the owner's defaults.
  await page.getByTestId('schedule-agent').click();
  await page.getByRole('option', { name: /Direct|مباشر/ }).click();
  const options = page.getByTestId('schedule-new-options');
  await expect(options).toBeVisible();
  const missed = options.getByRole('checkbox', { name: /^شغّله لو فات وقته \(خلال ٢٤ ساعة\)/ });
  await expect(missed).not.toBeChecked();
  await expect(options.getByRole('radio', { name: /^انتظر ثم شغّل/ })).toBeChecked();

  await page.getByTestId('schedule-name').fill('تذكير بالموعد');
  await page.getByTestId('schedule-value').fill('30 7 * * *');
  await page.getByTestId('schedule-prompt').fill('ذكّرني بموعد اليوم');
  await missed.click();
  await options.getByRole('radio', { name: /^أوقف السابق/ }).click();
  await shot(page, 'schedule-run-options-ar-light');
  await page.getByTestId('schedule-save').click();

  const card = page.getByTestId('schedule-card').filter({ hasText: 'تذكير بالموعد' });
  await expect(card).toBeVisible();
  await card.getByTestId('schedule-options-toggle').click();
  const panel = card.getByTestId('schedule-options');
  await expect(panel.getByRole('checkbox', { name: /^شغّله لو فات وقته/ })).toBeChecked();
  await expect(panel.getByRole('radio', { name: /^أوقف السابق/ })).toBeChecked();

  // Changed from the card, saved at once.
  await panel.getByRole('radio', { name: /^شغّل معه/ }).click();
  await expect(panel.getByRole('radio', { name: /^شغّل معه/ })).toBeChecked();

  // What the hub now holds.
  const owner = await request.post('/api/v1/auth/login', {
    data: { username: 'admin', password: PASSWORD },
  });
  const headers = {
    authorization: `Bearer ${(await owner.json()).access_token}`,
    'X-Hub-Profile': 'default',
  };
  await expect
    .poll(async () => {
      const list = await request.get('/api/v1/schedules?profiles=all', { headers });
      const items = (await list.json()).items as Array<Record<string, unknown>>;
      const saved = items.find((item) => item.name === 'تذكير بالموعد');
      return saved ? [saved.run_if_missed, saved.overlap] : null;
    })
    .toEqual([true, 'parallel']);
});
