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

    // Dark theme and English (LTR) through the settings screen; both persist on the root.
    await page.getByRole('link', { name: 'الإعدادات' }).click();
    // The sidebar is slim: the management pages are here, not in the rail. The rail is
    // New chat · Search · Tasks · Schedules, and the segment row is Chat · Rooms only.
    await expect(page.getByTestId('settings-management').getByRole('link')).toHaveCount(4);
    await expect(page.getByTestId('rail').getByRole('link')).toHaveCount(4);
    await expect(page.getByTestId('segments').getByRole('radio')).toHaveCount(2);
    await expect(page.getByTestId('segments')).not.toContainText('السجل');
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
    // Five agents from the catalog, and a trailing "+" that goes to the Agent Manager.
    await expect(page.getByTestId('agent-chip')).toHaveCount(5);
    await expect(page.getByTestId('agent-add')).toBeVisible();
    await expect(row).toHaveAttribute('data-density', 'comfortable');
    await shot(page, 'agents-comfortable-ar-light');

    // Narrow enough that the labels no longer fit: only the chosen agent keeps its word,
    // the rest collapse to their initial, and nothing wraps or scrolls.
    await page.setViewportSize({ width: 860, height: 720 });
    await expect(row).toHaveAttribute('data-density', 'compact');
    const chips = page.getByTestId('agent-chip');
    await expect(chips.first()).toHaveAttribute('aria-checked', 'true');
    await expect(chips.first()).toContainText('Hermes');
    await expect(chips.nth(1)).toHaveClass(/mj-segment-icon-only/);
    // An icon is not a mystery: the name is still the accessible name.
    await expect(chips.nth(1)).toHaveAttribute('aria-label', /Claude Code/);
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
    await page.getByRole('button', { name: 'إلغاء' }).click();
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
});
