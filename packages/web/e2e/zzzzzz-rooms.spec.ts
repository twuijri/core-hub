/**
 * Rooms against the real hub (DECISIONS §69): the Rooms segment, a new room with an agent
 * seated, a message into it, the invite code, a second agent added from the members panel,
 * and archiving it.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

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

test.describe('rooms', () => {
  test('makes a room, seats two agents, writes in it and archives it', async ({ page }) => {
    await login(page);
    await page.getByTestId('segments').getByText('الغرف').click();
    await expect(page).toHaveURL(/\/rooms$/);
    await expect(page.getByTestId('rooms-pick')).toBeVisible();

    await page.getByTestId('new-room').click();
    const dialog = page.getByTestId('new-room-dialog');
    await dialog.getByTestId('new-room-name').fill('غرفة التجربة');
    await dialog.locator('[data-testid^="new-room-agent-"]').first().click();
    await dialog.getByTestId('new-room-create').click();
    await expect(page).toHaveURL(/\/rooms\/[0-9A-Z]{26}$/);
    await expect(page.getByTestId('room-title')).toHaveText('غرفة التجربة');
    await expect(page.getByTestId('room-list').getByTestId('room-row')).toContainText([
      'غرفة التجربة',
    ]);
    const seats = page.getByTestId('room-members').getByTestId('room-seat');
    await expect(seats).toHaveCount(1);

    // A second seat of the same agent, under a name of its own.
    await page.getByTestId('room-add-seat').click();
    const seat = page.getByTestId('seat-dialog');
    await seat.getByTestId('seat-name').fill('المراجع');
    await seat.getByTestId('seat-description').fill('يراجع الخطة');
    await seat.getByTestId('seat-save').click();
    await expect(seats).toHaveCount(2);

    // A message to the room, addressed with @ picked from the list.
    const input = page.getByTestId('room-input');
    await input.fill('@المر');
    await expect(page.getByTestId('mention-option')).toHaveText(['@المراجع']);
    await input.press('Enter');
    await expect(input).toHaveValue('@المراجع ');
    await input.pressSequentially('راجع الخطة من فضلك');
    await expect(input).toHaveValue('@المراجع راجع الخطة من فضلك');
    await input.press('Enter');
    await expect(input).toHaveValue('');
    await expect(page.getByTestId('room-message-person').last()).toContainText(
      '@المراجع راجع الخطة من فضلك',
    );

    // The invite code is the manager's to see.
    await page.getByTestId('room-invite').click();
    await expect(page.getByTestId('room-invite-code')).toHaveText(/^[A-Z2-9]{8}$/);
    await page.screenshot({ path: path.join(shots, 'rooms-invite-ar-light.png') });
    await page.keyboard.press('Escape');

    await page.screenshot({ path: path.join(shots, 'rooms-room-ar-light.png') });

    // Archived: listed apart, and the composer says why it is closed.
    await page.getByTestId('room-menu-trigger').click();
    await page.getByRole('menuitem', { name: 'أرشفة' }).click();
    await expect(page.getByTestId('room-input')).toBeDisabled();
    await page.getByTestId('room-filter').getByText('المؤرشفة').click();
    await expect(page.getByTestId('room-list').getByTestId('room-row')).toContainText([
      'غرفة التجربة',
    ]);
  });

  test('an agent mentioned in the room answers and hands the next step to another', async ({
    page,
  }) => {
    await login(page);
    await page.getByTestId('segments').getByText('الغرف').click();
    await page.getByTestId('new-room').click();
    const dialog = page.getByTestId('new-room-dialog');
    await dialog.getByTestId('new-room-name').fill('غرفة الفريق');
    await dialog.getByTestId('new-room-create').click();
    await expect(page.getByTestId('room-title')).toHaveText('غرفة الفريق');

    // Two scripted agents, each with a name and a role of its own.
    for (const [name, role] of [
      ['المخطِّط', 'يضع الخطة'],
      ['المبرمج', 'ينفّذ الخطوات'],
    ]) {
      await page.getByTestId('room-add-seat').click();
      const seat = page.getByTestId('seat-dialog');
      await seat.getByTestId('seat-name').fill(name!);
      await seat.getByTestId('seat-description').fill(role!);
      await seat.getByTestId('seat-save').click();
      await expect(seat).toHaveCount(0);
    }
    await expect(page.getByTestId('room-members').getByTestId('room-seat')).toHaveCount(2);

    const input = page.getByTestId('room-input');
    await input.fill('@المخ');
    await input.press('Enter');
    await input.pressSequentially('ضع خطة للصفحة الرئيسية');
    await input.press('Enter');

    // The planner is seen working, then its reply streams in and passes the turn.
    await expect(page.getByTestId('room-activity-seat').first()).toContainText('المخطِّط');
    const planner = page.getByTestId('room-message-agent').first();
    await expect(planner).toContainText('الخطة: ثلاث خطوات');
    await page.screenshot({ path: path.join(shots, 'rooms-streaming-ar-light.png') });
    await expect(planner).toContainText('@المبرمج ابدأ بالخطوة الأولى.');
    await expect(planner.getByTestId('room-handoff-note')).toContainText('@المبرمج');

    // The coder takes the turn, works with a tool, and answers.
    const coder = page.getByTestId('room-message-agent').nth(1);
    await expect(coder).toContainText('أنهيت الخطوة الأولى: الواجهة جاهزة.');
    await expect(coder).toHaveAttribute('data-status', 'complete');
    await expect(page.getByTestId('room-activity')).toHaveCount(0);
    await page.screenshot({ path: path.join(shots, 'rooms-handoff-ar-light.png') });

    // The room's summary, written now on request, is what the agents are told next time.
    const memory = page.getByTestId('room-memory');
    await expect(memory.getByTestId('room-memory-text')).toContainText('لا ملخّص بعد');
    await memory.getByTestId('room-memory-refresh').click();
    await expect(memory.getByTestId('room-memory-text')).not.toContainText('لا ملخّص بعد');
  });
});
