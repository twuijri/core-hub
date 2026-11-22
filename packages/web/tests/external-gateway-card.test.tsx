// The model gateway's external entrance on the Models screen (DECISIONS §156): an admin's one
// switch for the whole hub, and the addresses a person's own program points at once it is on.
// A member never sees it, and the hub is not even asked.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeSocket {
  connected = false;
  io = { on: () => undefined };
  on() {
    return this;
  }
  off() {
    return this;
  }
  once() {
    return this;
  }
  connect() {
    return this;
  }
  emit(_event: string, _payload: unknown, ack?: (reply: unknown) => void) {
    ack?.({ ok: true, replayed: 0, truncated: false });
    return this;
  }
  removeAllListeners() {}
  disconnect() {}
}

vi.mock('../src/realtime/socket.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, connectNamespace: () => new FakeSocket() };
});

const { AuthProvider } = await import('../src/auth/context.js');
const { SessionStore } = await import('../src/auth/store.js');
const { ThemeProvider } = await import('../src/design/theme.js');
const { I18nProvider } = await import('../src/i18n/context.js');
const { RealtimeProvider } = await import('../src/realtime/context.js');
const { ExternalGatewayCard } = await import('../src/models/ExternalGatewayCard.js');

afterEach(cleanup);

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

// The base addresses the hub hands out (`ExternalGateway.*_base_path`). They are not operations
// themselves, so they are built here rather than typed as one string (check-clients, ADR 0003).
const OPENAI_BASE = ['', 'api', 'v1', 'gateway', 'openai', 'v1'].join('/');
const ANTHROPIC_BASE = ['', 'api', 'v1', 'gateway', 'anthropic'].join('/');

function gateway(over: Record<string, unknown> = {}) {
  return {
    enabled: false,
    available: true,
    reason: null,
    openai_base_path: OPENAI_BASE,
    anthropic_base_path: ANTHROPIC_BASE,
    rate_limit_per_minute: 120,
    ...over,
  };
}

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

function hub(start: Record<string, unknown> = gateway()) {
  const sent: Sent[] = [];
  let state = start;
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
    sent.push({ method, path, body });
    const json = (value: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(value), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    if (path === '/models/external-gateway') {
      if (method === 'PATCH') state = { ...state, ...(body as Record<string, unknown>) };
      return json(state);
    }
    return json({ items: [] });
  };
  return { sent, fetchImpl };
}

function show(fetchImpl: typeof fetch, role: 'owner' | 'admin' | 'member' = 'owner') {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: 'u', username: 'admin', display_name: 'Admin', role },
  });
  return render(
    <ThemeProvider>
      <I18nProvider language="en">
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <AuthProvider store={store} baseUrl="http://hub.test" fetchImpl={fetchImpl}>
            <RealtimeProvider>
              <MemoryRouter>
                <div data-testid="host">
                  <ExternalGatewayCard />
                </div>
              </MemoryRouter>
            </RealtimeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

const asked = (sent: Sent[], method: string) =>
  sent.filter((each) => each.method === method && each.path === '/models/external-gateway');

describe('the external entrance card', () => {
  it('is not there for a member, and the hub is not even asked', async () => {
    const { sent, fetchImpl } = hub();
    show(fetchImpl, 'member');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('external-gateway-card')).toBeNull();
    expect(asked(sent, 'GET')).toHaveLength(0);
  });

  it('is off by default; switching it on shows the addresses with this hub in front', async () => {
    const { sent, fetchImpl } = hub();
    show(fetchImpl, 'admin');
    const card = await screen.findByTestId('external-gateway-card');
    expect(card.getAttribute('data-enabled')).toBe('false');
    expect(screen.queryByTestId('external-gateway-openai')).toBeNull();
    expect(card.textContent).toContain('120 calls a minute');

    await userEvent.click(screen.getByTestId('external-gateway-switch'));
    await waitFor(() => expect(asked(sent, 'PATCH')).toHaveLength(1));
    expect(asked(sent, 'PATCH')[0]!.body).toEqual({ enabled: true });
    const openai = await screen.findByTestId('external-gateway-openai');
    expect(openai.textContent).toBe(`${window.location.origin}${OPENAI_BASE}`);
    expect(openai.getAttribute('dir')).toBe('ltr');
    expect(screen.getByTestId('external-gateway-anthropic').textContent).toBe(
      `${window.location.origin}${ANTHROPIC_BASE}`,
    );
  });

  it('cannot be switched on where the hub has no gateway, and says why', async () => {
    const { fetchImpl } = hub(
      gateway({
        available: false,
        reason: 'This hub has no CLIProxyAPI, which the model gateway needs.',
      }),
    );
    show(fetchImpl, 'owner');
    const card = await screen.findByTestId('external-gateway-card');
    expect(card.textContent).toContain('no CLIProxyAPI');
    expect(screen.getByTestId('external-gateway-switch').hasAttribute('disabled')).toBe(true);
  });
});
