// A coding agent's failed run says what is wrong and where to fix it (owner, 2026-09-29):
// Goose with no provider set ended in a bare "Internal error", Claude Code in "Authentication
// required". Our sentence names the agent, the action goes where the hub can fix it, and the
// agent's own words stay underneath.
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { RunFailureNotice, agentHelp } from '../src/chat/RunFailureNotice.js';
import { I18nProvider } from '../src/i18n/context.js';
import { translate } from '../src/i18n/index.js';
import type { Agent } from '../src/types.js';

afterEach(cleanup);

const agent = (slug: string, name: string, extra: Partial<Agent> = {}) =>
  ({
    id: `01J8QK3ZR2W7M5N4P6T8V9X0${slug.slice(0, 2).toUpperCase()}`,
    slug,
    name,
    kind: 'acp',
    install: { source: 'managed' },
    ...extra,
  }) as unknown as Agent;

function show(language: 'ar' | 'en', a: Agent, error: string, code = 'agent_error') {
  render(
    <MemoryRouter>
      <I18nProvider language={language}>
        <RunFailureNotice failure={{ code, error }} agent={a} />
      </I18nProvider>
    </MemoryRouter>,
  );
}

const GOOSE_ERROR =
  'Internal error — ERROR goose: No provider configured. Run goose configure first';

describe('a coding agent’s failed run', () => {
  it.each(['ar', 'en'] as const)('Goose with no provider: its config files, in %s', (language) => {
    const goose = agent('goose', 'Goose');
    show(language, goose, GOOSE_ERROR);
    expect(screen.getByTestId('run-failed-reason').textContent).toBe(
      translate(language, 'chat.agent_help.goose_provider', { name: 'Goose' }),
    );
    const action = screen.getByTestId('run-failed-action');
    expect(action.getAttribute('href')).toBe(`/agents/${goose.id}/config-files`);
    expect(screen.getByTestId('run-failed-detail').textContent).toContain(GOOSE_ERROR);
  });

  it('Claude Code asking for authentication: Models, with its words kept', () => {
    show('en', agent('claude-code', 'Claude Code'), 'Authentication required');
    expect(screen.getByTestId('run-failed-reason').textContent).toContain('Claude Code needs');
    expect(screen.getByTestId('run-failed-action').getAttribute('href')).toBe('/settings/models');
    expect(screen.getByTestId('run-failed-detail').textContent).toContain(
      'Authentication required',
    );
  });

  it('an agent with its own account sign-in is sent to it', () => {
    const kimi = agent('kimi-code', 'Kimi Code', {
      install: { source: 'managed', sign_in: true } as Agent['install'],
    });
    show('en', kimi, 'Unauthorized: please log in');
    expect(screen.getByTestId('run-failed-action').getAttribute('href')).toBe(
      `/agents/${kimi.id}/settings`,
    );
  });

  it('a card that says credentials are missing gets the guidance whatever the words', () => {
    expect(
      agentHelp(agent('codex', 'Codex', { credentials: 'missing' }), {
        code: 'agent_error',
        error: 'Internal error',
      }),
    ).toEqual({ key: 'codex_auth', action: 'models' });
  });

  it('leaves Hermes, and failures it does not recognise, as they were', () => {
    expect(
      agentHelp(agent('hermes', 'Hermes', { kind: 'hermes' }), {
        code: 'agent_error',
        error: 'Authentication required',
      }),
    ).toBeNull();
    expect(
      agentHelp(agent('codex', 'Codex', { credentials: 'ready' }), {
        code: 'agent_error',
        error: 'the model returned nothing',
      }),
    ).toBeNull();
    show('en', agent('codex', 'Codex'), 'the model returned nothing');
    expect(screen.queryByTestId('run-failed-agent-help')).toBeNull();
  });
});
