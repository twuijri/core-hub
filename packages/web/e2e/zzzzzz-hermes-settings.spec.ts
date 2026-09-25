/**
 * Journey 45: Hermes's own settings, from its Settings page (contract decision §56) — against the
 * real hub, whose Hermes home is a folder of the e2e data directory:
 *
 * - the page draws Hermes's sections with each field's help and Hermes's default, in Arabic;
 * - «أقصى عدد للدورات في التشغيل» set to 60 is saved and the page says it applies from the next
 *   message; the HTTPS proxy is saved and the page says Hermes takes it after a restart;
 * - after a reload both are still there — read back from Hermes's own `config.yaml` and `.env`
 *   (which file holds which is the server's tests, `hermes-settings.routes.test.ts`).
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

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

test("45. Hermes's settings: max turns and the proxy saved to Hermes's files and read back after a reload", async ({
  page,
}) => {
  await login(page);
  await page.getByTestId('rail').getByRole('link', { name: 'الوكلاء' }).click();
  const hermes = page.locator('[data-testid="agent-card"][data-agent-slug="hermes"]');
  // The e2e hub reaches Hermes over the network (no `hermes` beside it), so its card has no
  // Settings button; the page is the agent's own, beside its Memory page.
  const memory = await hermes.getByRole('link', { name: /الذاكرة/ }).getAttribute('href');
  await page.goto(memory!.replace(/\/memory$/, '/settings'));
  await expect(page).toHaveURL(/\/agents\/[^/]+\/settings$/);

  // ---- Hermes's sections, each field with its help and Hermes's default.
  const agent = page.getByTestId('settings-section-agent');
  await expect(agent).toContainText('أقصى عدد للدورات في التشغيل');
  await expect(agent).toContainText('الافتراضي في هرمز: ٥٠٠ في محادثات كور هب');
  await expect(page.getByTestId('settings-section-memory')).toContainText(
    'الافتراضي في هرمز: 2200',
  );
  await expect(page.getByTestId('section-note-network')).toContainText('لهرمز وحده');
  await expect(page.getByTestId('pending-writes')).toContainText('لا شيء بانتظار المراجعة');
  await shot(page, 'hermes-settings-ar-light');

  // ---- Max turns: saved, applies from the next message.
  await page.getByTestId('field-max_turns').fill('60');
  await page.getByTestId('save-agent').click();
  await expect(page.getByTestId('saved-agent')).toContainText('من الرسالة التالية');

  // ---- The proxy: saved to the profile's .env, applies after a restart.
  await page.getByTestId('field-https_proxy').fill('http://proxy.corehub.test:3128');
  await page.getByTestId('field-no_proxy').fill('localhost,127.0.0.1');
  await page.getByTestId('save-network').click();
  await expect(page.getByTestId('saved-network')).toContainText('بعد إعادة تشغيله');

  // ---- A reload reads them back from Hermes's files.
  await page.reload();
  await expect(page.getByTestId('field-max_turns')).toHaveValue('60');
  await expect(page.getByTestId('field-https_proxy')).toHaveValue('http://proxy.corehub.test:3128');
  await expect(page.getByTestId('field-no_proxy')).toHaveValue('localhost,127.0.0.1');
});
