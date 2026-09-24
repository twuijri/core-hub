// The one segmented control (src/ui/Segmented.tsx): what it announces, how it reads from
// the keyboard, and that the arrows follow the UI language rather than the screen.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n/context.js';
import { Segmented } from '../src/ui/Segmented.js';

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
];

function renderControl(
  props: Partial<Parameters<typeof Segmented>[0]> = {},
  language: 'ar' | 'en' = 'en',
) {
  const onChange = vi.fn();
  render(
    <I18nProvider language={language}>
      <Segmented
        label="Sections"
        value="a"
        onChange={onChange}
        options={OPTIONS}
        testId="control"
        {...props}
      />
    </I18nProvider>,
  );
  return onChange;
}

const buttons = () => [...screen.getByTestId('control').querySelectorAll('button')];
const focused = () => document.activeElement?.textContent;

afterEach(cleanup);

describe('the segmented control', () => {
  it('is one named radio group, with the chosen option marked', () => {
    renderControl();
    const track = screen.getByTestId('control');
    expect(track).toHaveAttribute('role', 'radiogroup');
    expect(track).toHaveAccessibleName('Sections');
    const [alpha, beta, gamma] = buttons();
    expect(alpha).toHaveAttribute('aria-checked', 'true');
    expect(beta).toHaveAttribute('aria-checked', 'false');
    // One tab stop for the whole group — the chosen option — not one per option.
    expect(alpha).toHaveAttribute('tabindex', '0');
    expect(beta).toHaveAttribute('tabindex', '-1');
    expect(gamma).toHaveAttribute('tabindex', '-1');
  });

  it('moves with the arrows and jumps with Home and End', async () => {
    const user = userEvent.setup();
    renderControl();
    buttons()[0]?.focus();
    await user.keyboard('{ArrowRight}');
    expect(focused()).toBe('Beta');
    await user.keyboard('{End}');
    expect(focused()).toBe('Gamma');
    await user.keyboard('{Home}');
    expect(focused()).toBe('Alpha');
    // It does not wrap past the ends: the edges are edges.
    await user.keyboard('{ArrowLeft}');
    expect(focused()).toBe('Alpha');
  });

  it('chooses with Enter, and choosing the same option again does not clear it', async () => {
    const user = userEvent.setup();
    const onChange = renderControl();
    buttons()[1]?.focus();
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('b');
    onChange.mockClear();
    // Radix lets a single-value group be emptied; a segmented control never is.
    buttons()[0]?.focus();
    await user.keyboard('{Enter}');
    expect(onChange).not.toHaveBeenCalledWith('');
  });

  it('follows the UI language: in Arabic, ArrowLeft goes to the next option', async () => {
    const user = userEvent.setup();
    renderControl({}, 'ar');
    expect(screen.getByTestId('control')).toHaveAttribute('dir', 'rtl');
    buttons()[0]?.focus();
    await user.keyboard('{ArrowLeft}');
    expect(focused()).toBe('Beta');
    await user.keyboard('{ArrowRight}');
    expect(focused()).toBe('Alpha');
  });

  it('skips a disabled option instead of trapping the keyboard on it', async () => {
    const user = userEvent.setup();
    renderControl({
      options: [OPTIONS[0]!, { ...OPTIONS[1]!, disabled: true }, OPTIONS[2]!],
    });
    expect(buttons()[1]).toBeDisabled();
    buttons()[0]?.focus();
    await user.keyboard('{ArrowRight}');
    expect(focused()).toBe('Gamma');
  });

  it('carries the size, the stretch and whatever the caller must put on an option', () => {
    renderControl({
      size: 'sm',
      stretch: true,
      options: [{ value: 'a', label: 'Alpha', itemProps: { 'data-testid': 'first' } }],
    });
    expect(screen.getByTestId('control')).toHaveAttribute('data-size', 'sm');
    expect(screen.getByTestId('control')).toHaveAttribute('data-stretch', 'true');
    expect(screen.getByTestId('first')).toBeTruthy();
  });
});

/**
 * Overflow and density in the component itself. jsdom has no layout, so the widths are
 * supplied the way a browser would: `clientWidth` on the track and `offsetWidth` on the
 * measuring row's children. The arithmetic is tested separately in segmented-fit.test.ts;
 * what is tested here is that the control asks, and renders what it is told.
 */
