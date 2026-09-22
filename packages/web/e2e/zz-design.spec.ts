/**
 * The design pass, photographed (owner direction, 2026-09-22: "design, then design, then
 * design"). It proves, against the real hub, the four claims the round is judged on:
 *
 *   1. the person is on the right and the agent on the left, in Arabic and in English;
 *   2. consecutive messages from one speaker group under one name, with a tighter gap;
 *   3. a live run shows something moving, the word, the elapsed seconds and the step —
 *      and never a spinner with no count;
 *   4. the rebuilt screens are made of the kit, in both themes.
 *
 * It runs last on purpose (`zz-`): it leaves extra sessions in the shared hub, and
 * smoke.spec.ts counts the rows in the session list.
 *
 * Everything lands in MAJLIS_SHOTS (or e2e/shots) at 1440×900.
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

async function newChat(page: Page) {
  await page.getByRole('link', { name: 'محادثة جديدة' }).first().click();
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByTestId('composer-input')).toBeEnabled();
}

/** Send from the composer with the keyboard, which works while a run is already alive. */
async function say(page: Page, text: string) {
  const input = page.getByTestId('composer-input');
  await input.fill(text);
  await input.press('Enter');
}

/** Switch the skin through the real Settings screen, the way a person would. */
async function setDisplay(page: Page, settings: string, display: string, testId: string) {
  await page.getByRole('link', { name: settings }).first().click();
  await page.getByRole('link', { name: display }).click();
  await page.getByTestId(testId).click();
}

test.describe('the chat surface, designed', () => {
  test('a multi-turn conversation reads as a conversation, in both languages and both themes', async ({
    page,
  }) => {
    await login(page);
    await newChat(page);
    await say(page, 'مرحبا، اشرح لي كيف يعمل البث اللحظي');
    await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}$/);
    await expect(page.getByTestId('message-assistant').first()).toHaveAttribute(
      'data-status',
      'complete',
    );

    // A second turn, this one answered in English with a table and code: the agent's side
    // must be able to use the whole column.
    await say(page, 'وضّح الفرق in English please');
    await expect(page.getByTestId('message-assistant')).toHaveCount(2);
    await expect(page.getByTestId('message-assistant').nth(1)).toHaveAttribute(
      'data-status',
      'complete',
    );
    await expect(page.getByTestId('message-assistant').nth(1).locator('table')).toBeVisible();

    // The rule, asserted and not merely photographed: the person is on the right and the
    // agent on the left, and the side never follows the content's language.
    for (const node of await page.getByTestId('message-user').all())
      await expect(node).toHaveAttribute('data-side', 'user');
    for (const node of await page.getByTestId('message-assistant').all())
      await expect(node).toHaveAttribute('data-side', 'agent');

    // The two sides really are two surfaces, not one column of identical text: the user's
    // bubble ends before the agent's does, and they are painted differently.
    const bubble = page.locator('.msg-user').first();
    const body = page.locator('.msg-agent-body').first();
    const column = page.getByTestId('chat-screen');
    const [bubbleBox, bodyBox, columnBox] = await Promise.all([
      bubble.boundingBox(),
      body.boundingBox(),
      column.boundingBox(),
    ]);
    expect(bubbleBox && bodyBox && columnBox).toBeTruthy();
    if (bubbleBox && bodyBox && columnBox) {
      // The user's bubble hugs the right edge of the column…
      expect(bubbleBox.x + bubbleBox.width).toBeGreaterThan(columnBox.x + columnBox.width - 40);
      // …and is nowhere near as wide as it (roughly 70% at most).
      expect(bubbleBox.width).toBeLessThan(columnBox.width * 0.75);
      // The agent starts at the left edge, past its avatar gutter.
      expect(bodyBox.x).toBeLessThan(columnBox.x + 80);
    }
    expect(await bubble.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
      await body.evaluate((el) => getComputedStyle(el).backgroundColor),
    );

    // The finished turn says how long it thought, with the text behind a disclosure.
    await expect(page.getByTestId('reasoning-summary').first()).toContainText('فكّر لمدة');
    await shot(page, 'design-chat-ar-light');

    // The same conversation in dark.
    await setDisplay(page, 'الإعدادات', 'العرض', 'theme-dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.goBack();
    await page.goBack();
    await expect(page.getByTestId('message-assistant').first()).toBeVisible();
    await shot(page, 'design-chat-ar-dark');

    // And in English (LTR). The sides must not move.
    await setDisplay(page, 'الإعدادات', 'العرض', 'language-en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await page.getByTestId('session-row').first().getByRole('link').click();
    await expect(page.getByTestId('message-assistant').first()).toBeVisible();
    for (const node of await page.getByTestId('message-user').all())
      await expect(node).toHaveAttribute('data-side', 'user');
    const ltrBubble = await page.locator('.msg-user').first().boundingBox();
    const ltrColumn = await page.getByTestId('chat-screen').boundingBox();
    if (ltrBubble && ltrColumn)
      expect(ltrBubble.x + ltrBubble.width).toBeGreaterThan(ltrColumn.x + ltrColumn.width - 40);
    await shot(page, 'design-chat-en-dark');

    // Back to Arabic light for the rest of the run.
    await setDisplay(page, 'Settings', 'Display', 'theme-light');
    await page.getByTestId('language-ar').click();
  });

  test('a live run is visibly alive: the word, the seconds counting up, and the step', async ({
    page,
  }) => {
    await login(page);
    await newChat(page);
    await say(page, 'يفكّر الآن من فضلك');
    await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}$/);

    // While the run is silent, a second message queues behind it — which is how two
    // messages from the same speaker end up next to each other.
    await say(page, 'وأضف مثالًا في النهاية');
    const users = page.getByTestId('message-user');
    await expect(users).toHaveCount(2);
    await expect(users.nth(0)).toHaveAttribute('data-grouped', 'false');
    await expect(users.nth(1)).toHaveAttribute('data-grouped', 'true');
    // Grouped is not merely a flag: the gap above the second message is the tighter one.
    // (The first message in the column has no gap at all — it opens the transcript — so
    // the comparison is against the turn gap itself, which is what a new turn would get.)
    const gaps = await users.nth(1).evaluate((node) => {
      const styles = getComputedStyle(node);
      const root = getComputedStyle(document.documentElement);
      const px = (value: string) => parseFloat(value) * (value.endsWith('rem') ? 16 : 1);
      return {
        mine: parseFloat(styles.marginBlockStart),
        turn: px(root.getPropertyValue('--mj-layout-turn-gap').trim()),
      };
    });
    expect(gaps.mine).toBeGreaterThan(0);
    expect(gaps.mine).toBeLessThan(gaps.turn);
    await shot(page, 'design-grouped-ar-light');

    // The indicator: something moving, the word, and the seconds. Never a bare spinner.
    const status = page.getByTestId('run-status');
    await expect(status).toBeVisible();
    await expect(status).toContainText('يفكّر');
    await expect(page.getByTestId('run-elapsed')).toBeVisible();
    // The step arrives when the agent reports one (the scripted runner opens a tool).
    await expect(page.getByTestId('run-step')).toContainText('read_file', { timeout: 15_000 });

    // The count is a clock, not a decoration: it is strictly larger a few seconds later.
    const secondsOf = async () =>
      Number(/(\d+)/.exec((await page.getByTestId('run-elapsed').textContent()) ?? '0')?.[1] ?? 0);
    const before = await secondsOf();
    await expect
      .poll(secondsOf, { timeout: 10_000, message: 'the elapsed seconds must count up' })
      .toBeGreaterThan(before);
    await shot(page, 'design-thinking-ar-light');

    // Stopping ends the run, and with it the indicator.
    await page.getByTestId('stop-run').click();
    await expect(page.getByTestId('run-status')).toHaveCount(0);
  });
});

