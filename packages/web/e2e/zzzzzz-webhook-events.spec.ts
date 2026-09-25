/**
 * Webhooks receive the hub's events (2026-09-25, contract decision §53), against the real
 * hub: a webhook subscribed to "An agent run finished" is added from Settings, a scripted
 * chat runs, and the delivery arrives at a receiver started by this test — signed with the
 * secret the page showed, without the message text — and is listed as delivered with the
 * endpoint's 200.
 *
 * Runs after the other journeys (`zzzzzz-`); the webhook it adds is deleted at the end.
 */
import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'e2e-owner-password';

async function login(page: Page) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('اسم المستخدم').fill('admin');
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/chat$/);
}

async function openWebhooks(page: Page) {
  await page.getByRole('link', { name: 'الإعدادات' }).first().click();
  await page
    .getByTestId('settings-nav')
    .getByRole('link', { name: 'خطافات الويب', exact: true })
    .click();
  await expect(page.getByTestId('webhooks-tab')).toBeVisible();
}

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

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
  return { server, url: `http://127.0.0.1:${port}/events`, received };
}

test('webhooks: a scripted chat’s "run finished" reaches the receiver, signed, and is listed as delivered', async ({
  page,
}) => {
  const endpoint = await receiver();
  try {
    await login(page);
    await openWebhooks(page);
    // The page says the hub sends events now, not only the test.
    await expect(page.getByTestId('webhooks-forwarding-note')).toContainText('فور وقوعه');

    await page.getByTestId('add-webhook').click();
    const dialog = page.getByTestId('webhook-dialog');
    await dialog.getByTestId('webhook-name').fill('أحداث المحادثات');
    await dialog.getByTestId('webhook-url-input').fill(endpoint.url);
    await dialog.getByRole('checkbox', { name: /^انتهى تشغيل وكيل/ }).click();
    // The defaults a new webhook starts with: every profile, no message text, five retries.
    await expect(dialog.getByRole('radio', { name: 'كل بروفايل أستطيع دخوله' })).toBeChecked();
    await expect(dialog.getByRole('switch', { name: /تضمين نص الرسائل/ })).not.toBeChecked();
    await expect(dialog.getByTestId('webhook-max-retries')).toHaveValue('5');
    await dialog.getByRole('switch', { name: /السماح بعنوان خاص/ }).click();
    await dialog.getByTestId('save-webhook').click();

    const secretDialog = page.getByTestId('webhook-secret-dialog');
    const secret = await secretDialog.getByTestId('webhook-secret-value').inputValue();
    await secretDialog.getByTestId('webhook-secret-done').click();
    const card = page.getByTestId('webhook-card').filter({ hasText: 'أحداث المحادثات' });
    await expect(card.getByTestId('webhook-profiles')).toHaveText('كل البروفايلات');

    // A chat, answered by the scripted agent.
    await page.goto('/new');
    await expect(page).toHaveURL(/\/new$/);
    await expect(async () => {
      await page.getByTestId('composer-input').fill('مرحبا، ما الجديد؟');
      await expect(page.getByTestId('send')).toBeEnabled({ timeout: 1_000 });
    }).toPass();
    await page.getByTestId('send').click();
    await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}(\?profile=[a-z0-9-]+)?$/);

    // It arrives on its own, signed with the secret the page showed.
    await expect.poll(() => endpoint.received.length, { timeout: 20_000 }).toBeGreaterThan(0);
    const arrived = endpoint.received[0]!;
    expect(arrived.headers['x-corehub-event']).toBe('run.completed');
    expect(arrived.headers['x-corehub-signature']).toBe(
      `sha256=${createHmac('sha256', secret).update(arrived.body).digest('hex')}`,
    );
    const body = JSON.parse(arrived.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      event: 'run.completed',
      content_included: false,
      data: { run: { status: 'succeeded' } },
    });
    // No message text unless the webhook asks for it.
    expect(arrived.body).not.toContain('مبثوث من المشغّل');

    // The deliveries say the same: the event, delivered, one attempt, 200, nothing pending.
    await openWebhooks(page);
    const listed = page.getByTestId('webhook-card').filter({ hasText: 'أحداث المحادثات' });
    await listed.getByTestId('webhook-deliveries-toggle').click();
    const row = listed
      .getByTestId('webhook-deliveries')
      .getByRole('row')
      .filter({ hasText: 'run.completed' });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('delivery-status')).toHaveText('سُلِّم');
    await expect(row.getByTestId('delivery-attempts')).toHaveText('1');
    await expect(row.getByTestId('delivery-code')).toHaveText('200');
    await expect(row.getByTestId('delivery-redeliver')).toHaveCount(0);
    await expect(listed.getByTestId('webhook-stats')).toContainText('سُلِّم 1');

    await listed.getByTestId('webhook-delete').click();
    await page.getByTestId('confirm-yes').click();
    await expect(
      page.getByTestId('webhook-card').filter({ hasText: 'أحداث المحادثات' }),
    ).toHaveCount(0);
  } finally {
    await new Promise((resolve) => endpoint.server.close(resolve));
  }
});
