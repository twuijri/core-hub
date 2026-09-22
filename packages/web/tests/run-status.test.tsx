/**
 * The thinking indicator.
 *
 * Owner decision, 2026-09-22: **never a spinner with no elapsed time.** A spinner cannot
 * tell a person whether the agent is thinking or stuck; the seconds can. So the rule under
 * test is not "an indicator appears" but "the indicator always carries a count, and the
 * count moves".
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n/context.js';
import { RunStatus } from '../src/chat/RunStatus.js';
import type { RunProgress } from '../src/chat/turns.js';

const progress = (partial: Partial<RunProgress> = {}): RunProgress => ({
  runId: 'r1',
  startedAtMs: Date.now(),
  step: null,
  stepIsIdentifier: false,
  queued: false,
  ...partial,
});

function mount(value: RunProgress, language: 'ar' | 'en' = 'en') {
  return render(
    <I18nProvider language={language}>
      <RunStatus progress={value} />
    </I18nProvider>,
  );
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('the live run indicator', () => {
  it('says the word and shows a count from the very first frame', () => {
    mount(progress());
    expect(screen.getByTestId('run-status')).toHaveTextContent('Thinking');
    expect(screen.getByTestId('run-elapsed')).toHaveTextContent('0s');
  });

  it('counts up once a second', () => {
    mount(progress({ startedAtMs: Date.now() }));
    act(() => void vi.advanceTimersByTime(3_000));
    expect(screen.getByTestId('run-elapsed')).toHaveTextContent('3s');
    act(() => void vi.advanceTimersByTime(9_000));
    expect(screen.getByTestId('run-elapsed')).toHaveTextContent('12s');
  });

  it('counts from when the hub says the run started, not from when this screen opened', () => {
    // Opening a chat on a run that has been going for a minute must show the minute.
    mount(progress({ startedAtMs: Date.now() - 65_000 }));
    expect(screen.getByTestId('run-elapsed')).toHaveTextContent('65s');
  });

  it('still counts when the hub has not timed the run yet (a queued one)', () => {
    mount(progress({ startedAtMs: null, queued: true }));
    expect(screen.getByTestId('run-status')).toHaveTextContent('Queued');
    act(() => void vi.advanceTimersByTime(2_000));
    expect(screen.getByTestId('run-elapsed')).toHaveTextContent('2s');
  });

  it('names the step the agent reports, and sets an identifier in the mono face', () => {
    mount(progress({ step: 'shell', stepIsIdentifier: true }));
    const step = screen.getByTestId('run-step');
    expect(step).toHaveTextContent('shell');
    expect(step).toHaveAttribute('data-mono', 'true');
  });

  it('shows no step line at all when the agent reports none', () => {
    mount(progress());
    expect(screen.queryByTestId('run-step')).toBeNull();
  });

  it('speaks Arabic, and keeps the count out of the live region', () => {
    mount(progress(), 'ar');
    expect(screen.getByTestId('run-status')).toHaveTextContent('يفكّر');
    // The seconds must not be announced once a second; they are written, not spoken.
    expect(screen.getByTestId('run-elapsed')).toHaveAttribute('aria-hidden', 'true');
    // The word itself is the live region, so a screen reader hears the state once.
    expect(screen.getByRole('status')).toHaveTextContent('يفكّر');
  });
});
