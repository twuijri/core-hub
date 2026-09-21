// The Models screen: a key is typed once, is never echoed back, and what each agent
// inherits is visible (ADR 0010).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { RealtimeProvider } from '../src/realtime/context.js';
import { ModelsScreen } from '../src/models/ModelsScreen.js';

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

const PROVIDER_ID = '01J8QK3ZR2W7M5N4P6T8V9X0PV';

function provider(over: Record<string, unknown> = {}) {
  return {
    id: PROVIDER_ID,
    profile: 'default',
    owner_id: '01J8QK3ZR2W7M5N4P6T8V9X0HM',
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-21T06:00:00Z',
    slug: 'anthropic',
    label: 'Anthropic',
    kind: 'llm',
    builtin: true,
    enabled: true,
    api_key: null,
    base_url: 'https://api.anthropic.com',
    api_mode: 'native',
    auth: { kind: 'api_key', signed_in: false },
    catalogue: { status: 'loading', refreshed_at: null, error: null, refreshable: true },
    visibility: { mode: 'all', models: [] },
    models: [],
    ...over,
  };
}

const MODEL = {
  key: 'anthropic/claude-sonnet-4-5',
  provider_id: PROVIDER_ID,
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  alias: null,
  kind: 'chat',
  visible: true,
  custom: false,
  preview: false,
  disabled: false,
  context_window: 200000,
  capabilities: ['tools'],
  pricing: null,
};

interface HubState {
  providers: Record<string, unknown>[];
  models: Record<string, unknown>[];
  defaults: Record<string, unknown>;
  agents: Record<string, unknown>[];
  /** Every request body the screen sent, for the "never echoed" assertions. */
  sent: { url: string; body: unknown }[];
}

function hub(state: Partial<HubState> = {}) {
  const hubState: HubState = {
    providers: [provider()],
    models: [],
    defaults: {
      default: null,
      fallbacks: [],
      auxiliary: {
        tasks: [{ key: 'coding', label: { ar: 'وكلاء البرمجة', en: 'Coding agents' } }],
        assignments: {},
      },
    },
    agents: [],
    sent: [],
    ...state,
  };
  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
    hubState.sent.push({ url, body });
    const json = (value: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(value), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    if (url.endsWith('/models/providers')) {
      if (init?.method === 'PATCH') return json(hubState.providers[0]);
      return json({ items: hubState.providers });
    }
    if (url.includes('/models/providers/') && url.endsWith('/test')) {
      return json({ ok: false, message: 'The provider rejected the stored key.', duration_ms: 42 });
    }
    if (url.includes('/models/providers/')) {
      // A key save: the response carries the mask, never the value.
      hubState.providers = [
        provider({ api_key: '[stored]', auth: { kind: 'api_key', signed_in: true } }),
      ];
      return json(hubState.providers[0]);
    }
    if (url.includes('/models/defaults')) return json(hubState.defaults);
    if (url.includes('/models/speech')) {
      return json({
        stt: {
          active_provider_id: null,
          ready: false,
          reason: 'models.speech.stt.not_chosen',
          providers: [],
        },
        tts: {
          active_provider_id: null,
          ready: false,
          reason: 'models.speech.tts.not_chosen',
          providers: [],
        },
      });
    }
    if (url.includes('/agents')) return json({ items: hubState.agents });
    if (url.includes('/models')) return json({ items: hubState.models, next_cursor: null });
    return json({ items: [] });
  };
  return { state: hubState, fetchImpl };
}

