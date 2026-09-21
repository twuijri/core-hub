// The composer's seven states, and that each one is visible rather than implied: empty,
// typing, sending, streaming (send becomes stop), error, drag-over, disabled with a reason.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { Composer } from '../src/chat/Composer.js';
import { canSend, composerState } from '../src/chat/composer-state.js';
import { starterSuggestions } from '../src/chat/starters.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { RealtimeProvider } from '../src/realtime/context.js';
import type { ContentBlock } from '../src/types.js';

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

const base = {
  disabled: false,
  dragging: false,
  busy: false,
  sending: false,
  error: false,
  hasContent: false,
};

type Props = Partial<Parameters<typeof Composer>[0]>;

function renderComposer(props: Props = {}, language: 'ar' | 'en' = 'en') {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
  });
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  const view = render(
    <ThemeProvider>
      <I18nProvider language={language}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <RealtimeProvider>
              <MemoryRouter>
                <Composer
                  busy={false}
                  disabled={false}
                  onSend={async () => {}}
                  onCancel={async () => {}}
                  {...props}
                />
              </MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
  return view;
}

const surface = () => screen.getByTestId('composer');
const state = () => surface().getAttribute('data-state');

afterEach(cleanup);

describe('composerState (pure)', () => {
  it('names exactly one state, in the order that matters', () => {
    expect(composerState(base)).toBe('empty');
    expect(composerState({ ...base, hasContent: true })).toBe('typing');
    expect(composerState({ ...base, hasContent: true, error: true })).toBe('error');
    expect(composerState({ ...base, hasContent: true, sending: true })).toBe('sending');
    // A run streaming wins over the POST still in flight: the button must be Stop.
    expect(composerState({ ...base, sending: true, busy: true })).toBe('streaming');
    expect(composerState({ ...base, busy: true, dragging: true })).toBe('dragging');
    // Disabled beats everything: nothing can be typed, dropped or sent.
    expect(composerState({ ...base, disabled: true, dragging: true, busy: true })).toBe('disabled');
  });

  it('refuses to send with nothing to send, while disabled, or twice at once', () => {
    expect(canSend(base)).toBe(false);
    expect(canSend({ ...base, hasContent: true })).toBe(true);
    expect(canSend({ ...base, hasContent: true, disabled: true })).toBe(false);
    expect(canSend({ ...base, hasContent: true, sending: true })).toBe(false);
    // An error does not block the retry.
    expect(canSend({ ...base, hasContent: true, error: true })).toBe(true);
  });
});

