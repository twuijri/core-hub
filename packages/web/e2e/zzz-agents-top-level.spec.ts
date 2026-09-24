/**
 * Journey 27: «الوكلاء» is a main-sidebar entry above Tasks, and an agent's pages carry the
 * agent's own list in the sidebar (owner, 2026-09-24: «قراري اننا ندخل الايجنتات داخل الاعدادات
 * كان خطا بالتصميم — تطلع فوق Tasks في الصفحة الرئيسية»).
 *
 * - An admin: Agents sits directly above Tasks → the Hermes card's «الذاكرة» chip opens Hermes's
 *   memory with the agent's side list and the profile chip still at the top → MCP from the side
 *   list → «رجوع إلى الوكلاء».
 * - An old `/settings/agents/…` URL lands on the same page under `/agents`.
 * - A member sees no Agents entry, and the page itself sends them home.
 * - On a phone the opened page shows the way back itself.
 *
 * It runs after the smoke and design journeys (`zzz-`); the member it makes is removed again.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const shots = process.env.COREHUB_SHOTS ?? path.resolve('e2e/shots');
mkdirSync(shots, { recursive: true });

const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });

async function login(page: Page, username: string, password: string) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('اسم المستخدم').fill(username);
  await page.getByLabel('كلمة المرور').fill(password);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/chat$/);
}

test('27. Agents above Tasks: a card chip opens the agent with its own side list, and back', async ({
  page,
}) => {
  await login(page, 'admin', PASSWORD);

  // The rail: New chat · Search · Agents · Tasks · Schedules — Agents directly above Tasks.
  const rail = page.getByTestId('rail');
  await expect(rail.getByRole('link')).toHaveCount(5);
  const order = await rail
    .getByRole('link')
    .evaluateAll((links) => links.map((link) => link.getAttribute('data-nav-id')));
  expect(order).toEqual(['new_chat', 'search', 'agent_manager', 'tasks', 'schedules']);
  await rail.getByRole('link', { name: 'الوكلاء' }).click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByRole('heading', { name: 'الوكلاء' }).first()).toBeVisible();
  await expect(rail.getByRole('link', { name: 'الوكلاء' })).toHaveClass(/active/);

  // The Hermes card: its chips go somewhere, its capability tags do not.
  const hermes = page.locator('[data-testid="agent-card"][data-agent-slug="hermes"]');
  await expect(hermes.getByTestId('agent-capabilities').getByRole('link')).toHaveCount(0);
  const memoryChip = hermes.getByTestId('agent-menu').getByRole('link', { name: 'الذاكرة' });
  await expect(memoryChip).toHaveAccessibleName('الذاكرة · Hermes');
  await shot(page, 'agents-page-ar-light');
  await memoryChip.click();
  await expect(page).toHaveURL(/\/agents\/[^/]+\/memory$/);
  const hermesId = /\/agents\/([^/]+)\/memory$/.exec(page.url())?.[1] ?? '';

  // Inside: the back row, the agent, its pages — and the rail has stepped aside.
  const back = page.getByTestId('back-to-agents');
  await expect(back).toHaveText('رجوع إلى الوكلاء');
  await expect(page.getByTestId('rail')).toHaveCount(0);
  await expect(page.getByTestId('segments')).toHaveCount(0);
  await expect(page.getByTestId('agent-nav-head')).toContainText('Hermes');
  const sections = page.getByTestId('agent-sections');
  await expect(sections.getByRole('link', { name: 'الذاكرة' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // Only the pages Hermes declares, in the manifest's order.
  const rows = await sections
    .getByRole('link')
    .evaluateAll((links) => links.map((link) => link.getAttribute('data-nav-id')));
  expect(rows.slice(0, 5)).toEqual([
    'agent_skills',
    'agent_mcp',
    'agent_memory',
    'agent_jobs',
    'agent_channels',
  ]);
  // The profile chip stays at the top: skills, MCP, memory and channels are per profile.
  await expect(page.getByTestId('workspace-switcher').first()).toBeVisible();
  await expect(page.getByTestId('memory-list')).toBeVisible();
  await shot(page, 'agent-nav-memory-ar-light');

  // MCP, one row away in the side list.
  await sections.getByRole('link', { name: 'MCP' }).click();
  await expect(page).toHaveURL(new RegExp(`/agents/${hermesId}/mcp$`));
  await expect(sections.getByRole('link', { name: 'MCP' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('new-mcp')).toBeVisible();
  await shot(page, 'agent-nav-mcp-ar-light');

  // Back returns to the Agents page, and the rail with it.
  await back.click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByTestId('rail').getByRole('link')).toHaveCount(5);
  await expect(page.getByTestId('back-to-agents')).toHaveCount(0);

  // An old URL from before the move lands on the same page.
  await page.goto(`/settings/agents/${hermesId}/skills`);
  await expect(page).toHaveURL(new RegExp(`/agents/${hermesId}/skills$`));
  await expect(
    page.getByTestId('agent-sections').getByRole('link', { name: 'المهارات' }),
  ).toHaveAttribute('aria-current', 'page');
  await page.goto('/settings/agents');
  await expect(page).toHaveURL(/\/agents$/);

  // On a phone the list is in the drawer, so the opened page shows the way back itself.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/agents/${hermesId}/memory`);
  const phoneBack = page.getByTestId('agent-page-back');
  await expect(phoneBack).toBeVisible();
  await expect(phoneBack).toHaveText('رجوع إلى الوكلاء');
  await shot(page, 'agent-nav-mobile-ar-light');
  await page.getByRole('button', { name: 'فتح القائمة' }).click();
  const drawer = page.getByTestId('menu-drawer');
  await expect(drawer.getByTestId('back-to-agents')).toBeVisible();
  await expect(
    drawer.getByTestId('agent-sections').getByRole('link', { name: 'الذاكرة' }),
  ).toHaveAttribute('aria-current', 'page');
  await shot(page, 'agent-nav-mobile-drawer-ar-light');
  await drawer.getByTestId('agent-sections').getByRole('link', { name: 'MCP' }).click();
  await expect(page).toHaveURL(new RegExp(`/agents/${hermesId}/mcp$`));
  await page.getByTestId('agent-page-back').click();
  await expect(page).toHaveURL(/\/agents$/);
});

test('27b. a member sees no Agents entry, and the Agents pages send them home', async ({
  page,
  browser,
  request,
}) => {
  const owner = await request.post('/api/v1/auth/login', {
    data: { username: 'admin', password: PASSWORD },
  });
  const ownerAuth = { authorization: `Bearer ${(await owner.json()).access_token}` };
  const made = await request.post('/api/v1/auth/users', {
    headers: ownerAuth,
    data: {
      username: 'layla',
      password: 'layla-password-1',
      role: 'member',
      profiles: ['default'],
    },
  });
  expect(made.status()).toBe(201);
  const laylaId = (await made.json()).id as string;
  try {
    const baseURL = test.info().project.use.baseURL;
    const context = await browser.newContext({ ...(baseURL ? { baseURL } : {}), locale: 'ar' });
    const member = await context.newPage();
    await login(member, 'layla', 'layla-password-1');
    const rail = member.getByTestId('rail');
    await expect(rail.getByRole('link')).toHaveCount(4);
    await expect(rail.getByRole('link', { name: 'الوكلاء' })).toHaveCount(0);
    // Not in Settings either: it left Management for the rail, and a member has neither.
    await member.getByRole('link', { name: 'الإعدادات', exact: true }).first().click();
    await expect(member.getByTestId('settings-nav')).not.toContainText('الوكلاء');
    // A typed or bookmarked URL does not open the page.
    await member.goto('/agents');
    await expect(member).toHaveURL(/\/chat$/);
    await member.goto('/settings/agents/whatever/memory');
    await expect(member).toHaveURL(/\/chat$/);
    await context.close();
  } finally {
    await request.delete(`/api/v1/auth/users/${laylaId}`, { headers: ownerAuth });
  }
  // The owner's page is untouched by any of it.
  await login(page, 'admin', PASSWORD);
  await expect(page.getByTestId('rail').getByRole('link', { name: 'الوكلاء' })).toBeVisible();
});
