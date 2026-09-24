/**
 * Journey 29: after WhatsApp is linked (the owner's report of 2026-09-24, «سويت رستارت وراسلته
 * ولا رد»), the Channels page says it is linked and to whom, how to use it, and who is waiting
 * for approval — against the real hub with Hermes's pairing scripted on its own files
 * (`e2e/hub.ts`):
 *
 * - the WhatsApp row reads «مربوط» with the account, Unlink instead of Pair by QR, and the plain
 *   steps — message the number from another account, approve the first request here — with the
 *   warning about a personal number;
 * - «طلبات بانتظار الموافقة» lists two senders; one is approved and moves to the approved list,
 *   the other is turned down; the approved one is revoked behind a confirm;
 * - Unlink, behind a confirm, forgets the phone and brings Pair by QR back.
 *
 * It runs after journey 23 (`zz-agent-tools`), which links WhatsApp; run on its own, it links
 * it first.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';
const shots = process.env.MAJLIS_SHOTS ?? path.resolve('e2e/shots');
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

test('29. a linked WhatsApp: how to use it, the senders waiting for approval, and Unlink', async ({
  page,
}) => {
  await login(page);
  await openChannels(page);

  const linkBadge = page.getByTestId('channel-link-whatsapp');
  // The list has loaded once the approvals section is drawn below it.
  await expect(page.getByTestId('pairing-section')).toBeVisible();
  if (
    !(await page
      .getByTestId('channel-unlink-whatsapp')
      .isVisible()
      .catch(() => false))
  ) {
    // Run on its own: link it the way journey 23 does.
    await page.getByTestId('channel-pair-whatsapp').click();
    await expect(page.getByTestId('channel-pair-done')).toContainText('مكتب المجلس', {
      timeout: 30_000,
    });
    await page.getByTestId('channel-pair').getByRole('button', { name: 'إغلاق' }).first().click();
  }

  // ---- Linked, and to whom; how to use it, in plain words.
  await expect(linkBadge).toHaveText('مربوط');
  await expect(page.getByTestId('channel-account-whatsapp')).toContainText('مكتب المجلس');
  await expect(page.getByTestId('channel-account-whatsapp')).toContainText('+966500000000');
  await expect(page.getByTestId('channel-login-whatsapp')).toHaveCount(0);
  await expect(page.getByTestId('channel-pair-whatsapp')).toHaveCount(0);
  const how = page.getByTestId('channel-how-to-use');
  await expect(how).toContainText('من حساب واتساب آخر');
  await expect(how).toContainText('طلبات بانتظار الموافقة');
  await expect(page.getByTestId('channel-personal-warning')).toContainText('رقمك الشخصي');

  // ---- Who is waiting.
  const section = page.getByTestId('pairing-section');
  await expect(section.getByRole('heading', { name: 'طلبات بانتظار الموافقة' })).toBeVisible();
  const sara = page.getByTestId('pairing-request-3f9a1c0e7b2d4a55');
  await expect(sara).toContainText('سارة');
  await expect(sara).toContainText('966500000001@s.whatsapp.net');
  await expect(sara).toContainText('whatsapp');
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

  // ---- Unlink, behind a confirm; Pair by QR comes back.
  await page.getByTestId('channel-unlink-whatsapp').click();
  await expect(page.getByTestId('confirm-dialog')).toContainText('الأجهزة المرتبطة');
  await page.getByTestId('confirm-yes').click();
  await expect(linkBadge).toHaveText('غير مربوط');
  await expect(page.getByTestId('channel-login-whatsapp')).toBeVisible();
  await expect(page.getByTestId('channel-pair-whatsapp')).toBeVisible();
  await expect(page.getByTestId('channel-how-to-use')).toHaveCount(0);
  await shot(page, 'agent-channels-unlinked-ar-light');
});
