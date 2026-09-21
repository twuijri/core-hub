import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ApprovalCard, decisionsFor } from '../src/chat/ApprovalCard.js';
import { I18nProvider } from '../src/i18n/context.js';
import type { Approval } from '../src/types.js';

const approval = (over: Partial<Approval>): Approval =>
  ({
    id: '01J8QK3ZR2W7M5N4P6T8V9X0AP',
    profile: 'default',
    owner_id: 'u',
    created_at: 't',
    updated_at: 't',
    kind: 'tool_call',
    status: 'pending',
    session_id: 's',
    run_id: 'r',
    message_id: 'm',
    room_id: null,
    workflow_run_id: null,
    node_id: null,
    agent: { id: 'a', name: 'Hermes' },
    title: 'تنفيذ أمر',
    description: null,
    command: 'pnpm test',
    choices: [],
    allow_always: true,
    answer_mode: 'choice',
    response: null,
    expires_at: null,
    ...over,
  }) as Approval;

function memory(): Storage {
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

describe('ApprovalCard', () => {
  it('offers always only when the hub allows it', () => {
    expect(decisionsFor({ allow_always: true }).map((d) => d.id)).toEqual([
      'once',
      'session',
      'always',
      'deny',
    ]);
    expect(decisionsFor({ allow_always: false }).map((d) => d.id)).toEqual([
      'once',
      'session',
      'deny',
    ]);
  });

  it('posts the decision through sessions.respondApproval', async () => {
    const bodies: unknown[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      bodies.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({}), { status: 200 });
    };
    const store = new SessionStore(memory());
    store.save({
      profile: 'default',
      token: 't',
      refresh_token: null,
      expires_at: null,
      user: { id: 'u', username: 'a', display_name: 'A', role: 'owner' },
    });
    render(
      <I18nProvider language="ar">
        <QueryClientProvider client={new QueryClient()}>
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <ApprovalCard approval={approval({})} />
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>,
    );
    expect(screen.getByText('تنفيذ أمر')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('approve-session'));
    await waitFor(() => expect(bodies).toHaveLength(1));
    const id = '01J8QK3ZR2W7M5N4P6T8V9X0AP';
    expect(bodies[0]).toEqual({
      url: `http://hub.test/api/v1/approvals/${id}/respond`,
      body: { decision: 'approve_session', answer: null },
    });
  });
});
