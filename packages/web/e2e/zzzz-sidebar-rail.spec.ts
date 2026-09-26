/**
 * The sidebar folds into a rail of icons (owner, 2026-09-26: the ChatGPT-style sidebar).
 *
 * In a real layout: the toggle narrows the sidebar to a rail and the page takes the room; a
 * rail row names itself in a tooltip toward the page; the choice survives a reload; the
 * keyboard shortcut unfolds it; and in Arabic the rail stands on the right with its tooltips
 * to its left. A phone-width window has no rail: its drawer is the full sidebar.
 *
 * Fresh browser context, so its folded choice reaches no other journey.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const shots = process.env.COREHUB_SHOTS ?? path.resolve('e2e/shots');
mkdirSync(shots, { recursive: true });

async function login(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('اسم المستخدم').fill('admin');
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/chat$/);
}

const sidebar = (page: Page) =>
  page.getByRole('navigation', { name: /القائمة الرئيسية|Main menu/ }).first();

/** The sidebar's width once its fold has finished easing. */
async function settledWidth(page: Page): Promise<number> {
  let last = -1;
  await expect
    .poll(async () => {
      const now = (await sidebar(page).boundingBox())?.width ?? 0;
      const same = Math.abs(now - last) < 0.5;
      last = now;
      return same;
    })
    .toBe(true);
  return last;
}

test('the sidebar folds into a rail, remembers it, and stands on the reading side', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page);
  const nav = sidebar(page);
  const wide = await settledWidth(page);
  expect(wide).toBeGreaterThan(250);

  // Arabic first (the hub's default): the sidebar is on the right.
  const viewport = page.viewportSize()!;
  const unfoldedBox = (await nav.boundingBox())!;
  expect(unfoldedBox.x + unfoldedBox.width).toBeGreaterThan(viewport.width - 2);

  await page.getByTestId('sidebar-fold').click();
  await expect(nav).toHaveAttribute('data-folded', 'true');
  const narrow = await settledWidth(page);
  expect(narrow).toBeLessThan(64);
  // Still on the right, and the page took the room.
  const railBox = (await nav.boundingBox())!;
  expect(railBox.x + railBox.width).toBeGreaterThan(viewport.width - 2);
  const main = (await page.locator('#main').boundingBox())!;
  expect(main.width).toBeGreaterThan(viewport.width - 80);

  // A row names itself on hover, toward the page: to the rail's left in Arabic.
  const newChat = nav.getByRole('link', { name: 'محادثة جديدة' });
  await newChat.hover();
  const tip = page.getByRole('tooltip', { name: 'محادثة جديدة' });
  await expect(tip).toBeVisible();
  const tipBox = (await tip.boundingBox())!;
  expect(tipBox.x + tipBox.width).toBeLessThanOrEqual(railBox.x + 1);
  await page.screenshot({ path: path.join(shots, 'sidebar-rail-ar-light.png') });

  // Remembered after a reload.
  await page.reload();
  await expect(sidebar(page)).toHaveAttribute('data-folded', 'true');
  expect(await settledWidth(page)).toBeLessThan(64);

  // The rail's rows still go where they say.
  await sidebar(page).getByRole('link', { name: 'المهام' }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(sidebar(page)).toHaveAttribute('data-folded', 'true');

  // The shortcut unfolds it — on the physical S key, whatever the layout.
  await page.keyboard.press('Control+Shift+KeyS');
  await expect(sidebar(page)).not.toHaveAttribute('data-folded', 'true');
  expect(await settledWidth(page)).toBeGreaterThan(250);
  await page.keyboard.press('Control+Shift+KeyS');
  await expect(sidebar(page)).toHaveAttribute('data-folded', 'true');

  // The person's menu holds the footer: switch to English from it.
  await sidebar(page).getByTestId('person-button').click();
  await page.getByTestId('person-menu').getByRole('menuitem', { name: 'English' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(sidebar(page)).toHaveAttribute('data-folded', 'true');

  // In English the rail is on the left, and its tooltips open to its right.
  const ltrBox = (await sidebar(page).boundingBox())!;
  expect(ltrBox.x).toBeLessThan(2);
  // On Tasks, no list icon claims to be the current page.
  await expect(sidebar(page).getByTestId('rail-segments').locator('.active')).toHaveCount(0);
  const tasks = sidebar(page).getByRole('link', { name: 'Tasks' });
  await tasks.hover();
  const ltrTip = page.getByRole('tooltip', { name: 'Tasks' });
  await expect(ltrTip).toBeVisible();
  expect((await ltrTip.boundingBox())!.x).toBeGreaterThanOrEqual(ltrBox.x + ltrBox.width - 1);
  await page.screenshot({ path: path.join(shots, 'sidebar-rail-en-light.png') });

  // A phone-width window has no rail: the drawer is the whole sidebar, folded or not.
  await page.mouse.move(640, 400, { steps: 8 });
  await expect(ltrTip).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open menu' }).click();
  const drawer = page.getByTestId('menu-drawer');
  await expect(drawer.getByTestId('segments')).toBeVisible();
  await expect(drawer.getByTestId('sidebar-fold')).toHaveCount(0);

  // Back to Arabic, in case the hub keeps the choice for the journeys after this one.
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 800 });
  await sidebar(page).getByTestId('person-button').click();
  await page.getByTestId('person-menu').getByRole('menuitem', { name: 'العربية' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
});
