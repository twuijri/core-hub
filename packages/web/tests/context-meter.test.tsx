// The context meter beside the composer (decision §52): which count it shows and how it says
// where the count came from, the details and the Compress button it opens to, and the
// progress the chat shows while the agent compresses.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompressionStatus, ContextRing, contextUse } from '../src/chat/ContextRing.js';
import { initialChat, reduce, type Compression } from '../src/chat/transcript.js';
import { I18nProvider } from '../src/i18n/context.js';
import type { Envelope } from '../src/realtime/envelope.js';
import type { Run } from '../src/types.js';

const S = '01J8QK3ZR2W7M5N4P6T8V9X0YA';
let seq = 0;
const env = (event: string, payload: Record<string, unknown>): Envelope => ({
  event,
  namespace: '/rt/sessions',
  profile: 'default',
  ts: '2026-09-25T10:00:00Z',
  seq: ++seq,
  payload,
});
const lastRun = (input: number, output: number) =>
  ({
    r1: {
      id: 'r1',
      started_at: '2026-09-25T09:00:00Z',
      usage: { input_tokens: input, output_tokens: output },
    },
  }) as unknown as Record<string, Run>;

afterEach(cleanup);

describe('which count the meter shows', () => {
  it('prefers the window the agent reported, and says whether it counted roughly', () => {
    expect(
      contextUse(lastRun(90_000, 1_000), 128_000, { used_tokens: 20_000, window_tokens: 200_000 }),
    ).toEqual({ used: 20_000, window: 200_000, ratio: 0.1, source: 'reported' });
    expect(
      contextUse({}, null, { used_tokens: 50_000, window_tokens: 100_000, estimated: true }),
    ).toMatchObject({ ratio: 0.5, source: 'agent_estimate' });
    // A count with no window of its own borrows the catalogue's.
    expect(contextUse({}, 100_000, { used_tokens: 25_000, window_tokens: null })).toMatchObject({
      window: 100_000,
      source: 'reported',
    });
  });

  it('falls back to its own estimate from the last turn, labelled so', () => {
    expect(contextUse(lastRun(30_000, 2_000), 128_000, null)).toEqual({
      used: 32_000,
      window: 128_000,
      ratio: 0.25,
      source: 'estimate',
    });
  });
});

function renderRing(props: Parameters<typeof ContextRing>[0], language: 'ar' | 'en' = 'en') {
  return render(
    <I18nProvider language={language}>
      <ContextRing {...props} />
    </I18nProvider>,
  );
}

async function openDetails(user: ReturnType<typeof userEvent.setup>) {
  const ring = screen.getByTestId('context-ring');
  ring.focus();
  await user.keyboard('{Enter}');
  return screen.findByTestId('context-details');
}

describe('the meter', () => {
  it('opens to the details, says an estimate is one, and compresses from there', async () => {
    const user = userEvent.setup();
    const onCompress = vi.fn(async () => {});
    renderRing({
      use: { used: 96_000, window: 128_000, ratio: 0.75, source: 'estimate' },
      onCompress,
    });
    const ring = screen.getByTestId('context-ring');
    expect(ring).toHaveAttribute('data-tone', 'warning');
    expect(ring.getAttribute('aria-label')).toMatch(/estimate/i);
    const details = await openDetails(user);
    expect(details).toHaveTextContent('75% full');
    expect(details).toHaveTextContent('96,000 of 128,000 tokens');
    expect(screen.getByTestId('context-source')).toHaveTextContent(/^Estimate:/);
    await user.click(screen.getByTestId('context-compress'));
    expect(onCompress).toHaveBeenCalledTimes(1);
  });

  it('while a run is in flight the button says why it waits; an agent without it has none', async () => {
    const user = userEvent.setup();
    renderRing({
      use: { used: 10, window: 100, ratio: 0.1, source: 'reported' },
      onCompress: vi.fn(async () => {}),
      compressBlocked: 'Wait for the running turn to finish, then compress.',
    });
    await openDetails(user);
    expect(screen.getByTestId('context-compress')).toBeDisabled();
    expect(screen.getByTestId('context-source')).toHaveTextContent(/reported/);
    cleanup();
    renderRing({ use: { used: 10, window: 100, ratio: 0.1, source: 'reported' } });
    await openDetails(user);
    expect(screen.queryByTestId('context-compress')).not.toBeInTheDocument();
  });

  it('shows the last compression, and its failure, with the agent’s own words', async () => {
    const user = userEvent.setup();
    const done: Compression = {
      phase: 'finished',
      trigger: 'manual',
      beforeTokens: 118_400,
      afterTokens: 21_900,
      message: 'Compressed: 64 → 9 messages',
    };
    renderRing({
      use: { used: 21_900, window: 200_000, ratio: 0.1, source: 'reported' },
      compression: done,
    });
    await openDetails(user);
    const last = screen.getByTestId('context-last-compression');
    expect(last).toHaveTextContent('about 118,400 → 21,900 tokens');
    expect(last).toHaveTextContent('Compressed: 64 → 9 messages');
  });

  it('speaks Arabic', async () => {
    const user = userEvent.setup();
    renderRing(
      {
        use: { used: 500, window: 1000, ratio: 0.5, source: 'reported' },
        onCompress: vi.fn(async () => {}),
      },
      'ar',
    );
    await openDetails(user);
    expect(screen.getByText('نافذة السياق')).toBeInTheDocument();
    expect(screen.getByTestId('context-compress')).toHaveTextContent('اضغط الآن');
  });
});

describe('compression in the chat', () => {
  it('follows context.compression: running, then the outcome', () => {
    let state = reduce(
      initialChat(),
      env('context.compression', {
        session_id: S,
        run_id: null,
        phase: 'started',
        trigger: 'auto',
        before_tokens: null,
        after_tokens: null,
        message: null,
      }),
      S,
    );
    expect(state.compression).toMatchObject({ phase: 'running', trigger: 'auto' });
    render(
      <I18nProvider language="en">
        <CompressionStatus compression={state.compression} />
      </I18nProvider>,
    );
    expect(screen.getByTestId('compression-status')).toHaveTextContent(/compressing the context/i);

    state = reduce(
      state,
      env('context.compression', {
        session_id: S,
        run_id: null,
        phase: 'finished',
        trigger: 'auto',
        before_tokens: 100,
        after_tokens: 40,
        message: null,
      }),
      S,
    );
    expect(state.compression).toEqual({
      phase: 'finished',
      trigger: 'auto',
      beforeTokens: 100,
      afterTokens: 40,
      message: null,
    });
    state = reduce(
      state,
      env('context.updated', {
        session_id: S,
        context: { used_tokens: 40, window_tokens: 1000 },
        usage: null,
      }),
      S,
    );
    expect(state.context).toEqual({ used_tokens: 40, window_tokens: 1000 });
  });

  it('shows nothing when no compression is running', async () => {
    render(
      <I18nProvider language="en">
        <CompressionStatus compression={null} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.queryByTestId('compression-status')).not.toBeInTheDocument());
  });
});
