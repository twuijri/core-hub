// The searchable picker itself (src/ui/Combobox.tsx): the field keeps the focus, the
// arrows move a highlight, hundreds of rows stay a handful of elements, and every state
// the list can be in says something.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n/context.js';
import { Combobox, type ComboboxOption } from '../src/ui/Combobox.js';
import { stubListViewport } from './helpers/ui.js';

const CATALOGUE: ComboboxOption[] = [
  {
    value: 'anthropic/claude-opus-4-6-thinking',
    label: 'Claude Opus 4.6 (thinking)',
    detail: 'anthropic/claude-opus-4-6-thinking',
    group: 'anthropic',
  },
  {
    value: 'anthropic/claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5',
    detail: 'anthropic/claude-sonnet-4-5',
    group: 'anthropic',
  },
  { value: 'openai/gpt-5', label: 'GPT-5', detail: 'openai/gpt-5', group: 'openai' },
];

/** 500 rows across ten providers, the shape an OpenRouter catalogue arrives in. */
function synthetic(count: number): ComboboxOption[] {
  return Array.from({ length: count }, (_, i) => {
    const provider = `provider-${String(i % 10).padStart(2, '0')}`;
    return {
      value: `${provider}/model-${i}`,
      label: `Model ${i}`,
      detail: `${provider}/model-${i}`,
      group: provider,
    };
  });
}

let undoViewport: (() => void) | null = null;

function renderBox(
  props: Partial<Parameters<typeof Combobox>[0]> = {},
  language: 'ar' | 'en' = 'en',
) {
  undoViewport = stubListViewport();
  const onChange = vi.fn();
  render(
    <I18nProvider language={language}>
      <Combobox
        value={null}
        onChange={onChange}
        options={CATALOGUE}
        label="Model"
        placeholder="Default model"
        testId="picker"
        {...props}
      />
    </I18nProvider>,
  );
  return onChange;
}

const openBox = async (user: ReturnType<typeof userEvent.setup>) => {
  const trigger = screen.getByTestId('picker');
  trigger.focus();
  await user.keyboard('{Enter}');
  return screen.findByTestId('combobox-field');
};
const rows = () => screen.queryAllByTestId('combobox-option');
const activeRow = () => rows().find((row) => row.getAttribute('data-active') === 'true');

afterEach(() => {
  undoViewport?.();
  undoViewport = null;
  cleanup();
});

