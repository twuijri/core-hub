// What the person is told when a run fails with no provider configured: our sentence and
// a way out, in both languages, with the agent's own words still on the page.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { Transcript } from '../src/chat/MessageView.js';
import {
  DEFAULTS_ROUTE,
  RunFailureNotice,
  failuresByMessage,
} from '../src/chat/RunFailureNotice.js';
import { hydrate, initialChat, reduce, type ChatState } from '../src/chat/transcript.js';
import { turnsOf } from '../src/chat/turns.js';
import { I18nProvider } from '../src/i18n/context.js';
import { translate } from '../src/i18n/index.js';
import type { Envelope } from '../src/realtime/envelope.js';
import { PaneProvider } from '../src/shell/pane.js';
import type { Message, Run, SessionDetail } from '../src/types.js';

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

/* ------------------------------------------------------------------------------------------
 * Where it is drawn (owner, 2026-09-25: «الخطا يبتل ما يروح»). A run failed with the
 * provider down; the next run succeeded; the red line stayed above the composer as if the
 * latest run had failed. A failure now belongs to the turn that failed.
 * ---------------------------------------------------------------------------------------- */

const SESSION = '01J8QK3ZR2W7M5N4P6T8V9X0YA';
const OUTAGE = 'HTTP 503: auth_unavailable (upstream provider unavailable)';

