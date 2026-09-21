// Three smoke journeys against the real hub (e2e/hub.ts): login → new session → streamed reply;
// approval once/session/always/deny; resume after a socket drop. Screenshots for light/dark
// and RTL/LTR land in MAJLIS_SHOTS (or e2e/shots) for the change record.
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

async function newSession(page: Page): Promise<string> {
  await page.getByRole('link', { name: 'محادثة جديدة' }).first().click();
  await page.getByTestId('pick-agent').first().click();
  await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}$/);
  await expect(page.getByTestId('composer-input')).toBeEnabled();
  return page.url().split('/').pop() as string;
}

test.describe('web smoke journeys', () => {
  test('1. login → new session → streamed markdown reply with reasoning, tool card and code', async ({
    page,
  }) => {
    await login(page);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await page.screenshot({ path: path.join(shots, 'chat-empty-ar-light.png'), fullPage: true });
    await newSession(page);
    await page.getByTestId('composer-input').fill('مرحبا');
    await page.getByTestId('send').click();
    await expect(page.getByTestId('message-user')).toContainText('مرحبا');
    const assistant = page.getByTestId('message-assistant');
    await expect(assistant.getByRole('heading', { name: 'مرحبا' })).toBeVisible();
    await expect(assistant.locator('strong')).toHaveText('رد');
    await expect(page.getByTestId('tool-call')).toContainText('shell');
    await expect(assistant.locator('pre code')).toContainText('const answer = 42;');
    await expect(assistant).toHaveAttribute('data-status', 'complete');
    await expect(page.getByTestId('reasoning')).toBeVisible();
    await expect(page.getByTestId('session-row')).toHaveCount(1);
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
    await newSession(page);
    await page.getByTestId('composer-input').fill('please approve');
    await page.getByTestId('send').click();
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
    await newSession(page);
    await page.getByTestId('composer-input').fill('slow reply please');
    await page.getByTestId('send').click();
    await expect(page.getByTestId('message-assistant')).toContainText('الجزء الأول');
    await expect(page.getByTestId('stop-run')).toBeVisible();
    const dropped = await request.post('/__e2e/drop-sockets');
    expect(dropped.ok()).toBeTruthy();
    await expect(page.getByRole('status').filter({ hasText: /أُعيد الاتصال/ })).toBeVisible();
    await expect(page.getByTestId('message-assistant')).toContainText('والجزء الثاني بعد الانقطاع');
    await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'complete');
    await expect(page.getByTestId('stop-run')).toHaveCount(0);
  });
});
