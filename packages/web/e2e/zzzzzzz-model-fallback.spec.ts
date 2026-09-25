/**
 * 34. The owner's outage of 2026-09-25, as a journey (contract decision §49).
 *
 * A proxy whose chat model answers `503 auth_unavailable`, and a second model on it that
 * works. The person puts the second one in the fallback chain on the Models page's Defaults
 * tab; the next message is answered by it, and the reply says so — which model answered,
 * which one failed and why — in the chat, after a reload, and in the Trajectory.
 *
 * The turn is the hub's own direct path (`e2e/hub.ts` §directTurn): the chat model, the chain
 * the Defaults tab saved, and the proxy's HTTP, which is scripted. It runs last (`zzzzzzz-`):
 * it adds a provider and changes the default profile's chat model on the shared hub.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const PROXY = 'http://proxy.e2e/v1';
const shots = process.env.COREHUB_SHOTS ?? path.resolve('e2e/shots');
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

test('34. a fallback model answers when the chat model is down, and the reply says so', async ({
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
  // The proxy, added as a person would add a custom endpoint, and its two models fetched.
  const added = await request.post('/api/v1/models/providers', {
    headers,
    data: { preset: 'openai-compatible', label: 'Proxy', kind: 'llm', base_url: PROXY },
  });
  expect(added.status()).toBe(201);
  const provider = (await added.json()) as { id: string; slug: string };
  await expect(async () => {
    const listed = await request.get('/api/v1/models/providers', { headers });
    const row = (
      (await listed.json()) as { items: { id: string; models: unknown[] }[] }
    ).items.find((item) => item.id === provider.id);
    expect(row?.models).toHaveLength(2);
  }).toPass();
  // The chat model is the one that is down.
  const chat = await request.put('/api/v1/models/defaults', {
    headers,
    data: { default: { provider_id: provider.id, model: 'gemini-3.8-flash-high' } },
  });
  expect(chat.status()).toBe(200);

  // The fallback chain, set on the Defaults tab.
  await login(page);
  await inDefault(page);
  await page.getByRole('link', { name: 'الإعدادات' }).first().click();
  await page.getByTestId('settings-nav').getByRole('link', { name: 'النماذج' }).click();
  await page.getByTestId('models-tabs').getByText('الافتراضيات').click();
  const list = page.getByTestId('fallback-models');
  await expect(list).toContainText('النماذج الاحتياطية');
  await expect(list.getByTestId('fallback-empty')).toBeVisible();
  await list.getByTestId('fallback-add').click();
  await page.getByRole('option', { name: /gpt-backup/ }).click();
  await expect(list.getByTestId('fallback-item')).toHaveCount(1);
  await expect(list.getByTestId('fallback-item').first()).toHaveAttribute(
    'data-model',
    'gpt-backup',
  );
  await expect(async () => {
    const saved = await request.get('/api/v1/models/defaults', { headers });
    expect(((await saved.json()) as { fallbacks: { model: string }[] }).fallbacks).toEqual([
      { provider_id: provider.id, model: 'gpt-backup' },
    ]);
  }).toPass();
  await shot(page, 'models-fallbacks-ar-light');

  // The next message: the chat model fails, the fallback answers, and the reply says so.
  await page.getByRole('link', { name: 'محادثة جديدة' }).first().click();
  await expect(page).toHaveURL(/\/new$/);
  await expect(async () => {
    await page.getByTestId('composer-input').fill('جرّب النموذج الاحتياطي');
    await expect(page.getByTestId('send')).toBeEnabled({ timeout: 1_000 });
  }).toPass();
  await page.getByTestId('send').click();
  await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}(\?profile=[a-z0-9-]+)?$/);

  const reply = page.getByTestId('message-assistant').last();
  await expect(reply).toContainText('أجاب النموذج الاحتياطي بدل النموذج المعطّل.', {
    timeout: 20_000,
  });
  const note = reply.getByTestId('fallback-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText(`فشل ${provider.slug}/gemini-3.8-flash-high`);
  await expect(note).toContainText(`فأجاب ${provider.slug}/gpt-backup`);
  await expect(note).toContainText('auth_unavailable');
  await shot(page, 'chat-fallback-note-ar-light');

  // Still there after a reload: the run remembers which model answered it.
  await page.reload();
  await expect(
    page.getByTestId('message-assistant').last().getByTestId('fallback-note'),
  ).toContainText(`فأجاب ${provider.slug}/gpt-backup`);

  // And in the Trajectory, on the turn the fallback answered.
  await page.getByTestId('chat-tabs-trajectory').click();
  await expect(page.getByTestId('trajectory-fallback').first()).toContainText(
    'gemini-3.8-flash-high',
  );
});
