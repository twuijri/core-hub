/**
 * Driving our own controls from a test.
 *
 * Since the UI policy (docs/clients/DESIGN.md) there are no native `<select>` elements, so
 * `userEvent.selectOptions` no longer applies: a select is a button that opens a listbox in
 * a portal. These helpers do what a person does — open it, then choose a row.
 *
 * Opening is done from the keyboard on purpose: jsdom stops dispatching a usable
 * `pointerdown` after the first `userEvent` interaction in a file, so a mouse open is
 * flaky there. The mouse path is covered by the Playwright journeys; the keyboard path has
 * to work anyway.
 */
import { screen, within } from '@testing-library/react';

/**
 * Both shapes of user-event: the direct API (`userEvent.click(...)`) and an instance from
 * `userEvent.setup()`. Only the two methods these helpers use are required.
 */
interface User {
  keyboard(text: string): Promise<unknown>;
  click(element: Element): Promise<unknown>;
}

/** Open a Radix-backed trigger (select, menu, popover). */
export async function openControl(user: User, trigger: HTMLElement): Promise<void> {
  trigger.focus();
  await user.keyboard('{Enter}');
}

/** The labels a control currently offers, in order. */
export async function optionLabels(user: User, trigger: HTMLElement): Promise<string[]> {
  await openControl(user, trigger);
  const options = await screen.findAllByRole('option');
  return options.map((option) => option.textContent ?? '');
}

/** Open a control and choose the row whose text matches. */
export async function chooseOption(
  user: User,
  trigger: HTMLElement,
  label: string | RegExp,
): Promise<void> {
  await openControl(user, trigger);
  const listbox = await screen.findByRole('listbox');
  await user.click(within(listbox).getByRole('option', { name: label }));
}

/** Escape, for a control a test opened only to read. */
export async function closeControl(user: User): Promise<void> {
  await user.keyboard('{Escape}');
}
