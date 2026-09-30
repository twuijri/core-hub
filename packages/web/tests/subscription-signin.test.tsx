// Subscriptions signed in to through the hub's gateway (DECISIONS §143), on the Models screen:
// "Add provider → Sign in with a subscription" with a link whose landing address is pasted back,
// a subscription card that opens its accounts dialog (usage windows, reset times, requests,
// errors, check now, turn off), and an older hub that does not offer any of it.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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

const CHATGPT = '01J8QK3ZR2W7M5N4P6T8V9X0CG';
const CLAUDE = '01J8QK3ZR2W7M5N4P6T8V9X0CL';
const ACCOUNT = 'codex-person@example.com-plus.json';
const SOON = new Date(Date.now() + 3 * 3600_000).toISOString();

function provider(over: Record<string, unknown> = {}) {
  return {
    id: CHATGPT,
    profile: 'default',
    owner_id: '01J8QK3ZR2W7M5N4P6T8V9X0HM',
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-21T06:00:00Z',
    slug: 'chatgpt-subscription',
    label: 'ChatGPT (Plus / Pro / Business)',
    kind: 'llm',
    scope: 'all',
    builtin: true,
    enabled: true,
    api_key: null,
    base_url: 'https://chatgpt.com/backend-api/codex',
    api_mode: 'native',
    auth: { kind: 'oauth', signed_in: true },
    catalogue: { status: 'ready', refreshed_at: null, error: null, refreshable: true },
    visibility: { mode: 'all', models: [] },
    models: [],
    subscription: { vendor: 'codex', flow: 'device', accounts: 1, accounts_ready: 1 },
    ...over,
  };
}

function account(over: Record<string, unknown> = {}) {
  return {
    id: ACCOUNT,
    label: 'person@example.com',
    email: 'person@example.com',
    plan: 'plus',
    status: 'active',
    status_message: null,
    disabled: false,
    next_retry_at: null,
    last_refresh_at: '2026-09-30T08:00:00Z',
    created_at: '2026-09-29T20:00:00Z',
    requests: {
      success: 42,
      failed: 1,
      recent: Array.from({ length: 20 }, (_, i) => ({
        at: new Date(Date.now() - (19 - i) * 600_000).toISOString(),
        success: i % 3,
        failed: i === 18 ? 1 : 0,
      })),
    },
    windows: [
      {
        id: 'primary',
        label: '5 hours',
        window_minutes: 300,
        used_percent: 12.5,
        resets_at: SOON,
        source: 'observed',
      },
    ],
    limit_reached: false,
    quota_observed_at: '2026-09-30T09:58:00Z',
    checked_at: null,
    check_error: null,
    ...over,
  };
}

interface Hub {
  providers: Record<string, unknown>[];
  sent: { url: string; method: string; body: unknown }[];
  /** A hub older than §143 answers 404 to its operations. */
  old: boolean;
  signInStatus: string;
}

