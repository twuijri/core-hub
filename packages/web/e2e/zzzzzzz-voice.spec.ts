/**
 * 32. Voice (contract decision §63), against the real hub with a scripted OpenAI (e2e/hub.ts):
 *     OpenAI is added once and chosen on the Speech to text and Text to speech tabs, which then
 *     say «جاهز»; in a new chat the mic records from Chromium's fake microphone, the hub
 *     transcribes the take, and the words land in the composer for review; the reply is read
 *     aloud through the hub's TTS with its code block announced as «كتلة كود», never recited;
 *     and voice mode goes round once — listening, thinking, speaking, listening again.
 *
 * Runs last (`zzzzzzz-`): it adds a provider to the shared hub.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const shots = process.env.COREHUB_SHOTS ?? path.resolve('e2e/shots');
mkdirSync(shots, { recursive: true });

test.use({
  viewport: { width: 1280, height: 860 },
  permissions: ['microphone'],
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

async function login(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('اسم المستخدم').fill('admin');
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/chat$/);
}

/** One speech tab: choose the provider, save, and read the hub's own «جاهز». */
async function choose(page: Page, kind: 'stt' | 'tts', label: string) {
  await page.locator(`[data-tab-id="${kind}_providers"]`).click();
  const card = page.getByTestId(`speech-card-${kind}`);
  await expect(card).toBeVisible();
  await card.getByTestId(`speech-provider-${kind}`).click();
  await page.getByRole('option', { name: label }).click();
  await card.getByTestId(`speech-save-${kind}`).click();
  await expect(card.getByTestId(`speech-ready-${kind}`)).toHaveText('جاهز');
}

test('32. dictation lands in the composer, a reply is read aloud, and voice mode goes round', async ({
  page,
}) => {
  await login(page);

  // ------------------------------------------------ Models: OpenAI, chosen for speech
  await page.getByRole('link', { name: 'الإعدادات' }).first().click();
  await page.getByTestId('settings-nav').getByRole('link', { name: 'النماذج' }).click();
  await page.getByTestId('open-add-provider').click();
  const dialog = page.getByTestId('add-provider-dialog');
  await dialog.getByTestId('add-preset').click();
  await page.getByRole('option', { name: 'OpenAI', exact: true }).click();
  await dialog.getByTestId('add-api-key').fill('sk-e2e-voice-0123456789');
  await dialog.getByTestId('add-submit').click();
  await expect(dialog).toHaveCount(0);

  await page.locator('[data-tab-id="stt_providers"]').click();
  await expect(page.getByTestId('speech-ready-stt')).toHaveText('غير جاهز');
  await choose(page, 'stt', 'OpenAI — speech to text');
  await page.getByTestId('speech-card-stt').screenshot({
    path: path.join(shots, 'models-speech-stt-ar-light.png'),
  });
  await choose(page, 'tts', 'OpenAI — text to speech');
  await expect(page.getByTestId('speech-voice-tts')).toHaveValue('alloy');
  // OpenAI has no voice list endpoint: its documented voices, labelled as such (§92).
  await expect(page.getByTestId('speech-voices-documented')).toBeVisible();
  await page.getByTestId('speech-card-tts').screenshot({
    path: path.join(shots, 'models-speech-tts-ar-light.png'),
  });

  // ------------------------------------------------ dictation into the composer
  await page.goto('/new');
  const mic = page.getByTestId('composer-mic');
  await expect(mic).toBeEnabled();
  await mic.click();
  await expect(mic).toHaveAttribute('data-phase', 'recording');
  await expect(page.getByTestId('dictation-status')).toContainText('أستمع');
  await page.waitForTimeout(700);
  const transcription = page.waitForRequest(
    (request) =>
      request.url().endsWith('/api/v1/models/speech/transcriptions') && request.method() === 'POST',
  );
  await mic.click();
  const sent = await transcription;
  expect(sent.headers()['content-type']).toContain('multipart/form-data');
  await expect(page.getByTestId('composer-input')).toHaveValue('لخّص اجتماع اليوم');
  // Dictation never sends by itself: the words wait for the person.
  await expect(mic).toHaveAttribute('data-phase', 'idle');
  await expect(page).toHaveURL(/\/new$/);

  await page.getByTestId('send').click();
  await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}(\?profile=[a-z0-9-]+)?$/);

  // ------------------------------------------------ read a reply aloud
  const speak = page.getByTestId('message-speak').last();
  await expect(speak).toBeVisible({ timeout: 20_000 });
  const spoken = page.waitForRequest(
    (request) =>
      request.url().endsWith('/api/v1/models/speech/speech') && request.method() === 'POST',
  );
  await speak.hover();
  await speak.click();
  const body = (await spoken).postDataJSON() as { text: string; language: string | null };
  expect(body.text).toContain('مرحبا');
  expect(body.language).toBe('ar');
  // The code block of the scripted reply is announced, not recited — in some chunk.
  const texts = [body.text];
  if (!texts.join(' ').includes('كتلة كود')) {
    const next = await page.waitForRequest((request) =>
      request.url().endsWith('/api/v1/models/speech/speech'),
    );
    texts.push((next.postDataJSON() as { text: string }).text);
  }
  expect(texts.join(' ')).toContain('كتلة كود');
  expect(texts.join(' ')).not.toContain('const answer');
  await expect(page.getByTestId('message-speak-error')).toHaveCount(0);
  await expect(speak).toHaveAttribute('data-phase', 'idle', { timeout: 15_000 });

  // ------------------------------------------------ voice mode, once round
  await page.getByTestId('composer-voice').click();
  await page.getByRole('menuitem', { name: 'الوضع الصوتي' }).click();
  const stage = page.getByTestId('voice-stage');
  await expect(stage).toBeVisible();
  await expect(stage).toContainText('دورًا بدور');
  const state = page.getByTestId('voice-stage-state');
  await expect(state).toHaveText('اضغط لتتكلم');
  const orb = page.getByTestId('voice-orb');
  await orb.click();
  await expect(state).toContainText('أستمع');
  await page.waitForTimeout(700);
  await stage.screenshot({ path: path.join(shots, 'voice-stage-ar-light.png') });
  await orb.click();
  await expect(page.getByTestId('voice-heard')).toContainText('لخّص اجتماع اليوم');
  // Round again: the reply is spoken and the stage listens once more.
  await expect(page.getByTestId('voice-reply')).toContainText('مرحبا', { timeout: 20_000 });
  await expect(state).toContainText('أستمع', { timeout: 20_000 });
  await page.getByTestId('voice-close').click();
  await expect(stage).toHaveCount(0);
});
