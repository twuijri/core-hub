/**
 * Browser notifications, end to end against the real hub (DECISIONS §66): Settings →
 * Notifications → «تفعيل إشعارات المتصفح», then «إرسال إشعار تجريبي», and the notice arrives —
 * encrypted to this browser's key and signed with the hub's VAPID key — at a push service.
 *
 * The push service is a fake in this test process (`fakePushService`, the one the server tests
 * use): a real browser's push service is Google's or Mozilla's, which a test cannot reach. The
 * browser's own half is real — the permission, the service worker at /push-sw.js, the page's
 * code — except `PushManager.subscribe`, which is pointed at the fake instead of Google.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startFakePushService } from '../../server/src/modules/devices/testing/fake-push.js';

const PASSWORD = 'e2e-owner-password';
const shots = process.env.COREHUB_SHOTS ?? path.resolve('e2e/shots');
mkdirSync(shots, { recursive: true });

test.use({ viewport: { width: 1440, height: 900 } });

async function login(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('اسم المستخدم').fill('admin');
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/chat$/);
}

test('a browser turns notifications on, and a test notice is pushed to it', async ({ page }) => {
  const service = await startFakePushService();
  try {
    const { subscription } = service.subscribe('e2e-browser');
    await page.addInitScript((sub) => {
      // The permission prompt is the browser's; the answer here is "allow".
      Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
      Notification.requestPermission = async () => 'granted';
      let current: unknown = null;
      PushManager.prototype.getSubscription = async () => current as PushSubscription | null;
      PushManager.prototype.subscribe = async (options?: PushSubscriptionOptionsInit) => {
        current = {
          endpoint: sub.endpoint,
          options: { userVisibleOnly: true, applicationServerKey: options?.applicationServerKey },
          unsubscribe: async () => {
            current = null;
            return true;
          },
          toJSON: () => sub,
        };
        return current as PushSubscription;
      };
    }, subscription);

    await login(page);
    await page.goto('/settings/notifications');
    const section = page.getByTestId('browser-push');
    await expect(section).toHaveAttribute('data-state', 'off');
    await section.getByTestId('browser-push-enable').click();
    await expect(section).toHaveAttribute('data-state', 'on');
    // The service worker that shows a push is the hub's own file, served from the root.
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await navigator.serviceWorker.getRegistration('/push-sw.js'))?.active?.scriptURL ??
            (await navigator.serviceWorker.getRegistration('/push-sw.js'))?.installing?.scriptURL ??
            null,
        ),
      )
      .toMatch(/\/push-sw\.js$/);

    await section.getByTestId('send-test-notice').click();
    await expect(section).toContainText('أُرسل');
    await expect.poll(() => service.received.length).toBe(1);
    const [pushed] = service.received;
    expect(pushed!.vapid).toMatchObject({ aud: new URL(subscription.endpoint).origin });
    expect(pushed!.payload).toMatchObject({
      type: 'notice',
      kind: 'system',
      title: 'إشعار تجريبي',
    });
    await section.screenshot({ path: path.join(shots, 'browser-push-ar-light.png') });

    // Signing out ends the registration with its sign-in (the hub forgets it); signing in again
    // hands the same subscription back without asking anything (browserPush.ts). Both on this
    // page: a reload would lose the played subscription.
    await page.getByRole('button', { name: 'تسجيل الخروج' }).click();
    await expect(page).toHaveURL(/\/login$/);
    const resumed = page.waitForResponse(
      (response) =>
        /\/api\/v1\/devices\/[^/]+\/push$/.test(new URL(response.url()).pathname) &&
        response.request().method() === 'PUT',
    );
    await page.getByLabel('اسم المستخدم').fill('admin');
    await page.getByLabel('كلمة المرور').fill(PASSWORD);
    await page.getByRole('button', { name: 'دخول' }).click();
    // Back where it signed out from.
    await expect(page).toHaveURL(/\/settings\/notifications$/);
    expect((await resumed).status()).toBe(200);
    await expect(section).toHaveAttribute('data-state', 'on');
    await section.getByTestId('send-test-notice').click();
    await expect(section).toContainText('أُرسل');
    await expect.poll(() => service.received.length).toBe(2);

    // The browser is now one of the person's devices, with push.
    // One page: pairing at the top, the devices as cards below it (no tabs since 2026-09-26).
    await page.goto('/settings/devices');
    await expect(page.getByRole('tab')).toHaveCount(0);
    const row = page.getByTestId('device-row').filter({ hasText: 'هذا المتصفح' });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('device-push')).toContainText('Web Push');
    await expect(row.getByTestId('device-seen')).toContainText('آخر نشاط');
    await expect(page.getByTestId('device-group-browser')).toContainText('المتصفحات');
    // The senders wait folded under the devices; opening them shows one row each.
    await page.getByTestId('push-senders-summary').click();
    await expect(page.getByTestId('push-sender-webpush')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByTestId('push-sender-fcm')).toHaveAttribute(
      'data-state',
      'not_configured',
    );
    await page.getByTestId('devices-panel').screenshot({
      path: path.join(shots, 'devices-ar-light.png'),
    });

    // Revoking it stops the pushes.
    await row.getByTestId('device-revoke').click();
    await page.getByTestId('confirm-dialog').getByRole('button', { name: 'إزالة' }).click();
    await expect(row).toHaveCount(0);
  } finally {
    await service.close();
  }
});