function hub(state: Partial<Hub> = {}) {
  const h: Hub = {
    providers: [provider()],
    sent: [],
    old: false,
    signInStatus: 'pending',
    ...state,
  };
  let current = account();
  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
    h.sent.push({ url, method, body });
    const json = (value: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(value), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const missing = () => json({ error: 'not found', code: 'not_found' }, 404);
    if (url.includes('/models/subscription-vendors')) {
      if (h.old) return missing();
      return json({
        available: true,
        reason: null,
        note: 'Some vendors limit using a subscription outside their own apps.',
        items: [
          {
            preset: 'chatgpt-subscription',
            vendor: 'codex',
            label: 'ChatGPT (Plus / Pro / Business)',
            flow: 'device',
            usage_windows: true,
            checkable: true,
          },
          {
            preset: 'claude-subscription',
            vendor: 'claude',
            label: 'Claude (Pro / Max)',
            flow: 'link',
            usage_windows: true,
            checkable: true,
          },
        ],
      });
    }
    if (url.includes('/models/hermes-source')) {
      if (h.old) return missing();
      return json({ source: 'hub', effective: 'hub', available: true, reason: null });
    }
    if (url.includes('/models/provider-presets')) {
      return json({ items: [], host: { containerized: false, loopback_alias: 'x' } });
    }
    if (url.endsWith('/models/providers') && method === 'POST') {
      const created = provider({
        id: CLAUDE,
        slug: 'claude-subscription',
        label: 'Claude (Pro / Max)',
        auth: { kind: 'oauth', signed_in: false },
        subscription: { vendor: 'claude', flow: 'link', accounts: 0, accounts_ready: 0 },
      });
      h.providers = [...h.providers, created];
      return json(created, 201);
    }
    if (url.endsWith('/models/providers')) return json({ items: h.providers });
    const signIn = (status: string) => ({
      id: '01J8QK3ZR2W7M5N4P6T8V9X0SN',
      status,
      user_code: null,
      verification_url: 'https://claude.ai/oauth/authorize?state=abc',
      accepts_code: true,
      callback_hint: 'http://localhost:54545/callback',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      error: null,
    });
    if (url.endsWith(`/models/providers/${CLAUDE}/sign-in`) && method === 'POST') {
      return json(signIn('pending'), 201);
    }
    if (url.includes(`/models/providers/${CLAUDE}/sign-in/`)) {
      if (method === 'POST') h.signInStatus = 'approved';
      return json(signIn(h.signInStatus));
    }
    if (url.endsWith(`/models/providers/${CHATGPT}/accounts`)) {
      return json({
        provider_id: CHATGPT,
        vendor: 'codex',
        flow: 'device',
        available: true,
        reason: null,
        observed_at: new Date().toISOString(),
        accounts: [current],
        errors: [
          {
            at: new Date(Date.now() - 600_000).toISOString(),
            account_id: ACCOUNT,
            model: 'gpt-5.5',
            status: 429,
            message: 'The usage limit has been reached',
          },
        ],
      });
    }
    if (url.endsWith('/check') && method === 'POST') {
      current = account({
        windows: [
          {
            id: 'secondary',
            label: 'Weekly',
            window_minutes: 10080,
            used_percent: 55,
            resets_at: SOON,
            source: 'checked',
          },
        ],
        checked_at: new Date().toISOString(),
      });
      return json(current);
    }
    if (url.includes(`/accounts/`) && method === 'PATCH') {
      current = account({ disabled: true, status: 'disabled' });
      return json(current);
    }
    if (url.includes('/models/runtime')) {
      return json({ agent: 'hermes', mode: 'managed', ready: true, reloaded_at: null, checks: [] });
    }
    if (url.includes('/models/defaults')) {
      return json({ default: null, fallbacks: [], auxiliary: { tasks: [], assignments: {} } });
    }
    if (url.includes('/models/speech')) {
      const side = { active_provider_id: null, ready: false, reason: null, providers: [] };
      return json({ stt: side, tts: side });
    }
    if (url.includes('/agents')) return json({ items: [] });
    if (url.includes('/models')) return json({ items: [], next_cursor: null });
    return json({ items: [] });
  };
  return { state: h, fetchImpl };
}