describe('the segmented control: overflow and density', () => {
  /** Every option is 100px with a label and 30px as an icon; More is 70px, "+" is 40. */
  function measure(trackWidth: number) {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('ch-segmented') ? trackWidth : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement) {
        const measured = this.getAttribute('data-measure');
        if (measured === 'comfortable') return 100;
        if (measured === 'compact') return 30;
        if (measured === 'more') return 70;
        if (measured === 'action') return 40;
        return 0;
      },
    });
  }
  afterEach(() => {
    // @ts-expect-error restoring the jsdom defaults
    delete HTMLElement.prototype.clientWidth;
    // @ts-expect-error restoring the jsdom defaults
    delete HTMLElement.prototype.offsetWidth;
  });

  const many = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((name) => ({
    value: name,
    label: name,
    icon: <span aria-hidden>{name[0]}</span>,
  }));

  function renderWide(
    width: number,
    props: Partial<Parameters<typeof Segmented>[0]> = {},
    language: 'ar' | 'en' = 'en',
  ) {
    measure(width);
    const onChange = vi.fn();
    render(
      <I18nProvider language={language}>
        <Segmented
          label="Agents"
          value="alpha"
          onChange={onChange}
          options={many}
          overflow
          testId="control"
          {...props}
        />
      </I18nProvider>,
    );
    return onChange;
  }

  const track = () => screen.getByTestId('control');
  const optionValues = () =>
    [...track().querySelectorAll('[data-segment-item]')]
      .map((el) => el.getAttribute('data-segment-item'))
      .filter((v) => v !== 'more');

  it('is comfortable when the labels fit, with no More', async () => {
    renderWide(1000);
    await waitFor(() => expect(track()).toHaveAttribute('data-density', 'comfortable'));
    expect(optionValues()).toEqual(['alpha', 'beta', 'gamma', 'delta', 'epsilon']);
    expect(screen.queryByTestId('control-more')).toBeNull();
    // Every option still reads as a word.
    expect(track()).toHaveTextContent('epsilon');
  });

  it('goes compact when the labels stop fitting: only the selected keeps its label', async () => {
    renderWide(300);
    await waitFor(() => expect(track()).toHaveAttribute('data-density', 'compact'));
    expect(optionValues()).toHaveLength(5);
    expect(screen.queryByTestId('control-more')).toBeNull();
    const [alpha, beta] = [...track().querySelectorAll('[data-segment-item]')] as HTMLElement[];
    expect(alpha).toHaveAttribute('aria-checked', 'true');
    expect(alpha).toHaveTextContent('alpha');
    // The others are icon-only — and still have a name for the keyboard and the reader.
    expect(beta).toHaveClass('ch-segment-icon-only');
    expect(beta).toHaveAccessibleName('beta');
    expect(beta?.textContent).not.toContain('beta');
  });

  it('falls back to More, and keeps the selected option in the track', async () => {
    renderWide(160, { value: 'epsilon' });
    await waitFor(() => expect(screen.getByTestId('control-more')).toBeTruthy());
    expect(track()).toHaveAttribute('data-density', 'compact');
    // Hoisted: what is active is never out of sight.
    expect(optionValues()).toContain('epsilon');
  });

  it('lists the overflow in the menu, in order, with a check on the current one', async () => {
    const user = userEvent.setup();
    renderWide(160, { value: 'epsilon' });
    const more = await screen.findByTestId('control-more');
    more.focus();
    await user.keyboard('{Enter}');
    const rows = await screen.findAllByRole('menuitemcheckbox');
    const labels = rows.map((row) => row.textContent);
    // Same logical order as the track, and none of them is the one on screen.
    expect(labels).not.toContain('epsilon');
    expect(labels).toEqual(
      [...labels].sort(
        (a, b) => many.findIndex((m) => m.label === a) - many.findIndex((m) => m.label === b),
      ),
    );
  });

  it('the keyboard crosses from the options into More', async () => {
    const user = userEvent.setup();
    renderWide(160, { value: 'alpha' });
    await screen.findByTestId('control-more');
    const items = [...track().querySelectorAll('[data-segment-item]')] as HTMLElement[];
    items[0]?.focus();
    await user.keyboard('{End}');
    expect(document.activeElement).toHaveAttribute('data-segment-item', 'more');
  });

  it('in Arabic the arrows and the overflow follow the same logical order', async () => {
    const user = userEvent.setup();
    renderWide(300, {}, 'ar');
    await waitFor(() => expect(track()).toHaveAttribute('dir', 'rtl'));
    const items = [...track().querySelectorAll('[data-segment-item]')] as HTMLElement[];
    // The DOM order is the logical order; the direction is the browser's business.
    expect(items.map((el) => el.getAttribute('data-segment-item'))).toEqual([
      'alpha',
      'beta',
      'gamma',
      'delta',
      'epsilon',
    ]);
    items[0]?.focus();
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toHaveAttribute('data-segment-item', 'beta');
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toHaveAttribute('data-segment-item', 'alpha');
  });

  it('the trailing action is an action: its own tab stop, after the options', async () => {
    const onAdd = vi.fn();
    renderWide(1000, {
      action: { label: 'Add an agent', icon: <span aria-hidden>+</span>, onSelect: onAdd },
    });
    const add = await screen.findByRole('button', { name: 'Add an agent' });
    // Not a radio, and not part of the group's roving stop.
    expect(add).not.toHaveAttribute('role', 'radio');
    expect(add).not.toHaveAttribute('data-segment-item');
    expect(add).not.toHaveAttribute('tabindex');
    await userEvent.setup().click(add);
    expect(onAdd).toHaveBeenCalledOnce();
  });
});
