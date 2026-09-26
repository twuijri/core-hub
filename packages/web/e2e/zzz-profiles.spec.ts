/**
 * Lists across profiles, against the real hub (ADR 0016, owner 2026-09-24).
 *
 * The owner's complaint, as a journey: with two profiles, the designer's chats only showed
 * after switching the top selector, and going back to the default's needed another switch.
 * Now the chats list has its own filter, on "All profiles" by default: both chats are in one
 * list, each with its profile's badge; each opens and answers in its own profile; search
 * finds both. The top selector is always the concrete profile the person is in (owner's
 * correction: «المفروض ما فيه خيار الكل. خيار الكل كان لتصنيف المحادثات بس»): new chats are
 * made there, and it and the list filter never move each other.
 *
 * It runs last on purpose (`zzz-`): it adds a profile to the shared hub, and every journey
 * before it photographs a sidebar that a second profile would change.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const shots = process.env.COREHUB_SHOTS ?? path.resolve('e2e/shots');
mkdirSync(shots, { recursive: true });

test.use({ viewport: { width: 1440, height: 900 } });

const CHAT_URL = /\/chat\/([0-9A-Z]{26})\?profile=([a-z0-9-]+)$/;

async function login(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('اسم المستخدم').fill('admin');
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/chat$/);
}

/** A second profile, made the way a person makes one (ADR 0014: from scratch). */
async function ensureDesigner(page: Page) {
  await page.getByRole('link', { name: 'الإعدادات' }).first().click();
  await page.getByTestId('settings-nav').getByRole('link', { name: 'البروفايلات' }).click();
  await expect(page.getByTestId('workspace-list')).toBeVisible();
  if ((await page.getByTestId('workspace-list').getByText('Designer').count()) === 0) {
    await page.getByTestId('add-workspace').click();
    await page.getByLabel('الاسم').fill('Designer');
    await expect(page.getByLabel('المعرّف')).toHaveValue('designer');
    await page.getByTestId('save-workspace').click();
    await expect(page.getByTestId('workspace-list')).toContainText('Designer');
  }
  await page.getByTestId('back-to-chats').click();
}

/** A new chat in the profile the top selector is on; returns its id. */
async function chatIn(page: Page, profileName: string, slug: string, text: string) {
  const top = page.getByTestId('workspace-switcher').first();
  if (!(await top.textContent())?.includes(profileName)) {
    await top.click();
    await page.getByRole('option', { name: profileName, exact: true }).click();
  }
  await expect(top).toContainText(profileName);
  await page.getByRole('link', { name: 'محادثة جديدة' }).first().click();
  await expect(page).toHaveURL(/\/new$/);
  // Where the chat is made is said on the screen: the top profile, nothing else.
  await expect(page.getByTestId('new-chat-profile')).toHaveAttribute('data-profile', slug);
  await expect(page.getByTestId('composer-input')).toBeEnabled();
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('send').click();
  await expect(page).toHaveURL(CHAT_URL);
  const [, id, profile] = CHAT_URL.exec(page.url()) ?? [];
  expect(profile).toBe(slug);
  await expect(page.getByTestId('message-assistant').last()).toHaveAttribute(
    'data-status',
    'complete',
  );
  return id as string;
}

const row = (page: Page, id: string) =>
  page.getByTestId('session-row').filter({ has: page.locator(`a[href^="/chat/${id}"]`) });

