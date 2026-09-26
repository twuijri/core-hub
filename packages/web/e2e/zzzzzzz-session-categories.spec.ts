/**
 * 32. Categories in the chats list (contract decision §60), against the real hub: a category
 *     «عملاء» is made from the list, a chat is moved into it from its menu («نقل إلى تصنيف»),
 *     the group is collapsed — and after a reload it is still collapsed, because which groups
 *     are closed is the viewer's own and stays in the browser.
 *
 * Runs after the other journeys (`zzzzzzz-`), which count the rows of the session list.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const shots = process.env.COREHUB_SHOTS ?? path.resolve('e2e/shots');
mkdirSync(shots, { recursive: true });

test.use({ viewport: { width: 1440, height: 900 } });

async function login(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('اسم المستخدم').fill('admin');
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/chat$/);
}

test('32. a category is made, a chat moved into it, and its collapse survives a reload', async ({
  page,
  request,
}, testInfo) => {
  // A retry runs against the same hub, where the first attempt's «عملاء» already exists and a
  // second one of that name is refused (§60): each attempt makes its own.
  const attempt = testInfo.retry + testInfo.repeatEachIndex;
  const name = attempt === 0 ? 'عملاء' : `عملاء ${attempt + 1}`;
  await login(page);

  // A chat of our own, so the journey does not depend on what ran before it.
  await page.getByRole('link', { name: 'محادثة جديدة' }).first().click();
  await expect(page).toHaveURL(/\/new$/);
  await expect(async () => {
    await page.getByTestId('composer-input').fill('خطة العميل الأول');
    await expect(page.getByTestId('send')).toBeEnabled({ timeout: 1_000 });
  }).toPass();
  await page.getByTestId('send').click();
  await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}(\?profile=[a-z0-9-]+)?$/);
  const sessionId = /\/chat\/([0-9A-Z]{26})/.exec(page.url())?.[1] ?? '';
  expect(sessionId).not.toBe('');

  const list = page.getByTestId('session-list');
  const row = list
    .getByTestId('session-row')
    .filter({ has: page.locator(`a[href*="${sessionId}"]`) });
  await expect(row).toHaveCount(1);

  // New category, named in our own dialog.
  await list.getByTestId('session-category-new').click();
  await page.getByTestId('prompt-field').fill(name);
  await page.getByTestId('prompt-confirm').click();
  const group = list
    .getByTestId('session-group')
    .filter({ has: page.getByTestId('session-group-toggle').getByText(name, { exact: true }) });
  await expect(group).toHaveCount(1);
  await expect(group).toContainText('اسحب محادثة إلى هنا');

  // Move the chat into it from the row's menu.
  await row.hover();
  await row.getByTestId('session-more-button').click();
  await page.getByRole('menuitem', { name: 'نقل إلى تصنيف' }).click();
  const dialog = page.getByTestId('move-category-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(group.getByTestId('session-row')).toHaveCount(1);
  await expect(group.locator(`a[href*="${sessionId}"]`)).toHaveCount(1);

  // Coloured from its menu (decision §102): a dot before its name.
  await group.getByTestId('session-group-head').hover();
  await group.getByTestId('session-group-more').click();
  await page.getByRole('menuitem', { name: 'اللون' }).click();
  await page.getByTestId('category-colour').getByRole('button', { name: 'أخضر' }).click();
  await expect(group.getByTestId('session-group-dot')).toHaveAttribute('data-color', '#22a06b');
  await list.screenshot({ path: path.join(shots, 'session-categories-ar-light.png') });

  // Collapse it: the chat is out of sight, the header says how many it holds.
  const toggle = group.getByTestId('session-group-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(group.getByTestId('session-row')).toHaveCount(0);

  // Reload: still collapsed, still holding the chat.
  await page.reload();
  const again = page
    .getByTestId('session-list')
    .getByTestId('session-group')
    .filter({ has: page.getByTestId('session-group-toggle').getByText(name, { exact: true }) });
  await expect(again).toHaveCount(1);
  await expect(again.getByTestId('session-group-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(again.getByTestId('session-row')).toHaveCount(0);
  await again.getByTestId('session-group-toggle').click();
  await expect(again.locator(`a[href*="${sessionId}"]`)).toHaveCount(1);

  // Drag works too: a second chat — made through the API, so the journey does not race the
  // composer a second time — picked up by its grip and dropped on the header.
  const signedIn = await request.post('/api/v1/auth/login', {
    data: { username: 'admin', password: PASSWORD },
  });
  const token = ((await signedIn.json()) as { access_token: string }).access_token;
  const headers = { authorization: `Bearer ${token}`, 'x-hub-profile': 'default' };
  const firstChat = (await (
    await request.get(`/api/v1/sessions/${sessionId}`, { headers })
  ).json()) as { agent_id: string };
  const made = await request.post('/api/v1/sessions', {
    headers,
    data: { agent_id: firstChat.agent_id, title: 'عرض سعر للعميل الثاني' },
  });
  expect(made.status()).toBe(201);
  const secondId = ((await made.json()) as { id: string }).id;
  const second = page
    .getByTestId('session-list')
    .getByTestId('session-row')
    .filter({ has: page.locator(`a[href*="${secondId}"]`) });
  await expect(second).toHaveCount(1);
  await second.hover();
  const grip = second.locator('.session-grip');
  const from = await grip.boundingBox();
  const to = await again.getByTestId('session-group-head').boundingBox();
  expect(from && to).toBeTruthy();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2 - 10, { steps: 4 });
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 12 });
  await expect(again.getByTestId('session-group-head')).toHaveAttribute('data-over', 'true');
  await page.mouse.up();
  await expect(again.locator(`a[href*="${secondId}"]`)).toHaveCount(1);
});
