/**
 * The fence around each part of the workflow editor (2026-09-29): an error while drawing one
 * part closes that part only, says what happened, and offers it again — the page next to it
 * stays. Before it, "Use the last run's values" once left the whole page white.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n/context.js';
import { PanelBoundary } from '../src/schedules/workflows/PanelBoundary.js';

afterEach(cleanup);

let broken = true;
function Fragile({ label }: { label: string }) {
  if (broken) throw new Error(`cannot read properties of undefined (reading '${label}')`);
  return <p data-testid="fragile">{label}</p>;
}

function page(resetKey: string) {
  return (
    <I18nProvider language="en">
      <p data-testid="beside">The canvas</p>
      <PanelBoundary resetKey={resetKey}>
        <Fragile label="values" />
      </PanelBoundary>
    </I18nProvider>
  );
}

describe('PanelBoundary', () => {
  it('closes only the part that failed, says why, and shows it again on request or another step', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    broken = true;
    const { rerender } = render(page('notify_1'));
    expect(screen.getByTestId('beside')).toHaveTextContent('The canvas');
    expect(screen.getByTestId('workflow-panel-failed')).toHaveTextContent(
      "This part of the editor hit an error and was closed so the rest keeps working: cannot read properties of undefined (reading 'values')",
    );
    expect(quiet).toHaveBeenCalled();

    broken = false;
    fireEvent.click(screen.getByTestId('workflow-panel-failed-retry'));
    expect(screen.getByTestId('fragile')).toHaveTextContent('values');

    broken = true;
    rerender(page('notify_1'));
    // Same step, failing again: closed again, the rest still there.
    expect(screen.getByTestId('workflow-panel-failed')).toBeTruthy();
    expect(screen.getByTestId('beside')).toBeTruthy();
    // Another step selected: tried again.
    broken = false;
    rerender(page('agent_1'));
    expect(screen.getByTestId('fragile')).toBeTruthy();
    quiet.mockRestore();
  });
});
