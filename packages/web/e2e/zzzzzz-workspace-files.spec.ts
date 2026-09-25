/**
 * Files («الملفات», DECISIONS §56), against the real hub: Settings → Files, a file dropped on
 * the folder, renamed, opened in the editor, changed and saved, then deleted after the
 * confirm. Every step goes through the page the way a person does it, and the page is what
 * says each step worked.
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

/** Drop one file on the folder, the way a file dragged from the desktop arrives. */
async function dropFile(page: Page, name: string, text: string) {
  await page.getByTestId('files-drop').evaluate(
    (zone, file) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([file.text], file.name, { type: 'text/plain' }));
      zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: transfer }));
      zone.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    },
    { name, text },
  );
}

function row(page: Page, name: string) {
  return page.getByTestId('files-table').locator('tr', { hasText: name });
}

test.describe('Files', () => {
  test('uploads by drop, renames, edits and saves, then deletes', async ({ page }) => {
    await login(page);
    await page.getByRole('link', { name: 'الإعدادات' }).first().click();
    await page.getByTestId('settings-nav').getByRole('link', { name: 'الملفات' }).click();
    await expect(page).toHaveURL(/\/settings\/files$/);
    await expect(page.getByTestId('files-tool')).toBeVisible();

    // Upload: a file dropped on the list lands in this folder.
    await dropFile(page, 'ملاحظات.txt', 'السطر الأول\n');
    await expect(row(page, 'ملاحظات.txt')).toBeVisible();

    // Rename it.
    await row(page, 'ملاحظات.txt').getByTestId('files-row-actions').click();
    await page.getByRole('menuitem', { name: 'إعادة تسمية' }).click();
    const prompt = page.getByTestId('prompt-dialog');
    await prompt.getByTestId('prompt-field').fill('plan.md');
    await prompt.getByTestId('prompt-confirm').click();
    await expect(row(page, 'plan.md')).toBeVisible();
    await expect(row(page, 'ملاحظات.txt')).toHaveCount(0);

    // Edit and save: open it, change the text, save, and the editor says it is saved.
    await row(page, 'plan.md').getByTestId('files-entry').click();
    const preview = page.getByTestId('files-preview');
    await expect(preview.getByTestId('files-preview-text-input')).toHaveValue('السطر الأول\n');
    await preview.getByTestId('files-preview-edit').click();
    const editor = page.getByTestId('files-editor');
    const text = editor.getByTestId('files-editor-text-input');
    await expect(text).toHaveValue('السطر الأول\n');
    await text.fill('# الخطة\n\n- صفحة الملفات\n');
    await expect(editor).toContainText('تغييرات غير محفوظة');
    await page.waitForTimeout(200);
    await editor.screenshot({ path: path.join(shots, '33-files-editor-ar.png') });
    await editor.getByTestId('files-editor-save').click();
    await expect(editor).toContainText('كل التغييرات محفوظة');
    await editor.getByRole('button', { name: 'إغلاق' }).first().click();
    await expect(editor).toHaveCount(0);

    // The saved text is what the hub now holds: open it again.
    await row(page, 'plan.md').getByTestId('files-entry').click();
    await expect(page.getByTestId('files-preview-text-input')).toHaveValue(
      '# الخطة\n\n- صفحة الملفات\n',
    );
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('files-preview')).toHaveCount(0);
    await page.getByTestId('files-tool').screenshot({ path: path.join(shots, '33-files-ar.png') });

    // Delete, after the confirm.
    await row(page, 'plan.md').getByTestId('files-row-actions').click();
    await page.getByRole('menuitem', { name: 'حذف' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('حذف «plan.md»؟');
    await confirm.getByRole('button', { name: 'حذف' }).click();
    await expect(row(page, 'plan.md')).toHaveCount(0);
  });
});
