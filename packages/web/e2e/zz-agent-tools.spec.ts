/**
 * Journey 23: the three agent tools that ask Hermes to act, against the real hub with a
 * scripted Hermes API (`e2e/hub.ts`):
 *
 * - MCP: "Test" has Hermes connect to a server and shows the tools it listed; a server Hermes
 *   cannot start shows Hermes's own sentence.
 * - Skills: "Import" takes a zip of two skills and lists both; the same pack again is refused
 *   with the skill named; a broken pack is refused with the file named.
 * - Channels: "Link WhatsApp" draws Hermes's QR code, redraws it when Hermes replaces it, and
 *   says the phone is linked.
 *
 * It runs after the smoke journeys (`zz-`): journey 15 photographs these pages empty.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { makeZip } from '../../server/src/modules/agents/testing/make-zip.js';

const PASSWORD = 'e2e-owner-password';
const shots = process.env.COREHUB_SHOTS ?? path.resolve('e2e/shots');
mkdirSync(shots, { recursive: true });

const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });

async function login(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('اسم المستخدم').fill('admin');
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/chat$/);
}

/** Agents is a rail entry; inside an agent's pages the rail is the row back (2026-09-24). */
async function openAgentPage(page: Page, name: string, url: RegExp) {
  const back = page.getByTestId('back-to-agents');
  if ((await back.count()) > 0) await back.click();
  else await page.getByTestId('rail').getByRole('link', { name: 'الوكلاء' }).click();
  await page.getByTestId('agent-menu').getByRole('link', { name }).first().click();
  await expect(page).toHaveURL(url);
}

const skill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\nlicense: MIT\nmetadata:\n  hermes:\n    tags: [e2e]\n---\n\n# ${name}\n\nSteps.\n`;

test('23. the agent tools ask Hermes: an MCP test, a skill pack imported, WhatsApp linked by QR', async ({
  page,
}) => {
  await login(page);

  // ---- MCP: Hermes connects and lists the tools, or says why it could not.
  await openAgentPage(page, 'MCP', /\/mcp$/);
  for (const [name, command] of [
    ['docs', 'mcp-server-filesystem'],
    ['broken', 'not-a-command'],
  ] as const) {
    await page.getByTestId('new-mcp').click();
    await page.getByTestId('mcp-name').fill(name);
    await page.getByTestId('mcp-config').fill(`{ "command": "${command}" }`);
    await page.getByTestId('save-mcp').click();
    await expect(page.getByTestId('mcp-list')).toContainText(name);
  }
  await page.getByTestId('mcp-test-docs').click();
  const ok = page.getByTestId('mcp-test-result-docs');
  await expect(ok).toHaveAttribute('data-ok', 'true');
  await expect(ok).toContainText('read_file');
  await expect(ok).toContainText('list_directory');
  await page.getByTestId('mcp-test-broken').click();
  const failed = page.getByTestId('mcp-test-result-broken');
  await expect(failed).toHaveAttribute('data-ok', 'false');
  // Hermes's words, unchanged.
  await expect(failed).toContainText("No such file or directory: 'not-a-command'");
  await shot(page, 'agent-mcp-test-ar-light');

  // ---- Core Hub tools (§67): switched on, the hub writes its own server into this profile's
  // config; Test has Hermes connect to it like any other; the block is not a row of the list.
  const card = page.getByTestId('hub-tools');
  await expect(card).toContainText('أدوات كور هب');
  await page.getByTestId('hub-tools-toggle').click();
  await expect(page.getByTestId('hub-group-toggle-tasks')).toBeEnabled();
  await page.getByTestId('hub-group-writes-tasks').click();
  await expect(page.getByTestId('hub-group-writes-tasks')).toHaveAttribute('data-state', 'checked');
  await page.getByTestId('hub-tools-test').click();
  await expect(page.getByTestId('mcp-test-result-corehub')).toHaveAttribute('data-ok', 'true');
  await expect(page.getByTestId('mcp-list')).not.toContainText('corehub');
  await shot(page, 'agent-mcp-hub-tools-ar-light');
  await page.getByTestId('hub-tools-toggle').click();
  await expect(page.getByTestId('hub-group-toggle-tasks')).toBeDisabled();

  // ---- Skills: a pack of two, installed as it is.
  await openAgentPage(page, 'المهارات', /\/skills$/);
  const pack = makeZip([
    { path: 'pack/pdf-notes/SKILL.md', data: skill('pdf-notes', 'يلخّص ملف PDF في ملاحظات') },
    { path: 'pack/pdf-notes/references/style.md', data: 'Keep headings.' },
    { path: 'pack/csv-clean/SKILL.md', data: skill('csv-clean', 'ينظّف ملف CSV') },
  ]);
  const input = page.getByTestId('import-skills-file');
  await input.setInputFiles({ name: 'pack.zip', mimeType: 'application/zip', buffer: pack });
  const result = page.getByTestId('import-skills-result');
  await expect(result).toHaveAttribute('data-ok', 'true');
  await expect(result).toContainText('pdf-notes');
  const categories = page.getByTestId('skill-categories');
  await expect(categories).toContainText('pdf-notes');
  await expect(categories).toContainText('ينظّف ملف CSV');
  await shot(page, 'agent-skills-import-ar-light');

  // The editor holds the pack's document as it came, nested front matter and all.
  await categories.getByText('pdf-notes').first().click();
  await expect(page.getByTestId('skill-content')).toHaveValue(
    /metadata:\n {2}hermes:\n {4}tags: \[e2e\]/,
  );
  await page.keyboard.press('Escape');

  // The same pack again: refused, and the skill that is already there is named.
  await input.setInputFiles({ name: 'pack.zip', mimeType: 'application/zip', buffer: pack });
  await expect(result).toHaveAttribute('data-ok', 'false');
  await expect(result).toContainText('pdf-notes');
  await expect(result).toContainText('احذفها أولًا');

  // A broken pack: refused with the file named, nothing installed.
  await input.setInputFiles({
    name: 'broken.zip',
    mimeType: 'application/zip',
    buffer: makeZip([{ path: 'half/SKILL.md', data: '# no front matter\n' }]),
  });
  await expect(result).toHaveAttribute('data-ok', 'false');
  await expect(result).toContainText('broken.zip: half/SKILL.md');
  await expect(result).toContainText('لا يبدأ بترويسة');
  await expect(categories).not.toContainText('half');

  // ---- Channels: WhatsApp linked by QR.
  await openAgentPage(page, 'القنوات', /\/channels$/);
  await page.getByTestId('channel-pair-whatsapp').click();
  const qr = page.getByTestId('channel-pair-qr');
  await expect(qr).toHaveAttribute('data-qr', 'https://wa.me/e2e#first-code');
  await expect(qr.locator('svg')).toBeVisible();
  await expect(page.getByTestId('channel-pair-message')).toContainText('الأجهزة المرتبطة');
  await shot(page, 'agent-channels-qr-ar-light');
  // Hermes replaced the code: the page draws the new one.
  await expect(qr).toHaveAttribute('data-qr', 'https://wa.me/e2e#second-code', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('channel-pair-done')).toContainText('مكتب المركز', {
    timeout: 20_000,
  });
  await expect(qr).toHaveCount(0);
  await shot(page, 'agent-channels-linked-ar-light');
});
