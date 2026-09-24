/**
 * A long conversation, and putting conversations away while they work (owner, 2026-09-24).
 *
 * 24. The chat opens with the newest 100 messages; scrolling up brings the page before, with
 *     the message that was at the top of the screen staying exactly where it was, while a
 *     reply keeps streaming at the bottom without pulling the reader down; at the start the
 *     chat says so.
 * 25. A search result deep in a long history opens there, with history on both sides of it.
 * 26. Archiving several conversations at once stops the one that is still working — the
 *     chat's own run and a task's — and the task goes back to Ready, still assigned.
 *
 * It runs after smoke.spec.ts (`zzz-`), which counts the rows of the session list.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const shots = process.env.MAJLIS_SHOTS ?? path.resolve('e2e/shots');
mkdirSync(shots, { recursive: true });

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
  await expect(page.getByTestId('agent-chip').first()).toBeVisible();
  await expect(page.getByTestId('composer-input')).toBeEnabled();
}

async function firstMessage(page: Page, text: string): Promise<string> {
  // Coming from another chat, the draft screen may settle once more after it shows: the
  // words are typed again until the send button takes them.
  await expect(async () => {
    await page.getByTestId('composer-input').fill(text);
    await expect(page.getByTestId('send')).toBeEnabled({ timeout: 1_000 });
  }).toPass();
  await page.getByTestId('send').click();
  await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}(\?profile=[a-z0-9-]+)?$/);
  return new URL(page.url()).pathname.split('/').pop() as string;
}

/**
 * Each helper finds the transcript's scroller the way the page does (followBottom.ts):
 * the nearest scrolling ancestor of the chat, or the document.
 */
type Where = 'top' | 'bottom';

/** How far the scroller is from its bottom, in pixels. */
const gap = (page: Page) =>
  page.getByTestId('chat-screen').evaluate((node) => {
    let at: HTMLElement | null = node.parentElement;
    while (at && !/auto|scroll/.test(getComputedStyle(at).overflowY)) at = at.parentElement;
    const s = at ?? (document.scrollingElement as HTMLElement);
    return s.scrollHeight - s.scrollTop - s.clientHeight;
  });

const scrollTo = (page: Page, where: Where) =>
  page.getByTestId('chat-screen').evaluate((node, to) => {
    let at: HTMLElement | null = node.parentElement;
    while (at && !/auto|scroll/.test(getComputedStyle(at).overflowY)) at = at.parentElement;
    const s = at ?? (document.scrollingElement as HTMLElement);
    s.scrollTop = to === 'top' ? 0 : s.scrollHeight;
  }, where);

/**
 * Scroll to the very top and report, in the same task (before the scroll event that asks
 * for the next page can run), which message is then at the top of the screen and where.
 */
const toTop = (page: Page) =>
  page.getByTestId('chat-screen').evaluate((node) => {
    let at: HTMLElement | null = node.parentElement;
    while (at && !/auto|scroll/.test(getComputedStyle(at).overflowY)) at = at.parentElement;
    const s = at ?? (document.scrollingElement as HTMLElement);
    s.scrollTop = 0;
    const top = s === document.scrollingElement ? 0 : s.getBoundingClientRect().top;
    const nodes = Array.from(s.querySelectorAll<HTMLElement>('[data-message-id]'));
    const first = nodes.find((each) => each.getBoundingClientRect().bottom > top)!;
    return { id: first.dataset.messageId!, y: first.getBoundingClientRect().top - top };
  });

/** Where a message is now, relative to the top of the scroller's visible area. */
const whereIs = (page: Page, id: string) =>
  page.getByTestId('chat-screen').evaluate((node, messageId) => {
    let at: HTMLElement | null = node.parentElement;
    while (at && !/auto|scroll/.test(getComputedStyle(at).overflowY)) at = at.parentElement;
    const s = at ?? (document.scrollingElement as HTMLElement);
    const top = s === document.scrollingElement ? 0 : s.getBoundingClientRect().top;
    const found = s.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
    return found ? found.getBoundingClientRect().top - top : null;
  }, id);

const messages = (page: Page) =>
  page.locator('[data-testid="message-user"], [data-testid="message-assistant"]');