describe('composer', () => {
  it('empty: the send button is there and refuses, and the tool row is complete', () => {
    renderComposer();
    expect(state()).toBe('empty');
    expect(screen.getByTestId('send')).toBeDisabled();
    for (const id of ['composer-plus', 'composer-model', 'composer-approval', 'composer-mic'])
      expect(screen.getByTestId(id)).toBeTruthy();
    // The order of the row is part of the design: + · model · approvals · … · mic · send.
    const row = [...surface().querySelectorAll('[data-testid]')]
      .map((el) => el.getAttribute('data-testid'))
      .filter((id): id is string =>
        ['composer-plus', 'composer-model', 'composer-approval', 'composer-mic', 'send'].includes(
          id ?? '',
        ),
      );
    expect(row).toEqual([
      'composer-plus',
      'composer-model',
      'composer-approval',
      'composer-mic',
      'send',
    ]);
  });

  it('typing: the state changes and the send button becomes usable', async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.type(screen.getByTestId('composer-input'), 'hello');
    expect(state()).toBe('typing');
    expect(screen.getByTestId('send')).toBeEnabled();
    // The growing textarea moves nothing: the twin carries the same text.
    expect(surface().querySelector('.composer-grow')?.getAttribute('data-value')).toBe('hello');
  });

  it('sending: the send button says it is busy until the promise settles, then clears', async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    const sent: ContentBlock[][] = [];
    renderComposer({
      onSend: async (blocks) => {
        sent.push(blocks);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    await user.type(screen.getByTestId('composer-input'), 'hello');
    await user.click(screen.getByTestId('send'));
    await waitFor(() => expect(state()).toBe('sending'));
    expect(screen.getByTestId('send')).toHaveAttribute('data-busy', 'true');
    release();
    await waitFor(() => expect(state()).toBe('empty'));
    expect(sent).toEqual([[{ type: 'text', text: 'hello' }]]);
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe('');
  });

  it('streaming: send becomes stop, and stop calls the hub', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn(async () => {});
    renderComposer({ busy: true, onCancel });
    expect(state()).toBe('streaming');
    expect(screen.queryByTestId('send')).toBeNull();
    await user.click(screen.getByTestId('stop-run'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('error: the failure is on screen and the text is kept for a retry', async () => {
    const user = userEvent.setup();
    renderComposer({
      onSend: async () => {
        throw new Error('the hub refused');
      },
    });
    await user.type(screen.getByTestId('composer-input'), 'hello');
    await user.click(screen.getByTestId('send'));
    await waitFor(() => expect(state()).toBe('error'));
    expect(screen.getByText(/the hub refused/)).toBeTruthy();
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe('hello');
  });

  it('drag-over: the surface says files may be dropped, and stops saying it on leave', () => {
    renderComposer();
    fireEvent.dragOver(surface(), { dataTransfer: { files: [] } });
    expect(state()).toBe('dragging');
    expect(screen.getByRole('status')).toBeTruthy();
    fireEvent.dragLeave(surface());
    expect(state()).toBe('empty');
  });

  it('disabled: the reason is visible, the textarea is dead, and drag does nothing', () => {
    renderComposer({ disabled: true, disabledReason: 'This session was deleted.' });
    expect(state()).toBe('disabled');
    expect(screen.getByTestId('composer-reason')).toHaveTextContent('This session was deleted.');
    expect(screen.getByTestId('composer-input')).toBeDisabled();
    expect(screen.getByTestId('composer-plus')).toBeDisabled();
    fireEvent.dragOver(surface(), { dataTransfer: { files: [] } });
    expect(state()).toBe('disabled');
  });

  it('Enter sends and Shift+Enter does not', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(async () => {});
    renderComposer({ onSend });
    const field = screen.getByTestId('composer-input');
    await user.type(field, 'first{Shift>}{Enter}{/Shift}second');
    expect(onSend).not.toHaveBeenCalled();
    await user.type(field, '{Enter}');
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  });

  it('the + menu offers attach and upload and closes on Escape', async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByTestId('composer-plus'));
    const menu = screen.getByTestId('composer-menu');
    expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('composer-menu')).toBeNull();
  });

  it('the approval selector binds to agent_settings.approval_mode', async () => {
    const user = userEvent.setup();
    const onApprovalMode = vi.fn();
    renderComposer({ approvalMode: 'ask', onApprovalMode });
    const select = screen.getByLabelText('Approvals') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['ask', 'auto_safe', 'auto_all']);
    await user.selectOptions(select, 'auto_all');
    expect(onApprovalMode).toHaveBeenCalledWith('auto_all');
  });

  it('a selector with no answer is disabled and says why', () => {
    renderComposer({ approvalDisabledReason: 'This agent declares no approval mode.' });
    expect(screen.getByLabelText('Approvals')).toBeDisabled();
    expect(screen.getByTestId('composer-approval')).toHaveAttribute(
      'title',
      'This agent declares no approval mode.',
    );
  });

  it('dictation is present but honestly disabled while models.transcribe is a stub', () => {
    renderComposer();
    expect(screen.getByTestId('composer-mic')).toBeDisabled();
    expect(screen.getByTestId('composer-mic').getAttribute('title')).toMatch(/501/);
  });

  it('starters: three on an empty chat, in the UI language, and one fills the field', async () => {
    const user = userEvent.setup();
    for (const language of ['ar', 'en'] as const) {
      cleanup();
      const suggestions = starterSuggestions(language);
      expect(suggestions).toHaveLength(3);
      renderComposer({ starters: suggestions }, language);
      const list = screen.getByTestId('composer-starters');
      expect(list.querySelectorAll('button')).toHaveLength(3);
      await user.click(list.querySelectorAll('button')[0] as HTMLElement);
      expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe(
        suggestions[0],
      );
      // Once there is something to send, the suggestions get out of the way.
      expect(screen.queryByTestId('composer-starters')).toBeNull();
    }
  });

  it('starters never show while streaming or disabled', () => {
    renderComposer({ busy: true, starters: starterSuggestions('en') });
    expect(screen.queryByTestId('composer-starters')).toBeNull();
    cleanup();
    renderComposer({ disabled: true, disabledReason: 'x', starters: starterSuggestions('en') });
    expect(screen.queryByTestId('composer-starters')).toBeNull();
  });
});
