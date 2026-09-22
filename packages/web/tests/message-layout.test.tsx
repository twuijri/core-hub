/**
 * The conversation reads as a conversation.
 *
 * Owner decision, 2026-09-22 (docs/clients/DESIGN.md §The conversation): the person is on
 * the right and the agent is on the left, **in every locale**, and consecutive messages
 * from one speaker group under a single name. This checks the rendering keeps that
 * promise in Arabic and in English, and that each message's own text still decides its
 * own direction.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../src/i18n/context.js';
import { PaneProvider } from '../src/shell/pane.js';
import { MessageView, Transcript } from '../src/chat/MessageView.js';
import { turnsOf } from '../src/chat/turns.js';
import type { Language } from '../src/i18n/index.js';
import type { Message, Run } from '../src/types.js';

function message(partial: Partial<Message> & Pick<Message, 'id' | 'role'>): Message {
  return {
    profile: 'default',
    owner_id: 'u1',
    created_at: '2026-09-22T10:00:00Z',
    updated_at: '2026-09-22T10:00:00Z',
    session_id: 's1',
    room_id: null,
    seq: 1,
    author: { kind: 'user', id: null, name: '', avatar: null },
    content: [],
    reasoning: null,
    tool_calls: [],
    run_id: null,
    status: 'complete',
    mentions: [],
    handoff: null,
    usage: null,
    reply_to_message_id: null,
    ...partial,
  } as Message;
}

const user = (id: string, text: string) =>
  message({ id, role: 'user', content: [{ type: 'text', text }] });
const bot = (id: string, text: string, extra: Partial<Message> = {}) =>
  message({
    id,
    role: 'assistant',
    author: { kind: 'agent', id: null, name: 'Hermes', avatar: null },
    content: [{ type: 'text', text }],
    ...extra,
  });

function mount(messages: Message[], language: Language, runs: Record<string, Run> = {}) {
  return render(
    <I18nProvider language={language}>
      <PaneProvider>
        <div className="chat-turns">
          <Transcript turns={turnsOf(messages)} showReasoning runs={runs} />
        </div>
      </PaneProvider>
    </I18nProvider>,
  );
}

afterEach(cleanup);

describe('the two sides of the conversation', () => {
  for (const language of ['ar', 'en'] as const) {
    it(`puts the person on the right and the agent on the left in ${language}`, () => {
      mount([user('u1', 'مرحبا'), bot('a1', 'Hello')], language);
      expect(screen.getByTestId('message-user')).toHaveAttribute('data-side', 'user');
      expect(screen.getByTestId('message-assistant')).toHaveAttribute('data-side', 'agent');
    });
  }

  it('does not let the content language move a message to the other side', () => {
    // An Arabic message from the person and an English one both belong on the right.
    mount([user('u1', 'مرحبا يا صديقي'), user('u2', 'and now in English')], 'en');
    for (const node of screen.getAllByTestId('message-user'))
      expect(node).toHaveAttribute('data-side', 'user');
  });

  it('lets each message decide its own direction', () => {
    mount([user('u1', 'مرحبا')], 'en');
    const bubble = within(screen.getByTestId('message-user')).getByText('مرحبا');
    expect(bubble).toHaveAttribute('dir', 'auto');
  });
});

describe('grouping a turn', () => {
  it('names the agent once and marks the rest as grouped', () => {
    mount([bot('a1', 'first'), bot('a2', 'second')], 'en');
    const [first, second] = screen.getAllByTestId('message-assistant');
    expect(first).toHaveAttribute('data-grouped', 'false');
    expect(second).toHaveAttribute('data-grouped', 'true');
    // The name is drawn once for the whole turn.
    expect(screen.getAllByText('Hermes')).toHaveLength(1);
  });

  it('keeps the grouped message aligned under the first with a reserved gutter', () => {
    const { container } = mount([bot('a1', 'first'), bot('a2', 'second')], 'en');
    expect(container.querySelectorAll('.msg-gutter')).toHaveLength(1);
  });

  it('starts a new turn when the person answers in between', () => {
    mount([bot('a1', 'first'), user('u1', 'thanks'), bot('a2', 'second')], 'en');
    for (const node of screen.getAllByTestId('message-assistant'))
      expect(node).toHaveAttribute('data-grouped', 'false');
  });
});

describe('what a finished turn says about its thinking', () => {
  const runs: Record<string, Run> = {
    r1: {
      profile: 'default',
      owner_id: 'u1',
      id: 'r1',
      created_at: '2026-09-22T10:00:00Z',
      updated_at: '2026-09-22T10:00:12Z',
      session_id: 's1',
      room_id: null,
      seat_id: null,
      job_id: 'j1',
      status: 'succeeded',
      queue_position: null,
      trigger: { kind: 'user', id: null },
      input_message_id: null,
      output_message_id: null,
      model: null,
      provider: null,
      reasoning_effort: null,
      interrupted: false,
      error: null,
      usage: null,
      started_at: '2026-09-22T10:00:00Z',
      finished_at: '2026-09-22T10:00:12Z',
    } as Run,
  };

  it('collapses to "thought for 12s", with the text behind a closed disclosure', () => {
    mount(
      [
        bot('a1', 'done', {
          run_id: 'r1',
          reasoning: { text: 'weighing it up', duration_ms: null },
        }),
      ],
      'en',
      runs,
    );
    expect(screen.getByTestId('reasoning-summary')).toHaveTextContent('Thought for 12s');
    expect(screen.getByTestId('reasoning')).not.toHaveAttribute('open');
  });

  it('says only "Reasoning" when no duration is known — never an invented number', () => {
    mount([bot('a1', 'done', { reasoning: { text: 'hmm', duration_ms: null } })], 'en');
    expect(screen.getByTestId('reasoning-summary')).toHaveTextContent('Reasoning');
  });

  it('shows no fold while the turn is still streaming: that is the live line’s job', () => {
    mount(
      [bot('a1', '', { status: 'streaming', reasoning: { text: 'thinking', duration_ms: null } })],
      'en',
    );
    expect(screen.queryByTestId('reasoning')).toBeNull();
  });

  it('is hidden entirely when the person turned reasoning off', () => {
    render(
      <I18nProvider language="en">
        <PaneProvider>
          <MessageView
            message={bot('a1', 'done', { reasoning: { text: 'hmm', duration_ms: 3000 } })}
            showReasoning={false}
          />
        </PaneProvider>
      </I18nProvider>,
    );
    expect(screen.queryByTestId('reasoning')).toBeNull();
  });
});
