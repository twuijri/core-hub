/**
 * Tasks stage 2 against the real hub and a real git repository (`e2e/hub.ts` makes
 * `e2e-repo` in the default profile's folder when asked): the project is pointed at the repository in
 * its settings, a task assigned and started gets its own `git worktree` on a branch of its
 * own, its details show it, and Remove takes it away.
 *
 * It runs last (`zzzzzzz-`): it gives the default project a repository, so every task started
 * after it would get a worktree too.
 */
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';

test.use({ viewport: { width: 1440, height: 900 } });

async function login(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('اسم المستخدم').fill('admin');
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/chat$/);
}

test('a started task works in its own git worktree, shown in its details and removable', async ({
  page,
}) => {
  test.setTimeout(90_000);
  expect((await page.request.post('/__e2e/git-repo')).ok()).toBe(true);
  await login(page);
  await page.getByRole('link', { name: 'المهام' }).click();
  await expect(page).toHaveURL(/\/tasks$/);

  // The project's repository: a folder inside the profile, checked by the hub.
  await page.getByTestId('project-settings').click();
  const settings = page.getByTestId('project-dialog');
  await settings.getByTestId('project-repository').fill('not-here');
  await settings.getByTestId('project-dialog-save').click();
  await expect(settings).toContainText('هذا المجلّد غير موجود');
  await settings.getByTestId('project-repository').fill('e2e-repo');
  await settings.getByTestId('project-dialog-save').click();
  await expect(settings).toBeHidden();

  // A task, assigned and started.
  await page.getByTestId('new-task-input').fill('Release notes');
  await page.getByTestId('new-task').click();
  await page.getByTestId('task-intake-toggle').click();
  const card = page.getByTestId('task-card').filter({ hasText: 'Release notes' });
  await card.getByTestId('task-more').click();
  await page.getByRole('menuitem', { name: 'إسناد إلى وكيل…' }).click();
  const assign = page.getByTestId('task-assign-dialog');
  await expect(assign.getByTestId('task-assign-agent')).not.toBeEmpty();
  await assign.getByTestId('task-assign-start').click();
  await expect(assign).toBeHidden();
  await expect(card).toHaveAttribute('data-status', 'review', { timeout: 20_000 });

  // Its details: the worktree, its branch and its state — then Remove, which keeps the branch.
  await card.getByTestId('task-more').click();
  await page.getByRole('menuitem', { name: 'التفاصيل…' }).click();
  const details = page.getByTestId('task-dialog');
  await expect(details.getByTestId('task-worktree-branch')).toHaveText(
    /^task\/[a-z0-9-]+-release-notes$/,
  );
  await expect(details.getByTestId('task-worktree-path')).toContainText('/worktrees/');
  await expect(details.getByTestId('task-worktree-status')).toHaveText(/جاهزة|فيها تغييرات/);
  await expect(details.getByTestId('task-auto-start')).toHaveAttribute('aria-checked', 'false');

  await details.getByTestId('task-worktree-remove').click();
  await page.getByRole('button', { name: 'إزالة شجرة العمل' }).last().click();
  await expect(details.getByTestId('task-worktree')).toBeHidden({ timeout: 15_000 });
});