/** 260 old messages; one of them, far back, holds the word the search looks for. */
const HISTORY = Array.from({ length: 260 }, (_, i) =>
  i === 30
    ? `رسالة قديمة ${i + 1}: وصفة الهيل والزنجبيل التي جرّبناها`
    : `رسالة قديمة ${i + 1}: سطر من محادثة طويلة جرت قبل شهور.`,
);

test.describe('a long conversation', () => {
  test('24. scrolling up pages back through history and keeps the reader’s place', async ({
    page,
    request,
  }) => {
    await login(page);
    await newChat(page);
    const sessionId = await firstMessage(page, 'مرحبا');
    await expect(page.getByTestId('message-assistant').last()).toHaveAttribute(
      'data-status',
      'complete',
    );
    // The conversation grows long (2 real messages, then 260 older-looking ones after them).
    const seeded = await request.post('/__e2e/seed-messages', {
      data: { session_id: sessionId, texts: HISTORY },
    });
    expect(seeded.ok()).toBeTruthy();
    await page.reload();

    // The newest 100 only, the line at the top saying more is there, and the chat at its
    // bottom as always.
    await expect(messages(page)).toHaveCount(100);
    const older = page.getByTestId('chat-older');
    await expect(older).toHaveAttribute('data-state', 'loading');
    await expect(older).toHaveText('جارٍ تحميل الرسائل الأقدم…');
    await expect.poll(() => gap(page)).toBeLessThan(80);

    // A reply starts streaming at the bottom, and the reader goes up to read history.
    await page.getByTestId('composer-input').fill('اكتب رد طويل');
    await page.getByTestId('send').click();
    const reply = page.getByTestId('message-assistant').last();
    await expect(reply).toContainText('سطر 3');
    const marker = await toTop(page);

    // The page before joins above; the message that was at the top has not moved.
    await expect(messages(page)).toHaveCount(202);
    expect(Math.abs((await whereIs(page, marker.id))! - marker.y)).toBeLessThan(2);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(shots, 'chat-older-ar-light.png') });

    // The reply kept growing meanwhile, and did not pull the reader down.
    await expect(reply).toContainText('سطر 20');
    expect(await gap(page)).toBeGreaterThan(2000);
    expect(Math.abs((await whereIs(page, marker.id))! - marker.y)).toBeLessThan(2);

    // Up again: the rest, and the start of the conversation — its very first words.
    const second = await toTop(page);
    await expect(older).toHaveAttribute('data-state', 'start');
    await expect(older).toHaveText('بداية المحادثة');
    await expect(messages(page)).toHaveCount(264);
    expect(Math.abs((await whereIs(page, second.id))! - second.y)).toBeLessThan(2);
    await scrollTo(page, 'top');
    await expect(page.getByTestId('message-user').first()).toContainText('مرحبا');
    await page.screenshot({ path: path.join(shots, 'chat-older-start-ar-light.png') });

    // The reply finished at the bottom while the reader stayed at the top.
    await expect(reply).toContainText('سطر 60', { timeout: 20_000 });
    expect(await gap(page)).toBeGreaterThan(2000);

    // Back at the bottom: following again, as before.
    await scrollTo(page, 'bottom');
    await page.getByTestId('composer-input').fill('شكرًا');
    await page.getByTestId('send').click();
    await expect(page.getByTestId('message-assistant')).toHaveCount(133);
    await expect.poll(() => gap(page)).toBeLessThan(80);
  });

  test('25. a search result deep in history opens there, with history on both sides', async ({
    page,
    request,
  }) => {
    await login(page);
    await newChat(page);
    const sessionId = await firstMessage(page, 'مرحبا من جديد');
    await expect(page.getByTestId('message-assistant').last()).toHaveAttribute(
      'data-status',
      'complete',
    );
    // 422 messages: the newest page is 323–422, the one before it 123–322, and the word
    // sits in message 128 — near the top of the page that brings it in.
    const texts = Array.from({ length: 420 }, (_, i) =>
      i === 125
        ? `نص سابق ${i + 3}: القرنفل في آخر الوصفة`
        : `نص سابق ${i + 3}: سطر من محادثة أطول.`,
    );
    const seeded = await request.post('/__e2e/seed-messages', {
      data: { session_id: sessionId, texts },
    });
    expect(seeded.ok()).toBeTruthy();

    await page.getByRole('link', { name: 'بحث' }).first().click();
    await page.getByRole('searchbox', { name: 'بحث' }).fill('القرنفل');
    const result = page.locator(`[data-testid="search-result"][href^="/chat/${sessionId}?"]`);
    await expect(result.locator('mark.msg-hit')).toHaveText('القرنفل');
    await result.click();

    const hit = page.locator('[data-anchored="true"]');
    await expect(hit).toBeInViewport();
    await expect(hit.locator('mark.msg-hit')).toHaveText('القرنفل');
    // History on both sides: the page before the one that held it came too, so the
    // messages just above it are there, not only the newer ones below.
    await expect(page.getByText('نص سابق 110:', { exact: false })).toHaveCount(1);
    await expect(page.getByText('نص سابق 400:', { exact: false })).toHaveCount(1);
    expect(await gap(page)).toBeGreaterThan(2000);
  });
});

