/**
 * The fallback chain and the provider sign-in, as the web shows them (contract decisions §54,
 * §55): the ordered list on the Defaults tab, the note a turn carries when a fallback model
 * answered it, and the device-code sign-in on a provider's card — code, link, a wait, and
 * the outcome.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { Transcript } from '../src/chat/MessageView.js';
import { failedNames, failureReasons, fallbackOf, modelName } from '../src/chat/fallback.js';
import { turnsOf } from '../src/chat/turns.js';
import { I18nProvider } from '../src/i18n/context.js';
import type { Language } from '../src/i18n/index.js';
import { FallbackList } from '../src/models/FallbackList.js';
import { SignInPanel } from '../src/models/SignInPanel.js';
import {
  addFallback,
  moveFallback,
  removeFallback,
  reorderFallback,
} from '../src/models/fallbacks.js';
import { PaneProvider } from '../src/shell/pane.js';
import { chatModels } from '../src/models/queries.js';
import { optionLabels, stubListViewport } from './helpers/ui.js';
import type { Message, Model, Provider, Run } from '../src/types.js';

afterEach(cleanup);

const P = '01J8QK3ZR2W7M5N4P6T8V9X0PV';
const ref = (model: string) => ({ provider_id: P, model });

describe('the chain as the Defaults tab edits it', () => {
  it('adds each model once, never the chat model itself', () => {
    const primary = ref('gemini');
    let chain = addFallback([], ref('gpt'), primary);
    chain = addFallback(chain, ref('gpt'), primary);
    chain = addFallback(chain, primary, primary);
    chain = addFallback(chain, ref('claude'), primary);
    expect(chain.map((each) => each.model)).toEqual(['gpt', 'claude']);
  });

  it('puts a dragged entry at its new place, the rest in order', () => {
    const chain = [ref('a'), ref('b'), ref('c')];
    const at = (value: string, index: number) =>
      reorderFallback(chain, `${P}|${value}`, index).map((each) => each.model);
    expect(at('a', 2)).toEqual(['b', 'c', 'a']);
    expect(at('c', 0)).toEqual(['c', 'a', 'b']);
    expect(at('b', 1)).toEqual(['a', 'b', 'c']);
    expect(at('zzz', 0)).toEqual(['a', 'b', 'c']);
    expect(at('a', 3)).toEqual(['a', 'b', 'c']);
  });

  it('moves one place at a time and keeps the ends where they are', () => {
    const chain = [ref('a'), ref('b'), ref('c')];
    expect(moveFallback(chain, 2, -1).map((each) => each.model)).toEqual(['a', 'c', 'b']);
    expect(moveFallback(chain, 0, 1).map((each) => each.model)).toEqual(['b', 'a', 'c']);
    expect(moveFallback(chain, 0, -1)).toEqual(chain);
    expect(moveFallback(chain, 2, 1)).toEqual(chain);
    expect(removeFallback(chain, 1).map((each) => each.model)).toEqual(['a', 'c']);
  });
});

function model(name: string): Model {
  return {
    key: `proxy/${name}`,
    provider_id: P,
    provider: 'proxy',
    model: name,
    alias: null,
    kind: 'chat',
    visible: true,
    custom: false,
    preview: false,
    disabled: false,
    context_window: null,
    capabilities: [],
    pricing: null,
  } as Model;
}

describe('the fallback list', () => {
  const models = [model('gemini'), model('gpt'), model('claude')];

  function mount(chain: { provider_id: string; model: string }[], language: Language = 'en') {
    const onChange = vi.fn();
    render(
      <I18nProvider language={language}>
        <FallbackList
          chain={chain}
          primary={ref('gemini')}
          models={models}
          disabled={false}
          onChange={onChange}
        />
      </I18nProvider>,
    );
    return onChange;
  }

  it('lists the chain numbered, with a grip and a ✕ on each row and no ▲/▼ buttons', async () => {
    const onChange = mount([ref('gpt'), ref('claude')]);
    const items = screen.getAllByTestId('fallback-item');
    expect(items.map((item) => item.getAttribute('data-model'))).toEqual(['gpt', 'claude']);
    expect(screen.getAllByTestId('fallback-place').map((n) => n.textContent)).toEqual(['1', '2']);
    // Dragging replaced the buttons (owner, 2026-09-26): «سحب وترتيب مهب كذا أزرار».
    expect(screen.queryByTestId('fallback-up')).toBeNull();
    expect(screen.queryByTestId('fallback-down')).toBeNull();
    expect(
      screen.getByRole('button', {
        name: 'Drag to reorder proxy/claude (Space to pick up, arrows to move)',
      }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Remove proxy/gpt' }));
    expect(onChange).toHaveBeenLastCalledWith([ref('claude')]);
  });

  it('reorders by dragging from the keyboard: the places follow, the drop saves once', async () => {
    // jsdom lays nothing out: give each row a place on the page, one under the other.
    const real = HTMLElement.prototype.getBoundingClientRect;
    const spy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const row = this.closest<HTMLElement>('[data-testid="fallback-item"]');
        if (!row) return real.call(this);
        const rows = [...document.querySelectorAll('[data-testid="fallback-item"]')];
        const top = rows.indexOf(row) * 40;
        return {
          x: 0,
          y: top,
          top,
          left: 0,
          right: 300,
          bottom: top + 36,
          width: 300,
          height: 36,
          toJSON: () => ({}),
        } as DOMRect;
      });
    try {
      const onChange = mount([ref('gpt'), ref('claude'), ref('llama')]);
      const grip = screen.getByRole('button', {
        name: 'Drag to reorder proxy/gpt (Space to pick up, arrows to move)',
      });
      grip.focus();
      fireEvent.keyDown(grip, { key: ' ', code: 'Space' });
      // The sensor listens for the arrows from the next tick on.
      await new Promise((resolve) => setTimeout(resolve, 0));
      fireEvent.keyDown(document, { key: 'ArrowDown', code: 'ArrowDown' });
      // Before the drop the numbers already say where it would land; nothing saved yet.
      await waitFor(() =>
        expect(
          screen.getAllByTestId('fallback-item').map((item) => item.getAttribute('data-model')),
        ).toEqual(['claude', 'gpt', 'llama']),
      );
      expect(onChange).not.toHaveBeenCalled();
      fireEvent.keyDown(document, { key: ' ', code: 'Space' });
      await waitFor(() =>
        expect(onChange).toHaveBeenLastCalledWith([ref('claude'), ref('gpt'), ref('llama')]),
      );
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('never offers a model that only draws (§87): it would fail a chat turn', async () => {
    const drawOnly = { ...model('gpt-image-2'), capabilities: ['image_output'], image_only: true };
    const drawsAndChats = {
      ...model('gemini-3.1-flash-image'),
      capabilities: ['image_output'],
      image_only: false,
    };
    expect(chatModels([...models, drawOnly, drawsAndChats] as Model[]).map((m) => m.model)).toEqual(
      ['gemini', 'gpt', 'claude', 'gemini-3.1-flash-image'],
    );
    const user = userEvent.setup();
    render(
      <I18nProvider language="en">
        <FallbackList
          chain={[]}
          primary={ref('gemini')}
          models={[...models, drawOnly, drawsAndChats] as Model[]}
          disabled={false}
          onChange={vi.fn()}
        />
      </I18nProvider>,
    );
    const undo = stubListViewport();
    try {
      const offered = await optionLabels(user, screen.getByTestId('fallback-add'));
      expect(offered.join(' ')).not.toContain('gpt-image-2');
      expect(offered.join(' ')).toContain('gemini-3.1-flash-image');
    } finally {
      undo();
    }
  });

  it('says what an empty chain means, in Arabic too', () => {
    mount([], 'ar');
    expect(screen.getByText('النماذج الاحتياطية')).toBeInTheDocument();
    expect(screen.getByTestId('fallback-empty')).toHaveTextContent('لا نماذج احتياطية');
  });

  it('asks for a chat model before a chain', () => {
    render(
      <I18nProvider language="en">
        <FallbackList
          chain={[]}
          primary={null}
          models={models}
          disabled={false}
          onChange={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(
      screen.getByText('Choose a chat model first; the fallbacks are tried after it.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('fallback-add')).toBeNull();
  });
});

function message(partial: Partial<Message> & Pick<Message, 'id' | 'role'>): Message {
  return {
    profile: 'default',
    owner_id: 'u1',
    created_at: '2026-09-25T10:00:00Z',
    updated_at: '2026-09-25T10:00:00Z',
    session_id: 's1',
    room_id: null,
    seq: 1,
    author: { kind: 'agent', id: null, name: 'Direct', avatar: null },
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

function run(over: Partial<Run> = {}): Run {
  return {
    id: 'r1',
    profile: 'default',
    owner_id: 'u1',
    created_at: '2026-09-25T10:00:00Z',
    updated_at: '2026-09-25T10:00:00Z',
    session_id: 's1',
    room_id: null,
    seat_id: null,
    job_id: 'j1',
    status: 'succeeded',
    queue_position: null,
    trigger: { kind: 'user', id: 'u1' },
    input_message_id: null,
    output_message_id: null,
    model: 'proxy/gpt-5.5',
    provider: 'proxy',
    reasoning_effort: null,
    interrupted: false,
    error: null,
    usage: null,
    fallback: {
      failed: [
        {
          model: 'gemini-3.8-flash-high',
          provider: 'proxy',
          code: 'agent_error',
          error: 'auth_unavailable: no auth available',
        },
      ],
    },
    started_at: null,
    finished_at: null,
    ...over,
  } as Run;
}

describe('a turn a fallback model answered', () => {
  function mount(runs: Record<string, Run>, language: Language) {
    const reply = message({
      id: 'm1',
      role: 'assistant',
      run_id: 'r1',
      content: [{ type: 'text', text: 'answered' }],
      usage: { input_tokens: 9, output_tokens: 2, cost: null },
    });
    render(
      <I18nProvider language={language}>
        <PaneProvider>
          <Transcript turns={turnsOf([reply])} showReasoning runs={runs} />
        </PaneProvider>
      </I18nProvider>,
    );
  }

  it('says which model answered, which failed, and why', () => {
    mount({ r1: run() }, 'en');
    expect(screen.getByTestId('fallback-note')).toHaveTextContent(
      'proxy/gemini-3.8-flash-high failed, so proxy/gpt-5.5 answered — Why: auth_unavailable: no auth available',
    );
    // The turn's meta line names the model that answered.
    expect(screen.getByText(/Answered by proxy\/gpt-5\.5/)).toBeInTheDocument();
  });

  it('says it in Arabic', () => {
    mount({ r1: run() }, 'ar');
    expect(screen.getByTestId('fallback-note')).toHaveTextContent(
      'فشل proxy/gemini-3.8-flash-high، فأجاب proxy/gpt-5.5',
    );
  });

  it('says nothing about a fallback when the chosen model answered', () => {
    mount({ r1: run({ fallback: null }) }, 'en');
    expect(screen.queryByTestId('fallback-note')).toBeNull();
  });

  it('words the parts the same way everywhere', () => {
    const fallback = run().fallback as NonNullable<Run['fallback']>;
    expect(modelName({ model: 'm', provider: null })).toBe('m');
    expect(failedNames({ failed: [...fallback.failed, ...fallback.failed] }, 'ar')).toBe(
      'proxy/gemini-3.8-flash-high، proxy/gemini-3.8-flash-high',
    );
    expect(failureReasons({ failed: [...fallback.failed, ...fallback.failed] })).toBe(
      'auth_unavailable: no auth available',
    );
    expect(fallbackOf(run({ fallback: null }))).toBeNull();
    expect(fallbackOf(undefined)).toBeNull();
  });
});

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

const CODEX = {
  id: '01J8QK3ZR2W7M5N4P6T8V9X0CX',
  profile: 'default',
  owner_id: 'u',
  created_at: '2026-09-25T00:00:00Z',
  updated_at: '2026-09-25T00:00:00Z',
  slug: 'openai-codex',
  label: 'ChatGPT / Codex (subscription)',
  kind: 'llm',
  scope: 'all',
  builtin: true,
  enabled: true,
  api_key: null,
  base_url: 'https://chatgpt.com/backend-api/codex',
  api_mode: 'native',
  auth: { kind: 'oauth', signed_in: false },
  catalogue: { status: 'loading', refreshed_at: null, error: null, refreshable: true },
  visibility: { mode: 'all', models: [] },
  models: [],
} as unknown as Provider;

describe('signing in to a provider by device code', () => {
  function mount(answers: string[], language: Language = 'en') {
    const polls: string[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      const url = String(input);
      const json = (value: unknown, status = 200) =>
        Promise.resolve(
          new Response(JSON.stringify(value), {
            status,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      const signIn = (status: string, error: string | null = null) => ({
        id: '01J8QK3ZR2W7M5N4P6T8V9X0SN',
        status,
        user_code: 'HXKQ-9P2M',
        verification_url: 'https://auth.openai.example/codex/device',
        accepts_code: false,
        expires_at: '2026-09-25T10:15:00Z',
        error,
      });
      if (init?.method === 'POST' && url.endsWith(`/models/providers/${CODEX.id}/sign-in`)) {
        return json(signIn('pending'), 201);
      }
      if (url.includes(`/models/providers/${CODEX.id}/sign-in/`)) {
        const status = answers[Math.min(polls.length, answers.length - 1)] as string;
        polls.push(status);
        return json(signIn(status, status === 'denied' ? 'the person declined' : null));
      }
      return json({ items: [] });
    };
    const store = new SessionStore(memoryStorage());
    store.save({
      profile: 'default',
      token: 't',
      refresh_token: null,
      expires_at: null,
      user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
    });
    const onDone = vi.fn();
    render(
      <I18nProvider language={language}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <SignInPanel provider={CODEX} onDone={onDone} />
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>,
    );
    return { polls, onDone };
  }

  it('shows the code and the link, waits, then says it is signed in', async () => {
    const { polls } = mount(['pending', 'approved']);
    await userEvent.click(screen.getByTestId('sign-in-start'));
    expect(await screen.findByTestId('sign-in-code')).toHaveTextContent('HXKQ-9P2M');
    expect(screen.getByTestId('sign-in-link')).toHaveAttribute(
      'href',
      'https://auth.openai.example/codex/device',
    );
    expect(screen.getByTestId('sign-in-link')).toHaveAttribute('target', '_blank');
    expect(await screen.findByTestId('sign-in-waiting')).toBeInTheDocument();
    expect(await screen.findByTestId('sign-in-approved', {}, { timeout: 6000 })).toHaveTextContent(
      'Signed in.',
    );
    // Polling stops once the sign-in is no longer pending.
    const asked = polls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(polls.length).toBe(asked);
  });

  it("says declined in the runtime's words, and offers to start again, in Arabic", async () => {
    mount(['denied'], 'ar');
    await userEvent.click(screen.getByTestId('sign-in-start'));
    await waitFor(() =>
      expect(screen.getByTestId('sign-in-ended')).toHaveTextContent(
        'رُفض تسجيل الدخول. the person declined',
      ),
    );
    expect(screen.getByTestId('sign-in-retry')).toHaveTextContent('ابدأ من جديد');
  });
});
