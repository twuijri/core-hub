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

const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
/** The sidebar on its own: the rail, the segment row and the list, at their real size. */
const sidebarShot = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: /القائمة الرئيسية|Main menu/ })
    .screenshot({ path: path.join(shots, `${name}.png`) });

/** Display preferences live on one Settings page; the journey uses it to change the skin. */
async function setDisplay(page: Page, settings: string, display: string, testId: string) {
  // A management page carries its own "back to Settings" link, so the name is not unique.
  await page.getByRole('link', { name: settings }).first().click();
  await page.getByRole('link', { name: display }).click();
  await page.getByTestId(testId).click();
}

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
    // The empty chat is centred: the composer is not docked until there is a transcript.
    await expect(page.getByTestId('new-chat')).toHaveAttribute('data-empty', 'true');
    await expect(page.getByTestId('composer')).toHaveAttribute('data-state', 'empty');
    await expect(page.getByTestId('composer-starters').getByRole('button')).toHaveCount(3);
    await shot(page, 'new-chat-ar-light');
    await sidebarShot(page, 'sidebar-ar-light');

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
    // The chip row belongs to an empty chat (owner decision, 2026-09-22): now that the
    // conversation has turns it is gone, and the agent is named in the header instead.
    await expect(page.getByTestId('agent-chips')).toHaveCount(0);
    await expect(page.getByTestId('session-agent')).toContainText('Hermes');
    // And the session named itself from its first exchange (contract decision §26), so
    // the sidebar row is no longer "محادثة جديدة".
    await expect(page.getByTestId('session-row').first()).toContainText(
      'خطة الإطلاق في ثلاث مراحل',
    );
    // Once the chat has run, the folder is fixed and says so instead of going quiet.
    await expect(page.getByTestId('working-dir-button')).toBeDisabled();
    await expect(page.getByTestId('working-dir-locked')).toBeVisible();
    // The column has handed itself to the transcript: the composer is docked.
    await expect(page.getByTestId('chat-screen')).toHaveAttribute('data-empty', 'false');
    await shot(page, 'chat-reply-ar-light');

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

    // The sidebar is slim: the rail is New chat · Search · Tasks · Schedules, and the
    // segment row is Chat · Rooms only. Both belong to the chat list, so they are checked
    // here, before Settings replaces the list with its own.
    await expect(page.getByTestId('rail').getByRole('link')).toHaveCount(4);
    await expect(page.getByTestId('segments').getByRole('radio')).toHaveCount(2);
    await expect(page.getByTestId('segments')).not.toContainText('السجل');

    // Dark theme and English (LTR) through the settings screen; both persist on the root.
    await page.getByRole('link', { name: 'الإعدادات' }).click();
    // Inside Settings the sidebar *is* the settings list (owner, 2026-09-22): the
    // management pages are rows in it, and the conversation list has stepped aside.
    await expect(page.getByTestId('settings-management').getByRole('link')).toHaveCount(4);
    await expect(page.getByTestId('session-row')).toHaveCount(0);
    await page.screenshot({
      path: path.join(shots, 'settings-management-ar-light.png'),
      fullPage: true,
    });
    await page.getByRole('link', { name: 'العرض' }).click();
    await page.getByTestId('theme-dark').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByTestId('glass-3').click();
    await expect(page.locator('html')).toHaveAttribute('data-glass', '3');
    await shot(page, 'settings-ar-dark');

    // Arabic, dark: the same two views and the sidebar.
    await page.goBack();
    await page.goBack();
    await expect(page.getByTestId('message-assistant')).toBeVisible();
    await shot(page, 'chat-reply-ar-dark');
    await sidebarShot(page, 'sidebar-ar-dark');
    await page.getByRole('link', { name: 'محادثة جديدة' }).first().click();
    await expect(page.getByTestId('new-chat')).toHaveAttribute('data-empty', 'true');
    await shot(page, 'new-chat-ar-dark');

    // English, dark (LTR): the segmented tracks have to read correctly in both directions.
    await setDisplay(page, 'الإعدادات', 'العرض', 'language-en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.locator('#settings-section')).toHaveText('Display');
    await page.getByRole('link', { name: 'New chat' }).first().click();
    await expect(page.getByTestId('agent-chip').first()).toBeVisible();
    await shot(page, 'new-chat-en-dark');
    await sidebarShot(page, 'sidebar-en-dark');
    await page.getByTestId('session-row').first().getByRole('link').click();
    await expect(page.getByTestId('message-assistant')).toBeVisible();
    await shot(page, 'chat-reply-en-dark');

    // The list filter is a link, not a mode: the URL carries it.
    const scope = page.getByTestId('session-scope');
    await scope.getByRole('radio', { name: 'Archived' }).click();
    await expect(page).toHaveURL(/sessions=archived/);
    await expect(page.getByTestId('session-list')).toContainText('Nothing archived.');
    await scope.getByRole('radio', { name: 'Active' }).click();
    await expect(page).not.toHaveURL(/sessions=/);
    await expect(page.getByTestId('session-row')).toHaveCount(1);

    await setDisplay(page, 'Settings', 'Display', 'theme-light');
    await shot(page, 'settings-en-light');
    await page.getByTestId('language-ar').click();
  });

  test('6. the agent row gives up labels before options, then overflows into More', async ({
    page,
  }) => {
    await login(page);
    await newChat(page);
    const row = page.getByTestId('agent-chips');
    // Six agents from the catalog — Hermes, the hub's own `direct` agent
    // (ADOPTION-BACKLOG §2.15) and the four coding CLIs — and a trailing "+" that goes
    // to the Agent Manager.
    await expect(page.getByTestId('agent-chip')).toHaveCount(6);
    await expect(page.getByTestId('agent-add')).toBeVisible();
    // At its widest the chat column is `--mj-layout-reading-max` (48rem), and six
    // Arabic labels no longer fit in it, so the row opens one rung down the ladder:
    // compact, with the chosen agent still a word and the rest icon-only. Nothing wraps
    // and nothing scrolls, which is what the ladder is for. The comfortable rung is
    // covered by `tests/segmented-fit.test.ts`; whether six labelled chips *should* fit
    // is the chip row's own question and a parallel branch owns it.
    await page.setViewportSize({ width: 1600, height: 720 });
    await expect(row).toHaveAttribute('data-density', 'compact');
    await shot(page, 'agents-comfortable-ar-light');

    // Narrow enough that the labels no longer fit: only the chosen agent keeps its word,
    // the rest collapse to their initial, and nothing wraps or scrolls.
    await page.setViewportSize({ width: 860, height: 720 });
    await expect(row).toHaveAttribute('data-density', 'compact');
    const chips = page.getByTestId('agent-chip');
    await expect(chips.first()).toHaveAttribute('aria-checked', 'true');
    await expect(chips.first()).toContainText('Hermes');
    await expect(chips.nth(1)).toHaveClass(/mj-segment-icon-only/);
    // An icon is not a mystery: the name is still the accessible name. Chip 1 is the
    // direct agent, which sits second in every list (`agents/service.ts` §order).
    await expect(chips.nth(1)).toHaveAttribute('aria-label', /مباشر/);
    await expect(chips.nth(2)).toHaveAttribute('aria-label', /Claude Code/);
    // The hairline is drawn between icon-only neighbours and never beside the raised
    // surface, and it is decorative: a pseudo-element, nothing in the accessibility tree.
    const dividerOn = (index: number) =>
      chips.nth(index).evaluate((el) => window.getComputedStyle(el, '::before').content !== 'none');
    expect(await dividerOn(1)).toBe(false); // right after the selected option
    expect(await dividerOn(2)).toBe(true);
    expect(await dividerOn(3)).toBe(true);
    await shot(page, 'agents-compact-ar-light');

    // A phone: even the icons no longer fit, so the rest move into More and the chosen
    // agent stays on screen.
    await page.setViewportSize({ width: 340, height: 720 });
    const more = page.getByTestId('agent-chips-more');
    await expect(more).toBeVisible();
    await expect(page.getByTestId('agent-chip').first()).toHaveAttribute('aria-checked', 'true');
    await shot(page, 'agents-overflow-ar-light');

    // The menu lists the rest, each with a check on the current one.
    await more.click();
    await expect(page.getByRole('menuitemcheckbox').first()).toBeVisible();
    await shot(page, 'agents-overflow-menu-ar-light');
    await page.keyboard.press('Escape');

    // Dark and English, back at a width where the sidebar is on screen, then narrowed
    // again: the compact row has to read in both themes and both directions.
    await page.setViewportSize({ width: 1280, height: 720 });
    await setDisplay(page, 'الإعدادات', 'العرض', 'theme-dark');
    await page.getByTestId('language-en').click();
    await page.getByRole('link', { name: 'New chat' }).first().click();
    await expect(page.getByTestId('agent-chips')).toBeVisible();
    await page.setViewportSize({ width: 860, height: 720 });
    await expect(page.getByTestId('agent-chips')).toHaveAttribute('data-density', 'compact');
    await shot(page, 'agents-compact-en-dark');
    await page.setViewportSize({ width: 1280, height: 720 });
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

  test('8. changing the agent mid-conversation forks the session and carries the transcript', async ({
    page,
  }) => {
    await login(page);
    await newChat(page);
    const original = await firstMessage(page, 'مرحبا');
    await expect(page.getByTestId('message-assistant')).toHaveAttribute('data-status', 'complete');
    await expect(page.getByTestId('session-agent')).toContainText('Hermes');
    await shot(page, 'chat-agent-header-ar-light');

    // The header control offers the other installed agents, and says in one line that
    // choosing one copies the conversation — which is what keeps it apart from the
    // composer's model selector, where nothing is copied.
    await page.getByTestId('session-agent').click();
    const menu = page.getByTestId('session-agent-menu');
    await expect(menu).toContainText('ينسخ هذه المحادثة');
    await shot(page, 'chat-agent-menu-ar-light');
    await menu.getByTestId('continue-with').first().click();

    // The fork is what opens, it is a different session, and the transcript came with it.
    await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}$/);
    await expect(page.getByTestId('chat-screen')).not.toHaveAttribute('data-session-id', original);
    await expect(page.getByTestId('message-user')).toContainText('مرحبا');
    await expect(page.getByTestId('message-assistant')).toContainText('رد');
    // The fork starts no run: it is a conversation waiting for its next turn.
    await expect(page.getByTestId('run-status')).toHaveCount(0);
    await expect(page.getByTestId('session-agent')).not.toContainText('Hermes');
    await shot(page, 'chat-forked-ar-light');

    // The original is untouched and still there, on its own agent, with its own transcript.
    await page.goto(`/chat/${original}`);
    await expect(page.getByTestId('chat-screen')).toHaveAttribute('data-session-id', original);
    await expect(page.getByTestId('session-agent')).toContainText('Hermes');
    await expect(page.getByTestId('message-user')).toHaveCount(1);
  });

  test('9. a session names itself, a person can rename it, and can hand the naming back', async ({
    page,
  }) => {
    await login(page);
    await newChat(page);
    await firstMessage(page, 'مرحبا');
    const row = page.getByTestId('session-row').first();
    await expect(row).toContainText('خطة الإطلاق في ثلاث مراحل');

    // Rename: our own dialog, never the browser's prompt (UI policy).
    await row.getByTestId('session-more-button').click();
    await page.getByRole('menuitem', { name: 'إعادة التسمية' }).click();
    const field = page.getByTestId('prompt-field');
    await expect(field).toBeVisible();
    await field.fill('اسم كتبته بنفسي');
    await shot(page, 'session-rename-ar-light');
    await page.getByTestId('prompt-confirm').click();
    await expect(row).toContainText('اسم كتبته بنفسي');

    // A name a person typed survives the next turn: the hub does not rename over it.
    await page.getByTestId('composer-input').fill('ومرة أخرى');
    await page.getByTestId('send').click();
    await expect(page.getByTestId('message-assistant')).toHaveCount(2);
    await expect(row).toContainText('اسم كتبته بنفسي');

    // Retitle hands the naming back, and the new name arrives on /rt/sessions.
    await row.getByTestId('session-more-button').click();
    await page.getByRole('menuitem', { name: 'أعد التسمية تلقائيًا' }).click();
    await expect(row).toContainText('خطة الإطلاق في ثلاث مراحل');
  });

  test('7. 443 models: the picker searches, and the list never stops being usable', async ({
    page,
  }) => {
    await login(page);
    // Models lives inside Settings now (round two); add a provider and ask for its list.
    await page.getByRole('link', { name: 'الإعدادات' }).first().click();
    await page.getByRole('link', { name: 'النماذج' }).click();
    await page.getByTestId('open-add-provider').click();
    await page.getByTestId('add-preset').click();
    await page.getByRole('option', { name: 'LM Studio' }).click();

    // Before the fetch, the picker says what is missing and offers the fetch itself.
    await page.getByTestId('add-default-model').click();
    await expect(page.getByTestId('combobox-unfetched')).toBeVisible();
    await shot(page, 'model-picker-unfetched-ar-light');
    await page.getByTestId('combobox-fetch').click();

    // 443 models, and the popup is still a list a person can read.
    await expect(page.getByTestId('combobox-list')).toBeVisible();
    const shown = await page.getByTestId('combobox-option').count();
    expect(shown).toBeGreaterThan(0);
    // Virtualized: a fraction of the catalogue is in the DOM, not all of it.
    expect(shown).toBeLessThan(60);
    await shot(page, 'model-picker-long-ar-light');

    // The owner's own example: typing `opus` finds the thinking variant.
    await page.getByTestId('combobox-field').fill('opus');
    const matches = page.getByTestId('combobox-option');
    await expect(matches.first()).toContainText('opus');
    // Every row still on screen is a match — the list narrowed, it did not merely re-sort.
    // (The count itself cannot shrink: the virtualizer always fills the viewport.)
    for (const text of await matches.allTextContents()) expect(text).toContain('opus');
    // The matched characters are marked, not merely ordered first.
    await expect(matches.first().locator('mark').first()).toBeVisible();
    await shot(page, 'model-picker-search-ar-light');

    // Keyboard: the field keeps the focus while the arrows move the highlight.
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('combobox-field')).toBeFocused();
    await expect(page.locator('[data-testid="combobox-option"][data-active="true"]')).toHaveCount(
      1,
    );
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('combobox-field')).toHaveCount(0);
    await expect(page.getByTestId('add-default-model')).toContainText('opus');

    // English and dark, at the same size. The add-provider dialog is modal, so it has to
    // be closed before the sidebar can be reached again.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('add-provider-dialog')).toHaveCount(0);
    await setDisplay(page, 'الإعدادات', 'العرض', 'theme-dark');
    await page.getByTestId('language-en').click();
    await page.getByRole('link', { name: 'Settings' }).first().click();
    await page.getByRole('link', { name: 'Models' }).click();
    await page.getByTestId('open-add-provider').click();
    await page.getByTestId('add-preset').click();
    await page.getByRole('option', { name: 'LM Studio' }).click();
    await page.getByTestId('add-default-model').click();
    await page.getByTestId('combobox-fetch').click();
    await expect(page.getByTestId('combobox-list')).toBeVisible();
    await page.getByTestId('combobox-field').fill('claude');
    await shot(page, 'model-picker-long-en-dark');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await setDisplay(page, 'Settings', 'Display', 'theme-light');
    await page.getByTestId('language-ar').click();
  });

  test('10. the Tasks board: an intake strip, four columns, and a drop that asks what it means', async ({
    page,
  }) => {
    await login(page);
    await page.getByRole('link', { name: 'المهام' }).click();
    await expect(page).toHaveURL(/\/tasks$/);

    // The board is there immediately: no project to create first, because writing
    // something down should not start with inventing a container for it.
    // The board is the shape of the work: an intake strip and four columns.
    const board = page.getByTestId('task-board');
    await expect(board).toBeVisible();
    await expect(board.locator('.task-column')).toHaveCount(4);
    await expect(page.getByTestId('task-intake')).toBeVisible();

    // Waiting and review are empty, so they are strips rather than full columns.
    await expect(page.locator('[data-column="waiting"]')).toHaveAttribute('data-collapsed', 'true');
    await expect(page.locator('[data-column="review"]')).toHaveAttribute('data-collapsed', 'true');

    // A new task lands in intake, which is where a task is specified before it queues.
    await page.getByTestId('new-task-input').fill('اكتب خطة الإطلاق');
    await page.getByTestId('new-task').click();
    await page.getByTestId('task-intake-toggle').click();
    await expect(page.getByTestId('task-card')).toHaveCount(1);
    // A column grows and shrinks with an animation; the screenshot waits for it to land
    // rather than photographing a column half-way open.
    await page.waitForTimeout(400);
    await shot(page, 'tasks-board-ar-light');

    // Its one quick action moves it on; the menu only offers moves the hub would accept.
    await page.getByTestId('task-quick').click();
    await expect(page.locator('[data-column-body="queue"] [data-testid="task-card"]')).toHaveCount(
      1,
    );

    // Waiting means two things, so the menu names both rather than the code choosing.
    await page.getByTestId('task-more').click();
    await page.getByRole('menuitem', { name: 'موقوفة' }).click();
    await page.getByRole('textbox').fill('ننتظر المفتاح');
    await page.getByRole('button', { name: 'حفظ' }).click();
    await expect(page.locator('[data-column="waiting"]')).not.toHaveAttribute(
      'data-collapsed',
      'true',
    );
    await expect(
      page.locator('[data-column-body="waiting"] [data-testid="task-card"]'),
    ).toContainText('ننتظر المفتاح');
    await page.waitForTimeout(400);
    await shot(page, 'tasks-blocked-ar-light');
  });

  test('12. a finished run reaches the inbox, and a switch stops the next one', async ({
    page,
  }) => {
    await login(page);

    // Every journey before this one finished a run, so the hub's inbox is not empty. The
    // journey starts by clearing it: what is being proved is that **this** run adds one,
    // not that the suite ran in a particular order.
    const openNotices = async () => {
      await page.getByRole('link', { name: 'الإعدادات' }).first().click();
      await page.getByTestId('settings-nav').getByRole('link', { name: 'الإشعارات' }).click();
    };
    await openNotices();
    // Retried rather than done once: the button is disabled until the count arrives, and
    // on a slow machine a run from an earlier journey can land a notice after the click.
    // "Clear it until it is clear" is the only form of this that is not a race.
    const badge = page.getByTestId('unread-badge');
    await expect(async () => {
      if (await badge.count()) await page.getByTestId('mark-all-read').click();
      await expect(badge).toHaveCount(0, { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });

    await newChat(page);
    await firstMessage(page, 'اكتب سطرًا واحدًا');
    // The reply has to be over before there is anything to be told about: the composer
    // leaves `streaming` when the run reaches a terminal state.
    await expect(page.getByTestId('stop-run')).toHaveCount(0, { timeout: 15_000 });

    // The count travels with the Settings list, so it is visible before the page is open.
    await page.getByRole('link', { name: 'الإعدادات' }).first().click();
    await expect(page.getByTestId('unread-badge')).toHaveText('1');

    await page.getByTestId('settings-nav').getByRole('link', { name: 'الإشعارات' }).click();
    // Unread only, so the assertion is about this run and not about the suite's history.
    await page.getByRole('radio', { name: 'غير المقروء' }).click();
    const list = page.getByTestId('notice-list');
    await expect(list.getByRole('listitem')).toHaveCount(1);
    // The hub's own words, about the agent that answered.
    await expect(list).toContainText('Hermes');
    await shot(page, 'notifications-ar-light');

    // Turning the kind off is the whole point of the page: the next run says nothing.
    await page.getByTestId('notify-kind-run_completed').click();
    await expect(page.getByTestId('notify-kind-run_completed')).toHaveAttribute(
      'data-state',
      'unchecked',
    );
    await newChat(page);
    await firstMessage(page, 'ومرة أخرى');
    await expect(page.getByTestId('stop-run')).toHaveCount(0, { timeout: 15_000 });
    await page.getByRole('link', { name: 'الإعدادات' }).first().click();
    // Still one: silenced means never written, not written and hidden.
    await expect(page.getByTestId('unread-badge')).toHaveText('1');

    // And reading it clears the count everywhere, including the list it came from.
    await page.getByTestId('settings-nav').getByRole('link', { name: 'الإشعارات' }).click();
    await page.getByTestId('mark-all-read').click();
    await expect(page.getByTestId('unread-badge')).toHaveCount(0);
  });

  test('13. People and Workspaces: a person added, and a workspace that archives', async ({
    page,
  }) => {
    await login(page);
    await page.getByRole('link', { name: 'الإعدادات' }).first().click();

    // People: the owner's own row offers nothing, because the hub refuses all of it.
    await page.getByTestId('settings-nav').getByRole('link', { name: 'المستخدمون' }).click();
    await expect(page.getByTestId('user-table')).toBeVisible();
    await expect(page.getByTestId('owner-note')).toBeVisible();
    await expect(page.getByTestId('user-menu')).toHaveCount(0);

    await page.getByTestId('add-user').click();
    await page.getByLabel('اسم المستخدم').fill('sara');
    await page.getByLabel('الاسم المعروض').fill('سارة');
    await page.getByLabel('كلمة المرور الجديدة').fill('a-long-enough-one');
    await page.getByTestId('save-user').click();
    const table = page.getByTestId('user-table');
    await expect(table).toContainText('سارة');
    // And now there is a row that is not the owner's, so a menu exists.
    await expect(page.getByTestId('user-menu')).toHaveCount(1);
    await shot(page, 'people-ar-light');

    // Workspaces: the default one cannot be archived, so it offers no button.
    await page.getByTestId('settings-nav').getByRole('link', { name: 'مساحات العمل' }).click();
    await expect(page.getByTestId('workspace-list')).toBeVisible();
    await expect(page.getByTestId('archive-workspace')).toHaveCount(0);

    await page.getByTestId('add-workspace').click();
    await page.getByLabel('الاسم').fill('Labs');
    // The slug followed the name without being typed.
    await expect(page.getByLabel('المعرّف')).toHaveValue('labs');
    await page.getByTestId('save-workspace').click();
    await expect(page.getByTestId('workspace-list')).toContainText('Labs');
    // A second workspace exists, so exactly one archive button appeared — the new one's.
    await expect(page.getByTestId('archive-workspace')).toHaveCount(1);
    await shot(page, 'workspaces-ar-light');

    // Archiving says archive, and says what happens to the conversations.
    await page.getByTestId('archive-workspace').click();
    await expect(page.getByRole('alertdialog')).toContainText('لا تُمحى');
  });

  test('14. the last four settings pages say what is true about themselves', async ({ page }) => {
    await login(page);
    await page.getByRole('link', { name: 'الإعدادات' }).first().click();
    const nav = page.getByTestId('settings-nav');

    // About: two versions, because they are two different things.
    await nav.getByRole('link', { name: 'حول' }).click();
    await expect(page.getByTestId('about-facts')).toBeVisible();
    // The real build, from a hub that is actually running — not a constant in the page.
    await expect(page.getByTestId('about-server')).not.toBeEmpty();
    await expect(page.getByTestId('about-namespaces')).toContainText('/rt/sessions');

    // Knowledge: a workspace where nothing has happened says so.
    await nav.getByRole('link', { name: 'المعرفة' }).click();
    await expect(page.getByText('لا شيء بعد')).toBeVisible();
    await expect(page.getByTestId('knowledge-list')).toHaveCount(0);

    // Plugins: the hub answers the list and has no installer.
    await nav.getByRole('link', { name: 'الإضافات' }).click();
    await expect(page.getByText('لا إضافات')).toBeVisible();

    // Updates: the sentence that stops the page being misread, then an empty shelf.
    await nav.getByRole('link', { name: 'التحديثات' }).click();
    await expect(page.getByText(/يخدمه المجلس نفسه/)).toBeVisible();
    await expect(page.getByText('لا إصدارات')).toBeVisible();
    // The source fields are not there until the hub is told to fetch from one.
    await expect(page.getByTestId('updates-source-fields')).toHaveCount(0);
    await page.getByTestId('updates-from-source').click();
    await expect(page.getByTestId('updates-source-fields')).toBeVisible();
    await shot(page, 'updates-ar-light');
  });

  test('15. an agent’s skills are the files in its folder', async ({ page }) => {
    await login(page);
    // The agent manager lives in the Settings list, like every management page.
    await page.getByRole('link', { name: 'الإعدادات' }).first().click();
    await page.getByTestId('settings-nav').getByRole('link', { name: 'مدير الوكلاء' }).click();
    // The link is not hand-placed: the card lists every agent-level page whose capability
    // the registry declares, and Hermes declares `skills`.
    await page.getByTestId('agent-menu').getByRole('link', { name: 'المهارات' }).first().click();
    await expect(page).toHaveURL(/\/skills$/);

    // A fresh hub's Hermes home has no skills folder, and the page says that rather than
    // showing an empty list that could mean anything.
    await expect(page.getByText('لا مهارات')).toBeVisible();

    await page.getByTestId('new-skill').click();
    await page.getByTestId('skill-key').fill('daily-note');
    await page
      .getByTestId('skill-content')
      .fill(
        '---\nname: daily-note\ndescription: يكتب ملخص اليوم\nlicense: MIT\n---\n\n# ملخص اليوم\n',
      );
    await page.getByTestId('save-skill').click();

    const row = page.getByTestId('skill-categories');
    await expect(row).toContainText('daily-note');
    await expect(row).toContainText('يكتب ملخص اليوم');
    await shot(page, 'agent-skills-ar-light');

    // Off is not gone: the row stays, and what it says about itself stays too.
    await page.getByTestId('skill-toggle-daily-note').click();
    await expect(page.getByTestId('skill-toggle-daily-note')).toHaveAttribute(
      'data-state',
      'unchecked',
    );
    await expect(row).toContainText('daily-note');

    // The editor holds the document, front matter and all — including the line this hub
    // does not understand.
    await page.getByText('daily-note').first().click();
    await expect(page.getByTestId('skill-content')).toHaveValue(/license: MIT/);
    await page.keyboard.press('Escape');

    // MCP: the same agent, the other page. It writes one block of config.yaml.
    await page.getByTestId('settings-nav').getByRole('link', { name: 'مدير الوكلاء' }).click();
    await page.getByTestId('agent-menu').getByRole('link', { name: 'MCP' }).first().click();
    await expect(page).toHaveURL(/\/mcp$/);
    await expect(page.getByText(/أعد تشغيله ليسري التغيير/)).toBeVisible();
    await expect(page.getByText('لا خوادم')).toBeVisible();

    await page.getByTestId('new-mcp').click();
    await page.getByTestId('mcp-name').fill('filesystem');
    // A bracket in the wrong place is said while typing, not after saving.
    await page.getByTestId('mcp-config').fill('{ "command": ');
    await expect(page.getByText('النصّ ليس JSON صالحًا بعد.')).toBeVisible();
    await expect(page.getByTestId('save-mcp')).toBeDisabled();

    await page
      .getByTestId('mcp-config')
      .fill('{\n  "command": "npx",\n  "args": ["-y", "mcp-server-filesystem"]\n}');
    await page.getByTestId('save-mcp').click();
    const list = page.getByTestId('mcp-list');
    await expect(list).toContainText('filesystem');
    await expect(list).toContainText('npx -y mcp-server-filesystem');
    await shot(page, 'agent-mcp-ar-light');

    // Memory: the persona cannot be deleted, only emptied.
    await page.getByTestId('settings-nav').getByRole('link', { name: 'مدير الوكلاء' }).click();
    await page.getByTestId('agent-menu').getByRole('link', { name: 'الذاكرة' }).first().click();
    await expect(page).toHaveURL(/\/memory$/);

    // Always the same three documents, including the ones nothing has written yet.
    const docs = page.getByTestId('memory-list');
    await expect(docs.getByRole('listitem')).toHaveCount(3);
    await expect(docs).toContainText('SOUL.md');
    await expect(docs).toContainText('لم يكتب عنك شيئًا بعد.');

    await page.getByTestId('memory-edit-user').click();
    await page.getByTestId('memory-content').fill('أفضّل الردود القصيرة.');
    await page.getByTestId('save-memory').click();
    await expect(docs).toContainText('أفضّل الردود القصيرة.');
    // Still three: writing one does not add a row, and there is no delete to offer.
    await expect(docs.getByRole('listitem')).toHaveCount(3);
    await shot(page, 'agent-memory-ar-light');

    // Channels: the fields come from the agent's own file, not from a form we wrote.
    await page.getByTestId('settings-nav').getByRole('link', { name: 'مدير الوكلاء' }).click();
    await page.getByTestId('agent-menu').getByRole('link', { name: 'القنوات' }).first().click();
    await expect(page).toHaveURL(/\/channels$/);
    await expect(page.getByText('لا قنوات')).toBeVisible();
    await shot(page, 'agent-channels-ar-light');
  });

  test('11. Schedules: a cron saved, its next time computed, and the button that says why', async ({
    page,
  }) => {
    await login(page);
    await page.getByRole('link', { name: 'الجدولة' }).click();
    await expect(page).toHaveURL(/\/schedules$/);

    await page.getByTestId('schedule-name').fill('تقرير الصباح');
    await page.getByTestId('schedule-value').fill('0 9 * * *');
    await page.getByTestId('schedule-prompt').fill('اكتب ملخص أمس');
    await page.getByTestId('schedule-save').click();

    const card = page.getByTestId('schedule-card').first();
    await expect(card).toBeVisible();
    // The hub computed a real next time rather than leaving it blank.
    await expect(card).not.toContainText('لا موعد');
    // And the run button is there, disabled, saying why — not hidden.
    await expect(page.getByTestId('schedule-run')).toBeDisabled();
    await shot(page, 'schedules-ar-light');

    // A cron the hub cannot read is refused when it is saved, with the reason.
    await page.getByTestId('schedule-name').fill('خطأ');
    await page.getByTestId('schedule-value').fill('@daily');
    await page.getByTestId('schedule-save').click();
    await expect(page.getByRole('alert')).toBeVisible();
  });
});
