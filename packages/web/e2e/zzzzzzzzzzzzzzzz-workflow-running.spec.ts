/**
 * 44. A workflow card shows its run while it goes, against the real hub (owner, 2026-09-29).
 *
 * In Arabic: a workflow with one delay step and a webhook trigger, made through the API; the
 * Workflows page open and idle; then a delivery POSTed to the trigger's public address — a
 * run nobody started from this page, the way a ClickUp event arrives — turns the card green
 * with a turning edge and "يعمل · <step>", and puts a dot on the sidebar's Workflows entry,
 * without a reload. With reduced motion the edge stays and stops turning. When the delay ends
 * the card is idle again and the dot is gone.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const TOKEN = 'e2e-running-card-token';
const STEP = 'انتظار قصير';
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

async function inDefault(page: Page) {
  const top = page.getByTestId('workspace-switcher').first();
  if ((await top.count()) && !(await top.textContent())?.includes('Default')) {
    await top.click();
    await page.getByRole('option', { name: 'Default', exact: true }).click();
  }
}

test('44. a run a trigger started shows on its card and in the sidebar, live', async ({ page }) => {
  await login(page);
  await inDefault(page);
  const session = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((name) => name.endsWith('.session'))!;
    return JSON.parse(localStorage.getItem(key)!) as { token: string };
  });
  const headers = { authorization: `Bearer ${session.token}`, 'X-Hub-Profile': 'default' };

  const made = await page.request.post('/api/v1/workflows', {
    headers,
    data: {
      name: 'بطاقة تعمل الآن',
      nodes: [
        {
          id: 'pause',
          kind: 'delay',
          title: STEP,
          agent_id: null,
          model: null,
          provider: null,
          reasoning_effort: null,
          skills: [],
          input: '5',
          approval_required: false,
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    },
  });
  expect(made.status()).toBe(201);
  const workflow = (await made.json()) as { id: string };
  const hook = await page.request.post(`/api/v1/workflows/${workflow.id}/triggers`, {
    headers,
    data: { name: 'e2e', preset: 'token', events: [], secret: TOKEN },
  });
  expect(hook.status()).toBe(201);
  const trigger = (await hook.json()) as { path: string };

  // Workflows has its own entry under «الأدوات» (DECISIONS §126).
  await page.getByTestId('rail').getByRole('link', { name: 'سير العمل', exact: true }).click();
  await expect(page).toHaveURL(/\/workflows$/);
  const card = page.locator(`[data-testid="workflow-card"][data-workflow-id="${workflow.id}"]`);
  const status = card.getByTestId('workflow-card-status');
  const dot = page.getByTestId('rail').getByTestId('sidebar-workflows-running');
  await expect(status).toHaveAttribute('data-state', 'idle');
  await expect(card).not.toHaveAttribute('data-frame');
  await expect(dot).toHaveCount(0);

  // A delivery from outside — nobody pressed Run on this page.
  const delivered = await page.request.post(trigger.path, {
    headers: { 'content-type': 'application/json', 'x-webhook-token': TOKEN },
    data: JSON.stringify({ event: 'task.created', id: 'e2e-running-1' }),
  });
  expect(delivered.status()).toBe(202);

  await expect(card).toHaveAttribute('data-frame', 'running', { timeout: 5_000 });
  await expect(status).toHaveAttribute('data-state', 'running');
  await expect(status).toContainText(`يعمل · ${STEP}`);
  await expect(dot).toBeVisible();
  // The entry keeps its own name while the dot shows (the dot is the eye's cue only).
  await expect(
    page.getByTestId('rail').getByRole('link', { name: 'سير العمل', exact: true }),
  ).toBeVisible();
  // The edge turns; with reduced motion it stays green and still.
  expect(await card.evaluate((el) => getComputedStyle(el).animationName)).toBe('task-frame-turn');
  await shot(page, 'workflow-running-card-ar-light');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await card.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  await page.emulateMedia({ reducedMotion: null });

  // The delay ends; the card and the sidebar follow on their own.
  await expect(status).toHaveAttribute('data-state', 'idle', { timeout: 20_000 });
  await expect(card).not.toHaveAttribute('data-frame');
  await expect(dot).toHaveCount(0);
  await expect(card).toContainText('عدد مرات التشغيل: 1');
});
