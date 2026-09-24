/**
 * Every realtime namespace needs a valid token (2026-09-24, realtime auth scope; owner:
 * «ايه صلحها دامها مشكله خطيره»). A person whose access token expired while the page was
 * away must not be left "Offline": the hub refuses the old token, the page gets a new one,
 * the sockets come back with it, and a chat still streams.
 *
 * The reload happens inside Settings, where nothing but the provider holds the footer's
 * socket — a conversation list would reconnect it on its own when the token changes.
 *
 * It runs last (`zzz-`): it adds a session to the shared hub, and smoke.spec.ts counts the
 * rows in the session list. It takes no screenshots.
 */
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

/** The stored session: localStorage key and its JSON. */
const stored = (page: Page) =>
  page.evaluate(() => {
    const key = Object.keys(localStorage).find((name) => name.endsWith('.session'))!;
    return { key, value: JSON.parse(localStorage.getItem(key)!) as Record<string, unknown> };
  });

const connection = (page: Page, name: string) => page.getByRole('status', { name, exact: true });

test('23. an access token that expired while away: the sockets take a new one, chats still stream', async ({
  page,
  request,
}) => {
  await login(page);
  const back = page.getByTestId('back-to-chats');
  if ((await back.count()) > 0) await back.click();
  await page.getByRole('link', { name: 'محادثة جديدة' }).first().click();
  await page.getByTestId('composer-input').fill('مرحبا قبل انتهاء المفتاح');
  await page.getByTestId('send').click();
  await expect(page).toHaveURL(/\/chat\/[0-9A-Z]{26}$/);
  const chatUrl = page.url();
  await expect(page.getByTestId('message-assistant').last()).toHaveAttribute(
    'data-status',
    'complete',
  );
  await page.getByRole('link', { name: 'الإعدادات' }).click();
  await expect(page.getByTestId('back-to-chats')).toBeVisible();

  // The page wakes up holding a token that has expired, and still believes it is good.
  const before = await stored(page);
  const res = await request.post('/__e2e/expire-token', { data: { token: before.value.token } });
  expect(res.ok()).toBeTruthy();
  const { token: expired } = (await res.json()) as { token: string };
  await page.evaluate(
    ([key, value]) => localStorage.setItem(key as string, JSON.stringify(value)),
    [
      before.key,
      {
        ...before.value,
        token: expired,
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    ] as const,
  );

  // Hold the page's HTTP back for a moment, so its own refresh cannot come first: the
  // sockets meet the hub with the expired token and are refused ("Offline").
  let held = true;
  await page.route('**/api/v1/**', async (route) => {
    while (held) await new Promise((resolve) => setTimeout(resolve, 50));
    await route.continue();
  });
  await page.reload();
  await expect(connection(page, 'غير متصل')).toBeVisible();
  held = false;

  // The page gets a new token and the sockets come back with it, with nothing clicked.
  await expect(connection(page, 'متصل')).toBeVisible({ timeout: 15_000 });
  expect((await stored(page)).value.token).not.toBe(expired);

  // And the conversation still streams on the socket that came back.
  await page.getByTestId('back-to-chats').click();
  await expect(page).toHaveURL(chatUrl);
  const replies = page.getByTestId('message-assistant');
  await expect(replies).toHaveCount(1);
  await page.getByTestId('composer-input').fill('وبعد تجديد المفتاح؟');
  await page.getByTestId('send').click();
  await expect(replies).toHaveCount(2);
  await expect(replies.last()).toContainText('مرحبا');
  await expect(replies.last()).toHaveAttribute('data-status', 'complete');
  await expect(connection(page, 'متصل')).toBeVisible();
});
