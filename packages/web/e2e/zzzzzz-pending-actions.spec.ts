// 40. The pending-actions bar and the global agent (NAVIGATION §4, contract decision §45):
// an approval a chat is blocked on shows in the bar at the top of another screen, opens
// there and is answered there, and the bar clears; the bar leads to the global agent, whose
// conversation is not in the chats list but is found by search, which opens its page.
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';

async function login(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('اسم المستخدم').fill('admin');
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/chat$/);
}

async function newChat(page: Page) {
  const back = page.getByTestId('back-to-chats');
  if ((await back.count()) > 0) await back.click();
  await page.getByRole('link', { name: 'محادثة جديدة' }).first().click();
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByTestId('composer-input')).toBeEnabled();
}

async function firstMessage(page: Page, text: string): Promise<string> {
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('send').click();
  await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}(\?profile=[a-z0-9-]+)?$/);
  return new URL(page.url()).pathname.split('/').pop() as string;
}

test.describe('pending actions and the global agent', () => {
  test('40. an approval waits in the bar, is answered there, and the bar leads to the global agent', async ({
    page,
  }) => {
    await login(page);
    await newChat(page);
    const sessionId = await firstMessage(page, 'please approve');
    await expect(page.getByTestId('approval-card')).toBeVisible();

    // Elsewhere — a fresh draft — the bar at the top still says something waits.
    await newChat(page);
    const bar = page.getByTestId('pending-actions');
    await expect(bar.getByTestId('pending-actions-count')).toBeVisible();

    await bar.click();
    const sheet = page.getByTestId('pending-actions-sheet');
    await expect(sheet).toBeVisible();
    const item = sheet.locator(`[data-testid="pending-item"][data-session-id="${sessionId}"]`);
    await expect(item.getByTestId('approval-card')).toContainText('تنفيذ أمر');
    await expect(item.getByTestId('pending-item-open')).toHaveAttribute(
      'href',
      new RegExp(`^/chat/${sessionId}`),
    );

    // Answered from the bar: it leaves the list, and the conversation goes on.
    await item.getByTestId('approve-once').click();
    await expect(item).toHaveCount(0);

    // The bar is the way into the global agent.
    await sheet.getByTestId('pending-global-agent').click();
    await expect(page).toHaveURL(/\/global-agent(\?profile=[a-z0-9-]+)?$/);
    const chat = page.getByTestId('chat-screen');
    await expect(chat).toBeVisible();
    await expect(page.getByTestId('chat-intro')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'الوكيل العام' })).toBeVisible();
    const globalId = await chat.getAttribute('data-session-id');
    expect(globalId).toMatch(/^[0-9A-Z]{26}$/);

    await page.getByTestId('composer-input').fill('سؤال للوكيل العام عن اليوم');
    await page.getByTestId('send').click();
    await expect(page.getByTestId('message-assistant').last()).toHaveAttribute(
      'data-status',
      'complete',
    );
    // It is not a chat in the list.
    await expect(page.getByTestId('session-row').first()).toBeVisible();
    await expect(page.locator(`a[href^="/chat/${globalId}"]`)).toHaveCount(0);

    // The first chat was answered: its run finished after the approval.
    await page.goto(`/chat/${sessionId}`);
    await expect(page.getByTestId('message-assistant').last()).toContainText('تمت الموافقة');

    // Search finds the global agent's conversation and opens its page, not a chat.
    await page.getByRole('link', { name: 'بحث' }).first().click();
    await page.getByRole('searchbox', { name: 'بحث' }).fill('سؤال للوكيل العام');
    const hit = page.locator('[data-testid="search-result"][href^="/global-agent"]');
    await expect(hit).toHaveCount(1);
    await hit.click();
    await expect(page).toHaveURL(/\/global-agent(\?profile=[a-z0-9-]+)?$/);
    await expect(page.getByTestId('chat-screen')).toHaveAttribute('data-session-id', globalId!);
  });
});
