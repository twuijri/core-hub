/**
 * Journey 30: after WhatsApp is linked (the owner's report of 2026-09-24, «سويت رستارت وراسلته
 * ولا رد»), the Channels page says it is linked and to whom, how to use it, and who is waiting
 * for approval — against the real hub with Hermes's pairing scripted on its own files
 * (`e2e/hub.ts`):
 *
 * - the WhatsApp row reads «مربوط» with the account, its mode («بوت»), Unlink instead of Pair by
 *   QR, and the plain steps — message the number from another account, approve the first request
 *   under «الموافقات» — with the warning about a personal number;
 * - «الموافقات» in the header counts two senders and opens the panel: one is approved and moves
 *   to the approved senders, the other is denied; the approved one is removed behind a confirm;
 * - «تغيير الوضع» switches the number to «أنا (مراسلة نفسي)», and the card says to write to the
 *   agent in "Message yourself";
 * - Unlink, behind a confirm, forgets the phone and the row leaves the list.
 *
 * It runs after journey 23 (`zz-agent-tools`), which links WhatsApp; run on its own, it links
 * it first.
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

async function openChannels(page: Page) {
  await page.getByTestId('rail').getByRole('link', { name: 'الوكلاء' }).click();
  await page.getByTestId('agent-menu').getByRole('link', { name: 'القنوات' }).first().click();
  await expect(page).toHaveURL(/\/channels$/);
}

test('30. a linked WhatsApp: how to use it, the senders waiting for approval, and Unlink', async ({
  page,
}) => {
  await login(page);
  await openChannels(page);

  const linkBadge = page.getByTestId('channel-link-whatsapp');
  // The page has loaded once «ربط منصة» is drawn (over the list, or in the empty state).
  await expect(page.getByTestId('platform-picker-open')).toBeVisible();
  if (
    !(await page
      .getByTestId('channel-unlink-whatsapp')
      .isVisible()
      .catch(() => false))
  ) {
    // Run on its own: link it the way journey 23 does.
    await page.getByTestId('platform-picker-open').click();
    await page.getByTestId('platform-option-whatsapp').click();
    await page.getByTestId('channel-pair-mode-choice').getByRole('radio').first().click();
    await page.getByTestId('channel-pair-continue').click();
    await expect(page.getByTestId('channel-pair-done')).toContainText('مكتب المركز', {
      timeout: 30_000,
    });
    await page.getByTestId('channel-pair').getByRole('button', { name: 'إغلاق' }).first().click();
  }

  // ---- Linked, and to whom; how to use it, in plain words.
  await expect(linkBadge).toHaveText('مربوط');
  await expect(page.getByTestId('channel-account-whatsapp')).toContainText('مكتب المركز');
  await expect(page.getByTestId('channel-account-whatsapp')).toContainText('+966500000000');
  await expect(page.getByTestId('channel-login-whatsapp')).toHaveCount(0);
  await expect(page.getByTestId('channel-pair-whatsapp')).toHaveCount(0);
  // How to use it, in WhatsApp's own card while somebody waits.
  const how = page.getByTestId('channel-list').getByTestId('channel-how-to-use');
  await expect(how).toContainText('من حساب واتساب آخر');
  await expect(how).toContainText('الموافقات');
  await expect(page.getByTestId('channel-personal-warning')).toContainText('رقمك الشخصي');
  await expect(page.getByTestId('channel-mode-whatsapp')).toHaveAttribute('data-mode', 'bot');

  // ---- Who is waiting: one button in the header, not a list under the cards.
  await expect(page.getByTestId('pairing-section')).toHaveCount(0);
  const approvals = page.getByTestId('approvals-open');
  await expect(approvals).toHaveAttribute('data-count', '2', { timeout: 15_000 });
  await expect(page.getByTestId('channel-waiting-whatsapp')).toBeVisible();
  await approvals.click();
  const section = page.getByTestId('approvals-sheet').getByTestId('pairing-section');
  await expect(section.getByRole('heading', { name: 'طلبات بانتظار الموافقة' })).toBeVisible();
  const sara = page.getByTestId('pairing-request-3f9a1c0e7b2d4a55');
  await expect(sara).toContainText('سارة');
  await expect(sara).toContainText('966500000001@s.whatsapp.net');
  await expect(sara).toContainText('واتساب');
  await expect(page.getByTestId('pairing-request-8c21d0f4a9e3b716')).toContainText('بلا اسم');
  await shot(page, 'agent-channels-pairing-ar-light');

  await page.getByTestId('pairing-approve-3f9a1c0e7b2d4a55').click();
  await expect(sara).toHaveCount(0);
  await expect(page.getByTestId('pairing-approved')).toContainText('سارة');

  await page.getByTestId('pairing-deny-8c21d0f4a9e3b716').click();
  await expect(page.getByTestId('pairing-none')).toBeVisible();

  await page.getByTestId('pairing-revoke-966500000001@s.whatsapp.net').click();
  await page.getByTestId('confirm-yes').click();
  await expect(page.getByTestId('pairing-approved-none')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('approvals-sheet')).toHaveCount(0);

  // ---- «أنا (مراسلة نفسي)»: the person's own number, written to in "Message yourself".
  await page.getByTestId('channel-mode-change-whatsapp').click();
  const modeDialog = page.getByTestId('channel-mode-dialog');
  await modeDialog.getByRole('radio').nth(1).click();
  await modeDialog.getByTestId('channel-mode-save').click();
  await expect(modeDialog).toHaveCount(0);
  await expect(page.getByTestId('channel-mode-whatsapp')).toHaveAttribute('data-mode', 'self-chat');
  // Nobody is approved any more, so the card's steps are open by themselves.
  await expect(page.getByTestId('channel-how-to-use')).toContainText('مراسلة نفسي');
  await expect(page.getByTestId('channel-personal-warning')).toHaveCount(0);
  await shot(page, 'agent-channels-self-chat-ar-light');

  // ---- Unlink, behind a confirm; the row leaves the list.
  await page.getByTestId('channel-unlink-whatsapp').click();
  await expect(page.getByTestId('confirm-dialog')).toContainText('الأجهزة المرتبطة');
  await page.getByTestId('confirm-yes').click();
  await expect(page.getByTestId('channel-unlinked')).toContainText('الأجهزة المرتبطة');
  await expect(linkBadge).toHaveCount(0);
  await expect(page.getByTestId('channel-how-to-use')).toHaveCount(0);
  await expect(page.getByTestId('platform-picker-open')).toBeVisible();
  await shot(page, 'agent-channels-unlinked-ar-light');
});
