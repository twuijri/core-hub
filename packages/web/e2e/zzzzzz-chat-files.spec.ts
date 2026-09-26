/**
 * 32. Files beside the chat (owner, 2026-09-25: «وبذات اني اقدر استعرض الملفات بالمحادثه»;
 *     contract decision §48): a scripted run writes `report.html`, `data.csv` and `notes.md`
 *     in the session's folder. The person opens each from the Files list and from the tool
 *     card's link: the page renders in a sandboxed frame (its script runs, apart from the
 *     app), the CSV is a table, the Markdown is rendered — then a word in the reply opens a
 *     file, and a second run that rewrites the report refreshes its open tab.
 *
 * Runs after the other journeys (`zzzzzz-`), which count the rows of the session list.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const shots = process.env.COREHUB_SHOTS ?? path.resolve('e2e/shots');
mkdirSync(shots, { recursive: true });

async function login(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('اسم المستخدم').fill('admin');
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/chat$/);
}

async function send(page: Page, text: string) {
  await expect(async () => {
    await page.getByTestId('composer-input').fill(text);
    await expect(page.getByTestId('send')).toBeEnabled({ timeout: 1_000 });
  }).toPass();
  await page.getByTestId('send').click();
}

test('32. files a run wrote open beside the chat from the Files list and the tool card', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('link', { name: 'محادثة جديدة' }).first().click();
  await expect(page).toHaveURL(/\/new$/);
  await send(page, 'اكتب الملفات الثلاثة');
  await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}(\?profile=[a-z0-9-]+)?$/);
  await expect(
    page.getByTestId('message-assistant').last().getByText('كتبت report.html'),
  ).toBeVisible({ timeout: 20_000 });

  // The Files list: the three files, newest first, each with its size.
  const button = page.getByTestId('chat-files');
  await expect(button).toHaveAccessibleName('الملفات (3)');
  await button.click();
  const sheet = page.getByTestId('files-sheet');
  await expect(sheet.getByTestId('file-row')).toHaveCount(3);
  await expect(sheet.getByTestId('file-row').first()).toContainText('notes.md');
  await sheet.getByTestId('file-row').filter({ hasText: 'report.html' }).click();

  // The page renders in the sandboxed frame, and its own script ran there.
  const pane = page.getByTestId('split-pane');
  await expect(pane).toBeVisible();
  const frameElement = pane.getByTestId('file-html-frame');
  await expect(frameElement).toHaveAttribute('sandbox', 'allow-scripts');
  const frame = page.frameLocator('[data-testid="file-html-frame"]');
  await expect(frame.locator('h1')).toHaveText('تقرير الربع');
  await expect(frame.locator('h1')).toHaveAttribute('data-ran', 'yes');
  // …and it cannot reach the app: an opaque origin has no access to the parent.
  const reached = await frameElement.evaluate((node) => {
    try {
      return (node as HTMLIFrameElement).contentWindow?.document !== undefined;
    } catch {
      return false;
    }
  });
  expect(reached).toBe(false);
  // "Open in new tab" never opens the page in the app's origin: the tab is a frame around it,
  // sandboxed the same way, and the page still runs its own script there.
  const [tab] = await Promise.all([
    page.waitForEvent('popup'),
    pane.getByTestId('file-new-tab').click(),
  ]);
  await expect(tab.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(tab.frameLocator('iframe').locator('h1')).toHaveAttribute('data-ran', 'yes');
  await tab.close();
  await pane.getByTestId('file-source-toggle').click();
  await expect(pane.getByTestId('file-code')).toContainText('<h1 id="t">');
  await page.screenshot({ path: path.join(shots, '32-chat-files-html.png') });

  // The CSV from the list: a table with its header.
  await button.click();
  await sheet.getByTestId('file-row').filter({ hasText: 'data.csv' }).click();
  const csv = pane.getByTestId('file-csv');
  await expect(csv.locator('th')).toHaveText(['البند', 'المبلغ']);
  await expect(csv.locator('tbody tr')).toHaveCount(2);
  await expect(pane.getByTestId('file-tab')).toHaveCount(2);

  // The Markdown from the tool card's link: the finished group opens, the link opens the file.
  await page.getByTestId('tool-group-summary').click();
  await page.getByTestId('tool-file-link').filter({ hasText: 'notes.md' }).click();
  const md = pane.getByTestId('file-markdown');
  await expect(md.locator('h1')).toHaveText('ملاحظات');
  await expect(md.locator('strong')).toHaveText('الميزانية');
  await expect(pane.getByTestId('file-tab')).toHaveCount(3);
  await page.screenshot({ path: path.join(shots, '32-chat-files-markdown.png') });

  // A word in the reply opens its file too.
  await page.getByTestId('file-mention').filter({ hasText: 'report.html' }).click();
  await expect(pane.getByTestId('file-name')).toHaveText('report.html');

  // The agent rewrites the report while its tab is open: the tab follows.
  await send(page, 'تحديث التقرير: اكتب الملفات من جديد');
  await expect(
    page.getByTestId('message-assistant').last().getByText('حدّثت report.html'),
  ).toBeVisible({ timeout: 20_000 });
  await expect(frame.locator('h1')).toHaveText('تقرير الربع المحدَّث', { timeout: 15_000 });

  // On a phone the panel is the whole screen, and closing it returns to the chat.
  await page.setViewportSize({ width: 390, height: 844 });
  const box = await pane.boundingBox();
  expect(box && Math.round(box.width) === 390 && Math.round(box.height) === 844).toBe(true);
  await page.screenshot({ path: path.join(shots, '32-chat-files-phone.png') });
  await page.getByRole('button', { name: 'إغلاق اللوحة الجانبية' }).click();
  await expect(pane).toHaveCount(0);

  // On a phone the conversation's bar keeps the agent and folds the folder, Files and the
  // Chat | Trajectory switch into one "More" panel: still one bar, pinned above the messages.
  const bar = page.getByTestId('chat-header');
  await expect(bar).toHaveAttribute('data-layout', 'menu');
  await expect(bar.getByTestId('session-agent')).toBeVisible();
  await bar.getByTestId('chat-more-button').click();
  const more = page.getByTestId('chat-more');
  await expect(more.getByTestId('chat-files')).toContainText('الملفات (3)');
  await expect(more.getByTestId('chat-tabs')).toBeVisible();
  await page.screenshot({ path: path.join(shots, '32-chat-bar-phone-more.png') });
  await more.getByTestId('chat-files').click();
  await expect(sheet.getByTestId('file-row')).toHaveCount(3);
});
