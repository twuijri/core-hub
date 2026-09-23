/**
 * The Tasks board's visual language, photographed against the real hub: every stage a
 * card can be in, side by side — running (a turning green frame), blocked (solid red),
 * scheduled (amber, dashed, with a clock), review (purple), ready (a quiet edge and its
 * badge) — next to a plain todo card and the archive behind Done. It follows the owner's
 * board decision of 2026-09-17, rebuilt here from the idea rather than from any code.
 *
 * It runs last (`zz-`, after the design pass): it leaves a run going on purpose, so the
 * running card is still running when it is photographed.
 *
 * Shots: Arabic light and English dark at 1440×900, and Arabic light on a 390px phone.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const shots = process.env.MAJLIS_SHOTS ?? path.resolve('e2e/shots');
mkdirSync(shots, { recursive: true });

test.use({ viewport: { width: 1440, height: 900 } });

const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false });

async function login(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('اسم المستخدم').fill('admin');
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/chat$/);
}

/** Write a task down; it lands in intake, where it is specified before it queues. */
async function newTask(page: Page, title: string) {
  await page.getByTestId('new-task-input').fill(title);
  await page.getByTestId('new-task').click();
  const card = page.getByTestId('task-card').filter({ hasText: title });
  await expect(card).toHaveAttribute('data-status', 'triage');
  return card;
}

/** One of the card's own quick buttons: queue, promote, archive. */
async function quick(card: ReturnType<Page['getByTestId']>, action: string, status: string) {
  await expect(card.getByTestId('task-quick')).toHaveAttribute('data-action', action);
  await card.getByTestId('task-quick').click();
  await expect(card).toHaveAttribute('data-status', status);
}

