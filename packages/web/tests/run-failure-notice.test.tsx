// What the person is told when a run fails with no provider configured: our sentence and
// a way out, in both languages, with the agent's own words still on the page.
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULTS_ROUTE, RunFailureNotice } from '../src/chat/RunFailureNotice.js';
import { I18nProvider } from '../src/i18n/context.js';
import { translate } from '../src/i18n/index.js';

afterEach(cleanup);

/** Hermes's own words, exactly as the owner saw them on 2026-09-22. */
const HERMES_TEXT =
  "⚠️ Provider authentication failed: No inference provider configured. Run 'hermes model' " +
  'to choose a provider and model, or set an API key (OPENROUTER_API_KEY, OPENAI_API_KEY, ' +
  'etc.) in ~/.hermes/.env';

function show(language: 'ar' | 'en', failure: { code: string; error: string }) {
  render(
    <MemoryRouter>
      <I18nProvider language={language}>
        <RunFailureNotice failure={failure} />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe('the run-failure notice', () => {
  it.each(['ar', 'en'] as const)('says what is missing and where to go, in %s', (language) => {
    show(language, { code: 'provider_not_configured', error: HERMES_TEXT });
    const reason = screen.getByTestId('run-failed-reason');
    const other = language === 'ar' ? 'en' : 'ar';
    expect(reason.textContent).toBe(translate(language, 'chat.no_provider'));
    // A real sentence in this language, not the key and not the other language's.
    expect(reason.textContent).not.toBe('chat.no_provider');
    expect(reason.textContent).not.toBe(translate(other, 'chat.no_provider'));

    const action = screen.getByTestId('run-failed-action');
    expect(action.textContent).toBe(translate(language, 'chat.no_provider_action'));
    expect(action.textContent).not.toBe(translate(other, 'chat.no_provider_action'));
    expect(action.getAttribute('href')).toBe(DEFAULTS_ROUTE);
    // The link lands on the Defaults tab by name, not on whichever tab happens to be first.
    expect(DEFAULTS_ROUTE).toContain('tab=auxiliary');
  });

  it('keeps the agent’s own words underneath, whole', () => {
    show('en', { code: 'provider_not_configured', error: HERMES_TEXT });
    expect(screen.getByTestId('run-failed-detail').textContent).toBe(HERMES_TEXT);
  });

  it('leaves every other failure as the one line it always was', () => {
    show('en', { code: 'agent_error', error: 'rate limit exceeded' });
    expect(screen.queryByTestId('run-failed-action')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('rate limit exceeded');
    expect(screen.getByRole('alert').textContent).toContain('agent_error');
  });
});