function message(partial: Partial<Message> & Pick<Message, 'id' | 'role' | 'seq'>): Message {
  return {
    profile: 'default',
    owner_id: 'u1',
    created_at: '2026-09-25T10:00:00Z',
    updated_at: '2026-09-25T10:00:00Z',
    session_id: SESSION,
    room_id: null,
    author:
      partial.role === 'assistant'
        ? { kind: 'agent', id: null, name: 'Hermes', avatar: null }
        : { kind: 'user', id: null, name: '', avatar: null },
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

function run(id: string, status: Run['status'], over: Partial<Run> = {}): Run {
  return {
    id,
    profile: 'default',
    owner_id: 'u1',
    created_at: '2026-09-25T10:00:00Z',
    updated_at: '2026-09-25T10:00:00Z',
    session_id: SESSION,
    room_id: null,
    seat_id: null,
    job_id: `job-${id}`,
    status,
    queue_position: null,
    trigger: { kind: 'user' },
    input_message_id: null,
    output_message_id: null,
    model: null,
    provider: null,
    reasoning_effort: null,
    interrupted: false,
    error: null,
    usage: null,
    started_at: null,
    finished_at: null,
    ...over,
  } as Run;
}

const envelope = (event: string, payload: Record<string, unknown>, seq: number): Envelope => ({
  event,
  namespace: '/rt/sessions',
  profile: 'default',
  ts: 't',
  seq,
  payload,
});

const detail = {
  id: SESSION,
  profile: 'default',
  status: 'idle',
  context: null,
  runs: [],
  pending_approvals: [],
} as unknown as SessionDetail;

/** The conversation the owner had: a run that failed on the outage, then one that answered. */
function failedThenSucceeded(): ChatState {
  let state = hydrate(initialChat(), detail, []);
  const failed = run('r1', 'failed', {
    input_message_id: 'u1',
    output_message_id: 'a1',
    error: { code: 'agent_error', error: OUTAGE },
  });
  state = reduce(
    state,
    envelope(
      'message.created',
      {
        message: message({
          id: 'u1',
          role: 'user',
          seq: 1,
          run_id: 'r1',
          content: [{ type: 'text', text: 'hello' }],
        }),
      },
      1,
    ),
    SESSION,
  );
  state = reduce(
    state,
    envelope(
      'message.created',
      {
        message: message({
          id: 'a1',
          role: 'assistant',
          seq: 2,
          run_id: 'r1',
          status: 'streaming',
        }),
      },
      2,
    ),
    SESSION,
  );
  state = reduce(state, envelope('run.failed', { run: failed }, 3), SESSION);
  state = reduce(
    state,
    envelope(
      'message.created',
      {
        message: message({
          id: 'u2',
          role: 'user',
          seq: 3,
          run_id: 'r2',
          content: [{ type: 'text', text: 'again' }],
        }),
      },
      4,
    ),
    SESSION,
  );
  state = reduce(state, envelope('run.started', { run: run('r2', 'running') }, 5), SESSION);
  state = reduce(
    state,
    envelope(
      'run.completed',
      {
        run: run('r2', 'succeeded', { input_message_id: 'u2', output_message_id: 'a2' }),
        message: message({
          id: 'a2',
          role: 'assistant',
          seq: 4,
          run_id: 'r2',
          content: [{ type: 'text', text: 'Here you go.' }],
          usage: { input_tokens: 53525, output_tokens: 874, cost: null },
        } as Partial<Message> & Pick<Message, 'id' | 'role' | 'seq'>),
      },
      6,
    ),
    SESSION,
  );
  return state;
}

function Conversation({ state, runs }: { state: ChatState; runs: Iterable<Run> }) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const failures = failuresByMessage(state.messages, runs);
  return (
    <div className="chat-turns">
      <Transcript
        turns={turnsOf(state.messages)}
        showReasoning
        runs={state.runs}
        noticeFor={(m) => {
          const entry = failures.get(m.id);
          return entry && !dismissed.has(entry.runId) ? (
            <RunFailureNotice
              failure={entry.failure}
              onDismiss={() => setDismissed((held) => new Set(held).add(entry.runId))}
            />
          ) : null;
        }}
      />
    </div>
  );
}

function showConversation(state: ChatState, runs: Iterable<Run>) {
  render(
    <MemoryRouter>
      <I18nProvider language="en">
        <PaneProvider>
          <Conversation state={state} runs={runs} />
        </PaneProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe('a failure belongs to the turn that failed', () => {
  it('after a failed run and a successful one: the error is under the failed reply only', () => {
    const state = failedThenSucceeded();
    showConversation(state, Object.values(state.runs));
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    const [failedReply, answer] = screen.getAllByTestId('message-assistant');
    expect(failedReply!.getAttribute('data-message-id')).toBe('a1');
    expect(failedReply).toContainElement(alerts[0]!);
    expect(alerts[0]!.textContent).toContain(OUTAGE);
    // The successful turn — the newest, nearest the composer — carries no error at all.
    expect(answer!.getAttribute('data-message-id')).toBe('a2');
    expect(within(answer!).queryByRole('alert')).toBeNull();
  });

  it('nothing is drawn outside a turn: the newest run succeeding leaves no stray banner', () => {
    const state = failedThenSucceeded();
    const map = failuresByMessage(state.messages, Object.values(state.runs));
    expect([...map.keys()]).toEqual(['a1']);
    expect(map.get('a1')?.runId).toBe('r1');
  });

  it('after a reload the failed turn keeps its error, from the failed-runs history', () => {
    const live = failedThenSucceeded();
    // A reload: `SessionDetail.runs` holds only live runs, so the failure comes back from
    // `sessions.listRuns?status=failed`, and the messages from the transcript page.
    const reloaded = hydrate(initialChat(), detail, live.messages);
    expect(reloaded.runs).toEqual({});
    const history = [live.runs.r1!];
    showConversation(reloaded, history);
    const alert = screen.getByRole('alert');
    const failedReply = screen
      .getAllByTestId('message-assistant')
      .find((node) => node.getAttribute('data-message-id') === 'a1')!;
    expect(failedReply).toContainElement(alert);
  });

  it('a run that failed before the agent wrote anything hangs under the message that started it', () => {
    const state = hydrate(initialChat(), detail, [
      message({
        id: 'u1',
        role: 'user',
        seq: 1,
        run_id: 'r1',
        content: [{ type: 'text', text: 'hi' }],
      }),
    ]);
    const failed = run('r1', 'failed', {
      input_message_id: 'u1',
      error: { code: 'provider_not_configured', error: HERMES_TEXT },
    });
    showConversation(state, [failed]);
    expect(screen.getByTestId('message-user')).toContainElement(screen.getByRole('alert'));
  });

  it('a reply that explains itself in the agent’s own words needs no second line', () => {
    const state = hydrate(initialChat(), detail, [
      message({
        id: 'a1',
        role: 'assistant',
        seq: 1,
        run_id: 'r1',
        status: 'failed',
        content: [{ type: 'text', text: 'The provider is down.' }],
      }),
    ]);
    const failed = run('r1', 'failed', {
      output_message_id: 'a1',
      error: { code: 'agent_error', error: OUTAGE },
    });
    expect(failuresByMessage(state.messages, [failed]).size).toBe(0);
  });

  it('can be dismissed', () => {
    const state = failedThenSucceeded();
    showConversation(state, Object.values(state.runs));
    fireEvent.click(screen.getByTestId('run-failed-dismiss'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
