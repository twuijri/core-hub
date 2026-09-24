/**
 * Lists across profiles, against the real hub (ADR 0016, owner 2026-09-24).
 *
 * The owner's complaint, as a journey: with two profiles, the designer's chats only showed
 * after switching the top selector, and going back to the default's needed another switch.
 * Now the app opens on "All profiles": both chats are in one list, each with its profile's
 * badge; each opens and answers in its own profile without the selector moving; and search
 * finds both.
 *
 * It runs last on purpose (`zzz-`): it adds a profile to the shared hub, and every journey
 * before it photographs a sidebar that a second profile would change.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const shots = process.env.MAJLIS_SHOTS ?? path.resolve('e2e/shots');
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

/** A new chat in `profileName`, chosen on the new-chat screen itself; returns its id. */
async function chatIn(page: Page, profileName: string, slug: string, text: string) {
  await page.getByRole('link', { name: 'محادثة جديدة' }).first().click();
  await expect(page).toHaveURL(/\/new$/);
  // Where the chat is made is said on the screen, and changed there (ADR 0016).
  const where = page.getByTestId('new-chat-profile');
  await expect(where).toBeVisible();
  if (!(await where.textContent())?.includes(profileName)) {
    await where.click();
    await page.getByRole('option', { name: profileName, exact: true }).click();
  }
  await expect(where).toContainText(profileName);
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
  test('two profiles, one list: both chats with badges, each opens and answers in its own profile, search finds both', async ({
    page,
  }) => {
    await login(page);
    await ensureDesigner(page);
    // A fresh entry into the app: the lists are on every profile (owner: «كل البروفايلات
    // افتراضيا»).
    await page.goto('/chat');
    const selector = page.getByTestId('workspace-switcher').first();
    await expect(selector).toContainText('كل البروفايلات');

    const word = `بنفسج${Date.now().toString(36)}`;
    const inDefault = await chatIn(page, 'Default', 'default', `محادثة ${word} في الافتراضي`);
    const inDesigner = await chatIn(page, 'Designer', 'designer', `محادثة ${word} عند المصمم`);

    // One list, both chats, each saying which profile it is from — and the selector never
    // moved while the new chats were made.
    await expect(selector).toContainText('كل البروفايلات');
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

    // Open each and send: it answers in its own profile, and the selector stays on all.
    for (const [id, slug] of [
      [inDefault, 'default'],
      [inDesigner, 'designer'],
    ] as const) {
      await row(page, id).getByRole('link').click();
      await expect(page).toHaveURL(new RegExp(`/chat/${id}\\?profile=${slug}$`));
      await expect(page.getByTestId('chat-profile')).toHaveAttribute('data-profile', slug);
      const before = await page.getByTestId('message-assistant').count();
      await page.getByTestId('composer-input').fill(`وماذا بعد في ${slug}؟`);
      await page.getByTestId('send').click();
      await expect(page.getByTestId('message-assistant')).toHaveCount(before + 1);
      await expect(page.getByTestId('message-assistant').last()).toHaveAttribute(
        'data-status',
        'complete',
      );
      await expect(selector).toContainText('كل البروفايلات');
      await expect(row(page, inDefault)).toBeVisible();
      await expect(row(page, inDesigner)).toBeVisible();
    }
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(shots, 'all-profiles-chat-ar-light.png') });

    // Narrowing is still there: one profile, one chat, no badges.
    await selector.click();
    await page.getByRole('option', { name: 'Designer', exact: true }).click();
    await expect(row(page, inDefault)).toHaveCount(0);
    await expect(row(page, inDesigner)).toBeVisible();
    await expect(page.getByTestId('session-profile')).toHaveCount(0);

    // Search looks in every profile, whatever the selector says (owner: «نعم»).
    await page.getByRole('link', { name: 'بحث' }).first().click();
    await page.getByRole('searchbox', { name: 'بحث' }).fill(word);
    const results = page.getByTestId('search-result');
    await expect(results).toHaveCount(2);
    await expect(page.getByTestId('search-result-profile')).toHaveCount(2);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(shots, 'all-profiles-search-ar-light.png') });
    await page.locator(`[data-testid="search-result"][href^="/chat/${inDefault}"]`).click();
    await expect(page.getByTestId('chat-profile')).toHaveAttribute('data-profile', 'default');
    await expect(page.getByTestId('message-user').first()).toContainText(word);

    // Back to all, for whatever runs after.
    await page.getByTestId('workspace-switcher').first().click();
    await page.getByRole('option', { name: 'كل البروفايلات', exact: true }).click();
    await expect(page.getByTestId('workspace-switcher').first()).toContainText('كل البروفايلات');
  });
});
