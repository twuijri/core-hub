/**
 * 42. The Memory page draws each entry on its own (decision §102), against the real hub and the
 *     files Hermes reads: two entries are added to «عنك» one at a time, the list shows them as two
 *     rows with the budget they count against, one is rewritten alone, and one is removed after a
 *     confirmation — the rest of the list staying as it was.
 *
 * Runs last (`zzzzzzzzzzzz-`): it writes to the default profile's memory, which the earlier
 * journeys photograph empty.
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

async function addEntry(page: Page, text: string) {
  await page.getByTestId('memory-add-user').click();
  const editor = page.getByTestId('memory-entry-editor');
  await editor.getByTestId('memory-entry-content').fill(text);
  await editor.getByTestId('save-memory-entry').click();
  await expect(editor).toHaveCount(0);
}

test('42. memory entries are drawn, edited and removed one by one, with their budget', async ({
  page,
}) => {
  await login(page);
  await page.getByTestId('rail').getByRole('link', { name: 'الوكلاء' }).click();
  const hermes = page.locator('[data-testid="agent-card"][data-agent-slug="hermes"]');
  await hermes.getByTestId('agent-menu').getByRole('link', { name: 'الذاكرة' }).click();
  await expect(page).toHaveURL(/\/agents\/[^/]+\/memory$/);
  const about = page.getByTestId('memory-doc-user');
  await expect(about).toBeVisible();
  // Hermes's default budget for what it knows about the person.
  await expect(about.getByTestId('memory-budget')).toHaveAttribute('data-limit', '1375');

  // What is there already (the smoke journey wrote one entry) stays first, as it was.
  const rows = page.getByTestId('memory-entries-user').getByTestId('memory-entry');
  const before = await rows.allTextContents();
  await addEntry(page, 'يفضّل الردود المختصرة.');
  await addEntry(page, 'Writes commit messages in English.');
  await expect(rows).toHaveCount(before.length + 2);
  await expect(rows.nth(before.length)).toHaveText('يفضّل الردود المختصرة.');
  // The entries and the `§` lines between them, counted in code points as Hermes counts them.
  const all = [...before, 'يفضّل الردود المختصرة.', 'Writes commit messages in English.'];
  await expect(about.getByTestId('memory-budget')).toHaveAttribute(
    'data-count',
    String([...all.join('\n§\n')].length),
  );
  await about.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, 'agent-memory-entries-ar-light.png') });

  // One entry rewritten alone.
  const last = before.length + 1;
  await rows.nth(last).getByTestId('memory-entry-edit').click();
  const editor = page.getByTestId('memory-entry-editor');
  await editor
    .getByTestId('memory-entry-content')
    .fill('Writes commit messages in English, briefly.');
  await editor.getByTestId('save-memory-entry').click();
  await expect(rows.nth(last)).toHaveText('Writes commit messages in English, briefly.');
  await expect(rows.nth(before.length)).toHaveText('يفضّل الردود المختصرة.');

  // One removed after asking; the others stay.
  await rows.nth(before.length).getByTestId('memory-entry-remove').click();
  await page.getByRole('button', { name: 'أزل' }).last().click();
  await expect(rows).toHaveCount(before.length + 1);
  await expect(rows.last()).toHaveText('Writes commit messages in English, briefly.');
});
