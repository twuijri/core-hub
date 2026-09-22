/**
 * The chat header's agent control (owner decision, 2026-09-22; contract decision §26).
 *
 * It replaces the chip row once a conversation has turns, so what it must get right is
 * not "does it render a name" but the gesture behind it: choosing another agent **forks**
 * — one `POST /sessions/{id}/fork` carrying `agent_id`, and the fork is what opens. The
 * original is the hub's business and is asserted there (`sessions-api.test.ts`); what is
 * asserted here is that the client asks for a fork at all, instead of patching the agent
 * of a conversation that has already happened.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { openControl } from './helpers/ui.js';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { SessionAgent } from '../src/chat/SessionAgent.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import type { Agent } from '../src/types.js';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  };
}

function agent(id: string, name: string, over: Partial<Agent> = {}): Agent {
  return {
    id,
    profile: 'default',
    owner_id: '01J8QK3ZR2W7M5N4P6T8V9X0HM',
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    slug: name.toLowerCase(),
    name,
    status: 'available',
    enabled: true,
    ...(over as Record<string, unknown>),
  } as unknown as Agent;
}

const HERMES = '01J8QK3ZR2W7M5N4P6T8V9X0AG';
const CODEX = '01J8QK3ZR2W7M5N4P6T8V9X0CX';
const GEMINI = '01J8QK3ZR2W7M5N4P6T8V9X0GM';
const SESSION = '01J8QK3ZR2W7M5N4P6T8V9X0YA';
const FORK = '01J8QK3ZR2W7M5N4P6T8V9X0YC';

interface Call {
  url: string;
  body: unknown;
}

function Where() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

function renderControl(agents: Agent[]) {
  const calls: Call[] = [];
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
  });
  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input);
    if (url.includes('/fork')) {
      calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as unknown });
      return Promise.resolve(
        new Response(JSON.stringify({ id: FORK, agent_id: CODEX }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    const body = url.includes('/agents') ? { items: agents } : { items: [] };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };
  render(
    <ThemeProvider>
      <I18nProvider language="en">
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <MemoryRouter initialEntries={[`/chat/${SESSION}`]}>
              <Routes>
                <Route
                  path="/chat/:sessionId"
                  element={
                    <>
                      <SessionAgent sessionId={SESSION} agentId={HERMES} />
                      <Where />
                    </>
                  }
                />
                <Route path="*" element={<Where />} />
              </Routes>
            </MemoryRouter>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
  return calls;
}

afterEach(cleanup);

describe('the chat header says which agent, and changing it forks', () => {
  it('names the session’s own agent', async () => {
    renderControl([agent(HERMES, 'Hermes'), agent(CODEX, 'Codex')]);
    const control = await screen.findByTestId('session-agent');
    expect(control).toHaveAttribute('data-agent-id', HERMES);
    expect(control.textContent).toContain('Hermes');
  });

  it('offers only the other installed agents, and explains what choosing one does', async () => {
    const user = userEvent.setup();
    renderControl([
      agent(HERMES, 'Hermes'),
      agent(CODEX, 'Codex'),
      agent(GEMINI, 'Gemini CLI', { status: 'not_installed' }),
    ]);
    await openControl(user, await screen.findByTestId('session-agent'));
    const offers = await screen.findAllByTestId('continue-with');
    expect(offers.map((node) => node.getAttribute('data-agent-id'))).toEqual([CODEX]);
    // The one line that keeps this apart from the composer's model selector.
    expect(screen.getByTestId('session-agent-menu').textContent).toContain(
      'copies this conversation',
    );
  });

  it('forks to the chosen agent and opens the fork, leaving the original behind', async () => {
    const user = userEvent.setup();
    const calls = renderControl([agent(HERMES, 'Hermes'), agent(CODEX, 'Codex')]);
    await openControl(user, await screen.findByTestId('session-agent'));
    const offer = await screen.findByTestId('continue-with');
    await user.click(offer.closest('[role="menuitem"]') as HTMLElement);

    await waitFor(() => expect(calls).toHaveLength(1));
    // A fork of *this* session, carrying the new agent — never a patch of `agent_id`.
    expect(calls[0]!.url).toContain(`/sessions/${SESSION}/fork`);
    expect(calls[0]!.body).toEqual({ agent_id: CODEX });
    // And the fork is what the person is now looking at.
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe(`/chat/${FORK}`));
  });

  it('says so when it is the only agent installed, instead of an empty menu', async () => {
    const user = userEvent.setup();
    renderControl([agent(HERMES, 'Hermes')]);
    await openControl(user, await screen.findByTestId('session-agent'));
    await waitFor(() =>
      expect(screen.getByTestId('session-agent-menu').textContent).toContain(
        'No other agent is installed',
      ),
    );
    expect(screen.queryAllByTestId('continue-with')).toHaveLength(0);
  });
});
