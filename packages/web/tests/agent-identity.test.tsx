// An agent is shown by its name and its face, as the phones show it (agents/identity.tsx,
// docs/design/family.md "Agents"): a chat reply's author is only an id and the hub's placeholder
// «agent», so the name comes from the registry; a room seat's own name wins.
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentIdentity, AUTHOR_PLACEHOLDER } from '../src/agents/identity.js';
import { Transcript } from '../src/chat/MessageView.js';
import { turnsOf } from '../src/chat/turns.js';
import { I18nProvider } from '../src/i18n/context.js';
import { PaneProvider } from '../src/shell/pane.js';
import type { Agent, Message } from '../src/types.js';

afterEach(cleanup);

const hermes = {
  id: 'AG-HERMES',
  slug: 'hermes',
  name: 'Hermes',
  avatar: { kind: 'generated', url: null, seed: 'hermes' },
} as unknown as Agent;
const custom = {
  id: 'AG-CUSTOM',
  slug: 'my-agent',
  name: 'Office helper',
  avatar: { kind: 'image', url: '/api/v1/agents/AG-CUSTOM/avatar', seed: null },
} as unknown as Agent;

describe('agentIdentity', () => {
  it('takes the registry name over the hub placeholder «agent»', () => {
    const who = agentIdentity('AG-HERMES', AUTHOR_PLACEHOLDER, [hermes, custom], 'Assistant');
    expect(who).toEqual({
      id: 'AG-HERMES',
      name: 'Hermes',
      slug: 'hermes',
      hasPicture: false,
      known: true,
    });
  });

  it('keeps a room seat’s own name, and knows when the agent has a picture', () => {
    const who = agentIdentity('AG-CUSTOM', 'المراجِع', [hermes, custom], 'Assistant');
    expect(who.name).toBe('المراجِع');
    expect(who.hasPicture).toBe(true);
    expect(who.known).toBe(true);
  });

  it('falls back when the registry does not know the author', () => {
    const who = agentIdentity('AG-GONE', AUTHOR_PLACEHOLDER, [hermes], 'Assistant');
    expect(who).toMatchObject({ name: 'Assistant', slug: null, known: false });
    expect(agentIdentity(null, '', [], 'Assistant').name).toBe('Assistant');
  });
});

describe('a chat reply', () => {
  const reply = {
    id: 'm1',
    role: 'assistant',
    profile: 'default',
    owner_id: 'u1',
    created_at: '2026-09-27T10:00:00Z',
    updated_at: '2026-09-27T10:00:00Z',
    session_id: 's1',
    room_id: null,
    seq: 1,
    author: { kind: 'agent', id: 'AG-HERMES', name: 'agent', avatar: null },
    content: [{ type: 'text', text: 'مرحبا' }],
    reasoning: null,
    tool_calls: [],
    run_id: null,
    status: 'complete',
    mentions: [],
    handoff: null,
    usage: null,
    reply_to_message_id: null,
  } as unknown as Message;

  it('names the agent from the registry and wears its mark — never «agent»', async () => {
    render(
      <I18nProvider language="ar">
        <PaneProvider>
          <Transcript
            turns={turnsOf([reply])}
            showReasoning
            runs={{}}
            identityOf={(message) =>
              agentIdentity(message.author.id, message.author.name, [hermes], 'المساعد')
            }
          />
        </PaneProvider>
      </I18nProvider>,
    );
    const article = screen.getByTestId('message-assistant');
    expect(within(article).getByText('Hermes')).toBeTruthy();
    expect(within(article).queryByText('agent')).toBeNull();
    // The catalog mark stands in for the initial (Radix draws the fallback a tick later).
    const face = within(article).getByTestId('message-agent-face');
    await vi.waitFor(() => expect(face.querySelector('svg')).not.toBeNull());
  });
});
