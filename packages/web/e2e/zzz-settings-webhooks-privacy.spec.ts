/**
 * The last two Settings pages against the real hub (2026-09-24).
 *
 * 24. Webhooks: the hub refuses a private address until told otherwise, the signing secret
 *     is shown once, and "Send test" really reaches an endpoint — a receiver started by
 *     this test, which checks the signature against the secret the page showed.
 * 25. Privacy: a token that can act as the person is listed, revoked from the page, and
 *     stops working at the hub.
 *
 * It runs after the other files (`zzz-`), because it adds a webhook and an app token to
 * the shared hub; both are gone again by the end of their journey.
 */
import { createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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

async function openSettings(page: Page, name: string) {
  await page.getByRole('link', { name: 'الإعدادات' }).first().click();
  await page.getByTestId('settings-nav').getByRole('link', { name, exact: true }).click();
}

interface Received {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** An endpoint on this machine that records what it is sent and answers 200. */
async function receiver(): Promise<{ server: Server; url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      received.push({ headers: request.headers, body });
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/hook`, received };
}

test('24. Webhooks: a private address needs a yes, the secret shows once, and the test really arrives signed', async ({
  page,
}) => {
  const endpoint = await receiver();
  try {
    await login(page);
    // `this_device` is a desktop and phone page: the web never lists it.
    await page.getByRole('link', { name: 'الإعدادات' }).first().click();
    await expect(
      page.getByTestId('settings-nav').getByRole('link', { name: 'هذا الجهاز' }),
    ).toHaveCount(0);

    await openSettings(page, 'خطافات الويب');
    await expect(page.getByTestId('webhooks-tab')).toBeVisible();
    // Not the placeholder, and it says what the hub does not send yet.
    await expect(page.getByTestId('webhooks-forwarding-note')).toContainText(
      'إلا التسليم التجريبي',
    );
    await expect(page.getByTestId('webhooks-empty')).toBeVisible();

    await page.getByTestId('add-webhook').click();
    const dialog = page.getByTestId('webhook-dialog');
    await dialog.getByTestId('webhook-name').fill('مستقبِل الاختبار');
    await dialog.getByTestId('webhook-url-input').fill(endpoint.url);
    await dialog.getByTestId('webhook-events-filter').fill('run.');
    await dialog.getByRole('checkbox', { name: 'run.completed', exact: true }).click();
    await shot(page, 'webhook-dialog-ar-light');
    await dialog.getByTestId('save-webhook').click();
    // 127.0.0.1 is private: the hub refuses it before storing anything, in words.
    await expect(dialog.getByText(/يشير إلى داخل شبكة خاصة/)).toBeVisible();

    await dialog.getByRole('switch', { name: /السماح بعنوان خاص/ }).click();
    await dialog.getByTestId('save-webhook').click();

    const secretDialog = page.getByTestId('webhook-secret-dialog');
    await expect(secretDialog).toBeVisible();
    const secret = await secretDialog.getByTestId('webhook-secret-value').inputValue();
    expect(secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    await shot(page, 'webhooks-secret-ar-light');
    await secretDialog.getByTestId('webhook-secret-done').click();
    await expect(secretDialog).toHaveCount(0);

    const card = page.getByTestId('webhook-card');
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId('webhook-url')).toHaveText(endpoint.url);
    await expect(card.getByTestId('webhook-signed')).toHaveText('موقَّع');
    // Once: the hub answers `[stored]`, and the page has nowhere left to show it from.
    await expect(page.locator('body')).not.toContainText(secret);

    await card.getByTestId('webhook-test').click();
    await expect(card.getByTestId('webhook-test-outcome')).toHaveText(
      'سُلِّم — أجاب العنوان بـ 200.',
    );
    // What arrived is what the receiver can verify with the secret it was given.
    expect(endpoint.received).toHaveLength(1);
    const arrived = endpoint.received[0]!;
    expect(JSON.parse(arrived.body)).toMatchObject({ event: 'webhook.test' });
    expect(arrived.headers['x-corehub-signature']).toBe(
      `sha256=${createHmac('sha256', secret).update(arrived.body).digest('hex')}`,
    );

    await card.getByTestId('webhook-deliveries-toggle').click();
    const deliveries = card.getByTestId('webhook-deliveries');
    await expect(deliveries).toContainText('webhook.test');
    await expect(deliveries).toContainText('200');
    await expect(card.getByTestId('webhook-stats')).toContainText('سُلِّم 1');
    await shot(page, 'webhooks-ar-light');

    // Off, then gone — the delete asks first.
    await card.getByRole('switch', { name: 'مفعَّل' }).click();
    await expect(card.getByTestId('webhook-state')).toHaveText('موقوف');
    await card.getByTestId('webhook-delete').click();
    await page.getByTestId('confirm-yes').click();
    await expect(page.getByTestId('webhooks-empty')).toBeVisible();
  } finally {
    await new Promise((resolve) => endpoint.server.close(resolve));
  }
});

test('25. Privacy: a token that acts as you is listed, revoked here, and refused at the hub', async ({
  page,
  request,
}) => {
  await login(page);
  const session = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((name) => name.endsWith('.session'))!;
    return JSON.parse(localStorage.getItem(key)!) as { token: string };
  });
  const created = await request.post('/api/v1/auth/app-tokens', {
    headers: { authorization: `Bearer ${session.token}` },
    data: { name: 'سكربت النسخ', scopes: ['read'] },
  });
  expect(created.status()).toBe(201);
  const appToken = ((await created.json()) as { token: string }).token;
  const me = (token: string) =>
    request.get('/api/v1/auth/me', { headers: { authorization: `Bearer ${token}` } });
  expect((await me(appToken)).status()).toBe(200);

  await openSettings(page, 'الخصوصية');
  const table = page.getByTestId('app-token-table');
  await expect(table).toContainText('سكربت النسخ');
  await expect(table).toContainText('رمز تطبيق');
  // One switch, and it is Hermes's own `privacy.redact_pii` (§58), not the hub's stored field.
  await expect(page.getByTestId('privacy-tab').getByRole('switch')).toHaveCount(1);
  await expect(page.getByTestId('privacy-redact')).toContainText('إخفاء المعرّفات');
  await shot(page, 'privacy-ar-light');

  await table
    .getByRole('row', { name: /سكربت النسخ/ })
    .getByTestId('revoke-token')
    .click();
  await page.getByTestId('confirm-yes').click();
  await expect(page.getByTestId('privacy-tab')).not.toContainText('سكربت النسخ');
  // Revoked at the hub, not only hidden on the page.
  expect((await me(appToken)).status()).toBe(401);
});