test.describe('the rebuilt screens', () => {
  test('agents, models, sessions, settings and the sign-in door are made of the kit', async ({
    page,
  }) => {
    await login(page);

    // Agents: one card per agent, from the kit's Card / Avatar / Badge / Button.
    await page.getByRole('link', { name: 'الإعدادات' }).first().click();
    await page.getByRole('link', { name: 'الوكلاء' }).click();
    await expect(page.getByTestId('agent-card').first()).toBeVisible();
    await expect(page.getByTestId('agent-card').first().locator('.mj-avatar')).toBeVisible();
    await expect(page.getByTestId('agent-card').first().locator('.mj-badge').first()).toBeVisible();
    await shot(page, 'design-agents-ar-light');

    // Settings: the tab strip, the management cards and the Display switch.
    await page.getByTestId('settings-back').click();
    await expect(page.getByTestId('settings-tabs')).toBeVisible();
    await expect(page.getByTestId('settings-management').getByRole('link')).toHaveCount(4);
    await shot(page, 'design-settings-ar-light');
    await page.getByRole('link', { name: 'العرض' }).click();
    await expect(page.getByRole('switch', { name: /تفكير/ })).toBeVisible();
    await shot(page, 'design-display-ar-light');

    // Models: the provider card, and the model panel's table inside a scroll area.
    // (A settings *tab* has no "back to Settings" link — it is already there.)
    await page.getByRole('link', { name: 'الإعدادات' }).first().click();
    await page.getByRole('link', { name: 'النماذج' }).click();
    await expect(page.getByTestId('open-add-provider')).toBeVisible();
    await shot(page, 'design-models-ar-light');

    // The add-provider dialog is now the kit's Dialog: one focus trap, one close.
    await page.getByTestId('open-add-provider').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await shot(page, 'design-add-provider-ar-light');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Dark, for the two screens that carry the most surface.
    await setDisplay(page, 'الإعدادات', 'العرض', 'theme-dark');
    await page.getByRole('link', { name: 'الإعدادات' }).first().click();
    await page.getByRole('link', { name: 'الوكلاء' }).click();
    await expect(page.getByTestId('agent-card').first()).toBeVisible();
    await shot(page, 'design-agents-ar-dark');
    await page.getByTestId('settings-back').click();
    await page.getByRole('link', { name: 'النماذج' }).click();
    // Wait for the screen itself, not for the click: the navigation is client-side and a
    // screenshot taken on the click would photograph the page it came from.
    await expect(page.getByTestId('open-add-provider')).toBeVisible();
    await shot(page, 'design-models-ar-dark');

    // The sidebar, on its own, in dark: the rail, the segment row and the session list.
    await page
      .getByRole('navigation', { name: 'القائمة الرئيسية' })
      .screenshot({ path: path.join(shots, 'design-sidebar-ar-dark.png') });

    // The sign-in door, signed out.
    await setDisplay(page, 'الإعدادات', 'العرض', 'theme-light');
    await page.getByRole('button', { name: 'تسجيل الخروج' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await shot(page, 'design-login-ar-light');
  });
});
