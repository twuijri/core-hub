// Five smoke journeys against the real hub (e2e/hub.ts): a new chat where the folder is
// chosen before the first message and the session is minted by that message; approvals;
// resume after a socket drop; stopping a run mid-stream. Screenshots for light/dark and
// RTL/LTR land in COREHUB_SHOTS (or e2e/shots) for the change record.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const shots = process.env.COREHUB_SHOTS ?? path.resolve('e2e/shots');
mkdirSync(shots, { recursive: true });

const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
/** The sidebar on its own: the rail, the segment row and the list, at their real size. */
const sidebarShot = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: /القائمة الرئيسية|Main menu/ })
    .screenshot({ path: path.join(shots, `${name}.png`) });

/** Display preferences live on one Settings page; the journey uses it to change the skin. */

/** Inside Settings the rail steps aside for one row back (owner, 2026-09-23). */
async function leaveSettings(page: Page) {
  const back = page.getByTestId('back-to-chats');
  if ((await back.count()) > 0) await back.click();
}

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
  await leaveSettings(page);
  await page.getByRole('link', { name: 'محادثة جديدة' }).first().click();
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByTestId('agent-chip').first()).toBeVisible();
  await expect(page.getByTestId('composer-input')).toBeEnabled();
}

/** The first message is what creates the session (contract: sessions.create then createRun). */
async function firstMessage(page: Page, text: string): Promise<string> {
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('send').click();
  // With more than one profile the address also says which (ADR 0016).
  await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}(\?profile=[a-z0-9-]+)?$/);
  return new URL(page.url()).pathname.split('/').pop() as string;
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
    // The column has handed itself to the transcript: the composer is docked.
    await expect(page.getByTestId('chat-screen')).toHaveAttribute('data-empty', 'false');
    await shot(page, 'chat-reply-ar-light');
    // Once the chat has run, the folder is fixed and says so instead of going quiet: the
    // folder icon in the top bar opens its name, its path and why it no longer moves.
    await page.getByTestId('working-dir-button').click();
    await expect(page.getByTestId('working-dir-locked')).toBeVisible();
    await expect(page.getByTestId('working-dir-path')).toContainText('لوحة-الإطلاق');
    await expect(page.getByTestId('working-dir-new')).toHaveCount(0);
    await shot(page, 'chat-bar-folder-ar-light');
    await page.keyboard.press('Escape');

    // A finished turn folds its tools into one line beside the reply; opened, a call
    // shows its output and sends it to the split pane. The divider is a keyboard separator.
    await expect(page.getByTestId('tool-group-summary')).toContainText('shell');
    await page.getByTestId('tool-group-summary').click();
    await page.getByTestId('tool-call').locator('summary').click();
    await page.getByRole('button', { name: 'فتح في اللوحة الجانبية' }).first().click();
    await expect(page.getByTestId('split-pane')).toContainText('README.md');
    const separator = page.getByRole('separator');
    const before = Number(await separator.getAttribute('aria-valuenow'));
    await separator.focus();
    await page.keyboard.press('ArrowRight');
    expect(Number(await separator.getAttribute('aria-valuenow'))).toBeGreaterThan(before);
    await page.screenshot({ path: path.join(shots, 'chat-pane-ar-light.png'), fullPage: true });

    // The sidebar is slim: the rail is New chat · Search · Agents · Tasks · Schedules (Agents
    // above Tasks since 2026-09-24), and the segment row is Chat · Rooms only. Both belong to the chat list, so they are checked
    // here, before Settings replaces the list with its own.
    await expect(page.getByTestId('rail').getByRole('link')).toHaveCount(5);
    await expect(page.getByTestId('segments').getByRole('radio')).toHaveCount(2);
    await expect(page.getByTestId('segments')).not.toContainText('السجل');

    // Dark theme and English (LTR) through the settings screen; both persist on the root.
    const chatUrl = page.url();
    await page.getByRole('link', { name: 'الإعدادات' }).click();
    // Inside Settings the sidebar *is* the settings list (owner, 2026-09-22): the
    // management pages are rows in it, and the conversation list has stepped aside.
    // Models · Device connections · Knowledge: Agents left for the rail (owner, 2026-09-24).
    // Four since «المراكز المرتبطة» / Linked hubs joined them (ADR 0026).
    await expect(page.getByTestId('settings-management').getByRole('link')).toHaveCount(4);
    await expect(page.getByTestId('session-row')).toHaveCount(0);
    // And the rail too (owner, 2026-09-23): one row leads back, to the conversation that
    // was open — not a New chat pressed to get out.
    await expect(page.getByTestId('rail')).toHaveCount(0);
    await expect(page.getByTestId('back-to-chats')).toHaveText('رجوع إلى المحادثات');
    await page.getByTestId('settings-nav').getByRole('link', { name: 'المستخدمون' }).click();
    await page.getByTestId('back-to-chats').click();
    await expect(page).toHaveURL(chatUrl);
    await expect(page.getByTestId('rail').getByRole('link')).toHaveCount(5);
    await expect(page.getByTestId('back-to-chats')).toHaveCount(0);
    await page.getByRole('link', { name: 'الإعدادات' }).click();
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
    await leaveSettings(page);
    await page.getByRole('link', { name: 'محادثة جديدة' }).first().click();
    await expect(page.getByTestId('new-chat')).toHaveAttribute('data-empty', 'true');
    await shot(page, 'new-chat-ar-dark');

    // English, dark (LTR): the segmented tracks have to read correctly in both directions.
    await setDisplay(page, 'الإعدادات', 'العرض', 'language-en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.locator('#settings-section')).toHaveText('Display');
    await leaveSettings(page);
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
    // Nine agents from the catalog — Hermes, the hub's own `direct` agent
    // (ADOPTION-BACKLOG §2.15) and the seven coding CLIs (Qwen Code, Kimi Code and Pi since
    // 2026-09-25) — and a trailing "+" that goes to the Agents page.
    await expect(page.getByTestId('agent-chip')).toHaveCount(9);
    await expect(page.getByTestId('agent-add')).toBeVisible();
    // Pages take the whole width (owner, 2026-09-23), so on a wide screen the row is at the
    // top of the ladder or one rung down — which one depends on the machine's fonts (CI's
    // are wider) — and never wraps or scrolls.
    await page.setViewportSize({ width: 1600, height: 720 });
    await expect(row).toHaveAttribute('data-density', /^(comfortable|compact)$/);
    await expect(page.getByTestId('agent-chips-more')).toHaveCount(0);
    await shot(page, 'agents-comfortable-ar-light');

    // Narrow enough that the labels no longer fit: only the chosen agent keeps its word,
    // the rest collapse to their initial, and nothing wraps or scrolls.
    await page.setViewportSize({ width: 860, height: 720 });
    await expect(row).toHaveAttribute('data-density', 'compact');
    const chips = page.getByTestId('agent-chip');
    await expect(chips.first()).toHaveAttribute('aria-checked', 'true');
    await expect(chips.first()).toContainText('Hermes');
    await expect(chips.nth(1)).toHaveClass(/ch-segment-icon-only/);
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
    await leaveSettings(page);
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

    // Selecting several: every chosen row keeps its tick in sight, not only the one
    // under the pointer (owner, 2026-09-23) — so the pointer is moved away first.
    await row.getByTestId('session-more-button').click();
    await page.getByRole('menuitem', { name: 'تحديد', exact: true }).click();
    // The row the menu came from is chosen already; choose the rest by their links.
    for (const each of await page.getByTestId('session-row').all()) {
      if ((await each.getAttribute('data-selected')) !== 'true') {
        await each.locator('.session-link').click();
      }
    }
    await page.getByTestId('composer-input').hover();
    const rows = page.locator('[data-testid="session-row"][data-selected="true"]');
    await expect.poll(() => rows.count()).toBeGreaterThan(0);
    for (const selected of await rows.all()) {
      await expect(selected.locator('.session-grip')).toHaveCSS('opacity', '1');
    }
    await page.getByTestId('session-select-done').click();
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

    // Waiting is empty, so it is a strip; Review stays a column even when empty.
    await expect(page.locator('[data-column="waiting"]')).toHaveAttribute('data-collapsed', 'true');
    await expect(page.locator('[data-column="review"]')).not.toHaveAttribute(
      'data-collapsed',
      'true',
    );

    // A new task lands in intake, which is where a task is specified before it queues.
    await page.getByTestId('new-task-input').fill('اكتب خطة الإطلاق');
    await page.getByTestId('new-task').click();
    await page.getByTestId('task-intake-toggle').click();
    // Hermes's finished card (journey 17) sits in Done; this journey drives its own card.
    const card = page.getByTestId('task-card').filter({ hasText: 'اكتب خطة الإطلاق' });
    await expect(page.locator('[data-testid="task-intake"] [data-testid="task-card"]')).toHaveCount(
      1,
    );
    // A column grows and shrinks with an animation; the screenshot waits for it to land
    // rather than photographing a column half-way open.
    await page.waitForTimeout(400);
    await shot(page, 'tasks-board-ar-light');

    // Its one quick action moves it on; the menu only offers moves the hub would accept.
    await card.getByTestId('task-quick').click();
    await expect(page.locator('[data-column-body="queue"] [data-testid="task-card"]')).toHaveCount(
      1,
    );
    // In the queue a todo card offers the next step, promote, as a button: dragging it
    // inside its own column would be a reorder, not a move.
    await expect(card.getByTestId('task-quick')).toHaveAttribute('data-action', 'promote');

    // The Waiting strip opens while a card that may go there is being dragged, and folds
    // back when the drag is called off.
    const waiting = page.locator('[data-column="waiting"]');
    const grip = await card.locator('.task-card-grip').boundingBox();
    expect(grip).toBeTruthy();
    if (grip) {
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(grip.x + 40, grip.y + 40, { steps: 6 });
      await expect(waiting).not.toHaveAttribute('data-collapsed', 'true');
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await expect(waiting).toHaveAttribute('data-collapsed', 'true');
    }

    // Waiting means two things, so the menu names both rather than the code choosing.
    await card.getByTestId('task-more').click();
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

  test("17. Hermes's own cards: marked as Hermes's, edited on Hermes, and Hermes's refusal in its own words", async ({
    page,
  }) => {
    await login(page);
    await page.getByRole('link', { name: 'المهام' }).click();
    const card = page.locator('[data-external="hermes"]');
    await expect(card).toContainText('راجعت سجل التغييرات');
    await expect(card.getByTestId('task-origin-hermes')).toBeVisible();
    await expect(page.locator('[data-column-body="done"]')).toContainText('راجعت سجل التغييرات');

    // A mirror, not a picture of one: the menu edits and deletes it too — on Hermes first.
    await card.getByTestId('task-more').click();
    await expect(page.getByRole('menuitem', { name: 'حذف' })).toHaveCount(1);
    await expect(page.getByRole('menuitem', { name: 'إعادة التسمية' })).toHaveCount(1);
    await page.keyboard.press('Escape');

    // Archiving is confirmed first, then asked of Hermes; Hermes says no, and the person
    // reads Hermes's reason.
    await card.getByTestId('task-quick').click();
    const confirm = page.getByTestId('confirm-dialog');
    await expect(confirm).toContainText('أرشفة «');
    await confirm.getByRole('button', { name: 'أرشفة' }).click();
    await expect(page.getByText('رفض هرمز: cannot archive t_e2e00001')).toBeVisible();
    await expect(page.locator('[data-column-body="done"]')).toContainText('راجعت سجل التغييرات');
    await shot(page, 'tasks-hermes-card-ar-light');

    // Its words are edited from here, and the board shows what Hermes kept.
    await card.getByTestId('task-more').click();
    await page.getByRole('menuitem', { name: 'التفاصيل…' }).click();
    const details = page.getByTestId('task-dialog');
    await expect(details).toContainText('كل تعديل يُجرى على هرمز أولًا');
    await details.getByTestId('task-dialog-title').fill('راجعت سجل التغييرات كاملًا');
    await details.getByTestId('task-dialog-save').click();
    await expect(details.getByTestId('task-dialog-title')).toHaveValue(
      'راجعت سجل التغييرات كاملًا',
    );
    // Nothing left unsaved: the dialog now shows Hermes's copy of the card.
    await expect(details.getByTestId('task-dialog-save')).toBeDisabled();
    await shot(page, 'tasks-hermes-details-ar-light');
    await page.keyboard.press('Escape');
    await expect(card).toContainText('راجعت سجل التغييرات كاملًا');
  });

  test("19. the agent asks, the card above the composer answers: a choice, one's own words, or skip", async ({
    page,
  }) => {
    await login(page);
    const card = page.getByTestId('question-card');
    const reply = page.getByTestId('message-assistant').last();

    // A choice: tapped, sent as the agent wrote it, and the card goes.
    await newChat(page);
    await firstMessage(page, 'اسألني سؤال بخيارات');
    await expect(card).toContainText('وش الجهاز اللي تبي تتصل فيه؟');
    await expect(card.getByTestId('question-choice')).toHaveCount(3);
    // Hermes's "(Recommended)" mark becomes a badge, not text in the choice.
    await expect(card.getByTestId('question-choice').first()).toContainText('موصى به');
    await expect(card).not.toContainText('(Recommended)');
    // Five minutes, counted down (owner, 2026-09-23: as Ekko does).
    await expect(card.getByTestId('question-left')).toContainText(/[45]:\d\d/);
    await page.waitForTimeout(300);
    await shot(page, 'question-card-ar-light');
    await card.getByTestId('question-choice').nth(1).click();
    await expect(card).toHaveCount(0);
    await expect(reply).toContainText('اخترت: ويندوز');
    // The chat keeps what was asked and what was chosen.
    await expect(reply.getByTestId('answered-question')).toContainText(
      'وش الجهاز اللي تبي تتصل فيه؟',
    );
    await expect(reply.getByTestId('answered-question')).toContainText('إجابتك: ويندوز');

    // One's own words, when no choice fits.
    await newChat(page);
    await firstMessage(page, 'اسألني مرة ثانية');
    await card.getByTestId('question-own').fill('أندرويد');
    await card.getByTestId('question-send').click();
    await expect(reply).toContainText('اخترت: أندرويد');

    // Skip is the person's to press; nothing skips for them.
    await newChat(page);
    await firstMessage(page, 'اسألني وأتخطى');
    await expect(card).toBeVisible();
    await card.getByTestId('question-skip').click();
    await expect(card).toHaveCount(0);
    await expect(reply).toContainText('اخترت: تخطّيت');
    await expect(reply.getByTestId('answered-question')).toContainText('تُخطّي السؤال');
  });

  test('20. the transcript follows a growing reply, unless the person scrolled away', async ({
    page,
  }) => {
    await login(page);
    await newChat(page);
    const reply = page.getByTestId('message-assistant').last();
    // How far the transcript's scroller is from its bottom, in pixels.
    const gap = () =>
      page.getByTestId('chat-screen').evaluate((node) => {
        let at: HTMLElement | null = node.parentElement;
        while (at && !/auto|scroll/.test(getComputedStyle(at).overflowY)) at = at.parentElement;
        const scroller = at ?? (document.scrollingElement as HTMLElement);
        return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      });
    const scrollTo = (where: 'top' | 'bottom') =>
      page.getByTestId('chat-screen').evaluate((node, to) => {
        let at: HTMLElement | null = node.parentElement;
        while (at && !/auto|scroll/.test(getComputedStyle(at).overflowY)) at = at.parentElement;
        const scroller = at ?? (document.scrollingElement as HTMLElement);
        scroller.scrollTop = to === 'top' ? 0 : scroller.scrollHeight;
      }, where);

    await firstMessage(page, 'اكتب رد طويل');
    await expect(reply).toContainText('سطر 15');
    // Taller than the screen by now, and the page kept up with it.
    await expect.poll(gap).toBeLessThan(80);

    // Scrolled up to read: the growing reply does not pull the person back down.
    await scrollTo('top');
    await expect(reply).toContainText('سطر 25');
    expect(await gap()).toBeGreaterThan(200);

    // Back at the bottom: following again, to the last line.
    await scrollTo('bottom');
    await expect(reply).toContainText('سطر 60');
    await expect.poll(gap).toBeLessThan(80);

    // A reload of the conversation comes back connected, without opening another one
    // (owner, 2026-09-23: it said "Offline" until another conversation was clicked).
    await page.reload();
    await expect(reply).toContainText('سطر 60');
    await expect(page.getByRole('status', { name: 'متصل', exact: true })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('21. a search result opens the conversation at the word, not at the bottom', async ({
    page,
  }) => {
    // Owner, 2026-09-23: «يوديني للكلمه داخل المحادثه لان بعض المحادثات يكون فيها كلام كثير».
    await login(page);
    await newChat(page);
    const replies = page.getByTestId('message-assistant');
    // How far the transcript's scroller is from its bottom, in pixels (as in journey 20).
    const gap = () =>
      page.getByTestId('chat-screen').evaluate((node) => {
        let at: HTMLElement | null = node.parentElement;
        while (at && !/auto|scroll/.test(getComputedStyle(at).overflowY)) at = at.parentElement;
        const scroller = at ?? (document.scrollingElement as HTMLElement);
        return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      });

    // A long reply, then the question with the word, then another long reply: the word
    // sits in the middle of a conversation several screens tall.
    const sessionId = await firstMessage(page, 'اكتب رد طويل');
    await expect(replies.last()).toContainText('سطر 60');
    await page.getByTestId('composer-input').fill('اكتب رد طويل ثانٍ عن الزعفران');
    await page.getByTestId('send').click();
    await expect(replies).toHaveCount(2);
    await expect(replies.last()).toContainText('سطر 60');

    await page.getByRole('link', { name: 'بحث' }).first().click();
    await page.getByRole('searchbox', { name: 'بحث' }).fill('الزعفران');
    // This conversation's result (a retry would have made another one like it).
    const result = page.locator(`[data-testid="search-result"][href^="/chat/${sessionId}?"]`);
    await expect(result).toHaveCount(1);
    // The result shows the word, marked as it will be inside the conversation.
    await expect(result.locator('mark.msg-hit')).toHaveText('الزعفران');
    await result.click();

    // The conversation, opened at the message that matched: on screen, and the page did
    // not go to the bottom; that message flagged and the word marked in it. The address is
    // the plain chat again.
    const asked = page.getByTestId('message-user').filter({ hasText: 'الزعفران' });
    await expect(asked).toBeInViewport();
    expect(await gap()).toBeGreaterThan(200);
    await expect(asked).toHaveAttribute('data-anchored', 'true');
    await expect(page.locator('[data-anchored="true"]')).toHaveCount(1);
    await expect(asked.locator('mark.msg-hit')).toHaveText('الزعفران');
    await expect(page).toHaveURL(new RegExp(`/chat/${sessionId}$`));
    await shot(page, 'search-jump-ar-light');

    // Scrolling back to the bottom lets go: the chat follows new replies again.
    await page.getByTestId('chat-screen').evaluate((node) => {
      let at: HTMLElement | null = node.parentElement;
      while (at && !/auto|scroll/.test(getComputedStyle(at).overflowY)) at = at.parentElement;
      const scroller = at ?? (document.scrollingElement as HTMLElement);
      scroller.scrollTop = scroller.scrollHeight;
    });
    await page.getByTestId('composer-input').fill('اكتب رد طويل ثالث');
    await page.getByTestId('send').click();
    await expect(replies).toHaveCount(3);
    await expect(replies.last()).toContainText('سطر 60');
    await expect.poll(gap).toBeLessThan(80);
  });

  test('16. one press of the theme button is one change', async ({ page }) => {
    await login(page);
    const chip = page.getByTestId('theme-chip');
    const html = page.locator('html');

    // What the button shows is what is on: there is nothing to compare it against, which
    // is the whole reason it replaced three symbols side by side.
    await expect(chip).toHaveAttribute('data-theme-choice', 'system');

    await chip.click();
    await expect(chip).toHaveAttribute('data-theme-choice', 'light');
    await expect(html).toHaveAttribute('data-theme', 'light');

    await chip.click();
    await expect(chip).toHaveAttribute('data-theme-choice', 'dark');
    await expect(html).toHaveAttribute('data-theme', 'dark');

    // …and round again, so the person is never stuck at the end of a list.
    await chip.click();
    await expect(chip).toHaveAttribute('data-theme-choice', 'system');
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
    browser,
    request,
  }) => {
    await login(page);
    await page.getByRole('link', { name: 'الإعدادات' }).first().click();

    // People: the owner's own row offers nothing, because the hub refuses all of it.
    await page.getByTestId('settings-nav').getByRole('link', { name: 'المستخدمون' }).click();
    await expect(page.getByTestId('user-table')).toBeVisible();
    // Every page takes the whole width beside the sidebar (owner, 2026-09-23), not a
    // centred column.
    const [tableBox, mainBox] = await Promise.all([
      page.getByTestId('user-table').boundingBox(),
      page.locator('#main').boundingBox(),
    ]);
    expect(tableBox && mainBox && tableBox.width).toBeGreaterThan((mainBox?.width ?? 0) - 64);
    // The owner's own row: a password, and nothing else (owner, 2026-09-23).
    await expect(page.getByTestId('user-password')).toHaveCount(1);
    await expect(page.getByTestId('user-menu')).toHaveCount(0);

    await page.getByTestId('add-user').click();
    await page.getByLabel('اسم المستخدم').fill('sara');
    await page.getByLabel('الاسم المعروض').fill('سارة');
    // A short password keeps the button off, and the field says why.
    await page.getByLabel('كلمة المرور الجديدة').fill('short');
    await expect(page.getByTestId('save-user')).toBeDisabled();
    await expect(page.getByTestId('add-user-dialog')).toContainText('ثمانية أحرف على الأقل');
    await expect(page.getByTestId('new-user-password')).toHaveAttribute('aria-invalid', 'true');
    await page.getByLabel('كلمة المرور الجديدة').fill('a-long-enough-one');
    // A member is not added until they have somewhere to go: a member enters only what is
    // chosen, and the hub refuses a member with nothing — and the dialog says so.
    await expect(page.getByTestId('save-user')).toBeDisabled();
    await expect(page.getByTestId('workspaces-required')).toBeVisible();
    await page.getByTestId('workspace-default').click();
    await expect(page.getByTestId('workspaces-required')).toHaveCount(0);
    await page.getByTestId('save-user').click();
    const table = page.getByTestId('user-table');
    await expect(table).toContainText('سارة');
    // And now there is a row that is not the owner's: its password and delete are on the
    // row, not behind "⋯".
    await expect(page.getByTestId('user-menu')).toHaveCount(1);
    const saraRow = page.getByRole('row').filter({ hasText: 'سارة' });
    await expect(saraRow.getByTestId('user-password')).toBeVisible();
    await expect(saraRow.getByTestId('user-delete')).toBeVisible();
    await saraRow.getByTestId('user-password').click();
    await expect(page.getByTestId('set-password')).toBeVisible();
    await page.keyboard.press('Escape');
    await saraRow.getByTestId('user-delete').click();
    await expect(page.getByRole('alertdialog')).toContainText('حذف سارة؟');
    await page.keyboard.press('Escape');
    await shot(page, 'people-ar-light');

    // Workspaces: the default one cannot be archived, so it offers no button.
    await page.getByTestId('settings-nav').getByRole('link', { name: 'البروفايلات' }).click();
    await expect(page.getByTestId('workspace-list')).toBeVisible();
    await expect(page.getByTestId('archive-workspace')).toHaveCount(0);

    await page.getByTestId('add-workspace').click();
    await page.getByLabel('الاسم').fill('Labs');
    // The slug followed the name without being typed.
    await expect(page.getByLabel('المعرّف')).toHaveValue('labs');
    // How it starts is asked, not assumed (ADR 0014): from scratch, or a copy of one picked.
    await expect(page.getByRole('radio', { name: 'من الصفر' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await page.getByRole('radio', { name: 'نسخة من بروفايل' }).click();
    await expect(page.getByTestId('save-workspace')).toBeDisabled();
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(shots, 'workspace-origin-ar-light.png') });
    await page.getByRole('radio', { name: 'من الصفر' }).click();
    await page.getByTestId('save-workspace').click();
    await expect(page.getByTestId('workspace-list')).toContainText('Labs');
    // A second workspace exists, so exactly one archive button appeared — the new one's.
    await expect(page.getByTestId('archive-workspace')).toHaveCount(1);
    await shot(page, 'workspaces-ar-light');

    // Archiving says archive, and says what happens to the conversations.
    await page.getByTestId('archive-workspace').click();
    await expect(page.getByRole('alertdialog')).toContainText('لا تُمحى');
    await page.keyboard.press('Escape');

    // Labs is new, and nobody gave it to Sara: it is not hers (owner, 2026-09-24: «المفروض ما
    // يضيفه له بدون ما ادخل انا واضيفه له»). Her row still names `default` alone…
    await page.getByTestId('settings-nav').getByRole('link', { name: 'المستخدمون' }).click();
    const saraCells = page.getByRole('row').filter({ hasText: 'سارة' });
    await expect(saraCells).toContainText('default');
    await expect(saraCells).not.toContainText('labs');
    // …the hub offers her `default` alone and refuses Labs by name…
    const signedIn = await request.post('/api/v1/auth/login', {
      data: { username: 'sara', password: 'a-long-enough-one' },
    });
    expect(signedIn.status()).toBe(200);
    const saraAuth = { authorization: `Bearer ${(await signedIn.json()).access_token}` };
    const offered = await request.get('/api/v1/profiles', { headers: saraAuth });
    expect(((await offered.json()).items as { slug: string }[]).map((p) => p.slug)).toEqual([
      'default',
    ]);
    const intoLabs = await request.get('/api/v1/sessions', {
      headers: { ...saraAuth, 'x-hub-profile': 'labs' },
    });
    expect(intoLabs.status()).toBe(404);
    // …and signed in as her, the profile switcher offers `default` and nothing else.
    const baseURL = test.info().project.use.baseURL;
    const saraContext = await browser.newContext({ ...(baseURL ? { baseURL } : {}), locale: 'ar' });
    const saraPage = await saraContext.newPage();
    await saraPage.goto('/');
    await saraPage.getByLabel('اسم المستخدم').fill('sara');
    await saraPage.getByLabel('كلمة المرور').fill('a-long-enough-one');
    await saraPage.getByRole('button', { name: 'دخول' }).click();
    await expect(saraPage).toHaveURL(/\/chat$/);
    await saraPage.getByTestId('workspace-switcher').first().click();
    await expect(saraPage.getByRole('option')).toHaveCount(1);
    await expect(saraPage.getByRole('option')).not.toContainText('Labs');
    await saraContext.close();

    // A member whose every profile was withdrawn enters nothing — not everything — and is
    // told so in one page, with the way out, instead of a shell full of refusals.
    const owner = await request.post('/api/v1/auth/login', {
      data: { username: 'admin', password: PASSWORD },
    });
    const ownerAuth = { authorization: `Bearer ${(await owner.json()).access_token}` };
    const nour = await request.post('/api/v1/auth/users', {
      headers: ownerAuth,
      data: { username: 'nour', password: 'nour-password-1', role: 'member', profiles: ['labs'] },
    });
    expect(nour.status()).toBe(201);
    const nourId = (await nour.json()).id as string;
    const withdrawn = await request.patch(`/api/v1/auth/users/${nourId}`, {
      headers: ownerAuth,
      data: { profiles: [] },
    });
    expect((await withdrawn.json()).profiles).toEqual([]);
    const nourContext = await browser.newContext({ ...(baseURL ? { baseURL } : {}), locale: 'ar' });
    const nourPage = await nourContext.newPage();
    await nourPage.goto('/');
    await nourPage.getByLabel('اسم المستخدم').fill('nour');
    await nourPage.getByLabel('كلمة المرور').fill('nour-password-1');
    await nourPage.getByRole('button', { name: 'دخول' }).click();
    await expect(nourPage.getByTestId('no-profile')).toContainText('اطلب من المشرف');
    await shot(nourPage, 'no-profile-ar-light');
    await nourContext.close();
    await page.reload();
    await expect(
      page.getByRole('row').filter({ hasText: 'nour' }).getByTestId('no-workspace'),
    ).toHaveText('بلا بروفايل');
    await request.delete(`/api/v1/auth/users/${nourId}`, { headers: ownerAuth });
    await page.reload();
    await expect(page.getByRole('row').filter({ hasText: 'nour' })).toHaveCount(0);

    // Sara is given the new workspace from her row, explicitly: a member enters only these.
    await page.getByTestId('user-menu').click();
    await page.getByRole('menuitem', { name: 'البروفايلات…' }).click();
    await page.getByTestId('workspace-labs').click();
    await page.getByTestId('save-workspaces').click();
    await expect(page.getByTestId('user-table')).toContainText('labs');

    // The owner changes their own password — and back, for the journeys after this one.
    await page.getByTestId('settings-nav').getByRole('link', { name: 'الحساب' }).click();
    const change = async (from: string, to: string) => {
      await page.getByTestId('current-password').fill(from);
      await page.getByTestId('new-password').fill(to);
      await page.getByTestId('confirm-password').fill(to);
      await page.getByTestId('save-own-password').click();
      await expect(page.getByTestId('change-password')).toContainText('تغيّرت كلمة المرور');
    };
    await change(PASSWORD, 'a-brand-new-password');
    // This device stays signed in and connected: only the other devices are signed out.
    await expect(page.getByRole('status', { name: 'متصل', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await shot(page, 'account-password-ar-light');
    await change('a-brand-new-password', PASSWORD);
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
    await expect(page.getByText(/يخدمه المركز نفسه/)).toBeVisible();
    await expect(page.getByText('لا إصدارات')).toBeVisible();
    // The source fields are not there until the hub is told to fetch from one.
    await expect(page.getByTestId('updates-source-fields')).toHaveCount(0);
    await page.getByTestId('updates-from-source').click();
    await expect(page.getByTestId('updates-source-fields')).toBeVisible();
    await shot(page, 'updates-ar-light');

    // A reload inside Settings comes back connected (owner, 2026-09-23: it said "Offline"
    // there for good, because no page in Settings opened the socket the footer reports).
    await page.reload();
    await expect(page.getByText('لا إصدارات')).toBeVisible();
    await expect(page.getByRole('status', { name: 'متصل', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await shot(page, 'updates-reloaded-ar-light');
  });

  test('15. an agent’s skills are the files in its folder', async ({ page }) => {
    await login(page);
    // Agents is a rail entry above Tasks (owner, 2026-09-24).
    await page.getByTestId('rail').getByRole('link', { name: 'الوكلاء' }).click();
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

    // MCP: the same agent, the other page — one row away in the agent's side list. It writes
    // one block of config.yaml.
    await page.getByTestId('agent-sections').getByRole('link', { name: 'MCP' }).click();
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
    await page.getByTestId('agent-sections').getByRole('link', { name: 'الذاكرة' }).click();
    await expect(page).toHaveURL(/\/memory$/);

    // Always the same three documents, including the ones nothing has written yet.
    const docs = page.getByTestId('memory-list');
    // Each document is one row; a list's own entries are rows inside it (decision §102).
    const documents = docs.locator('[data-testid^="memory-doc-"]');
    await expect(documents).toHaveCount(3);
    await expect(docs).toContainText('SOUL.md');
    await expect(docs).toContainText('لم يكتب عنك شيئًا بعد.');

    await page.getByTestId('memory-edit-user').click();
    await page.getByTestId('memory-content').fill('أفضّل الردود القصيرة.');
    await page.getByTestId('save-memory').click();
    await expect(docs).toContainText('أفضّل الردود القصيرة.');
    // Still three: writing one does not add a document, and there is no delete to offer.
    await expect(documents).toHaveCount(3);
    await expect(page.getByTestId('memory-entries-user').getByTestId('memory-entry')).toHaveCount(
      1,
    );
    await shot(page, 'agent-memory-ar-light');

    // Channels: nothing linked yet — a short explanation and the one «ربط منصة» button.
    await page.getByTestId('agent-sections').getByRole('link', { name: 'القنوات' }).click();
    await expect(page).toHaveURL(/\/channels$/);
    const empty = page.getByTestId('channels-empty');
    await expect(empty).toContainText('لا منصة مربوطة بعد');
    await expect(empty.getByTestId('platform-picker-open')).toHaveText('ربط منصة');
    await shot(page, 'agent-channels-ar-light');
  });

  test('11. Schedules: a cron saved, its next time computed, and a run button that runs', async ({
    page,
  }) => {
    await login(page);
    await page.getByRole('link', { name: 'الجدولة' }).click();
    await expect(page).toHaveURL(/\/schedules$/);

    await page.getByTestId('schedule-name').fill('تقرير الصباح');
    await page.getByTestId('schedule-value').fill('0 9 * * *');
    await page.getByTestId('schedule-prompt').fill('اكتب ملخص أمس');
    // Not Hermes (journey 18): an agent without a scheduler of its own is fired by the hub.
    await page.getByTestId('schedule-agent').click();
    await page.getByRole('option', { name: /Direct|مباشر/ }).click();
    // A new schedule is made in the profile the person is in — the top selector — and the
    // form says so rather than offering a second picker (ADR 0016). Labs (journey 13) makes
    // two profiles, so the page names it and badges each schedule; there is no profile
    // filter (journey 26 walks both profiles).
    await expect(page.getByTestId('schedule-new-profile')).toHaveAttribute(
      'data-profile',
      'default',
    );
    await expect(page.getByTestId('schedule-workspace')).toHaveCount(0);
    await expect(page.getByTestId('schedule-filter')).toHaveCount(0);
    await page.getByTestId('schedule-save').click();

    const card = page.getByTestId('schedule-card').filter({ hasText: 'تقرير الصباح' });
    await expect(card.getByTestId('schedule-profile')).toHaveAttribute('data-profile', 'default');

    await expect(card).toBeVisible();
    // The hub computed a real next time rather than leaving it blank.
    await expect(card).not.toContainText('لا موعد');
    // The hub fires its own schedules, so "Run now" is a real button (journey 28 presses it).
    await expect(card.getByTestId('schedule-run')).toBeEnabled();
    await shot(page, 'schedules-ar-light');

    // A cron the hub cannot read is refused when it is saved, with the reason.
    await page.getByTestId('schedule-name').fill('خطأ');
    await page.getByTestId('schedule-value').fill('@daily');
    await page.getByTestId('schedule-save').click();
    await expect(page.getByRole('alert')).toBeVisible();
  });

  test("18. a schedule for Hermes lives in Hermes's scheduler, and runs now when asked", async ({
    page,
  }) => {
    await login(page);
    await page.getByRole('link', { name: 'الجدولة' }).click();
    await expect(page.getByTestId('schedule-agent')).toContainText('Hermes');

    // A cron in the person's zone: Hermes runs every cron in its own, and says which.
    await page.getByTestId('schedule-name').fill('ملخص البريد');
    await page.getByTestId('schedule-value').fill('0 7 * * *');
    await page.getByTestId('schedule-prompt').fill('لخّص بريدي وأرسله لي على تيليجرام');
    await page.getByTestId('schedule-save').click();
    await expect(page.getByRole('alert')).toContainText('Pacific/Chatham');
    await page.getByTestId('schedule-use-zone').click();

    const card = page.locator('[data-external="hermes"]').filter({ hasText: 'ملخص البريد' });
    await expect(card).toBeVisible();
    await expect(card.getByTestId('schedule-origin-hermes')).toBeVisible();
    await expect(card).toContainText('0 7 * * * · Pacific/Chatham');

    // Hermes has a scheduler, so "Run now" works — and says what will happen.
    await card.getByTestId('schedule-run').click();
    await expect(page.getByText('سيشغّله هرمز في دورته التالية.')).toBeVisible();
    await shot(page, 'schedules-hermes-ar-light');
  });

  test('22. a task assigned and started runs the agent, lands in Review, and opens its conversation', async ({
    page,
  }) => {
    await login(page);
    await page.getByRole('link', { name: 'المهام' }).click();
    await page.getByTestId('new-task-input').fill('جهّز ملاحظات الإصدار');
    await page.getByTestId('new-task').click();
    await page.getByTestId('task-intake-toggle').click();
    const card = page.getByTestId('task-card').filter({ hasText: 'جهّز ملاحظات الإصدار' });
    await expect(card).toHaveAttribute('data-status', 'triage');

    // Give it to an agent, with a word of instruction, and have it start now.
    await card.getByTestId('task-more').click();
    await page.getByRole('menuitem', { name: 'إسناد إلى وكيل…' }).click();
    const dialog = page.getByTestId('task-assign-dialog');
    await expect(dialog.getByTestId('task-assign-agent')).not.toBeEmpty();
    await dialog.getByTestId('task-assign-instructions').fill('اكتبها للمستخدمين لا للمطوّرين.');
    await dialog.getByTestId('task-assign-start').click();
    await expect(dialog).toBeHidden();

    // Running: in the queue, breathing, with a way to stop it and a way into its chat.
    await expect(card).toHaveAttribute('data-status', 'running');
    await expect(card.getByTestId('task-stop')).toBeVisible();
    await expect(card.getByTestId('task-session')).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, 'tasks-running-ar-light');

    // The run ends on its own time; the board moves the card without a reload.
    await expect(card).toHaveAttribute('data-status', 'review', { timeout: 20_000 });
    await expect(page.locator('[data-column-body="review"]')).toContainText('جهّز ملاحظات الإصدار');
    await expect(card.getByTestId('task-summary')).toContainText('بقي: مراجعة الصياغة.');
    await page.waitForTimeout(400);
    await shot(page, 'tasks-review-ar-light');

    // The conversation is an ordinary chat: the task as the prompt, the agent's reply.
    await card.getByTestId('task-session').click();
    await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}(\?profile=[a-z0-9-]+)?$/);
    await expect(page.getByTestId('message-assistant').last()).toContainText(
      'جمعت ملاحظات الإصدار',
    );
    await expect(page.getByText('اكتبها للمستخدمين لا للمطوّرين.')).toBeVisible();
  });
});