function renderScreen(fetchImpl: typeof fetch, language: 'ar' | 'en' = 'en') {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role: 'owner' },
  });
  return render(
    <ThemeProvider>
      <I18nProvider language={language}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <RealtimeProvider>
              <MemoryRouter initialEntries={['/models']}>
                <ModelsScreen />
              </MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

afterEach(cleanup);

describe('models screen', () => {
  it('shows every provider with whether a key is stored', async () => {
    const { fetchImpl } = hub({
      providers: [
        provider(),
        provider({
          id: '01J8QK3ZR2W7M5N4P6T8V9X0PW',
          slug: 'ollama',
          label: 'Ollama',
          auth: { kind: 'none', signed_in: true },
          catalogue: { status: 'ready', refreshed_at: null, error: null, refreshable: true },
        }),
      ],
    });
    renderScreen(fetchImpl);

    await waitFor(() => expect(screen.getByTestId('provider-list')).toBeTruthy());
    expect(screen.getByText('Anthropic')).toBeTruthy();
    expect(screen.getByText('No key')).toBeTruthy();
    // A provider that needs no key says so instead of showing an empty key field.
    expect(screen.getByText('No key needed')).toBeTruthy();
  });

  it('sends a typed key once and never renders it back', async () => {
    const { state, fetchImpl } = hub();
    renderScreen(fetchImpl);
    await waitFor(() => expect(screen.getByTestId('provider-key')).toBeTruthy());

    const field = screen.getByTestId('provider-key') as HTMLInputElement;
    // The key field is a password field: a shoulder-surfer sees nothing either.
    expect(field.type).toBe('password');
    await userEvent.type(field, 'sk-ant-api03-TYPED-ONCE');
    await userEvent.click(screen.getByRole('button', { name: 'Save key' }));

    await waitFor(() => {
      const patch = state.sent.find((call) => call.url.includes(PROVIDER_ID));
      expect(patch?.body).toEqual({ api_key: 'sk-ant-api03-TYPED-ONCE' });
    });
    // The field is cleared, and the screen shows the mask, not the key.
    await waitFor(() =>
      expect((screen.getByTestId('provider-key') as HTMLInputElement).value).toBe(''),
    );
    expect(document.body.textContent).not.toContain('TYPED-ONCE');
    await waitFor(() => expect(screen.getByText('Key stored')).toBeTruthy());
  });

  it('shows what the provider answered to a test, success or failure', async () => {
    const { fetchImpl } = hub();
    renderScreen(fetchImpl);
    await waitFor(() => expect(screen.getByTestId('provider-test')).toBeTruthy());

    await userEvent.click(screen.getByTestId('provider-test'));
    await waitFor(() => {
      expect(screen.getByTestId('provider-test-result').textContent).toContain(
        'The provider rejected the stored key.',
      );
    });
    expect(screen.getByTestId('provider-test-result').textContent).toContain('42 ms');
  });

  it('says why speech is not ready instead of showing an empty tab', async () => {
    const { fetchImpl } = hub({ providers: [] });
    renderScreen(fetchImpl);
    await waitFor(() => expect(screen.getByTestId('models-tabs')).toBeTruthy());

    await userEvent.click(screen.getByText('Text to speech'));
    await waitFor(() =>
      expect(screen.getByText('No text-to-speech provider is chosen.')).toBeTruthy(),
    );
  });

  it('picks the defaults and lists which agents inherit them', async () => {
    const { state, fetchImpl } = hub({
      models: [MODEL],
      agents: [
        {
          id: 'a1',
          slug: 'claude-code',
          name: 'Claude Code',
          default_model: { provider_id: PROVIDER_ID, model: 'claude-sonnet-4-5' },
          capabilities: [],
        },
        { id: 'a2', slug: 'codex', name: 'Codex CLI', default_model: null, capabilities: [] },
      ],
    });
    renderScreen(fetchImpl);
    await waitFor(() => expect(screen.getByTestId('models-tabs')).toBeTruthy());
    await userEvent.click(screen.getByText('Defaults'));

    await waitFor(() => expect(screen.getByTestId('default-chat')).toBeTruthy());
    await userEvent.selectOptions(
      screen.getByTestId('default-chat'),
      `${PROVIDER_ID}|claude-sonnet-4-5`,
    );
    await waitFor(() => {
      const put = state.sent.find((call) => call.url.endsWith('/models/defaults') && call.body);
      expect(put?.body).toEqual({
        default: { provider_id: PROVIDER_ID, model: 'claude-sonnet-4-5' },
      });
    });

    // Which agent inherits what, with no second request and no guessing.
    const inheriting = screen.getByTestId('inheriting-agents');
    expect(inheriting.textContent).toContain('Claude Code');
    expect(inheriting.textContent).toContain('anthropic/claude-sonnet-4-5');
    expect(inheriting.textContent).toContain('Not chosen');
  });

  it('renders in Arabic', async () => {
    const { fetchImpl } = hub();
    renderScreen(fetchImpl, 'ar');
    await waitFor(() => expect(screen.getByTestId('provider-list')).toBeTruthy());
    expect(screen.getByText('المزوّدون')).toBeTruthy();
    expect(screen.getByText('حفظ المفتاح')).toBeTruthy();
  });

  it('gives every control a label a keyboard reaches', async () => {
    const { fetchImpl } = hub();
    renderScreen(fetchImpl);
    await waitFor(() => expect(screen.getByTestId('provider-key')).toBeTruthy());
    // The key field is reachable by its label, and every action is a real button.
    expect(screen.getByLabelText('API key')).toBeTruthy();
    for (const name of ['Save key', 'Test', 'Add a provider']) {
      expect(screen.getByRole('button', { name }).tagName).toBe('BUTTON');
    }
    expect(screen.getByRole('checkbox', { name: 'Enabled' })).toBeTruthy();
  });
});
