/**
 * 33. The files a run changed (contract decision §49): a scripted run writes three files, and
 *     a second run edits two of them and creates a third. Under the second reply a card says
 *     «غيّر 3 ملفات» with the added and removed lines of each file; a file opens what the run
 *     did to it beside the chat — numbered lines, left to right in the Arabic page, side by
 *     side on a wide screen — and the file itself opens from there.
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

test('33. a run’s changed files are counted under its reply and open as a diff', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('link', { name: 'محادثة جديدة' }).first().click();
  await expect(page).toHaveURL(/\/new$/);
  await send(page, 'اكتب الملفات الثلاثة');
  await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}(\?profile=[a-z0-9-]+)?$/);
  // The first run created three files: its own card says so.
  const first = page.getByTestId('run-changes').first();
  await expect(first.getByTestId('run-changes-title')).toHaveText('غيّر 3 ملفات', {
    timeout: 20_000,
  });

  await send(page, 'عدّل المشروع');
  await expect(page.getByTestId('message-assistant').last().getByText('كتبت plan.md')).toBeVisible({
    timeout: 20_000,
  });
  const card = page.getByTestId('message-assistant').last().getByTestId('run-changes');
  await expect(card.getByTestId('run-changes-title')).toHaveText('غيّر 3 ملفات');
  // The totals and each file's counts, left to right inside the Arabic sentence.
  await expect(card.getByTestId('run-change-counts').first()).toHaveText('+6−1');
  await expect(card.getByTestId('run-change-counts').first()).toHaveAttribute('dir', 'ltr');
  const rows = card.getByTestId('run-change-file');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute('data-path', 'data.csv');
  await expect(rows.nth(0)).toContainText('معدَّل');
  await expect(rows.nth(0).getByTestId('run-change-counts')).toHaveText('+1−1');
  await expect(rows.nth(1)).toHaveAttribute('data-path', 'notes.md');
  await expect(rows.nth(1).getByTestId('run-change-counts')).toHaveText('+1−0');
  await expect(rows.nth(2)).toHaveAttribute('data-path', 'plan.md');
  await expect(rows.nth(2)).toContainText('جديد');
  await expect(rows.nth(2).getByTestId('run-change-counts')).toHaveText('+4−0');
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, '33-run-changes-card.png') });

  // A file opens what this run did to it, beside the chat.
  await rows.nth(0).click();
  const pane = page.getByTestId('split-pane');
  const diff = pane.getByTestId('diff-view');
  await expect(diff).toBeVisible();
  await expect(pane.getByTestId('file-tab').first()).toHaveText('data.csv (التغييرات)');
  const table = diff.getByTestId('diff-table');
  await expect(table.locator('xpath=ancestor::*[@dir][1]')).toHaveAttribute('dir', 'ltr');
  await expect(table.locator('tr[data-kind="del"] td.diff-code')).toHaveText(['-كهرباء,300']);
  await expect(table.locator('tr[data-kind="add"] td.diff-code')).toHaveText(['+كهرباء,350']);
  // Numbered on both sides: line 3 before, line 3 after.
  await expect(table.locator('tr[data-kind="del"] td').first()).toHaveText('3');
  await expect(table.locator('tr[data-kind="add"] td').nth(1)).toHaveText('3');

  // Side by side on a wide screen.
  await diff.getByTestId('diff-split').click();
  await expect(table).toHaveAttribute('data-split', 'true');
  await expect(table.locator('td[data-kind="del"]')).toHaveText('كهرباء,300');
  await expect(table.locator('td[data-kind="add"]')).toHaveText('كهرباء,350');
  await page.screenshot({ path: path.join(shots, '33-run-changes-diff.png') });

  // …and the file itself, from the diff.
  await diff.getByTestId('diff-open-file').click();
  await expect(pane.getByTestId('file-view')).toBeVisible();
  await expect(pane.getByTestId('file-csv')).toContainText('350');
  await expect(pane.getByTestId('file-tab')).toHaveCount(2);

  // A new file's diff is every line added.
  await rows.nth(2).click();
  await expect(pane.getByTestId('diff-view').getByTestId('diff-line')).toHaveCount(4);
  await expect(pane.getByTestId('diff-view').locator('tr[data-kind="add"]')).toHaveCount(4);
});

test('33. while a run is still going, the files it has changed so far show under its reply', async ({
  page,
}) => {
  // Decision §102: the same card, marked «حتى الآن», read again as the run works; the recorded
  // card takes over when the run ends.
  await login(page);
  await page.getByRole('link', { name: 'محادثة جديدة' }).first().click();
  await expect(page).toHaveURL(/\/new$/);
  await send(page, 'اكتب ببطء ملفين');
  await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}(\?profile=[a-z0-9-]+)?$/);
  const reply = page.getByTestId('message-assistant').last();
  const live = reply.getByTestId('run-changes-live');
  await expect(live).toBeVisible({ timeout: 15_000 });
  await expect(live.getByTestId('run-changes-live-badge')).toHaveText('حتى الآن');
  await expect(live.getByTestId('run-change-file')).toHaveCount(1);
  await expect(live.getByTestId('run-change-file').first()).toHaveAttribute(
    'data-path',
    'draft.md',
  );
  await live.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, '33-run-changes-live.png') });

  // The run ends: the recorded card, with both files, and the live one is gone.
  const recorded = page.getByTestId('message-assistant').last().getByTestId('run-changes');
  await expect(recorded.getByTestId('run-changes-title')).toHaveText('غيّر ملفين', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('run-changes-live')).toHaveCount(0);
});
