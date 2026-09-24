// The Models screen: the providers the person added, one way to add another, a key that
// is typed once and never echoed, and no control that contradicts another (ADR 0010,
// contract decision §26).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  chooseInCombobox,
  chooseOption,
  closeControl,
  optionLabels,
  stubListViewport,
} from './helpers/ui.js';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../src/auth/context.js';
import { SessionStore } from '../src/auth/store.js';
import { ThemeProvider } from '../src/design/theme.js';
import { I18nProvider } from '../src/i18n/context.js';
import { RealtimeProvider } from '../src/realtime/context.js';
import { ModelsScreen } from '../src/models/ModelsScreen.js';
import { isLoopbackUrl, suggestedHostUrl } from '../src/models/loopback.js';

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

const PRESETS = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'llm',
    api_mode: 'native',
    base_url: 'https://api.anthropic.com',
    base_url_required: false,
    key: 'required',
    local: false,
    repeatable: false,
    keys_url: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    kind: 'llm',
    api_mode: 'chat_completions',
    base_url: 'http://127.0.0.1:1234/v1',
    base_url_required: false,
    key: 'optional',
    local: true,
    repeatable: false,
    keys_url: null,
  },
  {
    id: 'litellm',
    label: 'LiteLLM',
    kind: 'llm',
    api_mode: 'chat_completions',
    base_url: null,
    base_url_required: true,
    key: 'optional',
    local: true,
    repeatable: false,
    keys_url: null,
  },
];