describe('the searchable picker', () => {
  it('shows the chosen model on the trigger, with its provider beneath', () => {
    renderBox({ value: 'openai/gpt-5' });
    const trigger = screen.getByTestId('picker');
    expect(trigger).toHaveTextContent('GPT-5');
    expect(trigger).toHaveTextContent('openai');
  });

  it('opens with the field focused, and typing never takes the focus away', async () => {
    const user = userEvent.setup();
    renderBox();
    const field = await openBox(user);
    await waitFor(() => expect(document.activeElement).toBe(field));
    await user.keyboard('opus');
    expect(document.activeElement).toBe(field);
    // The highlight moves, the focus does not.
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(field);
    expect(field).toHaveAttribute('aria-activedescendant');
  });

  it('filters by the id as well as the name, and highlights what matched', async () => {
    const user = userEvent.setup();
    renderBox();
    const field = await openBox(user);
    await user.type(field, 'opus');
    await waitFor(() => expect(rows()).toHaveLength(1));
    const row = rows()[0] as HTMLElement;
    expect(row).toHaveTextContent('Claude Opus 4.6 (thinking)');
    expect(within(row).getAllByText('opus', { exact: false }).length).toBeGreaterThan(0);
    expect(row.querySelectorAll('mark').length).toBeGreaterThan(0);
  });

  it('walks with the arrows, jumps with Home and End, and picks with Enter', async () => {
    const user = userEvent.setup();
    const onChange = renderBox();
    await openBox(user);
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    await user.keyboard('{ArrowDown}');
    const second = activeRow()?.textContent;
    await user.keyboard('{Home}');
    expect(activeRow()?.textContent).not.toBe(second);
    await user.keyboard('{End}');
    expect(activeRow()).toHaveTextContent('GPT-5');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('openai/gpt-5');
    // Choosing closes it.
    await waitFor(() => expect(screen.queryByTestId('combobox-field')).toBeNull());
  });

  it('Escape closes it and gives the focus back to the trigger', async () => {
    const user = userEvent.setup();
    const onChange = renderBox();
    await openBox(user);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('combobox-field')).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId('picker'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('groups by provider with a sticky header once more than one is in scope', async () => {
    const user = userEvent.setup();
    renderBox();
    await openBox(user);
    await waitFor(() => expect(screen.getByTestId('combobox-sticky')).toBeTruthy());
    expect(screen.getByTestId('combobox-sticky')).toHaveTextContent('anthropic');
  });

  it('keeps 500 rows to a handful of elements, and still finds one of them', async () => {
    const user = userEvent.setup();
    const onChange = renderBox({ options: synthetic(500) });
    const field = await openBox(user);
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    // Virtualized: a fraction of 500 is in the DOM, not 500.
    expect(rows().length).toBeLessThan(40);
    expect(screen.getByTestId('combobox-list')).toBeTruthy();

    await user.type(field, 'model-499');
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('provider-09/model-499');
  });

  it('says so when the query matches nothing, instead of showing an empty box', async () => {
    const user = userEvent.setup();
    renderBox();
    const field = await openBox(user);
    await user.type(field, 'zzzz');
    expect(await screen.findByTestId('combobox-empty')).toHaveTextContent('zzzz');
    expect(rows()).toHaveLength(0);
  });

  it('says so when there is nothing to list at all', async () => {
    const user = userEvent.setup();
    renderBox({ options: [] });
    await openBox(user);
    expect(await screen.findByTestId('combobox-empty')).toHaveTextContent('No models');
  });

  it('draws the loading, unfetched and error states, and keeps Fetch inside the popup', async () => {
    const user = userEvent.setup();
    renderBox({ status: 'loading' });
    await openBox(user);
    expect(await screen.findByTestId('combobox-loading')).toBeTruthy();
    cleanup();

    const onFetch = vi.fn();
    renderBox({
      status: 'unfetched',
      fetchAction: { label: 'Fetch', onSelect: onFetch },
    });
    await openBox(user);
    expect(await screen.findByTestId('combobox-unfetched')).toHaveTextContent('Fetch the list');
    await user.click(screen.getByTestId('combobox-fetch'));
    expect(onFetch).toHaveBeenCalledOnce();
    cleanup();

    // The provider's own words, not ours.
    renderBox({ status: 'error', errorMessage: 'Connection refused at 127.0.0.1:1234' });
    await openBox(user);
    expect(await screen.findByTestId('combobox-error')).toHaveTextContent(
      'Connection refused at 127.0.0.1:1234',
    );
  });

  it('lists the recently chosen first, under their own header', async () => {
    const user = userEvent.setup();
    renderBox({ recent: ['openai/gpt-5'] });
    await openBox(user);
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    expect(rows()[0]).toHaveTextContent('GPT-5');
    expect(screen.getByTestId('combobox-sticky')).toHaveTextContent('Recent');
  });

  it('reads right to left in Arabic, with the id kept left to right', async () => {
    const user = userEvent.setup();
    renderBox({}, 'ar');
    await openBox(user);
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    expect(screen.getByTestId('combobox-field')).toHaveAttribute('placeholder', 'ابحث…');
    // A Latin id inside an Arabic page is isolated, not re-directed: its characters keep
    // their order while the line stays on the page's own edge, beside the name.
    const id = (rows()[0] as HTMLElement).querySelector('.ch-combo-sub');
    expect(id).not.toHaveAttribute('dir');
    expect(id).toHaveClass('ch-combo-sub');
  });
});
