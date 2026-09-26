/**
 * The design-family audit (owner, 2026-09-27: «أبي الويب وكل برامج سطح المكتب والآيفون
 * والأندرويد يكونون عائلة وحدة»). One pass over the screens the audit is judged on — the chat,
 * the one-bar header, Models, Channels, Settings, Tasks and the agents — on a desktop window
 * and on a phone-width window, in Arabic and English, light and dark
 * (docs/design/family.md).
 *
 * It asserts the family rules a screenshot cannot be trusted to keep:
 *   - every row of the settings list and of the rail carries its icon;
 *   - every icon is a Lucide outline (stroke 2 on a 24 grid);
 *   - on a phone the connection state is a dot, not a word;
 *   - the product's own name is not repeated in the top bar beside the sidebar's brand.
 *
 * The pictures land in COREHUB_FAMILY_SHOTS (default `test-results/family`, not committed):
 * the before/after evidence lives outside the repository. Runs last: it adds a session.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const shots = process.env.COREHUB_FAMILY_SHOTS ?? path.resolve('test-results/family');
mkdirSync(shots, { recursive: true });

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function login(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('اسم المستخدم').fill('admin');
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/chat$/);
}

/** The display preferences, as the Display page stores them, then a fresh load. */
async function display(page: Page, language: 'ar' | 'en', theme: 'light' | 'dark') {
  await page.evaluate(
    ([lang, th]) => {
      const key = 'corehub.display';
      const current = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
      localStorage.setItem(key, JSON.stringify({ ...current, language: lang, theme: th }));
    },
    [language, theme] as const,
  );
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator('html')).toHaveAttribute('lang', language);
}

async function settle(page: Page) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

async function shoot(page: Page, name: string) {
  await settle(page);
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

test('the family pass: the audited screens, desktop and phone, both languages and themes', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize(DESKTOP);
  await login(page);

  // A conversation to look at: the scripted runner answers with Markdown, a table and code.
  await page.getByRole('link', { name: 'محادثة جديدة' }).first().click();
  await expect(page).toHaveURL(/\/new$/);
  await expect(async () => {
    await page.getByTestId('composer-input').fill('مرحبا، اشرح لي كيف يعمل البث اللحظي');
    await expect(page.getByTestId('send')).toBeEnabled({ timeout: 1_000 });
  }).toPass();
  await page.getByTestId('send').click();
  await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}/);
  await expect(page.getByTestId('message-assistant').last()).toHaveAttribute(
    'data-status',
    'complete',
    { timeout: 30_000 },
  );
  const chatUrl = new URL(page.url()).pathname;

  // Hermes's Channels page, found the way a person finds it.
  await page.goto('/agents');
  await page.getByTestId('agent-menu').getByRole('link', { name: 'القنوات' }).first().click();
  await expect(page).toHaveURL(/\/agents\/[^/]+\/channels$/);
  const channelsUrl = new URL(page.url()).pathname;

  const screens: Array<[string, string]> = [
    ['chat', chatUrl],
    ['models', '/settings/models'],
    ['channels', channelsUrl],
    ['settings', '/settings/account'],
    ['tasks', '/tasks'],
    ['agents', '/agents'],
  ];

  for (const [language, theme] of [
    ['ar', 'light'],
    ['ar', 'dark'],
    ['en', 'light'],
  ] as const) {
    await page.setViewportSize(DESKTOP);
    await display(page, language, theme);
    for (const [name, url] of screens) {
      await page.goto(url);
      await expect(page.locator('main')).toBeVisible();
      await shoot(page, `family-${name}-${language}-${theme}`);
    }

    await page.setViewportSize(PHONE);
    for (const [name, url] of screens) {
      await page.goto(url);
      await expect(page.locator('main')).toBeVisible();
      await shoot(page, `family-${name}-${language}-${theme}-phone`);
    }
    // The drawer, open over the chat.
    await page.goto(chatUrl);
    await page
      .getByRole('button', { name: language === 'ar' ? 'فتح القائمة' : 'Open menu' })
      .click();
    await expect(page.getByTestId('menu-drawer').getByTestId('rail')).toBeVisible();
    await shoot(page, `family-drawer-${language}-${theme}-phone`);
  }
});

test('the family rules hold: icons on every row, Lucide strokes, a dot on a phone', async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await login(page);
  await display(page, 'ar', 'light');

  // Every rail row and every settings row carries its icon.
  const railRows = page.getByTestId('rail').locator('a');
  await expect(railRows.first()).toBeVisible();
  for (const row of await railRows.all()) await expect(row.locator('svg')).toHaveCount(1);

  await page.goto('/settings/account');
  const settingsRows = page.getByTestId('settings-nav').locator('a');
  await expect(settingsRows.first()).toBeVisible();
  for (const row of await settingsRows.all()) await expect(row.locator('svg')).toHaveCount(1);

  // Every icon in the sidebar is drawn with Lucide's stroke on its 24 grid.
  const strokes = await page
    .locator('[data-testid="settings-nav"] svg, [data-testid="footer"] svg')
    .evaluateAll((svgs) =>
      svgs.map((svg) => `${svg.getAttribute('viewBox')}|${svg.getAttribute('stroke-width')}`),
    );
  expect(new Set(strokes)).toEqual(new Set(['0 0 24 24|2']));

  // The top bar does not repeat the product's name beside the sidebar's brand.
  await expect(page.locator('header .topbar-hub')).toHaveCount(0);

  // On a phone the connection state is a dot with its words for a screen reader.
  await page.setViewportSize(PHONE);
  await page.goto('/chat');
  await page.getByRole('button', { name: 'فتح القائمة' }).click();
  const status = page.getByTestId('menu-drawer').getByTestId('footer').getByRole('status');
  await expect(status).toBeVisible();
  await expect(status).toHaveAttribute('aria-label', /.+/);
  expect(await status.evaluate((el) => (el as HTMLElement).innerText.trim())).toBe('');
});