interface HubState {
  providers: Record<string, unknown>[];
  models: Record<string, unknown>[];
  defaults: Record<string, unknown>;
  agents: Record<string, unknown>[];
  containerized: boolean;
  /** What the probe answers, so a test can be a failure as easily as a success. */
  probe: Record<string, unknown>;
  /** Every request body the screen sent, for the "never echoed" assertions. */
  sent: { url: string; method: string; body: unknown }[];
  /** What `models.getRuntime` answers; every check passing when absent. */
  runtime?: Record<string, unknown>;
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
    containerized: false,
    probe: {
      ok: true,
      message: null,
      duration_ms: 12,
      models: [{ id: 'qwen2.5-coder-7b-instruct', label: 'qwen2.5-coder-7b-instruct' }],
    },
    sent: [],
    ...state,
  };
  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
    hubState.sent.push({ url, method: init?.method ?? 'GET', body });
    const json = (value: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(value), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    if (url.includes('/models/provider-presets')) {
      return json({
        items: PRESETS,
        host: {
          containerized: hubState.containerized,
          loopback_alias: 'host.docker.internal',
        },
      });
    }
    if (url.includes('/models/provider-probes')) return json(hubState.probe);
    if (url.endsWith('/models/providers')) {
      if (init?.method === 'POST') {
        const created = provider({
          id: '01J8QK3ZR2W7M5N4P6T8V9X0NEW',
          slug: 'lmstudio',
          label: 'LM Studio',
          builtin: true,
          base_url: 'http://127.0.0.1:1234/v1',
          auth: { kind: 'none', signed_in: true },
        });
        hubState.providers = [...hubState.providers, created];
        return json(created, 201);
      }
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
    if (url.includes('/models/runtime')) {
      if (hubState.runtime) return json(hubState.runtime);
      // The self-check strip under the provider list (ADR 0010): a hub that took the
      // providers reports every step passing.
      return json({
        agent: 'hermes',
        mode: 'managed',
        ready: true,
        reloaded_at: '2026-09-22T09:00:00Z',
        checks: [
          { id: 'runtime_writable', ok: true, detail: 'managed' },
          { id: 'provider_keys', ok: true, detail: '1' },
          { id: 'model_selected', ok: true, detail: 'anthropic/claude-sonnet-4-5' },
          { id: 'gateway_reloaded', ok: true, detail: null },
        ],
      });
    }
    if (url.includes('/models/defaults')) return json(hubState.defaults);
    if (url.includes('/models/speech')) {
      return json({
        stt: {
          active_provider_id: null,
          ready: false,
          reason: 'No speech-to-text provider is chosen.',
          providers: [],
        },
        tts: {
          active_provider_id: null,
          ready: false,
          reason: 'No text-to-speech provider is chosen.',
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

/** Open the add dialog and wait for the presets to arrive in it. */
async function openDialog() {
  await waitFor(() => expect(screen.getByTestId('open-add-provider')).toBeTruthy());
  await userEvent.click(screen.getByTestId('open-add-provider'));
  await waitFor(() => expect(screen.getByTestId('add-preset')).toBeTruthy());
  return screen.getByTestId('add-provider-dialog');
}

/** The provider presets the dialog currently offers, by their visible names. */
async function presetLabels(): Promise<string[]> {
  const labels = await optionLabels(userEvent, screen.getByTestId('add-preset'));
  await closeControl(userEvent);
  return labels;
}

afterEach(cleanup);

describe('models screen', () => {
  it('lists only the providers that were added, with one way to add another', async () => {
    const { fetchImpl } = hub({
      providers: [
        provider({ api_key: '[stored]', auth: { kind: 'api_key', signed_in: true } }),
        provider({
          id: '01J8QK3ZR2W7M5N4P6T8V9X0PW',
          slug: 'lmstudio',
          label: 'LM Studio',
          base_url: 'http://host.docker.internal:1234/v1',
          auth: { kind: 'none', signed_in: true },
          catalogue: { status: 'ready', refreshed_at: null, error: null, refreshable: true },
        }),
      ],
    });
    renderScreen(fetchImpl);

    await waitFor(() => expect(screen.getByTestId('provider-list')).toBeTruthy());
    expect(screen.getByText('Anthropic')).toBeTruthy();
    expect(screen.getByText('LM Studio')).toBeTruthy();
    expect(screen.getByText('Key stored')).toBeTruthy();
    // A provider that needs no key says the key is optional — never "no key needed"
    // beside a complaint that one is missing.
    expect(screen.getByText('Key optional')).toBeTruthy();
    expect(screen.queryByText('No key')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add a provider' })).toBeTruthy();

    // A preset already added is not offered again: adding it twice is a 409.
    await openDialog();
    const offered = await presetLabels();
    expect(offered).not.toContain('Anthropic');
    expect(offered).not.toContain('LM Studio');
    expect(offered).toContain('LiteLLM');
  });

  it('says a fresh workspace has no providers and offers the first one', async () => {
    const { fetchImpl } = hub({ providers: [] });
    renderScreen(fetchImpl);
    await waitFor(() =>
      expect(
        screen.getByText('No providers yet. Add the first one and its models arrive with it.'),
      ),
    );
    // Two ways to the same dialog: the header button and the empty state.
    expect(screen.getAllByRole('button', { name: 'Add a provider' }).length).toBe(2);
  });

  it('prefills the base URL from the preset and asks for one the preset cannot know', async () => {
    const { fetchImpl } = hub({ providers: [] });
    renderScreen(fetchImpl);
    await openDialog();

    const url = () => screen.getByTestId('add-base-url') as HTMLInputElement;
    // Anthropic is first: its address is known.
    expect(url().value).toBe('https://api.anthropic.com');
    await chooseOption(userEvent, screen.getByTestId('add-preset'), 'LM Studio');
    expect(url().value).toBe('http://127.0.0.1:1234/v1');
    // LiteLLM has no address anybody could guess, so the field is empty and required.
    await chooseOption(userEvent, screen.getByTestId('add-preset'), 'LiteLLM');
    expect(url().value).toBe('');
    expect(url().required).toBe(true);
    expect((screen.getByTestId('add-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('never demands a key for a provider whose preset says optional', async () => {
    const { state, fetchImpl } = hub({ providers: [] });
    renderScreen(fetchImpl);
    await openDialog();

    await chooseOption(userEvent, screen.getByTestId('add-preset'), 'LM Studio');
    // The field is there — always — and it says it is optional.
    const key = screen.getByTestId('add-api-key') as HTMLInputElement;
    expect(key.required).toBe(false);
    expect(screen.getByLabelText('API key (optional)')).toBeTruthy();
    // And the dialog can be submitted with it empty.
    expect((screen.getByTestId('add-submit') as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(screen.getByTestId('add-submit'));

    await waitFor(() => {
      const post = state.sent.find(
        (call) => call.method === 'POST' && call.url.endsWith('/models/providers'),
      );
      expect(post?.body).toMatchObject({
        preset: 'lmstudio',
        base_url: 'http://127.0.0.1:1234/v1',
      });
      // Nothing about a key was sent, and nothing complained about one.
      expect((post?.body as { api_key?: string }).api_key).toBeUndefined();
    });
  });

  it('a preset that requires a key will not submit without one', async () => {
    const { fetchImpl } = hub({ providers: [] });
    renderScreen(fetchImpl);
    await openDialog();

    await chooseOption(userEvent, screen.getByTestId('add-preset'), 'Anthropic');
    expect(screen.getByLabelText('API key')).toBeTruthy();
    expect((screen.getByTestId('add-submit') as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByTestId('add-api-key'), 'sk-ant-typed');
    expect((screen.getByTestId('add-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('custom asks for a name instead of a preset, and needs an address', async () => {
    const { fetchImpl } = hub({ providers: [] });
    renderScreen(fetchImpl);
    await openDialog();

    await userEvent.click(screen.getByTestId('add-mode-custom'));
    expect(screen.queryByTestId('add-preset')).toBeNull();
    const label = screen.getByTestId('add-label') as HTMLInputElement;
    expect(label.required).toBe(true);
    // A name with no address is not enough, and neither is an address with no name.
    expect((screen.getByTestId('add-submit') as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(label, 'cli-proxy-api');
    expect((screen.getByTestId('add-submit') as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByTestId('add-base-url'), 'http://cli-proxy-api:8317/v1');
    expect((screen.getByTestId('add-submit') as HTMLButtonElement).disabled).toBe(false);
    // A custom endpoint may be given a key, and is never forced to have one.
    expect((screen.getByTestId('add-api-key') as HTMLInputElement).required).toBe(false);
  });

  it('fetches the model list from the endpoint, and shows its own words when it cannot', async () => {
    const { state, fetchImpl } = hub({
      providers: [],
      probe: {
        ok: false,
        message: 'Connection refused at 127.0.0.1:1234',
        duration_ms: 3,
        models: [],
      },
    });
    renderScreen(fetchImpl);
    await openDialog();
    await chooseOption(userEvent, screen.getByTestId('add-preset'), 'LM Studio');

    await userEvent.click(screen.getByTestId('add-fetch-models'));
    await waitFor(() =>
      expect(screen.getByTestId('add-fetch-error').textContent).toBe(
        'Connection refused at 127.0.0.1:1234',
      ),
    );
    // A failure is a failure: no models were invented for the picker, and the picker
    // shows the provider's own sentence rather than an empty list.
    await userEvent.click(screen.getByTestId('add-default-model'));
    expect(await screen.findByTestId('combobox-error')).toHaveTextContent(
      'Connection refused at 127.0.0.1:1234',
    );
    await userEvent.keyboard('{Escape}');
    const probe = state.sent.find((call) => call.url.includes('provider-probes'));
    expect(probe?.body).toMatchObject({ preset: 'lmstudio', base_url: 'http://127.0.0.1:1234/v1' });
  });

  it('fetches, offers the models and sets the chosen one as the default', async () => {
    const { state, fetchImpl } = hub({ providers: [] });
    renderScreen(fetchImpl);
    await openDialog();
    await chooseOption(userEvent, screen.getByTestId('add-preset'), 'LM Studio');
    await userEvent.click(screen.getByTestId('add-fetch-models'));

    const undo = stubListViewport();
    await chooseInCombobox(
      userEvent,
      screen.getByTestId('add-default-model'),
      'qwen2.5-coder-7b-instruct',
    );
    undo();
    await userEvent.click(screen.getByTestId('add-submit'));

    await waitFor(() => {
      const put = state.sent.find((call) => call.url.endsWith('/models/defaults') && call.body);
      expect(put?.body).toEqual({
        default: {
          provider_id: '01J8QK3ZR2W7M5N4P6T8V9X0NEW',
          model: 'qwen2.5-coder-7b-instruct',
        },
      });
    });
    // The model was registered first, so the default is legal before the refresh job ends.
    expect(state.sent.some((call) => call.url.includes('/models/qwen2.5-coder-7b-instruct'))).toBe(
      true,
    );
  });

  it('warns that loopback means the container, and suggests the address that works', async () => {
    const { fetchImpl } = hub({ providers: [], containerized: true });
    renderScreen(fetchImpl);
    await openDialog();
    await chooseOption(userEvent, screen.getByTestId('add-preset'), 'LM Studio');

    const warning = await screen.findByTestId('loopback-warning');
    expect(warning.textContent).toContain('http://host.docker.internal:1234/v1');
    expect(warning.textContent).toContain('host.docker.internal:host-gateway');
    // …and it is a warning, not a rewrite.
    expect((screen.getByTestId('add-base-url') as HTMLInputElement).value).toBe(
      'http://127.0.0.1:1234/v1',
    );
  });

  it('sends a typed key once and never renders it back', async () => {
    const { state, fetchImpl } = hub();
    renderScreen(fetchImpl);
    await waitFor(() => expect(screen.getByTestId('provider-edit')).toBeTruthy());
    await userEvent.click(screen.getByTestId('provider-edit'));

    const field = screen.getByTestId('provider-key') as HTMLInputElement;
    // The key field is a password field: a shoulder-surfer sees nothing either.
    expect(field.type).toBe('password');
    await userEvent.type(field, 'sk-ant-api03-TYPED-ONCE');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const patch = state.sent.find((call) => call.method === 'PATCH');
      expect(patch?.body).toMatchObject({ api_key: 'sk-ant-api03-TYPED-ONCE' });
    });
    expect(document.body.textContent).not.toContain('TYPED-ONCE');
    await waitFor(() => expect(screen.getByText('Key stored')).toBeTruthy());
  });

  it('offers a key field on a provider that does not require one', async () => {
    const { fetchImpl } = hub({
      providers: [
        provider({
          slug: 'cli-proxy-api',
          label: 'cli-proxy-api',
          builtin: false,
          base_url: 'http://cli-proxy-api:8317/v1',
          auth: { kind: 'none', signed_in: true },
          catalogue: {
            status: 'error',
            refreshed_at: null,
            error: 'missing api key',
            refreshable: true,
          },
        }),
      ],
    });
    renderScreen(fetchImpl);
    await waitFor(() => expect(screen.getByTestId('provider-edit')).toBeTruthy());

    // The badge says the key is optional and the card shows the endpoint's own error —
    // the two do not contradict, and the upstream words are not replaced by ours.
    expect(screen.getByText('Key optional')).toBeTruthy();
    expect(screen.getByText('missing api key')).toBeTruthy();
    // One click reaches the field. This is what was impossible on 2026-09-22.
    await userEvent.click(screen.getByTestId('provider-edit'));
    const panel = screen.getByTestId('provider-edit-panel');
    expect(within(panel).getByLabelText('API key (optional)')).toBeTruthy();
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
    await waitFor(() => {
      expect(screen.getByText('No text-to-speech provider is chosen.')).toBeTruthy();
    });
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
    const undo = stubListViewport();
    await chooseInCombobox(userEvent, screen.getByTestId('default-chat'), 'claude-sonnet-4-5');
    undo();
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

  it('folds the Runtime card to one line when every check passes', async () => {
    const { fetchImpl } = hub();
    const user = userEvent.setup();
    renderScreen(fetchImpl);
    const card = await screen.findByTestId('runtime-report');
    expect(card.getAttribute('data-collapsed')).toBe('true');
    expect(within(card).getByTestId('runtime-all-ok').textContent).toBe('Everything works');
    // Nothing to read, so the list is not on the page until somebody asks for it.
    expect(within(card).queryByTestId('runtime-checks')).toBeNull();
    await user.click(within(card).getByTestId('runtime-toggle'));
    expect(within(card).getByTestId('runtime-checks')).toBeTruthy();
    expect(card.getAttribute('data-collapsed')).toBeNull();
    await user.click(within(card).getByTestId('runtime-toggle'));
    expect(within(card).queryByTestId('runtime-checks')).toBeNull();
  });

  it('opens the Runtime card by itself when a check fails', async () => {
    const { fetchImpl } = hub({
      runtime: {
        agent: 'hermes',
        mode: 'managed',
        ready: false,
        reloaded_at: null,
        checks: [
          { id: 'runtime_writable', ok: true, detail: 'managed' },
          { id: 'provider_keys', ok: true, detail: '1' },
          { id: 'model_selected', ok: false, detail: null },
          { id: 'gateway_reloaded', ok: true, detail: null },
        ],
      },
    });
    renderScreen(fetchImpl);
    const card = await screen.findByTestId('runtime-report');
    expect(card.getAttribute('data-collapsed')).toBeNull();
    expect(within(card).getByTestId('runtime-checks')).toBeTruthy();
    expect(within(card).getByText(/No chat model is selected/)).toBeTruthy();
    // A failure is not folded away behind a toggle, nor summed up as "everything works".
    expect(within(card).queryByTestId('runtime-toggle')).toBeNull();
    expect(within(card).queryByTestId('runtime-all-ok')).toBeNull();
  });

  it('renders in Arabic', async () => {
    const { fetchImpl } = hub();
    renderScreen(fetchImpl, 'ar');
    await waitFor(() => expect(screen.getByTestId('provider-list')).toBeTruthy());
    expect(screen.getAllByRole('heading', { name: 'النماذج' }).length).toBeGreaterThan(0);
    expect(screen.getAllByText('المزوّدون').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'إضافة مزوّد' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'تحديث قائمة النماذج' })).toBeTruthy();
  });

  it('warns about loopback in Arabic too', async () => {
    const { fetchImpl } = hub({ providers: [], containerized: true });
    renderScreen(fetchImpl, 'ar');
    await openDialog();
    await chooseOption(userEvent, screen.getByTestId('add-preset'), 'LM Studio');
    const warning = await screen.findByTestId('loopback-warning');
    expect(warning.textContent).toContain('حاوية');
    expect(warning.textContent).toContain('http://host.docker.internal:1234/v1');
  });

  it('gives every control a label a keyboard reaches', async () => {
    const { fetchImpl } = hub();
    renderScreen(fetchImpl);
    await waitFor(() => expect(screen.getByTestId('provider-list')).toBeTruthy());
    for (const name of ['Test', 'Add a provider', 'Refresh model cache', 'Edit', 'Remove']) {
      expect(screen.getByRole('button', { name }).tagName).toBe('BUTTON');
    }
    await userEvent.click(screen.getByTestId('provider-edit'));
    // Enablement takes effect the moment it is flipped, so it is a switch, not a tick box.
    expect(screen.getByRole('switch', { name: 'Enabled' })).toBeTruthy();
    // The dialog is a dialog, and Escape closes it.
    await userEvent.click(screen.getByTestId('open-add-provider'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('the container trap', () => {
  const host = { containerized: true, loopback_alias: 'host.docker.internal' };

  it('knows a loopback address from a routable one', () => {
    expect(isLoopbackUrl('http://127.0.0.1:1234/v1')).toBe(true);
    expect(isLoopbackUrl('http://localhost:11434')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:1234/v1')).toBe(true);
    expect(isLoopbackUrl('http://host.docker.internal:1234/v1')).toBe(false);
    expect(isLoopbackUrl('https://api.anthropic.com')).toBe(false);
    // Half-typed addresses are not warnings.
    expect(isLoopbackUrl('http://')).toBe(false);
    expect(isLoopbackUrl('')).toBe(false);
  });

  it('suggests the host alias and keeps the port and path', () => {
    expect(suggestedHostUrl('http://127.0.0.1:1234/v1', host)).toBe(
      'http://host.docker.internal:1234/v1',
    );
    expect(suggestedHostUrl('http://localhost:11434', host)).toBe(
      'http://host.docker.internal:11434',
    );
  });
});