async function menu(page: Page, card: ReturnType<Page['getByTestId']>, item: string) {
  await card.getByTestId('task-more').click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

test.describe('the Tasks board, in colour', () => {
  test('every stage is told by its frame and its word, in both themes and on a phone', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await login(page);
    await page.getByRole('link', { name: 'المهام' }).click();
    await expect(page).toHaveURL(/\/tasks$/);
    await page.getByTestId('task-intake-toggle').click();

    // Ready: queued, then promoted with the card's own button.
    const ready = await newTask(page, 'صمّم الشعار');
    await quick(ready, 'queue', 'todo');
    await quick(ready, 'promote', 'ready');

    // To do: queued and left there, a plain card with the promote button.
    const todo = await newTask(page, 'رتّب المراجع');
    await quick(todo, 'queue', 'todo');

    // Scheduled: waiting on a time.
    const scheduled = await newTask(page, 'أرسل النشرة');
    await quick(scheduled, 'queue', 'todo');
    await menu(page, scheduled, 'جدولة');
    await expect(scheduled).toHaveAttribute('data-status', 'scheduled');

    // Blocked: waiting on a person, with the reason the hub asks for.
    const blocked = await newTask(page, 'اربط الدفع');
    await quick(blocked, 'queue', 'todo');
    await menu(page, blocked, 'موقوفة');
    await page.getByRole('textbox').fill('ننتظر مفاتيح البوابة');
    await page.getByRole('button', { name: 'حفظ' }).click();
    await expect(blocked).toHaveAttribute('data-status', 'blocked');

    // Review: done by whoever did it, not yet accepted.
    const review = await newTask(page, 'راجع الترجمة');
    await quick(review, 'queue', 'todo');
    await quick(review, 'promote', 'ready');
    await menu(page, review, 'للمراجعة');
    await expect(review).toHaveAttribute('data-status', 'review');

    // Done, then archived: the Archive button asks first.
    const archived = await newTask(page, 'نظّف المستودع');
    await quick(archived, 'queue', 'todo');
    await quick(archived, 'promote', 'ready');
    await menu(page, archived, 'تمّت');
    await expect(archived).toHaveAttribute('data-status', 'done');
    await archived.getByTestId('task-quick').click();
    const confirm = page.getByTestId('confirm-dialog');
    await expect(confirm).toContainText('أرشفة «نظّف المستودع»؟');
    await confirm.getByRole('button', { name: 'أرشفة' }).click();
    await expect(archived).toHaveCount(0);

    // Running: given to an agent and started; the run is scripted not to end here.
    const running = await newTask(page, 'ترجم الدليل');
    await running.getByTestId('task-more').click();
    await page.getByRole('menuitem', { name: 'إسناد إلى وكيل…' }).click();
    const dialog = page.getByTestId('task-assign-dialog');
    await expect(dialog.getByTestId('task-assign-agent')).not.toBeEmpty();
    await dialog.getByTestId('task-assign-start').click();
    await expect(dialog).toBeHidden();
    await expect(running).toHaveAttribute('data-status', 'running');
    await page.getByTestId('task-intake-toggle').click();

    // Each stage has its own frame, and its word beside it.
    const frames: Array<[ReturnType<Page['getByTestId']>, string, string]> = [
      [running, 'running', 'تعمل'],
      [blocked, 'blocked', 'متوقّفة'],
      [scheduled, 'scheduled', 'مجدولة'],
      [review, 'review', 'للمراجعة'],
      [ready, 'ready', 'جاهزة'],
    ];
    for (const [card, frame, word] of frames) {
      await expect(card).toHaveAttribute('data-frame', frame);
      await expect(card.getByTestId('task-status')).toContainText(word);
    }
    await expect(todo).not.toHaveAttribute('data-frame');
    await expect(scheduled.getByTestId('task-clock')).toBeVisible();
    // The frames really are drawn differently, not only named differently.
    const style = (card: ReturnType<Page['getByTestId']>, property: string) =>
      card.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);
    expect(await style(scheduled, 'border-top-style')).toBe('dashed');
    expect(await style(blocked, 'border-top-style')).toBe('solid');
    expect(await style(blocked, 'border-top-color')).not.toBe(
      await style(review, 'border-top-color'),
    );
    // Running turns, and stops turning — but stays a green frame — under reduced motion.
    expect(await style(running, 'animation-name')).toBe('task-frame-turn');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await style(running, 'animation-name')).toBe('none');
    expect(await style(running, 'border-top-width')).toBe('2px');
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    // The archive behind Done: a counted link, read-only cards.
    const toggle = page.getByTestId('task-archive-toggle');
    await expect(toggle).toContainText('عرض المؤرشفة (1)');
    await toggle.click();
    const archive = page.getByTestId('task-archive');
    await expect(archive).toContainText('نظّف المستودع');
    await expect(archive.getByTestId('task-more')).toHaveCount(0);

    await page.waitForTimeout(400);
    await shot(page, 'tasks-colours-ar-light');

    // A phone: the board scrolls sideways, the cards keep their frames.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    await shot(page, 'tasks-colours-mobile-ar-light');
    await page.setViewportSize({ width: 1440, height: 900 });

    // English and dark, the same board.
    await page.getByRole('link', { name: 'الإعدادات' }).first().click();
    await page.getByRole('link', { name: 'العرض' }).click();
    await page.getByTestId('theme-dark').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByTestId('language-en').click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    const back = page.getByTestId('back-to-chats');
    if ((await back.count()) > 0) await back.click();
    await page.getByRole('link', { name: 'Tasks' }).click();
    await expect(page).toHaveURL(/\/tasks$/);
    await expect(running).toHaveAttribute('data-frame', 'running');
    await expect(running.getByTestId('task-status')).toContainText('Running');
    await page.getByTestId('task-archive-toggle').click();
    await page.waitForTimeout(400);
    await shot(page, 'tasks-colours-en-dark');

    // Leave the display as the other journeys expect it.
    await page.getByRole('link', { name: 'Settings' }).first().click();
    await page.getByRole('link', { name: 'Display' }).click();
    await page.getByTestId('theme-light').click();
    await page.getByTestId('language-ar').click();
  });
});
