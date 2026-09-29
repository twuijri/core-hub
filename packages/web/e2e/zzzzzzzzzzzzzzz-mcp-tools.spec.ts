/**
 * An MCP server's tools without pressing Test, and which the agent may use (DECISIONS §134),
 * against the real hub with a scripted Hermes (`e2e/hub.ts`):
 *
 * - a server never tested is tested once, by itself, the first time its row opens, and lists
 *   its tools — the folded row then says how many;
 * - after a reload the list is there without a test: the hub kept it;
 * - «للقراءة فقط» ticks the tools that only look; Save writes the filter, and after a reload the
 *   folded row says «الأدوات: 2 من 4».
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

async function openMcp(page: Page) {
  await page.getByTestId('rail').getByRole('link', { name: 'الوكلاء' }).click();
  await page.getByTestId('agent-menu').getByRole('link', { name: 'MCP' }).first().click();
  await expect(page).toHaveURL(/\/mcp$/);
}

test('MCP tools: listed without Test, tested once by itself, and filtered read-only', async ({
  page,
}) => {
  await login(page);
  await openMcp(page);

  await page.getByTestId('new-mcp').click();
  await page.getByTestId('mcp-name').fill('picker');
  await page.getByTestId('mcp-config').fill('{ "command": "picker-mcp" }');
  await page.getByTestId('save-mcp').click();
  await expect(page.getByTestId('mcp-list')).toContainText('picker');
  // Never tested: no count yet.
  await expect(page.getByTestId('mcp-tool-count-picker')).toHaveCount(0);

  // Opening it tests it once, by itself (no Test press), and the row learns the count.
  const tested = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/mcp-servers/picker/test'),
  );
  await page.getByTestId('mcp-expand-picker').click();
  await tested;
  await expect(page.getByTestId('mcp-tools-picker')).toContainText('get_issue');
  await expect(page.getByTestId('mcp-tool-count-picker')).toHaveText('الأدوات: 4');

  // Kept by the hub: after a reload the list is there and nothing is tested.
  let again = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/mcp-servers/picker/test'))
      again += 1;
  });
  await page.reload();
  await expect(page.getByTestId('mcp-tool-count-picker')).toHaveText('الأدوات: 4');
  await expect(page.getByTestId('mcp-tools-picker')).toContainText('delete_repo');
  expect(again).toBe(0);

  // Read-only ticks the tools that only look.
  await page.getByTestId('mcp-tools-read-picker').click();
  await expect(page.getByTestId('mcp-tool-check-picker-get_issue')).toHaveAttribute(
    'data-state',
    'checked',
  );
  await expect(page.getByTestId('mcp-tool-check-picker-list_repos')).toHaveAttribute(
    'data-state',
    'checked',
  );
  await expect(page.getByTestId('mcp-tool-check-picker-create_issue')).toHaveAttribute(
    'data-state',
    'unchecked',
  );
  await expect(page.getByTestId('mcp-tool-check-picker-delete_repo')).toHaveAttribute(
    'data-state',
    'unchecked',
  );
  await expect(page.getByTestId('mcp-tools-note-picker')).toContainText('تبقى مغلقة حتى تحددها');
  await page.screenshot({ path: path.join(shots, 'agent-mcp-tools-ar-light.png'), fullPage: true });

  const saved = page.waitForRequest(
    (request) => request.method() === 'PATCH' && request.url().endsWith('/mcp-servers/picker'),
  );
  await page.getByTestId('mcp-tools-save-picker').click();
  expect((await saved).postDataJSON()).toEqual({
    tool_filter: { include: ['get_issue', 'list_repos'], exclude: null },
  });
  await expect(page.getByTestId('mcp-tools-saved-picker')).toBeVisible();
  await expect(page.getByTestId('mcp-tool-count-picker')).toHaveText('الأدوات: 2 من 4');

  // Written to the profile's config: still there after a reload.
  await page.reload();
  await expect(page.getByTestId('mcp-tool-count-picker')).toHaveText('الأدوات: 2 من 4');
  await expect(page.getByTestId('mcp-tools-allowed-picker')).toHaveText('المسموح: 2 من 4');

  // Leave the page as it was for the journeys after this one.
  await page.getByTestId('mcp-delete-picker').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'حذف' }).click();
  await expect(page.getByTestId('mcp-row-picker')).toHaveCount(0);
});
