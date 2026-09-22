// Five smoke journeys against the real hub (e2e/hub.ts): a new chat where the folder is
// chosen before the first message and the session is minted by that message; approvals;
// resume after a socket drop; stopping a run mid-stream. Screenshots for light/dark and
// RTL/LTR land in MAJLIS_SHOTS (or e2e/shots) for the change record.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const shots = process.env.MAJLIS_SHOTS ?? path.resolve('e2e/shots');
mkdirSync(shots, { recursive: true });

async function login(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.screenshot({ path: path.join(shots, 'login-ar-light.png'), fullPage: true });
  await page.getByLabel('اسم المستخدم').fill('admin');
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/chat$/);
}

/** Open the draft chat: the agent chips, the folder chip and the composer, no session yet. */
async function newChat(page: Page) {
  await page.getByRole('link', { name: 'محادثة جديدة' }).first().click();
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByTestId('agent-chip').first()).toBeVisible();
  await expect(page.getByTestId('composer-input')).toBeEnabled();
}

/** The first message is what creates the session (contract: sessions.create then createRun). */
async function firstMessage(page: Page, text: string): Promise<string> {
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('send').click();
  await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}$/);
  return page.url().split('/').pop() as string;
}

test.describe('web smoke journeys', () => {
  test('1. new chat → pick a folder → streamed markdown reply with reasoning, tool card and code', async ({
    page,
  }) => {
    await login(page);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await page.screenshot({ path: path.join(shots, 'chat-empty-ar-light.png'), fullPage: true });

    await newChat(page);
    // The empty chat offers three starters and a composer in its `empty` state.
    await expect(page.getByTestId('composer')).toHaveAttribute('data-state', 'empty');
    await expect(page.getByTestId('composer-starters').getByRole('button')).toHaveCount(3);
    await page.screenshot({ path: path.join(shots, 'new-chat-ar-light.png'), fullPage: true });

    // Name the folder this chat works in; the hub creates it under the workspace root.
    await page.getByTestId('working-dir-button').click();
    const sheet = page.getByTestId('working-dir-sheet');
    await expect(sheet).toBeVisible();
    await sheet.getByTestId('working-dir-new').fill('لوحة-الإطلاق');
    await page.screenshot({ path: path.join(shots, 'working-dir-ar-light.png'), fullPage: true });
    await sheet.getByRole('button', { name: 'إنشاء' }).click();
    await expect(page.getByTestId('working-dir-button')).toContainText('لوحة-الإطلاق');

    await firstMessage(page, 'مرحبا');
    // The chosen folder travelled with the session and is shown in the chat header.
    await expect(page.getByTestId('chat-header')).toContainText('لوحة-الإطلاق');
    await expect(page.getByTestId('message-user')).toContainText('مرحبا');
    const assistant = page.getByTestId('message-assistant');
    await expect(assistant.getByRole('heading', { name: 'مرحبا' })).toBeVisible();
    await expect(assistant.locator('strong')).toHaveText('رد');
    await expect(page.getByTestId('tool-call')).toContainText('shell');
    await expect(assistant.locator('pre code')).toContainText('const answer = 42;');
    await expect(assistant).toHaveAttribute('data-status', 'complete');
    await expect(page.getByTestId('reasoning')).toBeVisible();
    await expect(page.getByTestId('session-row')).toHaveCount(1);
    // Once the chat has run, the folder is fixed and says so instead of going quiet.
    await expect(page.getByTestId('working-dir-button')).toBeDisabled();
    await expect(page.getByTestId('working-dir-locked')).toBeVisible();
    await page.screenshot({ path: path.join(shots, 'chat-reply-ar-light.png'), fullPage: true });

    // The tool card opens its output in the split pane; the divider is a keyboard separator.
    await page.getByTestId('tool-call').locator('summary').click();
    await page.getByRole('button', { name: 'فتح في اللوحة الجانبية' }).first().click();
    await expect(page.getByTestId('split-pane')).toContainText('README.md');
    const separator = page.getByRole('separator');
    const before = Number(await separator.getAttribute('aria-valuenow'));
    await separator.focus();
    await page.keyboard.press('ArrowRight');
    expect(Number(await separator.getAttribute('aria-valuenow'))).toBeGreaterThan(before);
    await page.screenshot({ path: path.join(shots, 'chat-pane-ar-light.png'), fullPage: true });

    // Dark theme and English (LTR) through the settings screen; both persist on the root.
    await page.getByRole('link', { name: 'الإعدادات' }).click();
    // The sidebar is slim now: the management pages are here, not in the rail.
    await expect(page.getByTestId('settings-management').getByRole('link')).toHaveCount(4);
    await expect(page.getByTestId('rail').getByRole('link')).toHaveCount(2);
    await page.screenshot({
      path: path.join(shots, 'settings-management-ar-light.png'),
      fullPage: true,
    });
    await page.getByRole('link', { name: 'العرض' }).click();
    await page.getByTestId('theme-dark').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByTestId('glass-3').click();
    await expect(page.locator('html')).toHaveAttribute('data-glass', '3');
    await page.screenshot({ path: path.join(shots, 'settings-ar-dark.png'), fullPage: true });
    await page.getByTestId('language-en').click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.locator('#settings-section')).toHaveText('Display');
    await page.goBack();
    await page.goBack();
    await expect(page.getByTestId('message-assistant')).toBeVisible();
    await page.screenshot({ path: path.join(shots, 'chat-reply-en-dark.png'), fullPage: true });

    // The composer in English and dark: the tool row, the chips and the model selector.
    await page.getByRole('link', { name: 'New chat' }).first().click();
    await expect(page.getByTestId('agent-chip').first()).toBeVisible();
    await page.screenshot({ path: path.join(shots, 'new-chat-en-dark.png'), fullPage: true });

    await page.getByRole('link', { name: 'Settings' }).click();
    await page.getByRole('link', { name: 'Display' }).click();
    await page.getByTestId('theme-light').click();
    await page.screenshot({ path: path.join(shots, 'settings-en-light.png'), fullPage: true });
    await page.getByTestId('language-ar').click();
  });

  test('2. an approval card answers once / session / always / deny through the hub', async ({
    page,
  }) => {
    await login(page);
    await newChat(page);
    await firstMessage(page, 'please approve');
    const card = page.getByTestId('approval-card');
    await expect(card).toContainText('تنفيذ أمر');
    await expect(card).toContainText('pnpm test');
    for (const id of ['once', 'session', 'always', 'deny'])
      await expect(card.getByTestId(`approve-${id}`)).toBeVisible();
    await page.screenshot({ path: path.join(shots, 'approval-ar-light.png'), fullPage: true });
    await card.getByTestId('approve-session').click();
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId('message-assistant')).toContainText('تمت الموافقة');
    await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'complete');
  });

  test('3. a socket drop mid-run resumes with after_seq and loses nothing', async ({
    page,
    request,
  }) => {
    await login(page);
    await newChat(page);
    await firstMessage(page, 'slow reply please');
    await expect(page.getByTestId('message-assistant')).toContainText('الجزء الأول');
    await expect(page.getByTestId('stop-run')).toBeVisible();
    const dropped = await request.post('/__e2e/drop-sockets');
    expect(dropped.ok()).toBeTruthy();
    await expect(page.getByRole('status').filter({ hasText: /أُعيد الاتصال/ })).toBeVisible();
    await expect(page.getByTestId('message-assistant')).toContainText('والجزء الثاني بعد الانقطاع');
    await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'complete');
    await expect(page.getByTestId('stop-run')).toHaveCount(0);
  });

  test('5. the send button becomes stop mid-stream, and stop ends the run', async ({ page }) => {
    await login(page);
    await newChat(page);
    await firstMessage(page, 'stop me please');
    // Streaming: the send button is gone and the surface says which state it is in.
    const composer = page.getByTestId('composer');
    await expect(composer).toHaveAttribute('data-state', 'streaming');
    await expect(page.getByTestId('send')).toHaveCount(0);
    await expect(page.getByTestId('message-assistant')).toContainText('أبدأ عملًا طويلًا');
    await page.screenshot({
      path: path.join(shots, 'chat-streaming-ar-light.png'),
      fullPage: true,
    });

    await page.getByTestId('stop-run').click();
    // The run ends, the stop button goes away, and the composer can take a message again.
    await expect(page.getByTestId('stop-run')).toHaveCount(0);
    await expect(composer).toHaveAttribute('data-state', 'empty');
    await expect(page.getByTestId('send')).toBeVisible();
    await expect(page.getByTestId('message-assistant')).not.toContainText(
      'هذا الجزء لا يجب أن يصل بعد الإيقاف',
    );
  });
});
