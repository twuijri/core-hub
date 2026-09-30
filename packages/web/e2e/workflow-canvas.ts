/**
 * The workflow editor's canvas as the journeys drive it (like n8n since 2026-09-29): a step is
 * added from "Add step" (or a "+") and opens in its own dialog; a step, a connection or a
 * trigger opens with a click, or with Enter once focused; "Run by hand" is a trigger node whose
 * dialog holds the run's input and a Run button.
 */
import { expect, type Page } from '@playwright/test';

/** Closes the step, connection or trigger dialog open over the canvas, if there is one. */
export async function closeDialog(page: Page) {
  const done = page.getByTestId('workflow-dialog-done');
  if ((await done.count()) === 0) return;
  await done.click();
  await expect(done).toHaveCount(0);
}

/** Adds a step from the canvas's "Add step" list; its dialog opens on it. */
export async function addStep(page: Page, kind: string) {
  await closeDialog(page);
  await page.getByTestId('workflow-add-step').click();
  await page.getByTestId(`workflow-pick-${kind}`).click();
  await expect(page.getByTestId('workflow-node-dialog')).toBeVisible();
}

/** Opens a step in its dialog — with the keyboard, which reaches a step scrolled out of view. */
export async function openStep(page: Page, id: string) {
  await closeDialog(page);
  // The drawing, not a run: a run's canvas has the same steps and opens nothing.
  await expect(page.getByTestId('workflow-run-view')).toHaveCount(0);
  await page
    .getByTestId('workflow-canvas')
    .locator(`[data-testid="workflow-node"][data-node-id="${id}"]`)
    .focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('workflow-panel')).toHaveAttribute('data-node-id', id);
}

/** Connects a step to the one titled `to` on success, from the step's dialog. */
export async function connect(page: Page, from: string, to: string) {
  await openStep(page, from);
  await page.getByTestId('workflow-connect-target').click();
  await page.getByRole('option', { name: to, exact: true }).click();
  await page.getByTestId('workflow-connect').click();
  await closeDialog(page);
}

/** Runs the workflow by hand from its "Run by hand" trigger, with this input. */
export async function runByHand(page: Page, input: string) {
  await closeDialog(page);
  await expect(page.getByTestId('workflow-run-view')).toHaveCount(0);
  await page
    .getByTestId('workflow-canvas')
    .locator('[data-testid="workflow-trigger-node"][data-trigger-kind="manual"]')
    .focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('workflow-run-input').fill(input);
  await page.getByTestId('workflow-manual-run').click();
}