test.describe('archiving stops the work', () => {
  test('26. archiving several conversations at once stops a running chat and a running task', async ({
    page,
  }) => {
    await login(page);

    // A task that works until it is stopped, started from the board.
    await page.getByRole('link', { name: 'المهام' }).click();
    await page.getByTestId('new-task-input').fill('اعمل حتى أوقفك على الفهرس');
    await page.getByTestId('new-task').click();
    await page.getByTestId('task-intake-toggle').click();
    const card = page.getByTestId('task-card').filter({ hasText: 'اعمل حتى أوقفك على الفهرس' });
    await card.getByTestId('task-more').click();
    await page.getByRole('menuitem', { name: 'إسناد إلى وكيل…' }).click();
    const dialog = page.getByTestId('task-assign-dialog');
    await expect(dialog.getByTestId('task-assign-agent')).not.toBeEmpty();
    await dialog.getByTestId('task-assign-start').click();
    await expect(card).toHaveAttribute('data-status', 'running');
    const taskHref = await card.getByTestId('task-session').getAttribute('href');
    const taskSession = /\/chat\/([0-9A-Z]{26})/.exec(taskHref ?? '')?.[1] as string;
    expect(taskSession).toMatch(/^[0-9A-Z]{26}$/);

    // A chat that works until it is stopped, and a quiet one next to it.
    await newChat(page);
    const busy = await firstMessage(page, 'اعمل حتى أوقفك');
    const working = page.getByTestId('message-assistant').last();
    await expect(working).toContainText('أعمل على ذلك');
    await expect(page.getByTestId('run-status')).toBeVisible();
    await newChat(page);
    const quiet = await firstMessage(page, 'مرحبا مرة أخرى');
    await expect(page.getByTestId('message-assistant').last()).toHaveAttribute(
      'data-status',
      'complete',
    );

    // Choose the three in the list and archive them together.
    const row = (id: string) =>
      page
        .getByTestId('session-row')
        .filter({ has: page.locator(`a[href^="/chat/${id}"]`) })
        .first();
    await row(busy).getByTestId('session-more-button').click();
    await page.getByRole('menuitem', { name: 'تحديد', exact: true }).click();
    await row(quiet).locator('.session-link').click();
    await row(taskSession).locator('.session-link').click();
    await expect(page.getByTestId('session-select-count')).toContainText('3');
    await page.getByTestId('session-bulk-archive').click();
    await expect(row(busy)).toHaveCount(0);
    await expect(row(taskSession)).toHaveCount(0);

    // The chat's run was stopped for real: its reply ends where it was cut, nothing running.
    await page.goto(`/chat/${busy}`);
    const cut = page.getByTestId('message-assistant').last();
    await expect(cut).toHaveAttribute('data-status', 'interrupted');
    await expect(cut).not.toContainText('هذا الجزء لا يصل بعد الإيقاف');
    await expect(page.getByTestId('run-status')).toHaveCount(0);

    // And the task, whose conversation went with them, is back in Ready — still assigned.
    await page.getByRole('link', { name: 'المهام' }).click();
    await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 15_000 });
    await expect(card.getByTestId('task-stop')).toHaveCount(0);
  });
});