function renderScreen(fetchImpl: typeof fetch) {
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
      <I18nProvider language="en">
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

describe('subscriptions on the models screen', () => {
  it('opens a subscription’s dialog from its card: usage, reset, requests, errors, check now, turn off', async () => {
    const { state, fetchImpl } = hub();
    renderScreen(fetchImpl);
    await waitFor(() => expect(screen.getByTestId('provider-accounts-count')).toBeTruthy());
    expect(screen.getByTestId('provider-accounts-count').textContent).toBe('1 (1 ready)');
    // A subscription has no key to test.
    expect(screen.queryByTestId('provider-test')).toBeNull();

    // Clicking the card itself (not one of its buttons) opens the dialog.
    const card = document.querySelector('[data-provider-slug="chatgpt-subscription"]')!;
    await userEvent.click(card.querySelector('.provider-facts')!);
    const dialog = await screen.findByTestId('provider-accounts-dialog');
    await waitFor(() => expect(within(dialog).getByTestId('account')).toBeTruthy());
    expect(within(dialog).getByText('person@example.com')).toBeTruthy();
    expect(within(dialog).getByTestId('account-status').textContent).toBe('Working');
    expect(within(dialog).getByTestId('window-left').textContent).toBe('88% left');
    expect(within(dialog).getByTestId('window-reset').textContent).toMatch(/^Resets in 3 hours$/);
    expect(within(dialog).getByTestId('account-requests').textContent).toBe(
      '42 answered · 1 failed',
    );
    expect(within(dialog).getByTestId('account-buckets').children).toHaveLength(20);
    expect(within(dialog).getByTestId('accounts-errors').textContent).toContain(
      'The usage limit has been reached',
    );

    await userEvent.click(within(dialog).getByTestId('account-check'));
    await waitFor(() =>
      expect(
        state.sent.some(
          (sent) =>
            sent.method === 'POST' &&
            sent.url.endsWith(
              `/models/providers/${CHATGPT}/accounts/${encodeURIComponent(ACCOUNT)}/check`,
            ),
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(within(dialog).getByTestId('window-left').textContent).toBe('45% left'),
    );

    await userEvent.click(within(dialog).getByTestId('account-enabled'));
    await waitFor(() =>
      expect(
        state.sent.find((sent) => sent.method === 'PATCH' && sent.url.includes('/accounts/'))?.body,
      ).toEqual({ disabled: true }),
    );
  });

  it('adds a subscription by a link and a pasted-back address, from "Add provider"', async () => {
    const { state, fetchImpl } = hub({ providers: [] });
    renderScreen(fetchImpl);
    await userEvent.click(await screen.findByTestId('open-add-provider'));
    await userEvent.click(await screen.findByTestId('add-mode-subscription'));
    const list = await screen.findByTestId('subscription-vendors');
    expect(within(list).getByTestId('subscription-note').textContent).toMatch(
      /outside their own apps/,
    );
    await userEvent.click(within(list).getByText('Claude (Pro / Max)'));
    await userEvent.click(within(list).getByTestId('subscription-continue'));

    const panel = await screen.findByTestId('sign-in-panel');
    expect(
      state.sent.find((sent) => sent.method === 'POST' && sent.url.endsWith('/models/providers'))
        ?.body,
    ).toMatchObject({
      preset: 'claude-subscription',
      scope: 'all',
    });
    await waitFor(() => expect(within(panel).getByTestId('sign-in-paste')).toBeTruthy());
    expect(within(panel).getByTestId('sign-in-link').getAttribute('href')).toBe(
      'https://claude.ai/oauth/authorize?state=abc',
    );
    expect(
      within(panel).getByText(/It starts with http:\/\/localhost:54545\/callback/),
    ).toBeTruthy();
    await userEvent.type(
      within(panel).getByTestId('sign-in-paste'),
      'http://localhost:54545/callback?code=abc&state=abc',
    );
    await userEvent.click(within(panel).getByTestId('sign-in-paste-submit'));
    await waitFor(() => expect(within(panel).getByTestId('sign-in-approved')).toBeTruthy());
    expect(
      state.sent.find((sent) => sent.method === 'POST' && sent.url.includes('/sign-in/'))?.body,
    ).toEqual({ code: 'http://localhost:54545/callback?code=abc&state=abc' });
  });

  it('offers nothing new on an older hub', async () => {
    const { fetchImpl } = hub({ old: true, providers: [] });
    renderScreen(fetchImpl);
    await userEvent.click(await screen.findByTestId('open-add-provider'));
    await screen.findByTestId('add-mode-custom');
    await waitFor(() => expect(screen.queryByTestId('add-mode-subscription')).toBeNull());
    expect(screen.queryByTestId('hermes-source')).toBeNull();
  });
});
