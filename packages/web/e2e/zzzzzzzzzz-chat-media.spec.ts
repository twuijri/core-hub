/**
 * 36. Media in chat (decision §98): a scripted run records a two-minute tone in the session's
 *     folder and leaves a short one for its reply. The short one plays in the reply; the long one
 *     opens in the file panel as a player that reads the hub a byte range at a time (`206` from a
 *     one-file stream address, no bearer in it) — so it knows its length at once and seeks to
 *     the end of the recording without the page ever fetching the whole file first.
 *
 * Runs after the other journeys, which count the rows of the session list.
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

test('36. a recording plays in the reply and seeks in the file panel, a byte range at a time', async ({
  page,
}) => {
  const ranges: Array<{
    url: string;
    status: number;
    range: string | null;
    contentRange: string | null;
  }> = [];
  page.on('response', (response) => {
    const url = response.url();
    if (!/\/api\/v1\/(file|attachment)-streams\//.test(url)) return;
    ranges.push({
      url,
      status: response.status(),
      range: response.request().headers().range ?? null,
      contentRange: response.headers()['content-range'] ?? null,
    });
  });

  await login(page);
  await page.getByRole('link', { name: 'محادثة جديدة' }).first().click();
  await expect(page).toHaveURL(/\/new$/);
  await expect(async () => {
    await page.getByTestId('composer-input').fill('سجّل نغمة طويلة');
    await expect(page.getByTestId('send')).toBeEnabled({ timeout: 1_000 });
  }).toPass();
  await page.getByTestId('send').click();
  await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}(\?profile=[a-z0-9-]+)?$/);

  // The short recording plays in the reply, from its stream address.
  const reply = page.getByTestId('message-assistant').last();
  const inline = reply.getByTestId('message-audio');
  await expect(inline).toBeVisible({ timeout: 20_000 });
  await expect(inline).toHaveAttribute('src', /^\/api\/v1\/attachment-streams\/[0-9a-f]{64}$/);
  await expect
    .poll(() => inline.evaluate((node) => Math.round((node as HTMLAudioElement).duration)))
    .toBe(2);

  // The long one, from the Files list, in the panel.
  await page.getByTestId('chat-files').click();
  const sheet = page.getByTestId('files-sheet');
  await sheet.getByTestId('file-row').filter({ hasText: 'tone.wav' }).click();
  const pane = page.getByTestId('split-pane');
  const player = pane.getByTestId('file-audio');
  await expect(player).toBeVisible();
  await expect(player).toHaveAttribute('src', /^\/api\/v1\/file-streams\/[0-9a-f]{64}$/);
  await expect
    .poll(() => player.evaluate((node) => Math.round((node as HTMLAudioElement).duration)))
    .toBe(120);
  await page.screenshot({ path: path.join(shots, '36-chat-media.png') });

  // Seek near the end: the player gets there, reading from where it landed.
  await player.evaluate((node) => {
    (node as HTMLAudioElement).currentTime = 110;
  });
  await expect
    .poll(
      () =>
        player.evaluate((node) => {
          const audio = node as HTMLAudioElement;
          return !audio.seeking && audio.readyState >= 2 ? Math.floor(audio.currentTime) : -1;
        }),
      { timeout: 30_000 },
    )
    .toBe(110);

  // Every read was a byte range the hub answered with 206, never the whole file at once.
  const fileReads = ranges.filter((entry) => entry.url.includes('/file-streams/'));
  expect(fileReads.length).toBeGreaterThan(0);
  for (const read of fileReads) {
    expect(read.range, JSON.stringify(read)).toMatch(/^bytes=\d+-/);
    expect(read.status, JSON.stringify(read)).toBe(206);
    expect(read.contentRange, JSON.stringify(read)).toMatch(/^bytes \d+-\d+\/5292044$/);
  }
  // No request carried the page's token in its address.
  expect(ranges.every((entry) => !/token|bearer/i.test(entry.url))).toBe(true);
});
