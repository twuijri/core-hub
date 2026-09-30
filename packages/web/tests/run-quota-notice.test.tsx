// A turn whose provider ran out of quota (the model gateway, ADR 0029; owner, 2026-09-30): the
// provider's and the model's names as people know them, in the person's language, and the
// conversation's model picker one click away — never the agent's "API Error: 429 {…}" with the
// hub's internal provider id in it.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunFailureNotice, failuresByMessage, quotaOf } from '../src/chat/RunFailureNotice.js';
import { I18nProvider } from '../src/i18n/context.js';
import { translate } from '../src/i18n/index.js';
import type { Message, Run } from '../src/types.js';

afterEach(cleanup);

const FAILURE = {
  code: 'rate_limited',
  error: 'CLI Proxy ran out of quota for Gemini 3.8 Flash High. Pick another model for this chat.',
  details: {
    reason: 'quota_exhausted',
    provider: 'CLI Proxy',
    model: 'Gemini 3.8 Flash High',
    provider_id: '01M3AZKMG9C7CSKQVSW4SBD0MW',
    model_id: 'gemini-3.8-flash-high',
  },
};

describe('a spent quota', () => {
  it.each(['ar', 'en'] as const)('names the provider and the model, in %s', (language) => {
    const pick = vi.fn();
    render(
      <MemoryRouter>
        <I18nProvider language={language}>
          <RunFailureNotice failure={FAILURE} onPickModel={pick} />
        </I18nProvider>
      </MemoryRouter>,
    );
    const reason = screen.getByTestId('run-failed-reason');
    expect(reason.textContent).toBe(
      translate(language, 'chat.quota_exhausted', {
        provider: 'CLI Proxy',
        model: 'Gemini 3.8 Flash High',
      }),
    );
    expect(screen.getByTestId('run-failed-quota').textContent).not.toMatch(/01M3|h01m/i);
    fireEvent.click(screen.getByTestId('run-failed-pick-model'));
    expect(pick).toHaveBeenCalledOnce();
  });

  it('tells no capacity and a passing limit from a spent quota, with the provider’s own words', () => {
    const capacity = {
      ...FAILURE,
      details: {
        ...FAILURE.details,
        reason: 'no_capacity',
        said: 'No capacity available for model gemini-3.8-flash-high on the server (MODEL_CAPACITY_EXHAUSTED)',
      },
    };
    render(
      <MemoryRouter>
        <I18nProvider language="en">
          <RunFailureNotice failure={capacity} />
        </I18nProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('run-failed-reason').textContent).toBe(
      translate('en', 'chat.no_capacity', {
        provider: 'CLI Proxy',
        model: 'Gemini 3.8 Flash High',
      }),
    );
    expect(screen.getByTestId('run-failed-reason').textContent).not.toMatch(/quota/);
    expect(screen.getByTestId('run-failed-detail').textContent).toContain(
      'MODEL_CAPACITY_EXHAUSTED',
    );
    expect(
      quotaOf({ ...FAILURE, details: { ...FAILURE.details, reason: 'rate_limited' } }),
    ).toMatchObject({
      reason: 'rate_limited',
    });
  });

  it('is only what the hub recognised: an older hub’s rate limit keeps its one line', () => {
    expect(quotaOf(FAILURE)).toEqual({
      provider: 'CLI Proxy',
      model: 'Gemini 3.8 Flash High',
      reason: 'quota_exhausted',
      said: null,
    });
    expect(quotaOf({ code: 'rate_limited', error: 'slow down' })).toBeNull();
    expect(quotaOf({ ...FAILURE, code: 'agent_error' })).toBeNull();
  });

  it('is shown even under a reply that carries the agent’s own words for it', () => {
    const reply = {
      id: 'm2',
      role: 'assistant',
      author: { kind: 'agent', id: 'a', name: 'Claude Code', avatar: null },
      content: [{ type: 'text', text: 'API Error: Request rejected (429)' }],
      run_id: 'r1',
    } as unknown as Message;
    const run = {
      id: 'r1',
      status: 'failed',
      error: FAILURE,
      output_message_id: 'm2',
      input_message_id: 'm1',
    } as unknown as Run;
    expect(failuresByMessage([reply], [run]).get('m2')?.failure).toEqual(FAILURE);
  });
});