test.describe('lists across profiles', () => {
  test('two profiles, one list: the list filter opens on all, the top selector is one profile, each chat answers in its own, search finds both', async ({
    page,
  }) => {
    await login(page);
    await ensureDesigner(page);
    // A fresh entry into the app: the top selector is the profile the person is in, and
    // offers no "All"; the list's own filter is on every profile.
    await page.goto('/chat');
    const top = page.getByTestId('workspace-switcher').first();
    const filter = page.getByTestId('session-profile-filter');
    await expect(top).toContainText('Default');
    await expect(filter).toContainText('كل البروفايلات');
    await top.click();
    // Profiles only (an earlier journey may have made more): never "All".
    await expect(page.getByRole('option', { name: 'Designer', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: 'كل البروفايلات' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    const word = `بنفسج${Date.now().toString(36)}`;
    const inDefault = await chatIn(page, 'Default', 'default', `محادثة ${word} في الافتراضي`);
    const inDesigner = await chatIn(page, 'Designer', 'designer', `محادثة ${word} عند المصمم`);

    // Changing the top selector to make the second chat did not narrow the list: both chats,
    // each saying which profile it is from.
    await expect(filter).toContainText('كل البروفايلات');
    await expect(row(page, inDefault).getByTestId('session-profile')).toHaveAttribute(
      'data-profile',
      'default',
    );
    await expect(row(page, inDesigner).getByTestId('session-profile')).toHaveAttribute(
      'data-profile',
      'designer',
    );
    await page.waitForTimeout(300);
    await page
      .getByRole('navigation', { name: /القائمة الرئيسية|Main menu/ })
      .screenshot({ path: path.join(shots, 'all-profiles-sidebar-ar-light.png') });

    // Open each and send: it answers in its own profile; the top selector stays on Designer
    // even while the default chat is open, and the list stays on all.
    for (const [id, slug] of [
      [inDefault, 'default'],
      [inDesigner, 'designer'],
    ] as const) {
      await row(page, id).getByRole('link').click();
      await expect(page).toHaveURL(new RegExp(`/chat/${id}\\?profile=${slug}$`));
      // The bar already shows the person's profile (Designer): the conversation's own is
      // added only when it is another one.
      if (slug === 'designer') await expect(page.getByTestId('chat-profile')).toHaveCount(0);
      else await expect(page.getByTestId('chat-profile')).toHaveAttribute('data-profile', slug);
      // Count only once the transcript is on screen: each chat already has its first reply,
      // and counting while it still loads read 0 on a busy hub (a race, not a failure).
      await expect(page.getByTestId('message-assistant').first()).toHaveAttribute(
        'data-status',
        'complete',
      );
      const before = await page.getByTestId('message-assistant').count();
      await page.getByTestId('composer-input').fill(`وماذا بعد في ${slug}؟`);
      await page.getByTestId('send').click();
      await expect(page.getByTestId('message-assistant')).toHaveCount(before + 1);
      await expect(page.getByTestId('message-assistant').last()).toHaveAttribute(
        'data-status',
        'complete',
      );
      await expect(top).toContainText('Designer');
      await expect(filter).toContainText('كل البروفايلات');
      await expect(row(page, inDefault)).toBeVisible();
      await expect(row(page, inDesigner)).toBeVisible();
    }

    // The list's filter narrows the list only: one profile, one chat, no badges — and the
    // top selector did not move.
    await filter.click();
    await page.getByRole('option', { name: 'Default', exact: true }).click();
    await expect(row(page, inDesigner)).toHaveCount(0);
    await expect(row(page, inDefault)).toBeVisible();
    await expect(page.getByTestId('session-profile')).toHaveCount(0);
    await expect(top).toContainText('Designer');
    await page.waitForTimeout(300);
    await page
      .getByRole('navigation', { name: /القائمة الرئيسية|Main menu/ })
      .screenshot({ path: path.join(shots, 'all-profiles-filter-ar-light.png') });

    // Search looks in every profile, whatever the list filter says (owner: «نعم»).
    await page.getByRole('link', { name: 'بحث' }).first().click();
    await page.getByRole('searchbox', { name: 'بحث' }).fill(word);
    await expect(page.getByTestId('search-result')).toHaveCount(2);
    await expect(page.getByTestId('search-result-profile')).toHaveCount(2);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(shots, 'all-profiles-search-ar-light.png') });
    await page.locator(`[data-testid="search-result"][href^="/chat/${inDefault}"]`).click();
    await expect(page.getByTestId('chat-profile')).toHaveAttribute('data-profile', 'default');
    await expect(page.getByTestId('message-user').first()).toContainText(word);

    // Back as it was, for whatever runs after: the list on all, the person in Default.
    await filter.click();
    await page.getByRole('option', { name: 'كل البروفايلات', exact: true }).click();
    await top.click();
    await page.getByRole('option', { name: 'Default', exact: true }).click();
    await expect(top).toContainText('Default');
  });
});
